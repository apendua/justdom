# What a panel draws

A panel is drawn from its elements' computed style, and this page says which of it: lists and their
markers, transforms, the document's stylesheets, animation, text revealed to a cursor, the paint
order, images, gradients, clipping and scrolling, and inline SVG. Each section ends with what is
followed and what is not. [Writing CSS for a panel](/guide/panel-css) in the guide is the short
version.

## Lists

An element laid out as a list item is drawn with its marker: every `<li>` a page has not restyled, a
`<summary>` with its disclosure triangle, and anything a stylesheet gives `display: list-item`.

```css
ol.steps {
  padding-left: 1.75rem;
}

ol.steps li::marker {
  color: #007bff;
  font-weight: 600;
}
```

Followed:

- `list-style-type`: `disc`, `circle`, `square`, `disclosure-open` and `disclosure-closed` as
  glyphs; `decimal`, `decimal-leading-zero`, `lower-alpha`, `upper-alpha`, `lower-latin`,
  `upper-latin`, `lower-roman`, `upper-roman` and `lower-greek` as numbers with a full stop after
  them; a string, `list-style-type: "→ "`, as written; `none` draws nothing.
- `list-style-position`: `outside`, the default, hangs the marker in the list's padding; `inside`
  puts it at the start of the line. Either way it sits on the item's first line of text, which is
  below the top of the item when the item opens with a block that has a margin of its own.
- `direction: rtl`: the marker on the right, a number's full stop on the side of the text (`.3`) and
  a closed disclosure triangle pointing left.
- A `::marker` rule's colour and font.
- `start` and `reversed` on the `<ol>` and `value` on the item. Each item's number counts on from
  the items before it, so appending a row numbers that row alone; inserting or removing a row
  renumbers the rows after it, and a `reversed` list with no `start` renumbers every row on every
  append.
- An item that clips its overflow cuts its outside marker off. An item that is not laid out — under
  `display: none`, in a closed `<details>` — has no marker.

Not followed:

- Any other `list-style-type`, a page's own `@counter-style` included, is drawn in decimal.
- A `list-style-image` is drawn as the `list-style-type` under it.
- A `content` in a `::marker` rule.
- A string marker in right-to-left text is drawn as written, where a browser would reorder it.

Every box the portal draws keeps a small computation that asks whether it has a marker, a plain
`<div>` as much as a row; an item with no marker builds no run.

## Transforms

A CSS `transform` (with its `transform-origin`) is mirrored onto the element's object as a matrix,
not baked into its geometry, so a `transform` written by a `[data-xr-hover]` rule is a matrix write
with no re-layout and no re-rasterized text. Prefer it for motion, as on the flat web.

- 3D is real depth: `rotateY` swings half the element _behind_ its own surface, up to half its width
  deep, and the panel covers that half (see [Paint order](#paint-order)). Give anything 3D-rotated
  enough `translateZ` to keep the swing in front.
- A transformed element paints over the earlier siblings it overlaps, the way a positioned one does
  (see [Paint order](#paint-order)).
- A panel laid flat has its y axis along the surface it lies on, so a key pressed with the page's
  `translateY(3px)` slides sideways across the desk. An effect that should move toward the viewer is
  `translateZ`, whatever the page uses for the same press.
- A transformed element, and everything under it, is measured off the layout — whole-pixel offsets —
  rather than the subpixel client rects untransformed content gets, since client rects come back
  with the transform applied. Text under a transform is measured against a detached, untransformed
  copy of the box its lines are laid out in: its parent, or the nearest ancestor that does not split
  across lines (`splitsAcrossLines` in `mirror.js`). One copy serves every text measured in it until
  something it was copied from changes, so its line boxes are exact under any transform, full 3D
  rotations included, without touching the live elements or the transitions playing on them.
- A transformed element's clip box turns with it (see
  [Clipping and scrolling](#clipping-and-scrolling)).

## Stylesheets

A panel follows its document's stylesheets, not only its own elements. Rewriting a `<style>`
element's text, adding or removing a `<style>` or a `<link rel="stylesheet">`, and a `<link>`
finishing its load each restyle the panels, which is how the `className` and `stylesheet` tags in
[`justdom`](../justdom) reach a panel.

How much a change costs depends on what its rules start from:

- When every rule in the `<style>` that changed starts from a class, as `.card { … }`,
  `.card:hover > .label { … }` or a rule inside `@media` does, only the panels those classes can
  reach restyle and re-measure: a panel with an element wearing one of them, or with one worn above
  its root, or before the root or one of its ancestors among their siblings. A panel they cannot
  reach pays nothing. That is every sheet a `className` writes whose body nests no rule, and a
  `stylesheet` written from `.${CLASS_NAME}`, so a component that brings its own styles when it
  mounts, such as a keyboard opening, restyles its own panel and leaves the other panels alone.
- Any other rule (one starting from a tag, an attribute, `:root` or a descendant, a nested rule, an
  `@keyframes` or an `@font-face`) and a `<link>` restyle and re-measure every panel on the page. So
  does a rule that starts from a class but has an attribute value in its selector, as
  `.screen[data-phosphor=amber]`, since the browser hands its selector back with the value quoted,
  or a class name that needs an escape, as `.md\:flex`.

Either way, animate through an inline `style` instead of a rule, which restyles only the element it
is on.

Not followed: a change made through the CSSOM, which a mutation observer cannot see — `insertRule`,
writing to a rule's `style`, `adoptedStyleSheets`, and every rule edited, added or switched off in
the browser's developer tools. A panel keeps showing the rules it read before any of these, unless
theming mode is on.

[Theming mode](./tooling#theming-mode) follows those too, by reading the text of every rule on a
timer.

## Animation

CSS transitions, keyframe animations and Web Animations play inside a portal: while anything is
animating, the affected elements are sampled once per frame, through the same invalidation path a
mutation takes, and the moment nothing is, the sampling stops. An idle panel costs nothing. Inline
style writes from a `useFrame` loop work too, each an ordinary mutation scoped to the element it
touched.

- A panel still loading is not sampled frame by frame: its mount reads each element's style as it
  builds it, and a sample every frame would undo that reading. An animation that ends during the
  load is settled once; the first frame after the load samples every element still animating.
- The cost per frame is the flat web's own hierarchy. `transform`, `opacity` and the colours are the
  cheap tier: a style read and a matrix or material write per animating element, text included,
  since glyphs are a mask coloured by the material. `opacity` on a container costs that write for
  every box and run of text inside. A layout property — `height`, `padding`, `font-size` —
  re-measures the panel every frame; it works, so save it for moments.
- **Inside an immersive session the browser's rendering step stops**, and with it the document
  timeline's advance, the `transitionrun`, `animationstart` and `transitionend` events and `scroll`.
  An animation started in a session would never move off its first value. The portal watches a frame
  request of its own, which runs in the rendering step and nowhere else: one unanswered for longer
  than any frame could take means the step has stopped. It then finds animations by looking,
  advances each one by however much of the elapsed time the browser did not, and has every scroll it
  performs itself — the drag gesture and the `scrollable` widget's arrows alike — announce that
  scroll. Nothing here asks whether a session is presenting, which is why it behaves under an
  emulator, where the page is presenting and rendering both. `sampleRenderingUpdates(now)` and
  `isRenderingSuspended()` are that reading, exported for a scene that wants the same answer.

## Revealing text

A letter being typed out is usually a string rewritten one character per tick, each a mutation, a
measurement, a rasterization and an upload, with the layout forced into a monospace face so the
lines do not move. `makeReveal(cursor)` separates the two: the node holds the whole text from the
first frame, the browser wraps it once, and how many glyphs are drawn is answered in the fragment
shader.

```js
import { makeReveal } from "justdom-three";
// The element builders are justdom's, as they are for any panel; `$` and
// `children` here are that package's, not the ones justdom-three hands out for
// Three objects.
import { $, children, set } from "justdom";

const reveal = makeReveal(() => letter.typed.get());

dom(
  ctx,
  $("div", [
    set("className", letterSheet),
    children(
      $("p", [children(reveal.text`${letter.body}`)]),
      $("p", [set("className", signature), children(reveal.text`— ${letter.from}`)]),
    ),
  ]),
);
```

- The cursor counts _rendered_ characters — the collapsed string the glyphs were drawn from, not the
  node's data — across every node the handle owns, in document order. Zero draws nothing, anything
  past the end draws everything, and a fractional value interpolates inside one glyph's advance, so
  the same primitive serves a discrete typewriter and a smooth wipe. How fast it moves, and what it
  sounds like, is the app's. A tick costs one uniform write of four floats.
- The layout never moves, so any face, any `white-space` and any alignment work, wrapped by the
  browser.
- **It is measured per character, once**: a revealed node is measured as every text node is, and
  then once more with a range read per character, when the text is laid out and not when the cursor
  moves, on the same budgeted mount every other measurement rides. That is why it is opt-in: the
  right price for a letter and the wrong one for a label.
- **A revealed run draws itself**, one extra draw per revealed node, since a run carrying a cut of
  its own cannot be batched.
- Clipping composes with it — a revealed run inside a scroller is clipped and cut in one shader pass
  — and so does a transform: the footnote on the _Interactions_ card in
  [`apps/showcase`](https://github.com/apendua/justdom/tree/develop/apps/showcase) types itself out
  on a card that can be tilted while it runs.

Not followed:

- A line running both ways is revealed as a unit: the prefix of a line with both directions of text
  on it is not a rectangle, so the line stays hidden until the cursor is past it and is then drawn
  whole. A line running entirely right to left cuts from its right edge.
- Tight leading trims descenders until the next line catches up. Line boxes that overlap share a
  band in which the finished line's descenders and the next line's ascenders sit at the same y, and
  the cut keeps that band hidden until the next line is being typed.

## Paint order

A panel is drawn the way a page paints it.

An element that is positioned and stacked above — `position` other than `static` plus a positive
`z-index`, the same declaration the flat build needs anyway — is an overlay, a layer of its own:

```css
.menu {
  position: absolute;
  z-index: 1;
  top: 100%;
}
```

It stands `OVERLAY_LIFT` (10 px) in front of its parent's content, so that stereo reads it as
floating, and it is opaque to rays, through a blocker of its own, so the ray that lands between two
menu rows does not carry through to a panel button a few millimetres behind. Overlays stack by
nesting, not by how big the number is: a menu inside a modal is two overlays up, `z-index: 1000` is
still one.

Followed:

- A panel is a set of layers: its root, every overlay, and every element whose transform takes it
  out of its parent's plane (`getLayer` in `elevation.js`). A transformed layer sits where its
  transform puts it; nothing but an overlay is lifted.
- Within a layer, the draw order is the paint order. Every element that a page paints over a sibling
  draws after everything that sibling draws, opaque or not, so a pile of cards climbs a draw level a
  card, while a list of rows stays at one row's levels however long it is. A card that is not opaque
  shows what it covers through it, tinted, as on a page.
- The page's order: a negative `z-index` under the rest, a positive one over it, and tree order
  within each. To bring a card to the front, append it to the end of its parent again.
- Between layers, geometry decides. The panel orders its layers' planes in a tree (`layerTree.js`)
  and walks it from the viewer every frame (`layerOrder.js`): what is nearer draws over what is
  farther, and layers in one plane draw in paint order. A layer that crosses another's plane, a card
  swung about its centre, is cut there, and each piece draws on its own side.
- A panel's boxes and runs of text draw together, with one shader (`paintBatch.js`): a stretch of
  the paint order is one draw call, across layers, broken only where something draws itself (a
  picture, an `<svg>` shape, a caret, a run with its colours baked in), at a layer cut in pieces,
  and at a sixteenth size of run.
- Panels draw whole, far to near.
- Nothing writes depth but one quad over the root, drawn after everything else in the panel, so the
  panel still hides what is drawn after it.
- A ray that meets two things at one distance lands on the one drawn later. Between layers, distance
  decides.

Not followed:

- **Flow siblings are not ordered against each other.** Only an element that is positioned or
  transformed clears its siblings, and only those that are too. A box pulled over a neighbour by a
  negative margin keeps its level in the tree, and so does a positioned box over a flow sibling,
  which then draws under that sibling's descendants: the positioned box's own text can sit behind a
  child of the box it covers.
- Only the sign of `z-index` counts. Two overlays stack in tree order, whatever their numbers, and
  two layers in one plane are ordered by that sign, as siblings are. A `z-index` inside a box that
  forms no stacking context is read where the box is, not let out of it.
- A transformed element counts as covering the axis-aligned box around its corners, which can be
  more than it covers, and one whose perspective puts a corner behind the eye counts as covering
  everything. A child that overflows its parent's box does not count towards what the parent
  overlaps.
- A box anchored above a scroller that its siblings scroll in counts as covering all of them, at
  every scroll position, rather than only those passing under it now.
- A piece is cut by at most 8 planes, and one cut more often is drawn with its first 8.
- A panel draws at most 254 pieces in places of their own. The rest share one, in no order among
  them, and a layer with a piece among them is drawn whole, uncut.
- What an element covers takes in the shadow of its own text, a text child's or a field's value's,
  but not the 2 px a run's glyphs, drawn one by one, can come out wider than their box. Where they
  do, something the overhang overlaps can draw over or under it.
- Both eyes draw one order, from the midpoint between them, so a layer seen edge-on, mid-flip, can
  be in the wrong order for one eye. It is a sliver then.
- The depth quad covers the root's border box, so an overlay that hangs past the root's edge, a menu
  past the panel's, writes no depth, and what draws after the panel there, a draggable panel's
  strips included, draws over it.
- **A layer that hangs outside its panel's silhouette is drawn with that panel.** A panel placed in
  front of it hides it and takes its rays, however high the layer's `z-index`. Keep an overlay
  within the silhouette of the panel it belongs to where you can, and keep it out of the flow — a
  menu that grew the panel would re-centre it under the ray that opened it. Where an overlay has to
  overhang, the remedy is the app's placement: Euclid's toolbar sits 18 cm nearer the viewer than
  its drawing.
- A native `<select>` cannot work here: `<option>` has no CSS box, and the list the browser pops up
  is chrome. Nor can the system keyboard. Both are in [`justdom-three-ui`](../three-ui), built out
  of ordinary elements: `dropdown(props)`, whose `root` is the positioning context and `menu` the
  layer, and `keyboard(props)`.

The paint-order tooling counts what a panel draws. `bench/paintOrderCount.jsdom.mjs` counts what the
jsdom scenes in `src/test/paintOrderScenes.js` draw, and `bench/paintOrderCount.browser.mjs` counts
the same for the desk's looks, the showcase, Knights and Euclid under the emulator.
`bench/paintOrderDraws.browser.mjs` counts the draw calls a frame makes in those apps.

## Images

An `<img>` in a panel is an ordinary CSS box that happens to have a picture in it: the picture is a
layer on the same quad that draws the background and the border ring, painted between them and the
element's descendants, where CSS paints replaced content.

```css
.avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 4px solid rgb(221, 64, 104);
  object-fit: cover;
}
```

Followed:

- `border-radius` and the clip box, since it is the same distance field: that avatar is round, and a
  picture halfway out of a scroller is trimmed with the box around it.
- `object-fit` (`fill`, `contain`, `cover`, `none`, `scale-down`) and `object-position`, resolved on
  the CPU into two rectangles, so they cost a uniform write. A translucent PNG composites over the
  element's own background.
- Swapping `src`; the element's `load` event says so, so a `srcset` is followed as soon as the
  browser has resolved it. An image arriving re-measures the panel, since an `<img>` given no size
  takes the picture's; give images a size in the stylesheet to avoid that reflow.
- Textures are shared by URL and reference-counted: a hundred rows wearing one icon decode and
  upload it once. A picture whose last element lets go of it is kept idle, so one that comes back is
  drawn at once. The idle pictures are held to 16 MiB at four bytes a pixel, counting each picture's
  base level, the oldest disposed first; a picture bigger than the whole budget is disposed alone, a
  picture that failed to load is not kept, and `render` disposes the rest with its renderer. Loading
  goes through `THREE.TextureLoader` with `crossOrigin: "anonymous"`, so a cross-origin image needs
  the CORS headers any WebGL texture needs.
- An SVG picture — a URL path ending in `.svg` or `.svgz`, or an `image/svg+xml` data URL — is drawn
  on a canvas at its natural size and the canvas uploaded, since Chrome refuses to upload an SVG
  with no `width` or `height` of its own as a texture. The draw happens once per URL, never per
  frame: about 3 ms for a 256 by 208 picture and 34 ms at 1024 by 832 in Chromium on SwiftShader. An
  SVG with only a `viewBox` has the browser's default size, 150 px tall in Chrome, so give it a
  `width` and a `height` for a sharp picture; one that reports no size is drawn at 300 by 150.

Not followed:

- A picture that fails to load draws nothing at all. The element's box, border and background stay,
  but there is no `alt` text and no broken-image frame.
- An SVG behind a URL that names no such type, a blob URL or an endpoint with no extension, is
  uploaded as it came.
- A box's `background-image: url()` (see [Gradients](#gradients)).

## Gradients

A `background-image` that is a gradient is drawn, laid out the way CSS lays it out, over the
element's `background-color`:

```css
.gauge-fill {
  background: linear-gradient(90deg, #3b82f6, #ef4444);
}
.hatched {
  background: #111
    repeating-linear-gradient(45deg, transparent 0 10px, rgb(255 255 255 / 0.1) 10px 20px);
}
.badge {
  background: radial-gradient(circle at 30% 30%, #fde68a, #d97706) right 8px center / 24px 24px
    no-repeat;
}
```

It costs no draw call: a box with a gradient stays one instance in its panel's batch. The stop list
is baked, once, into a row of a texture shared by the whole page, rows are shared by content and
given back when the last box wearing them goes, and swapping gradients on hover is a lookup.

Followed:

- `linear-`, `radial-` and `conic-gradient` and their `repeating-` forms, with stops in `%`, `px` or
  angles, hard stops, double-position stops and interpolation hints.
- Interpolation in premultiplied sRGB, compositing over the background colour in sRGB, which is what
  CSS does, so a fade to `transparent` keeps its hue.
- `background-size`, `background-position`, `background-repeat` (`round` included) and
  `background-origin`.

Not followed:

- **One layer.** A background that stacks several images is drawn as its topmost gradient over its
  background colour; the others, and any `url()` image, are not drawn.
- **`background-clip`.** The background, colour and gradient alike, fills the padding box, so a
  `content-box` clip draws wider than the page does.
- **`space` repeats as `repeat`**: tiles are laid edge to edge rather than spaced out.
- **Interpolation is sRGB whatever the gradient asks for.** `in oklab` and its kin are accepted and
  ignored. A stop colour in a space browsers do not compute to `rgb()`, such as `oklch()`, makes the
  gradient unreadable and the box draws its background colour alone.
- Tile edges are antialiased like every other edge in a panel, so a `no-repeat` tile's border is a
  pixel softer than the page's.

Prefer percentage stops on anything that resizes: a `px` stop is a different fraction of the
gradient at every size, so a box animating its width bakes a new row every frame it moves.

## Clipping and scrolling

An element that hides its overflow clips what is inside it, in the scene as on the page:

```css
.list {
  height: 168px;
  overflow: hidden;
  border-radius: 16px;
}
```

Everything below such an element is confined to its padding box, corners included: a box is already
drawn as a rounded-rectangle distance field, so the window is one more call to the same function and
its edge is antialiased at any scale and under any transform. The clipping ancestors of an element
are intersected into a single box, so nesting a scroller inside a clipped panel costs nothing. The
same box trims ray hits, so the half of a button that has scrolled out of sight cannot be pressed,
and an element with nothing left showing leaves the raycast set and the render traversal entirely.

Followed:

- Who clips whom follows the page rather than the parent chain: an absolutely positioned element is
  clipped by its containing block's ancestors, not by scrollers below that block, and a
  `position: fixed` element escapes every scroller.
- A transformed element is clipped where its layout puts it, before the transform, in the frame its
  quad is drawn in, so the box turns with the element: a rotating element in a round window centred
  on it comes out as it does on the page.
- Scrolling is the ordinary DOM write, `element.scrollTop += 48`, and it costs no re-layout:
  everything inside a scroller is mirrored in coordinates a scroll cannot change, and the offset is
  one translation of the group carrying the scrolled content, so a frame of scrolling re-measures
  nothing however long the list is.

Not followed:

- Where two clip boxes cross, the corner they leave is square.
- A rotated card lying across a window's straight edge has that edge drawn turned with the card.
- An `<svg>` root has no layout offsets to read, so on a transformed chain it is still placed from
  its client rect, the transformed bounds, and its clip slides as a rotation turns.
- Layout offsets ignore scrollers between an element and its clip holder, so a turned element in a
  scrolled list under an outer clip is clipped as if the list were not scrolled. Box and clip agree,
  so nothing tears.

**To scroll by hand, take hold of the list and pull.** Holding the trigger anywhere over an element
that clips its overflow and has more inside than fits drags the content with the hand. The ray is
sampled against the list's own plane each frame rather than following hit events, so an angled,
scaled or hand-held panel needs no special case and the list keeps up with a hand that has slid off
it; let go while moving and it glides to a stop. A drag that travels more than a few px is a scroll
rather than a press, so pulling a list made of buttons does not also press the one you grabbed;
below that threshold the press is delivered as an ordinary click. A press that becomes a scroll
sends the page `pointercancel` and no `pointerup`. There is nothing to opt into: a list becomes
draggable the moment it overflows. A press on a `draggable="true"` row is the exception: it becomes
a drag and drop, as it does under a mouse, so a list made only of draggable rows is scrolled by its
gaps and its padding.

For a scrollbar's kind of control — visible, precise, resting — there is `scrollable(props)` in
[`justdom-three-ui`](../three-ui): arrows, a track and a thumb, over a viewport that hides its
overflow. It scrolls through `scrollElementBy(element, dx, dy)`, which is exported here and is the
write above plus the `scroll` event the browser will not dispatch while the session has the display.

## SVG

Inline `<svg>` is drawn through a plugin, and only through one. Drawing a shape means triangulating
it — three's `ShapePath`, the earcut triangulator and the stroker from `SVGLoader`, none of which a
panel of boxes and text has any use for — so the support lives behind a second entry point that the
main one never imports:

```js
import { render } from "justdom-three";
import { svgElements } from "justdom-three/svg";

render(Scene, { portalPlugins: [svgElements()] });
```

A single panel can carry it instead, through `dom(ctx, tree, [], { plugins: [svgElements()] })`.
Without the plugin an `<svg>` is the CSS box it also is — background, border, radius, its place in
the flow — and nothing inside it is drawn or measured. With it, the `<svg>` stays the box it was,
its shapes clipped by its own `overflow` and by every scroller above it, and what is read is the
elements' _computed_ style, not their attributes, which is what makes a class on a `<path>`, a
`[data-xr-hover]` rule on the button around an icon, `fill: currentColor` and a CSS keyframe on
`stroke-dashoffset` work:

```css
.diagram .edge {
  fill: none;
  stroke: rgb(40, 44, 58);
  stroke-width: 2;
  stroke-dasharray: 6 4; /* dashes are cut as geometry */
  stroke-linecap: round; /* and `0 6` under round caps is a dotted line */
}

.toolbar button[data-xr-hover] svg path {
  fill: white; /* restyles through the same path a hover on the button does */
}

.selection {
  stroke-dasharray: 6 4;
  animation: march 0.8s linear infinite; /* marching ants */
}
```

**Shapes.** `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`, `<polyline>` and `<polygon>` are
drawn; `<g>`, `<switch>` and an `<a>` outside a `<text>` group them. Followed:

- `fill`, `fill-opacity` and `fill-rule`; `stroke`, `stroke-opacity`, `stroke-width`,
  `stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`, `stroke-dasharray` and
  `stroke-dashoffset`; `opacity`, the group's included; `display`; `visibility`, on the shape's own
  meshes as on a box's quad, so a shape that says `visible` is drawn under a hidden `<g>`.
- `transform` and `transform-origin` on every element in the chain, the `transform` _attribute_
  included, since the browser computes it as the same property, and `transform-box: fill-box`.
  Transforms are matrices: a shape's vertices stay in its own user space and each `<g>`, nested
  `<svg>` and shape carries its own `transform` on its object, so a `transform` animated on a `<g>`
  is a matrix write per frame.
- `viewBox` and `preserveAspectRatio`, with the viewport at the `<svg>`'s content box; a nested
  `<svg>` as a viewport, clipping what spills out of it unless its `overflow` is `visible` or
  `auto`. A `<symbol>`, an `<svg>` drawn by a `<use>` and a `<marker>` clip their content to their
  viewports the same way.
- Geometry from the computed style where the browser exposes it as CSS (`cx`, `r`, `x`, `width`,
  `d`) and from the attribute otherwise, so a shape whose `d`, `points` or `fill` attribute is bound
  to data is redrawn when the data changes. A percentage in a shape's geometry is a share of the
  nearest viewport: `x`, `cx`, `x1`, `x2`, `width` and `rx` of its width, their `y` counterparts of
  its height, and a circle's `r`, the `stroke-width`, the dashes and the dash offset of its diagonal
  over √2, so `<rect width="100%" height="100%">` covers the viewport and follows it when it
  resizes.
- `revert-layer`, beside the other keywords that set nothing.
- A scale change, animated or the `<svg>` resizing, re-samples curves only when it crosses a
  half-octave, so a zoomed shape never shows its polygons and a slow zoom does not re-triangulate
  each frame.

**Images.** An `<image>` is a textured quad in its user space, under the same matrices as a shape.
The texture comes from the cache an `<img>` uses, shared by URL; `href` is read, and the legacy
`xlink:href` when there is no `href`. The box is `x`, `y`, `width` and `height`, a percentage of the
nearest viewport, a size left `auto` the picture's; the picture is fitted by `preserveAspectRatio`
(`meet`, `slice`, `none`). An `<image>` takes its place in the paint order, fades with `opacity`,
and is a ray target like a shape with a fill. Its load re-measures nothing. A picture that is itself
an SVG file is a bitmap of that file, as it is in an `<img>`.

**Markers.** `marker-start`, `marker-mid` and `marker-end` on a `<path>`, `<line>`, `<polyline>` or
`<polygon>` name a `<marker>`, and a copy of its content is drawn at each vertex, following the
marker's `viewBox`, `preserveAspectRatio`, `markerWidth`, `markerHeight`, `refX`, `refY` (with SVG
2's keywords), `markerUnits` and `orient` (`auto`, `auto-start-reverse` or an angle). Each copy is
one object carrying one matrix, drawn over the path's stroke and under whatever comes after the
path, styled by its own rules. A path hidden by `visibility` hides its markers. A marker whose
content names the same marker is drawn once.

```html
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" orient="auto">
    <path d="M0 0 L10 5 L0 10 z" />
  </marker>
</defs>
<line x1="0" y1="10" x2="40" y2="10" marker-end="url(#arrow)" />
```

**`<use>`.** A `<use>` draws a copy of the element its `href` (or `xlink:href`) names, at its `x`
and `y`. A `<symbol>` is a viewport: its `viewBox` is fitted into the `<use>`'s `width` and
`height`, or the symbol's own, or else the whole of the nearest viewport. An `<svg>` is one in the
same way, an inline icon elsewhere on the page included, though its own `x`, `y` and `transform` are
not followed. Anything else, a `<g>` or a shape drawn once already where it stands, is drawn again
whole, its own `transform` included. The copy inherits the `<use>`'s styles, as a browser's clone
does: a sprite whose paths set no `fill` takes the `<use>`'s, `fill="currentColor"` takes the
`<use>`'s `color`, and a hidden `<use>` hides its copy. A property counts as inherited when nothing
between the copied element and the top of the copy sets it, by its attribute, its `style` or a
different computed value; `inherit`, `unset` and `revert` set nothing, and a stylesheet rule that
sets a property to exactly the value it would have inherited reads as not setting it. A new `href`
draws the target it names, and the `<use>` looks its target up again when it is restyled. A `<use>`
whose copy would draw it again stops there.

**Text.** A `<text>` is drawn, with the `<tspan>`s and `<a>`s in it. The browser lays it out: `x`,
`y`, `dx`, `dy`, `text-anchor`, the font and its spacing, a percentage being of the nearest
viewport. It is measured as HTML text under a transform is, in a detached copy with the `<text>`'s
own transform switched off, and each text node is drawn as one textured quad in its user space,
under the same matrices as a shape. Text in a font under 64 units is enlarged by a power of two for
both steps and scaled back down, since a browser snaps a small font's ascent and descent to device
pixels; the factor is at most 1024 and the measuring `<svg>` at most 2^20 px a side, so a font under
1/16 of a unit, or under 1/16384 of the viewport a percentage places it in, stays a little snapped.
The colour is `fill`, with `fill-opacity` and `opacity`, and a colour change is a uniform write. The
texture is redrawn only when the scale the matrices give it crosses a half-octave. Each run is a ray
target by its own fill, its `<tspan>`'s `pointer-events` deciding as for a shape. Text in a
`<symbol>` or a `<marker>` is drawn in each copy, taking the `<use>`'s font and fill where it sets
none.

```html
<text x="52" y="60" text-anchor="middle" fill="white">input</text>
```

**Rays.** A shape with `cursor: pointer` is a ray target of its own, by the rule a box follows, and
forwards the ray to its element exactly as a box does, with the point on the page and
`data-xr-hover` and `data-xr-active` on the element. `pointer-events` decides which of the fill and
the stroke a ray can hit, with SVG's values: `visiblePainted`, the default, hits whatever is painted
and visible, `none` lets the ray through, `fill` and `stroke` pick one region, and `all` hits a
region with no paint. The `<svg>`'s clip trims the hits as it trims the drawing. `cursor` is
inherited, so the shapes of an icon inside a `cursor: pointer` button are clickable too, and a press
on the icon is a press on the `<path>`, which bubbles to the button in the DOM and holds the button
as well; where the button should be the target itself, put `pointer-events: none` on the icon's
`<svg>`. A `<g>` under `cursor: pointer` is a ray target too, hovered and pressed with whichever of
its shapes the ray is on, so a diagram can style a node by its group:

```css
.diagram .node {
  cursor: pointer;
}

.diagram .node[data-xr-hover] rect {
  fill: #ffe9a3; /* the ray may be on the rect or on the label beside it */
}
```

**`clip-path`.** A `clip-path` is drawn when it names a `<clipPath>` that holds one `<rect>`, the
one shape the clip box a nested `<svg>` uses can hold:

```html
<defs>
  <clipPath id="frame">
    <rect width="32" height="32" />
  </clipPath>
</defs>
<image href="sheet.png" x="-64" width="256" height="128" clip-path="url(#frame)" />
```

The rect is in the user space of the element that names it, so the element's own `transform` moves
the clip with it, and a `clip-path` on a `<g>` or a `<use>` clips everything drawn under it. On a
nested `<svg>` it is in the space the `<svg>`'s `x` and `y` are in. A `<symbol>`, a `<marker>` or an
`<svg>` a `<use>` draws, with a `clip-path` of its own, clips every copy of itself. A percentage is
of the viewport around the `<clipPath>`; one defined inside a `<symbol>` or a `<marker>` resolves
against the viewport above the template. Under `clipPathUnits="objectBoundingBox"` the rect is a
share of the element's box: for a copy, the box it is drawn in; for a nested `<svg>`, its
`getBBox()` moved out past its `x`, `y` and `viewBox`; for anything else, its `getBBox()`, read
again only when the chain that reads it is read again, which for a `<g>` is when one of its children
has an attribute changed. A `transform` on the `<clipPath>` or the `<rect>` moves the rect. The clip
intersects the viewports around the element, and trims a ray as it trims the drawing. A `<clipPath>`
that is not in the document when the element is first drawn is found the next time the element's
chain is read. A `<title>`, `<desc>` or `<metadata>` beside the rect is skipped.

Not followed:

- Gradients and patterns: a `url(#…)` paint reads as `none`, though it still counts as painted for a
  ray, and one given a fallback colour, `url(#hatch) black`, is drawn in that colour. `mask`,
  filters, `<foreignObject>` and `vector-effect`.
- A `clip-path` of any shape but the rect above — a circle, a path, two shapes, a basic shape such
  as `inset()` — clips nothing, and so does a `clip-path` on an `<svg>` root as it stands on the
  page. The corners are square whatever the rect's `rx` and `ry`, and a rect turned or skewed
  anywhere on its chain clips to its bounding box, as a viewport under a rotation does.
- A `<switch>` choosing: every child is drawn where a browser draws the first that applies.
- `paint-order`: a shape is its fill and then its stroke.
- `stroke` on text, `text-shadow` on text (a run is a mask coloured by its `fill`), `<textPath>`,
  vertical writing modes, and a text node placed one character at a time (`x` or `rotate` with a
  list of values), which is drawn as one run from where its characters start. As with HTML text, a
  stylesheet rule that reaches above the `<text>` to style a `<tspan>` does not apply to the
  measured copy.
- A `<use>` target that appears only after the `<use>` mounted, such as a sprite fetched and
  injected later.
- An edit inside a `<marker>`, a `<symbol>` or a `<clipPath>` reaches every copy when the template
  is inside the panel, wherever its `<defs>` sits there; one elsewhere on the page is drawn as it
  was first read, since the portal observes only its own panel.
- Markers and the copies a `<use>` draws are not ray targets: a press on an arrowhead goes to what
  is behind it.
- A `getBBox()` read for a `clip-path` under `objectBoundingBox` forces a layout, once for each
  shape under the `<g>` it clips, and a restyle the mirror keeps to one element reads the box again
  for that child alone, so two shapes under one `clip-path` can be clipped to two boxes until the
  next attribute change on one of the `<g>`'s own children.

Three costs to know. Dashes are geometry, not a shader, for the reason `svg/dash.js` gives, so a
`stroke-dashoffset` animation rebuilds the stroke each frame — a few hundred vertices, which the
marching ants in the showcase spend without noticing. SVG text runs draw themselves, one draw each,
and are not batched with the panel's HTML text. And a shape's curves are sampled for the scale
inside the `<svg>`, not for how sharply the panel is drawn, so an icon on a panel held close can
show its polygons where the label beside it does not.
