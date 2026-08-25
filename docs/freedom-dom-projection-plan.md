# `justdom-three`: DOM projection improvements — implementation plan

The companion to [`freedom-dom-projection.md`](./freedom-dom-projection.md),
which analyzed the current architecture and its tradeoffs. This document
turns that analysis into a phased, concrete plan: what changes, in which
files, in what order, with what tests, and what each phase deliberately
leaves out.

Phases are ordered so each is shippable on its own and a prerequisite (or at
least a simplifier) for the next:

| Phase | Deliverable                                         | Size   | Depends on                |
| ----- | --------------------------------------------------- | ------ | ------------------------- |
| P1    | Per-target invalidation                             | M      | —                         |
| P2    | CSS `transform` mapping                             | M      | P1 (soft)                 |
| P3    | Animation clock                                     | M      | P1, P2                    |
| P4    | Paint-path decoupling (text tint, owned materials)  | S      | —                         |
| P5    | SDF rounded-rect quad                               | M      | — (supersedes half of P4) |
| P6    | Instanced panel rendering                           | L      | P5; gated on measurement  |
| P7    | Parity backlog (images, opacity, scroll, …)         | S each | varies                    |
| P8    | Scroll as an offset (per-frame cost of a long list) | M      | P7.5 (done)               |

The animation-critical path is P1 → P2 → P3 → P4; after it, transform,
opacity, and color animations authored in ordinary CSS render at frame rate.
P5 makes layout animation viable and halves per-element cost; P6 is the
draw-call endgame and stays gated on a measured need.

A note on testing that applies everywhere: the test suite runs under jsdom
(`src/test/setup-jsdom.js`), which computes styles but performs **no
layout** — every rect is zero — and runs no animations. The existing tests
already work with that grain (they inject the portal's subject via
`setSubject` and assert registration/position _logic_, not pixel values).
Every phase below keeps its geometry and parsing in pure functions so the
math is unit-testable, and reserves end-to-end visual checks for the demo
apps (`apps/todo-xr`, `apps/rubik`, `apps/blockout-xr`).

---

## P1 — Per-target invalidation

**Problem** (T2 in the analysis): the portal publishes one
`Subject<Set<MutationType>>` shared by every node, so a single
`data-xr-hover` write re-snapshots computed style for every element in the
portal — O(panel) per hover transition — and any future per-frame animation
invalidation would fan out the same way.

**Scope decision — computed style only.** Rect and text-layout invalidation
_stay coarse_. Layout is non-local (a sibling growing moves you; a text node
rewrapping shifts everything after it), so per-target rect invalidation is
unsound; and rects are only invalidated by `childList`/`characterData`/
`fontLoaded`, which are rare, structural events. The O(N)-per-twitch hot
path is computed style, and that is where targeting is both sound and
valuable.

### Changes

- **`portal.js`** — the observer callback currently coalesces records into
  `Set<MutationType>`; extend the payload to
  `{ types: Set<MutationType>, targets: Set<Node> | null }` (a
  `MutationBatch` typedef in `cache.js`). `targets` comes straight from
  `MutationRecord.target` (for `childList` records that is the parent, which
  is exactly right — see the covering rule). `null` means portal-wide and is
  used for `fontLoaded` and the resize path.
- **`cache.js`** — `getComputedStyleCached`'s dependency becomes
  `subject.pipe(filter(batch => typeMatches(batch) && covers(batch, element)))`
  with the covering rule:

  ```js
  const covers = (batch, node) =>
    batch.targets === null || [...batch.targets].some((t) => (t.parentNode ?? t).contains(node));
  ```

  Rationale for `(t.parentNode ?? t)`: an attribute change on `t` can
  restyle `t` and its descendants (descendant combinators, inheritance) but
  also its _siblings_ (`.a ~ .b`, `.a + .b`); widening to the parent's
  subtree covers both. Structural pseudo-classes (`:nth-child`) arrive as
  `childList` mutations whose target already is the parent. The one thing
  this is knowingly unsound for is `:has()` (a descendant mutation
  restyling an _ancestor_); document that limitation, and provide a portal
  option (`{ coarseInvalidation: true }`) restoring today's behavior as the
  escape hatch.

- **`getBoundingClientRectCached` / `getTextLayout` / `getParentElement`** —
  unchanged semantics; only the filter predicates adapt to the new payload
  shape (they ignore `targets`).
- **Test files** — `div.test.js`, `portal.test.js`, etc. construct
  `Subject<Set<MutationType>>` by hand; update the helpers to the new
  payload (a tiny `announce(types, targets)` helper keeps the tests
  readable).

### Tests

- Sibling isolation: two elements under one parent-of-parents; attribute
  batch targeting A does not recompute B's style (count recomputes by
  spying on `window.getComputedStyle`).
- Ancestor propagation: attribute batch targeting a grandparent recomputes
  the grandchild.
- Sibling-combinator safety: batch targeting A _does_ recompute A's sibling
  (they share a parent).
- `targets: null` behaves exactly like today (regression guard for
  `fontLoaded`).

### Exit criteria

Hover transition on an N-element panel performs O(subtree) style snapshots
(assert via spy in a portal-level test); full suite green; no public API
change beyond the `MutationBatch` type.

---

## P2 — CSS `transform` mapping

**Problem** (T5): `transform` is unmodeled and currently _mis_-rendered —
`getBoundingClientRect` returns the transformed AABB, so a rotated/scaled
element draws as a wrong-sized, unrotated box at the transformed position.
Fixing it is both a correctness fix and the key that unlocks the standard
performant-animation vocabulary in P3.

### Design

Split "where the box is" from "how the box is transformed":

1. **Layout rect** — untransformed border box relative to the parent
   element. Hybrid measurement in a new cached read
   `getLayoutRect(element)` (in `cache.js`, invalidated like rects today):
   - _Fast path_ (overwhelmingly common): if neither the element nor its
     parent chain inside the portal has a transform, this is exactly the
     current `getBoundingClientRect` arithmetic — subpixel-accurate, no
     behavior change. "Has a transform" is itself a cheap cached read of
     computed `transform !== "none"`.
   - _Transform path_: resolve `offsetLeft/offsetTop` through the
     `offsetParent` chain up to `parentElement` (adjusting for the parent's
     `clientLeft/clientTop` border and `scrollLeft/scrollTop`), and take
     `offsetWidth/offsetHeight` for size. Integer precision is the accepted
     cost, only paid by elements that opted into transforms.
2. **Transform matrix** — new cached read `getTransformCached(element)`
   (invalidated with computed style, incl. `"animated"` from P3): parse
   computed `transform` — which browsers serialize as `matrix(a,b,c,d,e,f)`
   or `matrix3d(m11,…,m44)`, both column-major — and `transform-origin`
   into a `THREE.Matrix4`. Pure parser in a new `elements/cssTransform.js`.
3. **Application** — in `div.js`, the position effect becomes: when the
   transform is identity, exactly today's `position.set(...)`; otherwise
   `object.matrixAutoUpdate = false` and

   ```
   object.matrix = T(layoutPos + z·step) · T(origin) · M_css · T(−origin)
   ```

   composed with `Matrix4` ops, no decompose (decompose loses skew).
   Coordinate care: the portal's container flip already makes local space
   y-down px, matching the CSS coordinate system, so the 2D matrix embeds
   directly (`x' = a·x + c·y + e`, `y' = b·x + d·y + f`); `matrix3d` z
   values are px and land in the same local unit the ±2px content steps
   use.

Raycasting needs nothing: the interaction manager casts against world
matrices, which now include the transform. `coverBox`/blockers compose the
same way as children.

### Tests

jsdom offsets are all zero, so the leverage is in pure functions:

- `cssTransform.js` parser: `none`, `matrix`, `matrix3d`, origins in px and
  %, y-axis conventions (golden matrices).
- Composition: a translated/rotated/scaled box produces the expected
  `object.matrix` given a stubbed layout rect (drive via the same
  `setSubject` harness `div.test.js` uses).
- Fast-path guard: with `transform: none` everywhere, `matrixAutoUpdate`
  stays true and positions match today's (regression).

Manual: add a rotated card and a scaled-on-hover button to a demo app
panel; verify alignment, hit-testing, and stereo depth in the emulator.

### Exit criteria

Transformed elements render correctly (position/rotation/scale, correct
origin); untransformed panels byte-identical in behavior; parser fully
unit-tested.

---

## P3 — Animation clock

**Problem** (T4): CSS transitions/animations and WAAPI mutate nothing, so
the mirror never sees them. The browser is already running them inside the
`visibility: hidden` container (timelines advance; `getComputedStyle`
returns interpolated values; transition/animation events fire); freedom
only has to sample while anything is animating.

### Design

New module `elements/animationClock.js`, owned by the portal:

- **Membership.** Bubbling listeners on the container for `transitionrun`,
  `transitionstart`, `transitionend`, `transitioncancel`,
  `animationstart`, `animationend`, `animationcancel` maintain a
  `Map<Element, { paint: number, transform: number, layout: number }>` of
  refcounts. Transitions classify by `event.propertyName`:
  - _transform class_: `transform`, `translate`, `rotate`, `scale`;
  - _paint class_: `opacity`, `color`, `background-color`,
    `border-*-color`, `text-decoration-color`, `box-shadow`;
  - _layout class_: everything else.
    CSS animations don't name their properties, so `animationstart`
    conservatively counts as all three classes for that element.
    Housekeeping: portal `childList` removals purge entries (a removed
    element fires no `transitionend`), and a once-per-second
    `getAnimations({ subtree: true })` reconciliation sweep catches anything
    events missed — it also picks up WAAPI animations, which fire no CSS
    events at all.
- **Ticking.** While the map is non-empty, register a frame callback —
  through the same listener registry `animate(ctx, fn)` uses when a
  `RendererContext` is present in `ctx`, falling back to a
  `requestAnimationFrame` loop otherwise (tests, non-XR embeds). Each
  tick:
  1. emit `{ types: Set(["animated"]), targets }` on the portal subject,
     where `targets` is the animating-element set — P1's covering rule
     scopes the fan-out;
  2. if any element is layout-class, also emit a coarse
     (`targets: null`) rect invalidation for that tick — layout is
     non-local, same rule as P1;
  3. call `interactionManager.updateIntersections()` so a control sliding
     under a stationary ray updates hover/press state.
     When the map empties, the callback unregisters. **Steady-state cost is
     exactly zero.**
- **Cache plumbing** (`cache.js`): add `"animated"` to the `MutationType`
  union; `getComputedStyleCached` and `getTransformCached` include it in
  their type filters; `getBoundingClientRectCached`/`getTextLayout` accept
  it only via the coarse layout-tick above.
- **Inline-style JS animation** (T3): add `"style"` to the observer's
  `attributeFilter`. Safe now — P1 scopes it to the mutated element's
  neighborhood, and `attributes` still never invalidates rects, consistent
  with the existing T1 contract. rAF-driven `el.style.transform = …` thus
  works through the ordinary mutation path even with no clock running.

### Tests

jsdom runs no animations, so tests drive the clock by construction:

- dispatch synthetic `TransitionEvent`/`AnimationEvent`s at elements;
  assert membership refcounts, class tallies, and that the frame callback
  registers on first entry and unregisters on last exit (stub rAF).
- tick emission: with elements A (paint) and B (layout) animating, a tick
  emits a targeted `"animated"` batch containing {A, B} and a coarse rect
  batch; with only A, no rect batch.
- removal purge and reconciliation sweep (stub `getAnimations`).
- end-to-end-ish: transition on `background-color` announced via events +
  manual style writes → material color updates each tick (harness as in
  `div.test.js`).

Manual: CSS `transition: transform .2s` on press (`[data-xr-active]`
selector) in a demo panel; a looping `@keyframes` spinner; verify frame
pacing with `renderer.info` and that idle panels register no frame
callback.

### Exit criteria

Transform/opacity/color transitions and keyframe animations visibly play
in XR; per-tick cost proportional to animating-element count; zero
listeners registered when idle.

---

## P4 — Paint-path decoupling

Two changes that make per-frame paint updates allocation-free. The second
half of this phase is superseded by P5 if P5 lands promptly — do the text
part regardless, and take the div-material part only if P5 is deferred.

### P4a — Alpha-mask text, tinted by material (do always)

**Problem** (T6): text color is baked into the raster
(`textHelpers.js` sets `fillStyle = style.color`; the material is white),
so animating `color` re-draws the canvas and re-uploads a texture every
frame.

- Split `TextRenderStyle` into raster-affecting fields (font, spacings,
  `text-transform`, decoration _presence/thickness_, shadow) and tint
  (`color`, and decoration color when it is `currentcolor`). In `text.js`,
  `textureData` depends only on the raster selector; a separate effect
  writes `material.color`/`opacity` from the tint selector.
- Raster path: when `textShadow` is `none` and the decoration color is
  `currentcolor`, draw glyphs and decorations **white**; tint via
  `material.color` (`MeshBasicMaterial` multiplies map × color — exactly
  the tint semantics needed). Otherwise (explicit shadow or decoration
  colors — rare, and rarely animated) keep today's baked-color path.
- `VisualProperties.textColor/textAlpha` already exist for the tint parse;
  reuse rather than re-parsing in `text.js`.

Tests: color-only restyle keeps the texture identity (assert same
`THREE.Texture` object) while `material.color` changes; content change
still re-rasters; baked fallback still triggers on `text-shadow`.

### P4b — Owned, mutated div materials (stopgap if P5 is deferred)

The `memoize`d `(color, opacity) → material` cache creates a new material
per _identity_, and every real style change mints a fresh `THREE.Color`
(the instance memo only preserves identity while the underlying string is
unchanged) — under animation that is a material per frame. Replace with
per-mesh owned `MeshBasicMaterial`s mutated in place
(`material.color.copy(...)`, `.opacity = …`), flipping
`transparent`/`colorWrite`/`depthWrite` (with `needsUpdate`) only when
crossing the opacity boundaries, and disposing on cleanup. Behavior parity
with the existing `colorWrite/depthWrite: opacity > 0` rule is the test.

---

## P5 — SDF rounded-rect quad

**Problem** (T6 geometry half, and half of T7): every rect-affecting change
re-triangulates a `ShapeGeometry` (the border ring especially), and each
element draws two meshes.

### Design

New `elements/sdfRect.js`:

- One shared, never-rebuilt unit quad geometry with top-left origin (the
  same convention `coverBox` uses), scaled to `(totalWidth, totalHeight, 1)`.
- A `ShaderMaterial` per element (cheap; three.js dedupes GPU programs)
  with uniforms: `uSize` (vec2), `uRadii` (vec4, per-corner),
  `uBorderWidth` (vec4, per-side), `uFillColor` (vec4),
  `uBorderColor` (vec4). Fragment shader: per-quadrant radius selection →
  rounded-box SDF for the outer edge; inner edge is the inset box with
  radii reduced by the adjacent border widths clamped at zero — matching
  `shrinkRectangle`'s degeneration behavior; fill inside the inner edge,
  border color in the ring, `fwidth`-based smoothstep antialiasing,
  `discard` where total alpha is 0 (preserving the current
  "fully-transparent fill writes neither color nor depth" rule).
- `div.js`: the two meshes collapse into one; `set("geometry", …)` and
  both `makeRectangleGeometry` calls disappear in favor of effects writing
  uniforms and scale. `renderOrder` and the ±z content steps are
  untouched. `VisualProperties.getRectangleParams` slims to the
  size/radii/border numbers the uniforms need.
- `rectangle.js` stays (tests, potential other users) but `div.js` no
  longer imports it; delete once nothing references it.

Resize, radius, border, and color changes all become uniform/scale writes —
**geometry is never rebuilt**, making P3's layout-class animation
(height/padding transitions) actually viable, bounded only by the browser's
own per-frame reflow.

Follow-ups this unlocks (each its own small change later): `box-shadow`
(outer SDF falloff), linear gradients, and `overflow: hidden` via a
clip-rect uniform — noting scroll needs a capture-phase `scroll` listener
on the container feeding rect invalidation, since scrolling emits no
mutations (P7).

### Tests

Shaders don't run under jsdom; assert the _uniforms_ — the div harness
already restyles via `setSubject`, so: border/radius/size styles map to
expected uniform values; degenerate radii clamp like `shrinkRectangle`;
transparent-fill rule preserved (uniform + material flags). Keep one
golden test comparing SDF uniforms against `makeRectangleGeometry` params
for the same style, while both exist. Visual parity check across the demo
apps before/after (screenshots in the desktop emulator).

### Exit criteria

Pixel parity (within AA) on the demo apps; element cost = 1 mesh, 0
geometry rebuilds; `renderer.info.render.calls` roughly halved on a busy
panel.

---

## P6 — Instanced panel rendering (RFC, gated)

Only after P5, and only if measurement (target headset,
`renderer.info.render.calls` on real panels) shows draw calls as the
binding constraint — the phases above already halve them.

Sketch, to be turned into its own design doc when the gate opens:

- One `InstancedMesh` per portal per elevation band; P5's uniforms become
  `InstancedBufferAttribute`s (size, radii, border widths, two colors);
  per-instance matrix from the existing object transforms.
- Instance order = DOM order = paint order, matching the physical
  `CONTENT_STEP` z-stepping, so today's `renderOrder` semantics survive
  within a band. Structural (`childList`) changes reindex the band's
  instances — an accepted panel-sized memmove on structural change; a
  free-list allocator with geometric growth handles slots.
- Hit-testing keeps per-element proxy `Object3D`s (never rendered) so the
  `InteractionManager` and event routing are untouched.
- Text initially stays per-mesh (it is not the draw-call driver at panel
  scale); a glyph-atlas (MSDF) instancing pass is a separate later RFC.

---

## P7 — Parity backlog

Independent, small; schedule opportunistically between phases:

1. ~~**Images**~~ — _done, for `<img>`_. Not a case in the portal's tag
   `switch` in the end: an `<img>` is an ordinary CSS box with a picture in
   it, so the picture became a third layer on the box's own SDF quad —
   painted between the background and the descendants, which is where CSS
   paints replaced content — rather than a second mesh with a second set of
   rounded corners to keep in step. Two rectangles say where it goes (the
   picture, and the content box that crops it, which differ whenever
   `object-fit` overflows); `objectFit.js` resolves all five fit values and
   `object-position` into them on the CPU, so a crop is a uniform write.
   Textures load through `THREE.TextureLoader`, shared by URL and
   reference-counted. `background-image` is the same machinery pointed at a
   different URL and is still to do; so are `alt` text and `srcset`
   `sizes`-driven re-selection beyond what `currentSrc` reports.
   `elements/image.js` deliberately reads padding and borders as px off the
   computed style rather than through `VisualProperties`' unit-aware getters:
   those resolve `ex`, which cannot be answered until the fonts have loaded,
   and a second reader joining that half-answered memo chain at an arbitrary
   moment — which is exactly what a picture arriving is — races the first one
   and can leave it waiting forever. Pictures announce their arrival to the
   portal on a frame rather than one at a time: each announcement re-measures
   the whole portal, the way a font arriving does, and a panel of nine icons
   was doing that nine times over for a layout that settles once. Two costs
   it did leave behind are items 8 and 9 below.
2. **Opacity inheritance** — finish `getInheritedOpacity` as a per-element
   derived chain (cheap after P1); multiplied opacity then animates through
   P3 automatically.
3. **Color parsing** — extend `parseColor` beyond `rgb()/rgba()`
   (`color(srgb …)`, `oklch(…)`): fast paths first, probe-element
   normalization (as `textHelpers.normalizeColor` already does) as the
   general fallback.
4. **`visibility`/`display` mapping** — mirror `visibility: hidden` to
   `object.visible = false` instead of relying on degenerate rects.
5. ~~**Scroll support**~~ — _done_: capture-phase `scroll` listener →
   targeted rect invalidation for the scroller's subtree, under its own
   `scroll` mutation type, plus the rounded clip boxes and the drag
   gesture. See P8 for the cost it left behind.
6. ~~**Reactive parent read**~~ — _done_: the position effect and the
   scroll gesture's ancestor walks read the cached `getParentElement`.
7. **Pseudo-elements** — `::before/::after` as extra SDF quads driven by
   `setFromElement(element, "::before")` (the parameter already exists,
   unused). Decorative use only; content text out of scope.
8. **A texture unit per box, drawn or not** — the cost images left on every
   other element. `uImage` is a `sampler2D` on the *shared* rect program, so
   three's `setValueT1` allocates a texture unit and binds its empty texture
   for every box in every portal, whether or not the branch that samples it
   is ever taken (verified in `WebGLUniforms.js`; the bind itself is cached
   by `WebGLState`, the unit allocation is not). The fix is a
   `#define USE_IMAGE` variant so a box with no picture compiles without the
   sampler at all: two programs instead of one, and a recompile when an
   element gains or loses a picture, which is rare enough to pay for.
   **Gated on measurement** — `renderer.info` on a real headset, on a panel
   of a few hundred elements, before touching it. It may well be
   unobservable next to the draw call it rides on, and a second program is
   not free either.
9. **The fit recomputed on every style sample** — `contentImage` reads
   `getComputedStyleCached`, whose `isEqual` is deliberately `() => false`,
   so every `animated` batch covering an image re-parses `object-position`
   and redoes `object-fit`'s arithmetic even when neither moved. Its own
   `isEqual` compares the result by value, so nothing downstream re-runs and
   no uniform is written — the waste is confined to the derivation. The
   remedy is the one `text.js` already applies to `renderStyle` and `tint`:
   put the raw strings behind a `selector()` so the parse gates on string
   equality. Small — a handful of parses and allocations per animating frame
   per picture — and worth doing when something else brings the file open.

---

## P8 — Scroll as an offset, not a re-measurement

> **Done**, as part of the fine-grained reactivity rewrite: `cache.js`'s
> broadcast subject + per-listener filters became `mirror.js`, a per-portal
> reactive DOM mirror (per-node signals, mutation flushes ingested inside
> one `batch()`, `oldValue`-deduplicated). Positions are stored in the
> parent's content space and clip windows in their owner's frame — both
> scroll-invariant — with each box carrying a content group translated by
> minus the scroll offset, so a scroll is one signal write and one
> translation: no rect reads, no Range measurements, regression-tested in
> `mirror.test.js` and `portal.test.js`.

**Why.** Dragging a long list drops frames, and the cost is linear in the
length of the list rather than in how much of it is on screen. A scroll
invalidates rects for the scroller's whole subtree (`affectsRect` is
`target.contains(node)`), and culling only prunes the render traversal
and the raycast set — the reactive graph keeps measuring rows nobody can
see. Measured on todo-xr's row shape (`li > span > #text`, `button >
#text`), one scroll frame, four rows visible throughout:

| rows | rect reads/frame | Range measurements/frame |
| ---- | ---------------- | ------------------------ |
| 10   | 51               | 20                       |
| 50   | 251              | 100                      |
| 100  | 501              | 200                      |
| 200  | 1001             | 400                      |

Text no longer re-measures on a scroll at all (see `affectsTextLayout`),
which removed the Range column and took the rect reads to 3 per row. The
rest is this phase.

**The observation to build on.** A scroll translates a subtree rigidly.
Every element in it keeps its size, and — because an element's mirrored
position is `elementRect - parentRect`, and parent and child move
together — every element also keeps its position _relative to its
parent_. The only object whose parent-relative position actually changes
is the scroller's own content child. The hundreds of rect reads per frame
recompute numbers that were already correct; what genuinely changes is
one offset, and each element's clip box, which is `clip − element origin`
in the element's own px.

**Design sketch.** Give each scroller a signal holding its current
`scrollTop`/`scrollLeft`, invalidated by the `scroll` batch. Express a
descendant's client rect as its last measured _layout_ rect plus the
accumulated scroll offsets of its scrolling ancestors, so a scroll
invalidates the offsets rather than the rects. Structural mutations and
`reflow` keep re-measuring as they do now. The clip chain already derives
per level and would take its origin from the same offset.

**Exit criteria.** Rect reads per scroll frame are O(rows on screen), not
O(rows); `apps/todo-xr` holds frame rate with 500 rows in the emulator;
the existing clipping, culling and gesture tests pass unchanged; a
regression test asserts the count does not scale with list length.

**Risks.** Sub-pixel drift between a synthesized rect and what the
browser would report (mitigate: re-measure on any non-scroll batch, which
is what already happens); nested scrollers compounding offsets; a
scroll that also triggers layout (scroll-driven animations, container
queries keyed on scroll) — out of scope, and unmirrored today either way.

**Ready-to-hand brief.** `docs/freedom-scroll-offset-brief.md` states this
as a self-contained task, including how to reproduce the numbers above.

---

## Risk register

| Risk                                                                  | Phase | Mitigation                                                                                                                                                           |
| --------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:has()` breaks per-target style invalidation                         | P1    | Documented limitation + `coarseInvalidation` portal option                                                                                                           |
| Covering rule misses an exotic selector pattern                       | P1    | Rule is parent-subtree (already generous); escape hatch as above; regression = stale styling, not crash                                                              |
| `offsetParent` chain math wrong in edge layouts                       | P2    | Only the transform path uses it; fast path preserves today's behavior; pure-function tests + demo verification                                                       |
| Transition events lost (removal mid-flight, browser quirks)           | P3    | `transitioncancel` + childList purge + periodic `getAnimations` sweep; worst case is a clock that keeps ticking until the sweep, not a stuck frame                   |
| Per-frame `getComputedStyle` cost with many simultaneous animations   | P3    | Cost is per animating element and equals what the browser spends on a visible animation anyway; document "animate transform/opacity" guidance mirroring the flat web |
| SDF border geometry diverges from CSS on extreme radius/border combos | P5    | Golden tests against `shrinkRectangle` params; degeneration rule copied deliberately                                                                                 |
| `ShaderMaterial` count                                                | P5    | Programs are deduped by three; per-element material objects are small; P6 removes them entirely if it ever matters                                                   |
| Instance reindexing jank on structural change                         | P6    | Gated phase; band-local reindex; measure before building                                                                                                             |

## Note: the emulator smoke test, now written

The end-to-end check that caught what jsdom structurally cannot (see the
P1–P5 PR) lives in `apps/showcase/tests` — `npm run test:visual`. It
serves the showcase with Vite, opens it in headless Playwright Chromium
(SwiftShader WebGL, the pre-installed browser), enters the emulated
immersive session through IWER, and photographs the scene. The three
assertions this note asked for are there — a baseline comparison, a visible
rotation after writing an inline `style.transform` into the portal's DOM,
and two frames of a running animation differing — alongside two that need
no baseline at all: that the panels are drawn, and that they wear the
colours their stylesheets asked for, which is the untinted-text regression
stated directly.

The two decisions it was waiting on came out like this. *Noise*: the scene
is frozen — every animation frame reports the same timestamp, and every CSS
and WAAPI animation is paused at the same point on its timeline — after
which photographing it twice moves exactly zero pixels, so the comparison
budget is slack rather than a measured need. *Baselines*: committed beside
the tests, filed under a fingerprint of the renderer, the font metrics and
the viewport, so more than one machine's can sit there at once. Both
historical regressions were re-introduced deliberately to confirm the suite
catches them — 1.67% and 0.94% of the frame against a 0.05% budget.

It runs on every pull request from `.github/workflows/visual.yml`, on an
ordinary shared runner, which works because the runner is also what draws
the baselines: dispatching that workflow with `record: true` redraws them
there and commits them. Under CI the check is strict — a machine with no
baseline of its own fails rather than recording one and reporting success,
because a green check that quietly declined to check is the one outcome
worth ruling out.

## Suggested landing order and verification cadence

1. **P1** (foundation, invisible to users) → full suite + hover-cost test.
2. **P2** (user-visible correctness fix) → demo app gets a transformed
   element as a permanent visual canary.
3. **P4a** (small, independent — can land any time; before P3 makes the
   color-animation demo satisfying).
4. **P3** (the feature) → add an "animated panel" demo scene: press-scale
   button, color transition, keyframe spinner; this scene becomes the
   manual regression check for everything after.
5. **P5** → pixel-parity screenshot pass over the demo apps; then the
   layout-transition demo joins the animated panel.
6. **P7** items interleaved; **P6** only on measured need.
