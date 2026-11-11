# `justdom-three`: SVG in a portal — implementation plan

Inline `<svg>` is the one kind of content a page uses for diagrams, icons and arrows, and until now
a portal drew none of it: an `<svg>` element was a CSS box like any other (its background and border
came through) and every shape inside it was projected as a box too — a transparent one, measured and
placed and never seen. This plan is what it takes to draw the shapes, in what order, and what each
step deliberately leaves out.

Two constraints shape everything below.

**It is a plugin.** Triangulating a path means three's shape subtree — `ShapePath`, the curves, the
earcut triangulator — and the stroker in `SVGLoader`, some 30 kB minified on top of what a portal
already costs. `checkbox.js` went to some trouble to keep exactly that out of every bundle with a
portal in it, and most panels never carry an SVG. So the mirror grows a small seam — a list of
_element plugins_ asked before the built-in dispatch — and the SVG support lives behind a second
entry point, `justdom-three/svg`, that nothing in the main entry imports. A scene registers it once;
a scene that does not pays nothing, and an `<svg>` in such a scene is its CSS box and nothing inside
it.

**The DOM stays the source of truth, styles included.** Nothing here parses an SVG file. The shapes
are live elements in the page, styled by the page's stylesheets, and what the plugin reads is their
_computed_ style: `fill`, `stroke`, `stroke-width`, `stroke-dasharray`, `opacity`, `transform` and
the rest — which is what makes a class swap, a `[data-xr-hover]` rule on the button around an icon,
or a CSS keyframe on `stroke-dashoffset` reach the scene through the same invalidation path every
other style does.

| Phase | Deliverable                                                   | Size | Status                                                              |
| ----- | ------------------------------------------------------------- | ---- | ------------------------------------------------------------------- |
| S1    | Plugin seam; shapes with fill, stroke, dashes; showcase panel | L    | **shipped**                                                         |
| S2a   | `<image>` inside inline SVG                                   | S    | **done**                                                            |
| S4a   | The matrix-aware clip patch, everything still at identity     | S    | **done**                                                            |
| S4b   | Transforms as matrices, not baked vertices                    | M    | **done**                                                            |
| S2b   | Markers (arrowheads), `<use>`/`<symbol>`, nested `<svg>` clip | M    | **done**                                                            |
| S3    | Shapes as ray targets: hover, press and click on a `<path>`   | M    | **done**                                                            |
| S5    | `<text>` inside SVG                                           | M    | **done**                                                            |
| S6    | Gradients, `clip-path`, `mask`, `vector-effect`, own stroker  | S–M  | gradients, patterns and a rect `clip-path` done; the rest as needed |

The order was revised in review of the first step: S4 goes before markers and `<use>`, because a
marker is a prefix matrix and a `<use>` is one geometry under a translation — on baked vertices
every instance would be re-triangulated and the composition code rewritten when S4 landed — and
because S4 is also what stops a root resize (a `width` transition on the `<svg>`) from rebuilding
every shape per frame. `<image>` goes first because it is small and depends on nothing. S4 lands in
two steps so the visual suite can confirm the clip change moved nothing before shapes get matrices.

A note on testing that applies throughout: the unit suite runs under jsdom, which computes styles
but lays nothing out and knows no SVG geometry — `getBBox`, `getCTM` and `getTotalLength` do not
exist there. Every phase keeps its arithmetic in pure functions (viewport matrices, dash splitting,
point transforms) so the maths is unit-tested, keeps the DOM-facing code readable from attributes as
well as computed style so it can be exercised under jsdom, and reserves the question "does it
appear" for the showcase's visual suite, which photographs the scene in a real browser.

---

## S1 — Plugin seam, shapes, dashes _(shipped)_

### The seam

- **`elements/plugins.js`** — `PortalPlugin`: an object with one method, `element(ctx, element)`,
  returning a `Subscribable<Object3D>` for an element it claims and `null` for one it does not.
  `PortalPluginsContext` carries the list; `render()` takes `portalPlugins` and sets it, and
  `PortalOptions.plugins` prepends per portal, for a panel that wants something the rest of the
  scene does not.
- **`portalNodes.js`** — `createObjectForNode` asks the plugins first, in order, before its own
  `switch`. An element in the SVG namespace that no plugin claims produces no object, and neither
  does anything under it (the walk stops at a node with no object), nor a text node whose parent is
  an SVG element. The `<svg>` root is the exception: it is a real CSS box and stays one, plugin or
  not.
- **`render.js`** — `RenderOptions.portalPlugins`.

### The plugin: `justdom-three/svg`

`svgElements()` returns the plugin. What it claims and how:

- **`<svg>`** — `box(ctx, element)` from `div.js`, unchanged: background, border, radii, its place
  in the flow, its clip chain, `cursor: pointer`. Its shapes attach to its content group like any
  children.
- **`<g>`** — a bare `Object3D`, so the object tree keeps the DOM's shape.
- **`<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`, `<polyline>`, `<polygon>`** —
  `shape(ctx, element)`: an `Object3D` carrying up to two meshes, fill and stroke, each a
  `MeshBasicMaterial` with the portal's clip patch (`applyClip`), two-sided, single-pass, no depth
  write — the same terms as the checkbox's tick.
- Anything else in the namespace (`<text>`, `<defs>`, `<use>`, `<marker>`, `<foreignObject>`, …) is
  declined and so skipped by the seam.

**Geometry is read, not parsed from a file.** The shape's own geometry comes from computed style
where the browser exposes it as CSS (`cx`, `r`, `x`, `width`, `d` as `path("…")` in Chromium) and
from the attribute otherwise — the computed style is read either way, because it is the dependency
that re-runs the read when an attribute changes. A `<path>`'s `d` is handed to `SVGLoader.parse` as
a one-element document, which yields a `ShapePath` in user space; that reuses three's `d` parser and
arc handling without re-implementing either, and the result is cached by `d`. Every other shape is
built into a `ShapePath` directly (`buildShapePath`), with the same curves the loader's own
`parseRectNode`, `parseCircleNode` and the rest build, so a rect, a circle, an ellipse, a line, a
polyline or a polygon whose numbers change every frame is a few curves a frame and not a document. A
`points` list is read by SVG's grammar (`parsePoints`), where the loader shifts the pairs of a list
written `0, 0 10, 0`. A `<path>` whose `d` changes every frame still parses a document every frame,
and each new `d` takes a place in the cache: Euclid's polygon tool draws one, so dragging a
polygon's vertex is not covered. Nothing about the element's styling goes through the loader.

**Transforms were baked in S1** (S4 moved them onto matrices, below). Each shape computed the matrix
from its user space to the `<svg>`'s border-box frame: the viewport transform (`viewBox`,
`preserveAspectRatio`, the content box, offset by border and padding), then each ancestor's computed
`transform` about its `transform-origin`, then its own — the same matrix Chromium's `getCTM()`
returns, but derived from computed styles so it is reactive. Vertices are transformed on the CPU
into the `<svg>` frame, which is what lets the existing clip patch (whose varying is mesh-local
`position.xy`) and the existing render-order rules apply unchanged. The cost is that a transform
animation on a `<g>` rewrites its descendants' vertex buffers every frame; S4 replaces this with
matrices.

**Strokes** are `SVGLoader.pointsToStrokeWithBuffers` over each subpath's sampled points, in user
space, with `stroke-width`, `stroke-linejoin`, `stroke-linecap` and `stroke-miterlimit` from
computed style; the buffers are transformed afterwards, so a non-uniform `viewBox` scale stretches
the stroke the way the browser does. Curves are sampled at a density that follows the matrix's
scale, so an icon scaled up eight times does not show its polygons.

**Dashes** are geometry: `stroke-dasharray` and `stroke-dashoffset` split each subpath's points into
runs along its arc length (`dashRuns` in `svg/dash.js`, pure), and each run is stroked with the
element's caps. A zero-length dash under `round` or `square` caps becomes a dot, which is what a
dotted line is. The stroker's `u` coordinate is per point rather than per unit length, so a shader
dash was not an option without writing a stroker; a `stroke-dashoffset` animation therefore rebuilds
the stroke each frame. A few hundred vertices, so cheap enough for the marching ants a diagram
wants, and something S4's matrices do not change.

**Paint.** `fill`, `fill-opacity`, `fill-rule`, `stroke`, `stroke-opacity` and `opacity` are read
into the materials in an effect of their own, so a colour animation is a uniform write and rebuilds
nothing. `fill: none` and `stroke: none` drop the mesh. `visibility: hidden` hides; `display: none`
draws nothing. In S1 a `url(#…)` paint was treated as `none`, or as its fallback colour when it
named one (`url(#hatch) black`). A gradient or a pattern is drawn now (S6), and the fallback is for
a reference to nothing a paint server can be.

**Draw order.** Every shape in one `<svg>` gets the `<svg>`'s content render order plus a fraction
from its place in the root's document order — fill, then stroke, then the next shape — kept inside
the first half of the root's own step, below the boxes drawn at the root's content level, which draw
half a step up (`BOX_BUCKET_BIAS`). A slot that took the whole step drew Night Ops' "deploy!" after
the box in front of it. The first cut relied on three's sort falling through to mesh id, which is
document order for the initial build only: a fill switched on by a hover, or a shape inserted before
its siblings, jumped the stack. The order is one computation per root (`getPaintOrder`) that follows
the mirror's child-list signals, so a `<g>` reorder is a render-order write, not a rebuild.

### Supporting changes

- **`animationClock.js`** — the clock only followed `HTMLElement` targets; an animating `<path>` was
  invisible to it. It now follows any element, and classifies the SVG paint properties (`fill`,
  `stroke`, `stroke-dashoffset`, `d`, `r`, …) as _paint_, so a marching-ants animation re-reads one
  element's style per frame rather than re-measuring the panel.
- **`mirror/geometryReads.js`, `cssTransform.js`** — the transformed-chain measurement used
  `offsetWidth`/`offsetLeft`, which an `<svg>` root does not have; it now falls back to
  `clientWidth` plus borders and to client-rect deltas.

### Showcase

The showcase gained a fifth panel, _Vectors_, centred between the four (in `apps/showcase` it is now
one panel of a deck, `SvgPanel.ts`, with _SVG paint_ beside it for S6): a diagram of boxes joined by
dashed and dotted arrows with polygon heads, a row of icons drawn through a `viewBox` at three
sizes, a rotated `<g>`, strokes with each `linecap`/`linejoin`, an animated `stroke-dashoffset` and
a stroke whose colour is animated by CSS keyframes — every mechanism S1 supports, in one photograph.
The visual suite also counts pixels of a colour only the SVG panel uses, a check that means the same
thing on any machine.

### Left out of S1, on purpose

Markers, `<use>`, `<image>`, `<text>`, gradients, `clip-path`, `mask`, filters,
`vector-effect: non-scaling-stroke`, `paint-order`, `pointer-events` and hit-testing on shapes,
`transform-box: fill-box`, percentage lengths in geometry, nested `<svg>` clipping to its own
viewport. `visibility` was left out too, because the portal's container was `visibility: hidden` and
every element inherited it. The base package has since hidden the container off-screen instead and
made boxes follow `visibility` on their own quads, and shapes now follow it the same way: the
shape's meshes go, its object stays, and a shape that says `visible` is drawn under a hidden `<g>`.
S3 has since added `pointer-events` and hit-testing. Item 5 of
[the architecture plan](https://github.com/apendua/apendua.dev/blob/develop/docs/freedom-architecture-plan.md)
in the apendua.dev repository (apendua.dev#525) added percentage lengths in a shape's geometry and
its stroke. Gradients and patterns came with S6, and so did a rectangular `clip-path`.
`site/api/three/css.md`, under _SVG_, is the current list of what is followed and what is not.

---

## S2a — `<image>` inside inline SVG _(done)_

The plugin claims `<image>` and builds a third kind of node beside `group` and `shape`: one textured
quad in the element's user space.

- The texture comes from `acquireImage(url)` in `image.js`, already shared by URL and
  reference-counted; `href` and the legacy `xlink:href` are read as attributes, since neither is a
  CSS property.
- Its box is `x`, `y`, `width`, `height` in user space (computed style where exposed, attribute
  otherwise); a missing size takes the picture's intrinsic size, which the image entry reports once
  loaded. `preserveAspectRatio` places the picture by the `meet`, `slice` and alignment rules of a
  `viewBox`.
- Placement is the shape's, now that S4b is in: the quad is in user space under its object's
  `localMatrix`, and tells the clip patch its chain's matrix. Under a rotation the quad rotates with
  it, which a bitmap in a box cannot.
- Painting is a `MeshBasicMaterial` with `map`, the clip patch, `opacity`, sRGB colour space and
  premultiplied alpha as the image module sets them; the `slice` crop reuses the image clip the rect
  shader already takes.
- An `<image>` whose `href` is an SVG file is a bitmap of that file, exactly as `<img>` is.
- A load re-lays nothing out: an `<image>` has no effect on the HTML flow, so the portal's `load`
  listener, which announces a layout change for an `<img>`, ignores SVG images — one namespace test
  — or a dense diagram would re-measure the panel per picture.

Tests: the fit arithmetic, pure; the node itself gets the same jsdom treatment as `shape`, with a
stubbed image entry; one visual specimen in the showcase panel.

As built, the node is `image()` in `svg/image.js`, and four things differ from the list above.

The quad is not a shared unit quad scaled into place. `buildImageGeometry` makes a `BufferGeometry`
per picture with its corners and texture coordinates baked in, rebuilt when the placement changes.

The `slice` crop is that geometry, not a shader term. `placeImage` cuts the part of the fitted
picture that overhangs the box off the quad and moves the texture coordinates in to match, so the
material is a plain `MeshBasicMaterial` with a `map` and the clip patch. It is one material for the
life of the node, and a new picture is a new `map` on it. The image module sets no premultiplied
alpha, so there was none to copy.

The fit is not `fitImage`'s. SVG places a picture as though it were a `viewBox` of its intrinsic
size, so `placeImage` fits it with `viewportMatrix`, the arithmetic that fits the root's `viewBox`.
A second copy of the alignment keywords would let the root and its pictures drift apart. A
percentage `x`, `y`, `width` or `height` is of the nearest viewport, through `viewportSize` in
`svg/shape.js`.

An `<image>` is also a ray target, which the list did not ask for. It takes its place in the paint
order among the shapes, so it had to agree with them about rays too. Its area counts as a fill that
is always painted, and `pointer-events` and `cursor: pointer` work on it as they do on a shape. The
paint order, the clip uniforms and the ray-target effect are the ones in `svg/shape.js`, exported
rather than copied.

## S4 — Transforms as matrices _(done)_

Two steps, so the second is a change the visual suite can vouch for. As built: S4a left the showcase
photograph byte-identical; S4b moved eleven pixels of antialiasing on the smallest icon's ring,
where the sampling ladder now rounds up.

**S4a — the clip follows a matrix.** The clip patch (`applyClip`) tests `position.xy` in mesh-local
space against a box in the element's frame. Replace it with one patch, not two: a per-material
`clipMatrix` uniform (mesh-local to clip-frame, the identity for every box and text run today),
applied in the vertex shader to produce the clip varying, under a new `customProgramCacheKey`. Every
shape already owns its materials, so the uniform costs nothing, and the same patch serves `<text>`
in S5 and any transformed box later. Land it with every mesh still at identity: the showcase
baselines must not move by a pixel.

**S4b — shapes get matrices.** Keep each shape's geometry in its own user space and put the
transforms on the scene graph, as boxes do with CSS transforms through `composeTransform`:

- the `<svg>` root's content group carries the viewport matrix (viewBox, aspect, border and padding
  offset);
- each `<g>` and each shape object carries its own computed `transform` about its
  `transform-origin`, committed as a local matrix, composed by three's world-matrix walk;
- each shape writes its `clipMatrix` uniform — the composition of every matrix from its user space
  up to the root's frame, which is where the clip box is — when its chain changes;
- a `transform` animation on a `<g>` is then a matrix write per frame and its descendants' buffers
  never change; the chain walk survives only for the composed scale (sampling density, on a stepped
  ladder so a scale animation does not re-triangulate) and the opacity product;
- stroke width under a non-uniform `viewBox` scale is applied by the matrix, which is what the
  browser does too;
- `clipRaycast` (S3) reads the root's clip box through the same `clipMatrix` the shader does (see S3
  as built).

As built: the content group's matrix is `box()`'s new `contentMatrix` option, with the scroll
applied on top; `localMatrix` and `rootMatrix` in `svg/shape.js` are what the objects carry, and the
chain walk composes the same two functions, so the clip matrix and three's world matrix cannot
disagree. The ladder is `samplingScale` in `svg/geometry.js`: half-octave rungs, rounded up. The
showcase's star spins on a CSS animation on its `<g>`.

Dashes are unchanged by S4: they are cut as geometry, so a `stroke-dashoffset` animation rebuilds
the stroke either way. A shader dash needs an arc-length `u` on the stroke vertices, which three's
stroker does not write; an own stroker is the S6 item that unlocks it.

## S2b — Markers, `<use>`, nested viewports _(done)_

Arrowheads are `marker-start/mid/end` on a `<path>`, and a diagram drawn by a tool (Excalidraw,
Mermaid, draw.io) uses them rather than hand-placed polygons. A marker is a shape template in
`<defs>` instanced at a vertex with the path's direction; `<use>` is the same idea without the
direction.

- Resolve `marker-*` from computed style to the `<marker>` element by id (the `url(#id)` is in the
  same document, and `getElementById` finds it).
- For each instance: the marker's own `viewBox`/`markerWidth`/`refX` matrix, the vertex position and
  tangent (`orient="auto"`), `markerUnits`, and then the marker's children rendered through the same
  `shape()` code under a prefix matrix — an object with a matrix of its own once S4b is in, which is
  why S4 comes first.
- `<use href="#id">`: the referenced subtree drawn with `translate(x, y)` prefixed; `<symbol>` as a
  viewport. A reactive dependency on the referenced element's subtree (the mirror's
  `childList`/`self` signals) so an edited symbol updates its instances.
- A nested `<svg>` clips to its own viewport: one more `ClipBox` intersected into the shapes under
  it, in the outer `<svg>`'s frame.

Tests: marker placement arithmetic (pure), one visual specimen.

### Markers, as built

S2b lands in three pull requests, markers first. The arithmetic is in `svg/marker.js`:
`markerVertices` lists a parsed path's vertices with the direction there, adding the closing segment
three leaves implicit, and `markerMatrix` composes the marker's viewport, reference point, stroke
scale and rotation into one matrix.

The drawing is `svg/template.js`. A copy of a template's content is an `Instance`, which `shape`,
`group` and `image` take as an option. Their chain walk stops at the template and continues from the
instance's chain, and their draw order is a share of the instance's slot. A shape now has three
layers in the draw order, fill, stroke and markers, so the copies are drawn over the stroke and
under the next element. `shape` gains a `decorate` hook, through which `template.js` hangs the
copies off it, so `shape.js` imports nothing from the module that builds on it.

Several things the list above did not foresee. The portal built nothing under a `<defs>` and adopted
nothing there either, so an edit inside a `<marker>` reached no signal. It now adopts every node of
an SVG subtree no plugin drew into its mirror, without building it. Its walk reaches a `<defs>` at
the end of the panel after the paths that use it. `markers` used to adopt a `<marker>` through a
`PortalTemplatesContext` the portal handed plugins, the moment it resolved one; item 4 of that
architecture plan took that out, since a read made before the walk gets there follows the node's
adoption and is read again once it does (apendua.dev#454). A `<marker>` outside the panel is drawn
as first read, since the portal observes only its own container.

Template content is drawn but never hit: a press forwarded to an element inside a `<marker>` would
reach nothing on the page. A copy's object follows the path's `visibility`, since browsers paint no
markers on a hidden shape. Each instance carries the set of templates it is inside, so a marker
whose content names the same marker, directly or through an inherited `marker-*`, is not expanded
again. And `markerVertices` skips the near-zero line three draws before an arc, which is rounding
error and not a segment.

### `<use>` and `<symbol>`, as built

`drawUse` in `svg/template.js`. The `<use>`'s object carries its own `transform`, and one object
below it carries the move to `x`, `y` and a symbol's viewport. A `<symbol>` is an instance whose
template is the symbol, so its children are drawn, and an `<svg>` is drawn the same way, in a
viewport the `<use>` sizes, so the walk up from its content stops at it rather than at another root.
Any other element is drawn whole as an instance whose template is its parent, so the walk up from it
takes in its own `transform` and stops there. A copy takes the `<use>`'s place in the draw order,
and `use` joins the elements counted there.

Each instance also carries the size of the viewport its content is in: a symbol's or an `<svg>`'s
`viewBox` or size, a marker's, or for content drawn whole the one around the `<use>`, and where its
`viewBox` starts. `viewportSize` and `nearestViewBoxOrigin` stop at the template and take them, so
percentages inside a copy, a `<use>` nested in a symbol among them, are of the viewport the copy is
drawn in, and a `view-box` transform origin is measured from its `viewBox`.

What the list above did not foresee is inheritance. A browser draws a clone under the `<use>`, which
inherits the `<use>`'s styles; the mirror sees the original, which inherits from where it is
defined. An icon sprite whose paths set no `fill` depends on the difference. `readDrawnProperty` in
`svg/shape.js` walks from the copied element up to the top of the copy and, where no element on the
way changes the property, reads the `<use>`'s value instead. It gets one case wrong: an element that
sets a property to the value it would have inherited anyway. A marker's content does not inherit
from the path, so a marker instance has no inheritance.

A `<use>` whose copy would draw the same template again, directly or through another `<use>`, stops
there, by the set of templates each instance carries (the one markers use); one that names its own
ancestor draws nothing. What it names is read again once the portal's walk adopts it, as a marker
is, and the portal leaves alone a node it has already built, since a `<use>` may name a `<g>` drawn
where it stands; one it has adopted already it does not walk again. The `href`, and every attribute
of the target with no CSS form, is read through `getAttributeCached`, so a new `href` draws the
target it names. A target that appears after the `<use>` mounted, a sprite injected later, is not
followed: it may be anywhere on the page, where the portal hears nothing. The `<use>` looks again
when it is restyled.

`readDrawnProperty` also counts an element's attribute or `style` naming a property as setting it,
whatever the value, except `inherit`, `unset`, `revert` and `revert-layer`, which pass the walk on
to the parent. It resolves a `fill` or `stroke` of `currentColor` against the copy's `color`,
inherited from the `<use>` in turn. `visibility` goes through it too, by `isDrawnHidden`.

### Viewport clips, as built

A shape's chain gains a `clip`: what the viewports above it leave, in the root's frame, intersected
into the root's own clip box by `clipUniforms`. `readChain` collects each nested `<svg>` whose
`overflow` clips on the way up, with the matrix from the shape to that viewport's parent, and maps
it into the root's frame at the top. A marker's instance adds its box (`markerFrame`, the marker's
matrix before its `viewBox`), and a symbol's or an `<svg>` target's adds the viewport its `<use>`
gives it, so all of them clip, as the browser's stylesheet asks. The clip box is axis-aligned, so a
viewport under a rotation clips to its bounding box. `auto` does not clip, since in SVG it means
`visible`; that is why the predicate is `clipsViewport` in `svg/style.js` and not the mirror's
`clipsOverflow`. A nested `<svg>`'s clip is placed before its own `transform`, which SVG 2 allows,
so the clip moves with the content. Its size comes from `svgViewport`: `auto` is the whole viewport
around it and a percentage a share of that, and a size no viewport can measure clips nothing rather
than everything.

The clip's edge is the patch's soft one, so an arrowhead that fills its marker's box exactly loses
half a pixel at its tip: 48 pixels of the showcase photograph moved.

### Batching

Two meshes and two materials per shape is a draw per shape, where the boxes and text of the same
panel are two draws in all. Before a merged-geometry rebuild, evaluate three's `BatchedMesh`: one
draw with per-instance matrices is exactly what S4b produces. The clip is no longer per `<svg>`,
though: a marker copy, a clipped symbol and a shape under a nested viewport each carry a clip box of
their own, so a batch would need the box per instance too, or one batch per distinct box. The other
thing to check is per-instance alpha — `BatchedMesh` has per-instance colour, and whether that
carries opacity through the clip patch decides it. Measure on a real dense diagram after S4b.

## S3 — Shapes as ray targets _(done)_

An `<svg>` root with `cursor: pointer` is already a button; the shapes in it are not targets of
their own. For a diagram whose nodes are clickable, or a map, the shape has to be:

- `makeInteractive` on the shape's object when its computed `cursor` is `pointer` (the same opt-in
  as a box), gated on `isPanelReady`, and the fill mesh (or a stroke mesh when there is no fill) is
  what the ray meets. The events dispatched back to the element are `div.js`'s, factored out of
  `box()` into a shared `forwardPointerEvents(element, object)` so the two cannot drift.
- `pointer-events: none` opts a shape out; `pointer-events: stroke`/`fill` choose the mesh.
- `clipRaycast` on the meshes with the `<svg>`'s clip box, in the `<svg>` frame (`frame` argument) —
  S1's choice of frame makes this a one-liner.

As built, three things differ from the list above.

Both meshes are ray targets, as in a browser, rather than the fill with the stroke as a fallback.
`pointer-events` takes all of SVG's values, parsed by `parsePointerEvents` in `svg/style.js`. A
region that `pointer-events` lets a ray hit but that paints nothing, such as `fill: none` under
`all`, gets a mesh whose material is not drawn. The rule applies to every shape, not only a
clickable one, because a ray walks everything under a registered object. A shape under
`pointer-events: none` inside a clickable `<svg>` lets the press through, as a page does.

`forwardPointerEvents` in `elements/pointerForwarding.js` takes the portal context as well as the
element and object, since the scroll gesture it starts on a press needs it. `isClickable` moved
there with it. A press that becomes a drag had to learn to walk out of an SVG subtree: a `<g>` has
no content group, so the walk from the element to its scroller now asks `getParentObject` in
`elements/contentGroup.js` for each step.

After S4b the clip box and the vertices are in different frames, so `clipRaycast` gained a `matrix`
argument, and each shape mesh passes its own `clipMatrix` uniform. The ray and the shader read the
same box through the same matrix.

The showcase's diagram nodes carry `cursor: pointer` and a `[data-xr-hover]` fill. The static
photograph did not move.

`cursor` is inherited, so every shape of an icon in a clickable button is clickable too, and in S3
as first built the innermost element took the press alone: `data-xr-active` landed on the `<path>`
and not the button. A follow-up made presses on nested clickable elements, boxes and shapes alike,
work as on a page. The innermost element is the target of the DOM events, sent once, and every
clickable element around it is held too.

## S5 — `<text>` _(done)_

SVG text is positioned by `x`/`y` and a baseline, not by CSS line boxes, but the browser still lays
it out: `getBoundingClientRect` on a `<text>` element returns its box, and `Range` rects work inside
it. The text module already rasterizes a run from a measured layout; what S5 adds is a layout source
for SVG text nodes (measured through the client rects, mapped through the CTM into user space or,
after S4, placed as a quad under the element's matrix), `text-anchor`, and `fill` as the text colour
instead of `color`.

### `<text>`, as built

`drawText` in `svg/text.js`, for a `<text>` and the `<tspan>`s and `<a>`s in it. The layout is the
browser's, measured the way `mirror/textLayout.js` measures HTML text under a transform: the rects
of the text in place are screen-space bounds after every matrix above, so the `<text>` is cloned
into a detached `<svg>` off-screen, with its computed style copied onto the clone and its
`transform` set to `none`, by the mirror's own `createMeasurementClone` with that `<svg>` as its
host. That `<svg>` maps one user unit to one CSS pixel, and where an attribute is a percentage its
`viewBox` is the viewport the text is in, so a Range rect per text node, read relative to it, is
already in the `<text>`'s user space. The rects are read through the mirror's one shared range
(`withMeasuringRange`). There is no CTM to undo, and no matrix is involved in the measurement at
all: the text's own matrix and everything above it are its object's and its chain's, as for a shape.

Each text node is a run, one textured quad under the `<text>`'s object, rasterized by
`generateTextTexture` as a coverage mask. The colour is the run's `fill`, read through
`readDrawnProperty`, times `fill-opacity` and the chain's opacity, on the material, so a colour
change does not redraw. The texture is drawn at the chain's scale in half-octave steps, as a shape's
curves are sampled; `generateTextTexture` caps the panel's part of that scale, as it does for HTML
text, and multiplies the user unit's in after the cap, since a unit in a small `viewBox` is many CSS
pixels. The runs take the `<text>`'s place in the paint order (`text` joins the counted elements),
and each is a ray target by its own fill region under its parent's `pointer-events`; `regionHits` in
`svg/shape.js` is the rule shapes and runs share. The runs are mounted by `keyedList`, keyed by text
node, so a run that moves is a geometry write, one whose characters change is a texture, and a
`<tspan>` added or taken away mounts or unmounts its own run, each for that run alone.

The measurement depends on the computed properties the layout reads, behind a gate per element so a
hover measures nothing, the attributes that place characters (through `getAttributeCached`), each
text node's characters (the new `getTextDataCached`) and `getReflowContext`, for fonts; never on a
matrix, so a transform animated above the text costs a matrix write and nothing else. The portal
builds a `<text>` before its children, and does not build them at all: a `<tspan>`, or an `<a>`
inside a `<text>`, is declined by the plugin and adopted as a template is. `drawText` reads them
while it is built, before the walk adopts them, and reads them again once it does, as `markers` and
`drawUse` read what they draw, so an edit to either reaches the measurement.

Templates come for free. The copy is measured off the page whether the original is laid out or not,
so text in a `<symbol>` or a `<marker>` is drawn in each copy, and the font properties join
`INHERITED`, so a copy takes the `<use>`'s font as it takes its fill. What is not followed: a
`stroke` on text, `<textPath>`, vertical writing, a text node whose characters are placed one at a
time (drawn as one run from its box), and, as for HTML text, a selector that reaches above the
`<text>` to style a `<tspan>` in the clone.

## S6 — Gradients, clip paths, masks

Each is a shader concern. The plan for a gradient was a small `ShaderMaterial` (or `SVGLoader`'s own
gradient texture, once it stops warning) keyed on the `<linearGradient>`'s stops, in
`objectBoundingBox` or `userSpaceOnUse` units.

As built, a linear or radial gradient and a `<pattern>` are drawn on a shape's fill and stroke.
`svg/paintServer.js` reads the server a `url(#…)` names as SVG defines it, `href` chains included.
`svg/paintShader.js` is a patch on the shape's own material, not a `ShaderMaterial`: it evaluates
the gradient per pixel from the shape's user space and reads the colour from the ramp atlas the CSS
boxes bake their stops into. A pattern is a picture of one tile (`svg/patternTile.js`), repeated by
the same patch. Neither is drawn on text.

`clip-path: url(#id)` referring to a `<clipPath>` of shapes is a stencil or a second SDF. A
rectangular one is the existing clip box, and is drawn: a `<clipPath>` holding one `<rect>` joins
the viewports `readChain` in `svg/shape.js` intersects, a turned rect as its bounding box (item 5 of
the architecture plan, apendua.dev#534). `mask` is a render target. `mask`, filters, `vector-effect`
and an own stroker are not built; each goes in when a real panel wants it.
