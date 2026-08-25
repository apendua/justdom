# `justdom-three`: the DOM→3D projection, its tradeoffs, and how far it can go

An analysis of how `packages/freedom` maps DOM elements to Three.js objects,
what the current invalidation model deliberately gives up, and what it would
take to lift those limits — in particular, whether animated DOM elements
(CSS transitions/animations, JS-driven animation) can be rendered without
performance degradation. Based on reading the source as of this writing:
`src/elements/portal.js`, `cache.js`, `div.js`, `text.js`, `textHelpers.js`,
`VisualProperties.js`, `rectangle.js`, `elevation.js`, and `render.js`.

---

## 1. How the projection works today

### 1.1 The pipeline

`dom(ctx, mountable$)` (`src/dom.js`) mounts a `justdom` component
tree into a **real, hidden DOM container** — `position: absolute; top: 0;
left: 0; visibility: hidden`, appended to `document.body`
(`portal.js:143-149`). The browser therefore performs full CSS parsing,
cascade, and layout on the panel's DOM; freedom never reimplements layout.
The scene is a *retained-mode mirror* of what the browser computed:

```
justdom mountable ──mount──▶ hidden container <div data-xr-portal>
                                    │
                          MutationObserver + font events
                                    │  Set<MutationType>
                                    ▼
                     per-portal Subject<Set<MutationType>>
                                    │  (filtered per read kind)
                                    ▼
              cached reads (Derived): getComputedStyle / getBoundingClientRect
                              / Range-based text layout
                                    │  (signal graph, equality-gated)
                                    ▼
                THREE.Object3D tree (1 node ↔ 1 object), meshes,
                     memoized materials, rebuilt geometries
```

### 1.2 Node ↔ object mapping

`createPortal(ctx)` keeps three WeakMaps: `nodeToObject`, `objectToNode`,
`objectToCleanup`. `getOrCreateObjectForNode` walks the DOM: every element
becomes `div(ctx, element)` (there is a `switch` on tag name with only a
`default` case today — a natural extension point), every text node becomes
`text(ctx, textNode)`. Children are added recursively, and the
`MutationObserver`'s `childList` records add/remove subtrees incrementally.

Each `div` produces:

- an `Object3D` positioned at `(rect.left − parentRect.left, rect.top −
  parentRect.top, −CONTENT_STEP)` — container-local px, y down, each nesting
  level physically 2px (local) in front of its parent;
- a **border mesh**: `ShapeGeometry` of the rounded outline with the inner
  rounded hole, and a `MeshBasicMaterial` memoized per `(color, opacity)`;
- a **background mesh**: the shrunken rounded rectangle, same material scheme;
- if the element is an *overlay* (`position` ≠ `static` and `z-index > 0`,
  `elevation.js`), an extra elevation offset (8px local) plus an invisible
  **blocker** plane so rays cannot pass between its rows into what it covers.

Each text node produces one quad whose texture is rasterized on a 2D canvas
(`textHelpers.js`): line boxes are *read back* from the browser via
`Range.getClientRects()` (so wrapping, `text-align`, centering all come from
the real layout), then glyphs are redrawn line by line at up to `MAX_DPR = 2`
into at most a 2048px texture. Color, shadow, and decorations are **baked
into the raster**.

Interactivity: `cursor: pointer` opts an element into the raycast set
(`div.js:53-55`); XR select/pointer events are translated back into DOM
`MouseEvent`s and `data-xr-hover` / `data-xr-active` attributes, which CSS
then reacts to; the resulting `class`/`data-xr-*` attribute mutation flows
back through the observer to restyle the meshes. Hover styling is therefore
a full round trip through the real DOM, which is what keeps CSS the single
source of truth.

### 1.3 The invalidation model — what triggers what

All invalidation flows through **one `Subject<Set<MutationType>>` per
portal** (`portal.js:59`, distributed to every node via `setSubject`). The
`MutationObserver` watches:

```js
{ childList: true, subtree: true, attributes: true,
  attributeFilter: ["data-xr-hover", "data-xr-active", "class"],
  characterData: true }
```

plus `document.fonts` "loadingdone" as a synthetic `fontLoaded` type. Each
cached read subscribes to the subject filtered by mutation type
(`cache.js`):

| Cached read | `childList` | `attributes` | `characterData` | `fontLoaded` |
|---|---|---|---|---|
| `getComputedStyleCached` | ✓ | ✓ | — | ✓ |
| `getBoundingClientRectCached` | ✓ | — | ✓ | ✓ |
| `getTextLayout` | ✓ | — | ✓ | ✓ |
| `getParentElement` | ✓ | — | — | — |

Downstream, `VisualProperties.setFromElement` snapshots ~20 style properties
into a `store()` whose **per-key equality gates propagation**: a hover class
swap re-reads styles but only actually pushes new geometry/materials for the
properties that changed. `getComputedStyleCached` itself always propagates
(`isEqual: () => false`) because the browser returns a *live*
`CSSStyleDeclaration` with stable identity — equality gating has to happen
after the snapshot, and it does.

---

## 2. The tradeoffs, as designed

These are deliberate, and the reasoning is sound; they are worth restating
because the improvement paths below are precisely about relaxing them.

**T1 — Attribute mutations restyle but never re-measure.** The hover
handlers write `data-xr-*` onto the element they fired on; if `attributes`
invalidated `getBoundingClientRectCached`, every twitch of the ray would
force a reflow read of the whole panel. The cost of the tradeoff: *a class
swap that changes size (padding, width, font-size) silently does not resize
the 3D mirror*. The README's contract — "anything that changes size has to
be mounted and unmounted rather than hidden and shown" — follows from this
line in `cache.js`, not from anything fundamental.

**T2 — Invalidation is portal-wide, not per-node.** The subject carries only
mutation *types*; every cached read in the portal subscribes to the same
stream. One `data-xr-hover` write on one button invalidates the computed
style cache of **every element in the portal** — O(N) `getComputedStyle`
snapshots per hover transition. The store equality means no GPU-side churn,
but the CPU-side re-read is linear in panel size for a 1-element change.
Fine at ~10² nodes; the first thing to fix beyond that, and a hard
prerequisite for animation (§4.1).

**T3 — Only `class` and `data-xr-*` attributes are observed.** Inline
`style` mutations are invisible. This closes off the most common JS
animation idiom (rAF + `el.style.transform = …`) entirely.

**T4 — No mutation, no update.** CSS transitions, CSS animations, WAAPI
animations, and `:hover`-style pseudo-class changes produce **no DOM
mutations at all**: computed style changes over time while the DOM stays
identical. Today the mirror simply never sees them. (Hover is only
supported *because* it was rerouted through `data-xr-hover` attributes.)

**T5 — CSS `transform` is not modeled.** Nothing in the projection path
reads `style.transform`. Worse than unsupported, it is *mis*-supported:
`getBoundingClientRect()` returns the transformed axis-aligned bounds, so a
rotated or scaled element renders as its wrong-sized AABB at the transformed
position, unrotated.

**T6 — Style changes rebuild geometry; text changes re-rasterize.** Any
change to the rect params re-triangulates a `ShapeGeometry` (border ring
triangulation is not cheap); any change to text layout *or color* allocates
a new canvas, redraws every glyph, and uploads a new `CanvasTexture`. As
one-off costs per discrete state change this is fine; at 60–120Hz it is not.

**T7 — Draw calls scale with node count.** Two meshes per element, one per
text node, individually drawn. A panel of 150 nodes is ~300 draw calls —
already meaningful on a standalone XR headset targeting 72–120Hz with two
eyes.

Two smaller observations while reading:

- `getInheritedOpacity` (`VisualProperties.js:156-169`) is stubbed — the
  loop that would multiply ancestor opacities is commented out, so it always
  returns 1.0 and only counts depth. Inherited `opacity` on a wrapper does
  nothing today.
- `div.js:194` reads `element.parentElement` directly inside the position
  effect rather than through the cached/reactive `getParentElement`, so the
  offset base is not reactive to reparenting (in practice reparenting goes
  through unmount/remount, so this is latent rather than live).
- `parseColor` only matches `rgb()/rgba()` serialization. Computed colors
  serialize that way today, but wide-gamut values serialize as
  `color(srgb …)`/`oklch(…)` and fall through to black.

---

## 3. Can we render animated DOM elements?

Yes — and the architecture is unusually well placed for it, because the
browser is already *running* the animation; freedom only has to sample it.
Two facts make this workable:

1. **CSS animations and transitions run inside a `visibility: hidden`
   container.** Style recalc still happens, the animation timeline advances,
   `getComputedStyle` returns the current interpolated value, and
   `transitionstart/end`, `animationstart/end`, and
   `element.getAnimations({ subtree: true })` all work. (`display: none`
   would kill them; the portal deliberately uses `visibility: hidden`, so
   the door is open.)
2. **freedom already owns a frame loop** (`render.js` listener registry,
   `animate(ctx, fn)`), wrapped in `Computation`s, running before render.
   There is a natural place to turn *time* into *invalidation*.

The plan decomposes by CSS property class, exactly the way browsers
themselves tier animation cost:

### 3.1 The animation clock (the core mechanism)

Add to the portal, alongside the `MutationObserver`:

- listeners for `transitionrun/start/end/cancel` and
  `animationstart/end/cancel` on the container (they bubble), maintaining a
  `Set<Element>` of currently-animating elements — with
  `getAnimations({ subtree: true })` as a fallback/reconciliation sweep;
- while the set is non-empty, a per-frame callback (registered through the
  same listener registry `animate` uses) that emits a *targeted*
  invalidation — a new `MutationType`, say `"animated"`, carrying the
  affected elements — and calls `interactionManager.updateIntersections()`
  so a button sliding under a stationary ray updates its hover state.

Per-frame cost while animating: k `getComputedStyle` reads (k = animating
elements, typically 1–5), plus whatever the sampled values invalidate
downstream. The style recalc the browser does to answer those reads is work
it does anyway for any visible animation. When the set empties, the
callback unregisters and the steady-state cost returns to zero. **No
polling when nothing animates** — this preserves the package's core
economy.

For JS-driven inline-style animation (T3), the same clock covers WAAPI via
`getAnimations()`; raw rAF + `el.style.x = …` needs `style` added to the
`attributeFilter` — cheap once invalidation is per-target (§4.1), since
only the mutated element re-reads.

### 3.2 What each property class costs per frame

**Opacity and color** — sample computed style → parse → material update.
Two changes make this genuinely cheap:

- *In-place material mutation for animating elements.* The memoized
  `(color, opacity) → material` cache is the wrong shape under animation: a
  new `THREE.Color` identity per sample means a new material per frame
  (`memoize` keys on the first argument's identity). While an element is in
  the animating set, its meshes should own a private material and write
  `material.color.set(...)` / `material.opacity = …` directly — zero
  allocation, no shader recompile (three's program cache already dedupes;
  only `transparent` flips recompile, so keep animating materials
  `transparent: true` for the duration).
- *Stop baking color into the text raster.* Rasterize glyphs white (alpha
  mask), tint via `material.color` — text color animation becomes a uniform
  write instead of a full canvas redraw + texture upload (fixes the worst
  case of T6 for free, and shrinks re-rasters generally to actual
  text/layout/font changes).

**Transform** — this is the big one, and it is currently missing entirely
(T5). Map it properly: read the *untransformed* border box
(`offsetLeft/Top/Width/Height`, or rect computed from the parent chain),
parse computed `transform` (which serializes as `matrix(…)`/`matrix3d(…)` —
trivial to parse) and `transform-origin`, and compose it into the
`Object3D`'s local matrix (minding the portal's y-down flip). Then a CSS
`transform` transition — the property the entire flat web uses for
performant motion — becomes **a per-frame matrix write on an existing
object**: no layout change, no rect re-reads, no geometry, no texture. This
one feature simultaneously fixes a correctness bug (rotated/scaled elements
render wrong today) and unlocks the standard animation vocabulary
(slide-in menus, scale-on-press, spinners) at effectively zero marginal
cost. The guidance to app authors becomes *identical to flat-web guidance*:
"animate transform and opacity" — a rule every web developer already knows.

**Layout-affecting properties** (height, padding, font-size…) — inherently
the expensive tier: per-frame forced reflow + rect re-reads for the
affected subtree + geometry updates. Supportable, but only worth doing
after §4.2's SDF change removes the per-frame retriangulation; even then it
should stay documented as the tier to avoid, exactly as on the flat web.

### 3.3 Verdict

With (a) per-target invalidation, (b) the animation clock, (c) transform
mapping, (d) in-place materials, and (e) alpha-mask text — transform,
opacity, and color animations run at frame rate with per-frame cost
proportional to the number of *animating elements*, not panel size, and
zero cost at rest. That is "without performance degradation" in the sense
that matters: the steady-state architecture is untouched, and the animated
path does strictly less work per frame than the browser itself would spend
compositing the same animation on screen.

---

## 4. Improvement roadmap

Ordered so that each tier is useful on its own and a prerequisite for the
next.

### 4.1 Tier 1 — per-target invalidation (prerequisite, fixes T2)

Change the portal subject from `Subject<Set<MutationType>>` to carry
targets: `Subject<{ types: Set<MutationType>, targets: Set<Node> }>` (the
`MutationRecord`s already have them; `mutationCallback` currently discards
them). Each node's cached read filters on type ∧ relevance:

- computed style: relevant if the target is the node itself **or an
  ancestor** (inheritance: `color`, `font-size` cascade down). The mirror
  object tree already encodes the hierarchy, and `Node.contains()` answers
  it directly.
- rects/text layout: keep the coarse behavior for `childList` (layout is
  non-local — a sibling growing moves you), per-target for
  `characterData`.

Effect: a hover transition goes from O(panel) style snapshots to
O(subtree of the hovered element). This is also what makes `style` safe to
add to the `attributeFilter`, and what keeps the animation clock's
invalidations from fanning out.

### 4.2 Tier 2 — SDF rounded rectangles (fixes T6 for geometry, enables layout animation)

Replace the triangulated `ShapeGeometry` border/background pair with a unit
quad and a small fragment shader: signed-distance rounded rect with
per-corner radii, border widths, fill and border colors as uniforms — the
approach of essentially every GPU UI toolkit. Resize becomes a scale +
uniform write; radius/border/color changes are uniform writes; **geometry
is never rebuilt again**, and the border mesh disappears (one mesh per
element instead of two). It also opens the door to `box-shadow` and
gradient backgrounds as shader features, and later to `overflow: hidden`
via a clip rect uniform (panels are planar, so scrolling containers become
translate + clip — cheap, and `scrollTop` animation comes along free).

### 4.3 Tier 3 — the animation clock and transform mapping (§3)

As described above. Suggested order: transform mapping first (correctness
fix + biggest payoff), then the clock, then in-place materials and
alpha-mask text.

Optionally, soften T1 with an explicit escape hatch rather than a behavior
change: export an `invalidateLayout(portalRoot)` (or honor a
`data-xr-remeasure` attribute) so an app that just applied a size-changing
class can request one re-measure without paying for reflow on every
attribute twitch.

### 4.4 Tier 4 — instanced panel rendering (fixes T7, the scale endgame)

Once every element is "a quad + SDF uniforms", the uniforms can become
instance attributes: one `InstancedMesh` (or `BatchedMesh`) per elevation
band per portal, each element an instance slot carrying rect, radii, colors.
DOM order = instance order = paint order, which matches the existing
physical z-stepping (`CONTENT_STEP`), so depth + instance order reproduce
today's `renderOrder` semantics within a band. A panel then renders in a
handful of draw calls **regardless of node count**, and the fine-grained
signal graph — which already delivers per-element updates — writes into
instance-buffer slots instead of per-mesh uniforms. Text can follow the
same road later (glyph atlas, e.g. MSDF, instanced quads per glyph run),
but canvas-per-node text is not the bottleneck at panel scale; keep it
until element count is.

An allocator (free-list of instance slots, buffer growth on overflow) is
the only genuinely new machinery; everything else is a representation
change under the existing reactive graph.

### 4.5 Independent parity items (any time)

- **Images**: an `img` case (and `background-image`) in the portal's tag
  switch — texture from the same URL onto the SDF quad. Straightforward.
- **Opacity inheritance**: finish `getInheritedOpacity` — with per-target
  invalidation, an ancestor-opacity `Derived` chain is cheap; multiplied
  opacity is then also animatable via the clock.
- **Pseudo-elements**: `VisualProperties.setFromElement` already accepts a
  `pseudoElement` argument that nothing passes; `::before/::after` boxes
  (their rects are readable via ranges only for content — realistically,
  support decorative pseudo-elements as extra SDF quads driven by their
  computed style).
- **Color parsing**: accept `color(srgb …)`/`oklch()` serializations
  (convert via a probe element or `CSS.supports`-guarded fast paths) so
  wide-gamut styles don't collapse to black.
- **`visibility: hidden` / `display: none` mapping**: mirror to
  `object.visible = false` explicitly rather than relying on degenerate
  zero-sized rects.

---

## 5. Why this architecture is worth taking this far

The alternative families are worth naming, because they explain why the
per-element mirror is the right foundation rather than a stopgap:

- **DOM-to-texture** (html2canvas-style snapshots, or CSS3D-renderer
  overlays) cannot work in WebXR: there is no live, interactive DOM→GPU
  texture path (SVG `foreignObject` serialization is static and tainting
  applies), and CSS3D overlays don't exist inside an immersive session at
  all. Per-element hit-testing and crisp text at any distance also fall out
  of the mirror approach for free.
- **Reimplemented layout engines** (e.g. flexbox-in-JS UI kits for three)
  buy full control at the price of owning layout, cascade, and text shaping
  forever. freedom's central bet — *let the browser be the layout and style
  engine, mirror the results* — keeps CSS, media queries, `ch` units, font
  fallback, bidi, and the whole authoring model intact. Everything in this
  document is about managing the one cost of that bet: the read-back
  channel. The bet itself is sound, and nothing in the animation story
  requires revisiting it — animations, after all, are computed by exactly
  the engine the architecture already delegates to.

The end state this roadmap reaches: panels of arbitrary DOM, styled and
animated with ordinary CSS, rendering in O(1) draw calls, updating at rest
for O(changed subtree) and under animation for O(animating elements) per
frame — with the browser doing what it is best at and the GPU scene doing
only arithmetic.
