# @apendua/freedom

A reactive Three.js scene graph, built on [`@apendua/signal`](../signal) with
the same operator vocabulary as [`@apendua/justdom`](../justdom) — `$`, `set`,
`children`, `effects`, `on` — except targeting `THREE.Object3D` instead of DOM
nodes. No VDOM, no diffing: every reactive value is wired directly to a
Three.js mutation through an RxJS subscription.

## Installation

```
npm install @apendua/freedom @apendua/signal three
```

`three` is a peer dependency.

## Usage

```js
import * as THREE from "three";
import { render, $, children, animate } from "@apendua/freedom";
import { component, just, effects, use } from "@apendua/signal";

const Scene = component((ctx) => {
  return just(new THREE.Scene()).pipe(
    children(
      $(new THREE.AmbientLight(0xffffff, 1)),
      $(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), [
        effects((cube) => {
          use(
            animate(ctx, () => {
              cube.rotation.y += 0.01;
            }),
          );
        }),
      ]),
    ),
  );
});

render(Scene).subscribe((renderer) => {
  document.body.appendChild(renderer.domElement);
});
```

`render(fn, options)` owns the `WebGLRenderer`, camera, resize handling, and
— when the device supports it — the WebXR session lifecycle. `camera(ctx)`,
`session(ctx)`, and `animate(ctx, fn)` read from that same context, using the
`createProperty`-based context mechanism shared with the rest of this
monorepo's stack.

## Pointing at things

`interactions(ctx)` gives an object the `makeInteractive()` operator, which puts
it in the raycast set and gets it pointer, select and squeeze events. It takes
an optional argument saying whether the object is pointable right now — a
boolean, a reactive getter, or an observable — so a ghost, a disabled control,
or anything else that comes and goes can leave and rejoin the raycast set
without leaving the scene:

```js
$(new THREE.Mesh(), [makeInteractive(() => props.draggable)]);
```

The manager raycasts once per controller per update to route those events, and
publishes the result:

```js
import { cursors, pointers } from "@apendua/freedom";

children(
  cursors(ctx), // a white ball, 1 cm across, on every ray hit
  cursors(ctx, { scale: 2, color: "#ff0000" }), // bigger, red
  cursors(ctx, { object: myArrow }), // one clone of your own object per hand
);
```

`cursors(ctx, options)` is the widget every XR scene ends up wanting: a mark
where the ray meets the scene, so the player can see what they are about to act
on. One appears per hand that is pointing at something interactive and goes away
with the hit. `object` is cloned rather than added, so its geometry and
materials are shared between hands; `scale` multiplies whatever scale it already
carries.

The ray each controller draws is cut at the same hit, so it stops at the
surface instead of disappearing into it, and stretches back out to a fixed
reach when the hand is pointing at nothing.

Hits are worked out once per frame, after every `animate(ctx, fn)` callback has
run and with world matrices already refreshed — the last thing before the frame
is drawn. That is what keeps the widget on the ray: cast any earlier and it
lands where the hand was pointing, and what it was pointing at, one frame ago.

`pointers(ctx)` is the data behind it — a reactive map from target ray space to
a signal holding that controller's current `THREE.Intersection`, for scenes that
want to do something else with the hit (a snapping preview, a measurement, a
sound).

## Projecting DOM into the scene

`dom(ctx, mountable$, operators)` mounts a
[`@apendua/justdom`](../justdom) component tree onto a Three.js `Group` through a
portal, so ordinary DOM-based UI (menus, HUDs, forms) can be composited
directly into a 3D or WebXR scene and still receive pointer events routed
through `interactions(ctx)`.

Two things about a portal are worth knowing before writing UI for one.

**Sizes are re-measured when the tree changes, not when an attribute does.**
The hover handlers write `data-xr-*` back onto the element they fired on, so
re-measuring the panel on every attribute mutation would mean re-laying-out
the whole thing on every twitch of the ray. A class swap restyles and
repaints; the one thing it re-measures is the mutated element's own subtree,
which is what a toggled `transform` moves (see below) — nothing outside it.
So anything that changes _layout_ — a menu opening, a section expanding —
has to be mounted and unmounted rather than hidden and shown.

**Hover and press are presentational, by contract.** The three attributes
the portal writes itself — `data-xr-hover`, `data-xr-active` and
`data-xr-checked` — restyle the panel but are declared unable to move it.
Colour, background, border colour, opacity and `transform` all work; a
width, a padding or a font size that changes under the ray is not mirrored,
and the boxes stay the size they were.

Two of the three carry a second restriction: **`data-xr-hover` and
`data-xr-active` may only style the element they match and its subtree.**

```css
.row[data-xr-hover] {
  background: #1d4ed8;
} /* fine */
.row[data-xr-hover] .label {
  color: #fff;
} /* fine — descendant */
.row[data-xr-hover] ~ .row {
  opacity: 0.5;
} /* ignored — sibling */

input[data-xr-checked] + .label {
  text-decoration: line-through;
} /* fine — checked is not restricted */
```

This is the one place a stylesheet can be written that the scene will not
follow, and it is worth the narrowness. These are the most frequent
mutations a panel ever sees — one per element the ray crosses, three more
on a press — and re-measuring on each costs a client rect for the element
plus a text measurement for every label under it, under a hand that is
moving, at frame rate. Declaring them presentational takes that to nothing.
It also gives up very little: layout that moves under the pointer slides the
target out from under the hand reaching for it, which is a thing interfaces
avoid on a flat screen and more so at the end of a metre-long ray.

Ruling out the sibling combinators buys the other half, and the reason is
the same shape. How far a change is allowed to style is how far the portal
must go looking: a rule that can restyle a sibling puts every element under
the hovered element's parent in the path of one hover, which in a list is
every row in it. A hover that can only reach its own subtree costs the row
the ray is on, whatever the list around it is doing.

That argument is one from frequency, and it does not reach `data-xr-checked`,
which is why the restriction stops at two. A box is ticked once, by a hand,
where hover is written on every element a moving ray crosses; and the flag is
written on the `<input>`, whose siblings are a label and a button rather than
a hundred rows. Narrowing it would save two elements a click, and would cost
`input:checked + label` — the idiom the flat web has always used to strike
through a completed item, and the reason the flag exists at all.

`transform` is the one to reach for, exactly as on the web — it costs a
matrix write, and it is mirrored on hover like anything else:

```css
.button[data-xr-hover] {
  background: #1d4ed8; /* fine */
  transform: translateZ(4px) scale(1.04); /* fine */
  padding: 12px; /* ignored — this is layout */
}
```

**The panel's background is clickable, and it is the panel you should listen
to.** A ray that lands on the panel but on none of its buttons hits the blocker
spanning the container, which dispatches a bubbling `click` on the portal's
root element. That is what "clicked outside" means to a menu that wants to
close itself; there is no other way for the tree inside to learn it happened.

Listen for it on the panel rather than on the document, via
`getPortalRoot(node)`:

```js
const scope = getPortalRoot(root) ?? document;
scope.addEventListener("click", onClickElsewhere);
```

A `document` listener also hears every real mouse click on the page around the
scene — the VR button, and in development an emulator whose every control is a
mouse click. A menu listening there closes itself the moment you reach for the
control that was going to choose from it, which looks exactly like the ray
having no effect. `getPortalRoot` returns null off a portal, where `document`
is the right answer and there is nothing to disambiguate.

A panel with nothing to press can say so and stop stopping rays:

```js
dom(ctx, panel, [set({ position })], { opaqueToRays: false });
```

That is for readouts rather than for controls, and mainly for the one kind of
panel that is always in the way: a head-locked overlay rides between the eye
and the whole scene, so an opaque one is a plate the player's own ray keeps
landing on. What goes is the panel's own background, and only that — a
`cursor: pointer` element inside is still a ray target, and a panel with one
in it wanted to be opaque after all.

**A panel mounts a budget per frame, behind a loading state.** Building a
mirrored element costs real work — an object, its measurements, its place in
the batches — and a list of hundreds arriving in one observer flush used to
pay all of it before the next frame could draw. The portal instead queues
what the observer reports and spends `budget` milliseconds of each frame on
it (5 by default), so however large the mount, the frame keeps its rate.

While that runs the panel is *loading*: invisible, and stopping no rays —
nothing inside it registers as a ray target until it is actually there to
press. Loading ends exactly once, when everything the initial content brought
has been built and settled; the panel appears whole rather than assembling
itself in front of the player. Later updates — rows arriving, a menu opening
— go through the same budgeted pump, but a panel that is already visible
absorbs them incrementally and never hides itself again.

```js
dom(ctx, panel, [set({ position })], {
  budget: 8, // ms of each frame spent mounting
  onLoadingChanged: (loading) => spinner.visible = loading, // fires once, with false
});
```

The budget bounds when work stops being started, not how long a piece takes:
at least one element is built and at least one update runs per frame, so a
single expensive node overshoots the budget rather than stalling the mount.
The grain is the element, not the inserted subtree — a whole panel usually
arrives as exactly one root, and a slicer that only sliced between roots
would build it whole.

**The budget is the scene's, not the panel's.** The budget guards the frame,
and the frame is shared: three panels each honouring a private five
milliseconds would cost it fifteen, and several panels mounting at once is
scene startup, not an edge case. `render()` installs one scheduler per
rendering context, and every portal under it draws frame time from the same
pool — set with `portalBudget`, a number or a getter read at the top of every
frame, so the mount-time-versus-fps trade stays a live one:

```js
render(Scene, {
  // A sliver while a hand is busy, generous otherwise; `Infinity` would
  // finish every mount in flight within the next frame.
  portalBudget: () => (interacting.get() ? 1 : 8),
});
```

What a single panel says about itself is `priority`, not milliseconds:

```js
dom(ctx, panel, [set({ position })], { priority: 1 });
```

Pumps of higher priority are offered each frame's pool before lower ones, so
a panel the player is waiting on can be told to finish first — and starving
the others meanwhile is the point, not a hazard. Within a priority the offer
rotates frame by frame, so equals share the pool and none waits forever on a
peer. A portal built outside a rendering context — a test runner, a plain
page — paces itself instead, and only there does its own `budget` option
govern. Where there are no frames to slice across — no
renderer and no `requestAnimationFrame`, as under a test runner — the portal
mounts synchronously, exactly as it always did.

**A scroll is never deferred.** Everything the offset moves — the content
group's translation, the clip boxes of the scrolled subtree, the culling at
the window's edges — is arithmetic on cached values, and all of it settles
synchronously in the event that carried the scroll, whatever the budget.
Spread over frames it would tear: the content sliding this frame, its
clipping catching up over the next several, under a hand that is still
dragging. An interaction lands whole in the frame that carries it; deferral
is for content changes, which nobody's hand is resting on.

## Checkboxes

Most elements are a box with other elements in them, which is all a portal has
to draw. A checkbox is the exception it can still mirror honestly — a box with
a mark in it — so `<input type="checkbox">` is projected as a component of its
own rather than as one more box, and the tick is drawn in the scene:

```css
.done {
  appearance: none;
  width: 1.25rem;
  height: 1.25rem;
  border: 2px solid #ccc;
  border-radius: 4px;
  background: white;
  color: white; /* the tick */
}

.done:checked,
.done[data-xr-checked] {
  background: #007bff;
  border-color: #007bff;
}
```

Everything but the tick comes from the same declarations any other box is drawn
from; the tick is drawn in the element's own `color`, the nearest thing CSS has
to naming it. `appearance: none` is implied in a scene — there is no native
look to keep — and writing it out is what the flat build needs to match.

Two things differ from an ordinary box. A checkbox is a ray target without
asking for one, because a control is there to be operated; `cursor: pointer` is
still worth writing for the page, and a disabled checkbox is not pointable
however it is dressed. And the ticked state is written back onto the element as
`data-xr-checked`: `:checked` is a pseudo-class, so it changes no attribute, and
without something that does, nothing would tell the portal to re-read a style
that follows it. Write the rule both ways, as above — and, being one of the
portal's own flags, it carries the same presentational contract `data-xr-hover`
does: a ticked box may change colour, but may not change size. It does _not_
carry hover's other restriction: a tick may style the element beside it, so
`input[data-xr-checked] + .label` works and is the form to reach for.

The DOM stays the thing that is true. A ray's click is a click, so the browser
does the toggling and fires `change`, and an application reads `checked` and
listens for `change` exactly as it would on a page — including
`set("checked", …)` from the other direction, which the scene follows.

Every other kind of `<input>` is still drawn as a plain box: a text field's
caret, a range's thumb and a number's steppers are chrome the DOM does not
describe, and there is nothing honest to mirror.

## Transforms

A CSS `transform` (with its `transform-origin`) is mirrored onto the
element's object as a matrix, not baked into its geometry — which is what
makes it the cheap way to move things: a `transform` written by a
`[data-xr-hover]` or `[data-xr-active]` rule becomes a matrix write, with no
re-layout and no re-rasterized text. Prefer it for motion, exactly as on the
flat web.

3D is real depth here, not a painted illusion: `rotateY` swings half the
element _behind_ its own surface — up to half its width deep — and the depth
buffer will honestly clip it into the panel. Give anything 3D-rotated enough
`translateZ` to keep the swing in front.

One print of the measuring tape to know about: a transformed element (and
everything under it) is measured off the layout — whole-pixel offsets —
rather than the subpixel client rects untransformed content enjoys, because
client rects come back with the transform already applied. Text under a
transform is measured against a detached, untransformed clone of its parent
instead, so its line boxes and positions are exact whatever the transform —
including full 3D rotations — without the measurement ever touching the live
elements or the transitions playing on them.

## Animation

CSS transitions, keyframe animations and Web Animations play inside a
portal: while anything is animating, the affected elements are sampled once
per frame — through the same invalidation path a mutation takes — and the
moment nothing is, the sampling stops. An idle panel costs nothing.
Inline-style writes from a frame loop work too; each one is an ordinary
mutation scoped to the element it touched. Drive that loop with
`animate(ctx, fn)` rather than with `requestAnimationFrame`, though. Once a
session has the display the page stops being rendered and the page's own
animation frames stop with it, so a `requestAnimationFrame` loop simply
stops running and whatever it was moving sits still. The session's frame
loop keeps going, and `animate` is how to draw on it. Nothing warns you:
under an emulator the page is presenting _and_ still rendering, so both work
and the difference only appears on a headset.

The cost per frame is the flat web's own hierarchy, and the guidance is the
same one every web developer already knows. `transform` and `opacity` (and
colours) are the cheap tier: a style read and a matrix or material write per
animating element. Text is no exception — glyphs are rasterized once as a
mask and coloured by the material, so animating `color` re-draws nothing.
(The mask needs one colour: text with a `text-shadow`, or a decoration
explicitly coloured something other than the text, keeps its colours baked
into the texture and pays a re-draw per change.) Animating a _layout_
property — `height`, `padding`, `font-size` — re-measures the panel every
frame, because a growing element moves neighbours no one named. It works;
save it for moments, not idle loops.

All of that holds inside an immersive session too, which takes some doing:
once the headset has the display, the page behind it stops being rendered,
and everything the browser does in its rendering step stops with it. The
document timeline no longer advances, so animations would sit frozen at the
value they had reached; the `transitionrun`/`animationstart`/`transitionend`
events are never dispatched, so nothing would say one had begun; and
`scroll` never fires either, so a dragged list would slide while its
mirrored rows stayed put. A portal notices when the document has stopped
keeping up with the frames and takes over: it finds animations by looking
rather than by being told — mutation observers are microtasks and keep
arriving, so a class swap is still a signal — advances each one by the real
time that passed, and has every scroll it performs itself — the drag gesture
and the `scrollable` widget's arrows and track alike — announce that scroll,
which the portal's listener cannot tell from the real thing. Nothing here is
switched on by asking whether a session is presenting, which is why it
behaves under an emulator, where the page is presenting and rendering both.

## Layers

An element that is positioned and stacked above — `position` other than
`static` plus a positive `z-index`, the same declaration the flat build needs
anyway — becomes a layer of its own rather than one more nested box:

```css
.menu {
  position: absolute;
  z-index: 1;
  top: 100%;
}
```

It is pushed clear of the surface it covers, so the depth buffer and stereo
both agree that it floats; its whole subtree is drawn in a band above
everything below it, however shallow the overlay itself is; and it is opaque
to rays, through a blocker of its own. That last one is the part with no
counterpart on a flat screen: without it the ray that lands between two menu
rows carries straight through the menu and hits a panel button a few
millimetres behind — not a miss, a click on something the menu is covering.

Layers stack by nesting, not by how big the number is: a menu inside a modal
is two layers up, `z-index: 1000` is still one. Keep an overlay within the
silhouette of the panel it belongs to where you can, and keep it out of the
flow — a menu that grew the panel would re-center it, sliding the whole thing
out from under the ray that opened it.

A native `<select>` cannot work here, layers or not: `<option>` has no CSS box
to mirror, and the list the browser pops up is chrome rather than DOM, so none
of it reaches the scene. `dropdown(props)` is one built out of ordinary
elements instead:

```js
dropdown({
  options: () => outputs.get().map(({ id, name }) => ({ value: id, label: name })),
  selected: () => chosen.get(),
  onSelect: (value) => chosen.set(value),
  classes: { root, trigger, caret, menu, option, optionSelected },
  placeholder: "Choose…",
});
```

Only the structure is shared: every part is dressed in a class name the caller
supplies, because a panel's dropdown has to look like that panel. Two of those
classes carry the requirements above — `root` is the positioning context
(`position: relative`), and `menu` is the layer (`position: absolute;
z-index: 1`), with `top: 100%` or `bottom: 100%` deciding which way it opens.
The menu is mounted and unmounted rather than hidden, for the re-measuring
reason above, and it closes on a click anywhere else in the panel.

`options` may be a getter, for a list that changes under the player — devices
coming and going, a document being edited — and the open menu follows it.

## Typing

The system keyboard cannot reach a panel either, and for a stronger version of
the same reason: it is not even the browser's, it is the compositor's.
`keyboard(props)` is a clickable one with a phone's layout, which is the right
one for a board you point at — four rows, no function row, no arrows, no
chording modifiers, every key either typing or changing what the board types
next:

```js
keyboard({
  classes: { root, row, key, keyActive },
  onKey: ({ key, code, shiftKey }) => {
    if (key === "Backspace") {
      text.set(text.get().slice(0, -1));
    } else if (key.length === 1) {
      text.set(text.get() + key);
    }
  },
});
```

Digits and punctuation live behind the `?123` key, exactly as they do on a
phone: pressing it turns every key's symbols face — `q` shows `1`, `a` shows
`-` — and `ABC` on the same key reads the way back. The view is sticky, unlike
shift: a view that snapped back after one character would be re-engaged for
every digit of a number. Shift flips each view's faces — `A` over `a`, `!`
over `1` — and stays one-shot, released by the key it modified, because
nobody chords on a board they have to point at. Between the two views and
shift, the whole printable ASCII set is never more than two clicks away, and
a test pins that.

A press is shaped like the `KeyboardEvent` it stands in for — `key`, `code`,
`shiftKey`, `ctrlKey`, `altKey`, `metaKey` — plus `capsLock` and `fnKey`, which
have nowhere to live on a plain object otherwise. `code` is the physical key
(`"KeyA"`, `"Space"`), and it is also on each element as `data-code`, which is
what to reach for from a test or from an app that wants to light a key up. It
names the position rather than the face: a key showing its symbols face still
reports the code it was built with, exactly as a hardware key reports where it
is and not what the layout painted on it — what it typed is in `key`.

Two things are set from the inside, because they are the layout the caller
asked for by name rather than the dressing: the root and its rows are flex
boxes, and each key gets the `flex-grow` its width unit calls for — 1 for a
letter, 1.5 for shift, 5 for the space bar, every row adding up to 10. Gaps,
corners, colours and type are yours; `key` needs a `cursor: pointer` like any
other control, or rays pass straight through the board.

The tree is built once and never changes shape — a state change moves a class
name and the text inside a key. That matters more here than anywhere else in
this README: a changed tree costs a re-measure of every box in the panel, and
the promise holds for the symbols view exactly as it holds for shift —
flipping the whole board to digits is the same keys wearing different faces,
not a different board.

`MOBILE_LAYOUT` is exported, and `layout` takes any array of rows of
`KeyboardKey`, for a numeric pad, a game's own control strip, or a board with
one key on it. A custom layout may also use the modifiers the default one
deliberately leaves out — caps lock, ctrl, alt, meta, fn — the machinery is
all still there.

## Images

An `<img>` in a panel is an ordinary CSS box that happens to have a picture in
it, and it is drawn as one: the picture is a layer on the same quad that draws
the background and the border ring, painted between them and the element's
descendants, which is where CSS paints replaced content. Nothing has to be
opted into — write the element and it appears.

```css
.avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 4px solid rgb(221, 64, 104);
  object-fit: cover;
}
```

Because it is the same distance field, the corners come free: that avatar is
round, not a square photograph behind a round frame, and a picture halfway
out of a scroller is trimmed by the same clip box that trims the box around
it. `object-fit` (`fill`, `contain`, `cover`, `none`, `scale-down`) and
`object-position` are resolved on the CPU into two rectangles — where the
picture goes and what crops it — so they cost a uniform write, and a
translucent PNG composites over the element's own background.

Textures are shared by URL and reference-counted: a list of a hundred rows
wearing the same icon decodes and uploads it once, and the last element to
let go of a picture disposes it. Loading goes through `THREE.TextureLoader`
with the usual `crossOrigin: "anonymous"`, so a cross-origin image needs the
CORS headers any WebGL texture needs. Swapping `src` swaps the picture; the
element's `load` event is what says so, which also means a `srcset` is
followed as soon as the browser has resolved it.

Two things to know. A picture that fails to load draws nothing at all — the
element's own box, border and background stay, but there is no `alt` text and
no broken-image frame, neither of which has a CSS box to mirror. And an image
arriving re-measures the panel, because an `<img>` given no size of its own
takes the one the picture turned out to have; giving images an explicit size
in the stylesheet avoids that reflow, exactly as it avoids the flash on a
flat page.

## Clipping and scrolling

An element that hides its overflow clips what is inside it, in the scene as on
the page:

```css
.list {
  height: 168px;
  overflow: hidden;
  border-radius: 16px;
}
```

Everything below such an element is confined to its padding box, corners
included: a box is already drawn as a rounded-rectangle distance field, so the
window is one more call to the same function and its edge is antialiased at any
scale and under any transform. The clipping ancestors of an element are
intersected into a single box before that — nesting a scroller inside a clipped
panel costs nothing, because the intersection of two axis-aligned rectangles is
another one. Where two of them cross, the corner they leave is square.

The same box also trims ray hits, so the half of a button that has scrolled out
of sight cannot be pressed, and an element with nothing left showing leaves the
raycast set and the render traversal entirely, taking its subtree with it.

Who clips whom follows the page rather than the parent chain: an absolutely
positioned element is clipped by its containing block's ancestors, not by
scrollers below that block — which is how a dropdown anchored outside a list
stays whole while its trigger row scrolls away — and a `position: fixed`
element escapes every scroller there is.

Scrolling is then the ordinary DOM thing to ask for:

```js
element.scrollTop += 48;
```

What it costs is not the ordinary re-layout, though. Everything inside a
scroller is mirrored in coordinates a scroll cannot change — positions
relative to the scroller's content, clip windows relative to the box that
owns them — and the offset itself is applied as one translation of the
group carrying the scrolled content. A frame of scrolling therefore
re-measures nothing and re-rasterizes nothing, however long the list is:
the clip boxes of the subtree shift by plain arithmetic, and rows crossing
the window's edge enter and leave the raycast set as they go.

**To scroll by hand, take hold of the list and pull.** Holding the trigger
anywhere over an element that clips its overflow and has more inside than fits
drags the content with the hand. The ray is sampled against the list's own
plane each frame rather than following hit events, so an angled, scaled or
hand-held panel needs no special case and the list keeps up with a hand that
has slid off it entirely; let go while moving and it glides to a stop. A drag
that travels more than a few px is a scroll rather than a press, so pulling a
list made of buttons does not also press the one you grabbed — the same
bargain a touchscreen strikes; below that threshold the press is delivered as
an ordinary click. There is nothing to opt into: a list becomes draggable the
moment it overflows, and stops being so when it no longer does.

For a scrollbar's kind of control — visible, precise, resting — there is
`scrollable(props)`, which supplies arrows, a track and a thumb, built out of
ordinary elements like the dropdown:

```js
scrollable({
  classes: { root, viewport, bar, button, track, thumb, page },
  content: [$("ul", [...])],
  step: 48,
});
```

`viewport` is the window and must hide its overflow; `bar` holds an arrow at
each end of a `track`, with a `thumb` saying how much of the content is showing
and where. An arrow moves `step` px and keeps moving while it is held; the free
track above and below the thumb — the optional `page` class — jumps a window at
a time. The bar is mounted only while there is something to scroll. Make it
chunky: a ray is a blunter instrument than a mouse.

One print of the measuring tape: the clip is placed from the element's client
rect, which is exact for untransformed and translated content, and falls back
to transformed bounds for anything rotated or scaled inside a scroller.

## Placing a panel

Everything a portal draws composes its local matrix once, in the effect that
placed it, rather than being recomposed every frame on the chance it moved —
which is most of what makes an idle panel cheap, and is exactly the premise
of the mirror restated in the scene graph.

You do not have to do anything to get that. Place the panel however you like:

```js
$(new THREE.Group(), [
  effects((group) => {
    group.position.set(0, 1, -2);
    group.scale.setScalar(0.01);
  }),
  children(dom(ctx, App(ctx))),
]);
```

It is worth knowing why that is worth saying. three propagates a recompute
downwards: an object that recomposed its own matrix marks its world matrix
stale, and every descendant then recomputes its own world matrix — not
because any of them moved, but because an ancestor might have. A group left
on three's defaults, positioned once and never touched again, is still
recomposed on every frame, so a panel below it would be handed back all the
work it had just opted out of, and the same is true of every ancestor up to
the scene root. A portal declines that at its own perimeter instead: it
recomputes its own world matrix each pass and passes the recompute on only
when that matrix actually came out different. Panels that are not moving cost
a matrix multiply; panels that are moving cost what they always did.

`place` and `placeAndScale` are exported for scenes that want the same
treatment for their own static objects:

```js
import { place, placeAndScale } from "@apendua/freedom";

placeAndScale(group, 0, 1, -2, 0.01, 0.01, 0.01);
```

Both take the object first and commit its matrix for you; moving something
and committing the move are deliberately one call rather than two, because a
bare `position.set` on such an object would leave it wherever it last was.
Set a rotation before the call if you need one — they compose from position,
quaternion and scale, so an Euler written just beforehand is picked up.

One print of the measuring tape, on a static panel of 800 mirrored rows at
8816 scene objects, timing only the world-matrix passes:

| scene above the panel | perimeter | matrix phase |
| --- | --- | --- |
| three's defaults | none | 10.0 ms/frame |
| every ancestor placed | none | 3.6 ms/frame |
| three's defaults | declines the recompute | 3.6 ms/frame |

## Real examples

This package drives several full apps in this monorepo —
[`apps/rubik`](../../apps/rubik), [`apps/blockout-xr`](../../apps/blockout-xr),
[`apps/marblerun`](../../apps/marblerun),
[`apps/todo-xr`](../../apps/todo-xr) — worth reading for realistic scenes
combining lighting, keyed lists (`list`/`keyedList`), controller/hand input,
and DOM panels projected into 3D space.
[`apps/showcase-xr`](../../apps/showcase-xr) is the sampler: four panels in a
grid demonstrating hover/press transitions, CSS keyframes, a Web Animations
API animation, an `animate(ctx, fn)` loop writing inline styles, animated
text colour, static transforms, a layout-tier width transition, and every
`object-fit` an image can be drawn with.

## License

MIT — see [LICENSE](../../LICENSE).
