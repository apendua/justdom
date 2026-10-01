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
import { render, $, children, getScene, useFrame } from "@apendua/freedom";
import { effects, effectsOnly, useEffects } from "@apendua/signal";

const Scene = effectsOnly((ctx) => {
  useEffects(getScene(ctx), [
    children(
      $(new THREE.AmbientLight(0xffffff, 1)),
      $(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), [
        effects((cube) => {
          useFrame(ctx, () => {
            cube.rotation.y += 0.01;
          });
        }),
      ]),
    ),
  ]);
});

render(Scene).subscribe((renderer) => {
  document.body.appendChild(renderer.domElement);
});
```

`render(fn, options)` owns the `WebGLRenderer`, the scene, the camera, resize
handling, and — when the device supports it — the WebXR session lifecycle. The
tree it is given decorates that scene rather than producing one. `getCamera(ctx)`,
`getXRSession(ctx)`, and `useFrame(ctx, fn)` read from that same context, using the
`createProperty`-based context mechanism shared with the rest of this
monorepo's stack.

`createXRButton(renderer, options)` builds the Enter AR / Enter VR button and
sets the session up the way the scenes here expect: a `local` origin
re-anchored to the first trustworthy viewer pose, the headset's best frame
rate, no standing session offers, and a crash panel. That last one is for the
failure nobody can see: a throw out of the frame loop, an uncaught exception
or an unhandled rejection ends the session and writes the error, stack and
all, onto the page, where it can be read on the headset instead of guessed at
from a scene that has stopped moving. The frame loop reports its own failures
rather than waiting to hear about them from the window, which is the
difference between seeing a crash and not: an XR frame callback that throws
is only reported to the window if whatever drives the session says so, and
the emulator these apps are developed against catches every one of them and
writes to the console instead. The panel's Copy button puts everything it is
showing on the clipboard, so a stack read off a headset goes into a bug
report without being retyped; where the page is not allowed a clipboard the
text is selected instead. Every option has an opt-out (`anchor`,
`frameRate`, `offerSession`, `crashPanel`, `handTracking`); see the JSDoc on
`createXRButton`.

The button itself is freedom's own — `createSessionButton`, which
`createXRButton` builds on — rather than three's `ARButton` / `VRButton`. Both
of those hold the running session in a variable assigned after an `await`,
with the `end` listener installed before it, so a session that ends inside
that window leaves the page saying `STOP AR` for as long as it is open: every
later click takes the exit branch and calls `end()` on a session that is
already over. It is the same complaint `suppressSessionOffers` was written
for — a Quest that goes on behaving as though it were still in a session —
reached a second way. The element keeps three's ids and wording, so anything
selecting `#ARButton` / `#VRButton` or reading the label works unchanged; what
is different is that the session is only ever recorded synchronously, and
there are three ways back to a button you can press again. `createXRButton`
no longer needs `suppressSessionOffers`, which stays exported for a page that
mounts three's buttons itself.

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

The events are the registered object's, whichever of its meshes the ray
met. A projected button is a quad of background and a quad of text, and a
hand drifting from the one onto the other gets a `pointermove`, not a
`pointerleave` and a `pointerenter`; a press on the label released on the
background is a `select`. Every event says which `controller` it came from
and which `inputSource` three connected to it, so what is pointed at can
reach the hand's gamepad. A pointer event's is null until something
connects, which is a controller under a test. A pointer event also names
the registered object its hit belongs to, as `registeredTarget`, since
`originalTarget` is the mesh and `target` is, as three's dispatcher writes
it, the object whose listener is running; and `pointerenter` and
`pointerleave` carry `relatedTarget`, as the web's do: the registered
object the ray was on before, or is on now, or null for nothing.

**Hiding something takes it out of the raycast**, as it takes it out of the
draw: `object.visible = false` on anything — the ray target itself, a group
several levels above it, a panel the app hangs a whole card off — and nothing
under it answers a ray or takes the cursor. That matters most for what an app
cannot reach: a projected panel registers its own buttons and its own backing
plane, so dropping one flag on the group it hangs off is the way to put the
whole card away, and the way to bring it back exactly as it was. Nothing is
deregistered, so what was pointable before is pointable again.

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

Hits are worked out once per frame, after every `useFrame(ctx, fn)` callback has
run and with world matrices already refreshed — the last thing before the frame
is drawn. That is what keeps the widget on the ray: cast any earlier and it
lands where the hand was pointing, and what it was pointing at, one frame ago.

`pointers(ctx)` is the data behind it — a reactive map from target ray space to
a signal holding that controller's current `THREE.Intersection`, for scenes that
want to do something else with the hit (a snapping preview, a measurement, a
sound).

## Picking things up

`drag(ctx, options)` is the carry every scene here ends up wanting: a press on
an object picks it up, the hand's own movement is what moves it, and the
release puts it back — where it is in the room, not where it was. It hands
back two things: `draggable()`, the operator that goes in the object's list,
and `held()`, a reactive reader saying which hand has it, or null.

```js
const { draggable, held } = drag(ctx, { enabled: () => props.movable });

$(mesh, [
  makeInteractive(),
  draggable(),
  effects((o) => {
    if (!held()) {
      o.position.copy(props.position); // the props place it whenever a hand does not
    }
  }),
  on("dragmove", (event) => board.preview(event.matrixWorld)),
  on("dragend", (event) => board.drop(event.matrixWorld, event.reset)),
]);
```

The object does not know where it goes. It says where it is — `dragstart` when
it is picked up, `dragmove` once a frame while it is held, `dragend` when it is
let go, each with its world matrix — and the scene it belongs to decides what
that means: a cell to snap to, a preview to show, a drop to refuse. `dragend`
also carries `reset()`, which puts the object back at the local pose it had
before it was picked up, for a drop the scene refuses or a drag that was only
ever meant to hand out a copy. The events go to the object itself and do not
bubble.

`buttons` says which buttons pick the object up — `["select"]`, the trigger,
unless given; `["select", "squeeze"]` for a scene that means something
different by each, which the events' `button` tells apart. `enabled` gates
picking up, as a boolean, a reactive getter or an observable; a drag already
under way always runs to its release. Interactivity is separate, because an
object that can be pointed at without being carriable is common:
`makeInteractive()` goes in the same list.

Two things the bookkeeping is there for, because every scene that did it by
hand got at least one of them wrong at some point. **It remembers which hand,
not merely that it is held:** a press from the other hand while the object is
carried is a handover — the object moves to that hand and the drag carries on,
one `dragstart` and one `dragend` for the whole of it — and only the holding
hand's release, of the button it is holding with, ends the drag. **It swallows
the presses it takes:** the press that picks the object up and the release
that lets it go never reach whatever is behind, so picking up a brick never
also picks up the board it sits on. An object taken out of the scene mid-drag
leaves the hand too.

`RendererContext` is the property behind the once-a-frame `dragmove`, and
`useFrame`; it is exported so a test can mount a draggable object without a
renderer — `RendererContext.set(ctx, {})` is enough for the frame callback to
be registered and never called.

## Carrying things level

`carry(ctx, options)` is the other way of moving something with a hand: for a
board with a floor and things standing on it, which a drag would tip over. A
hand reaching out across a board rolls and pitches far more than it feels like
it does, and a board handed the wrist's whole pose arrives on its side with
everything sliding off it. So a carry keeps only what a level thing can have —
where it is, and which way round it faces — and poses the object once a frame
from where the hand has got to, rather than reparenting it.

```js
const board = carry(ctx, { enabled: () => phase.get() === "build" });

$(new THREE.Group(), [
  board.carriable(),
  children(
    $(floor, [makeInteractive(), board.handle()]), // the furniture it is carried by
    Game(ctx),
  ),
]);
```

The reference for everything is the **grab point**, the spot the ray landed on
when the trigger closed. It stays pinned to the ray, as far out along it as it
was taken hold of, so tipping the wrist tows the board where the ray now
points instead of leaving the cursor to slide across it; and the turn about
the vertical pivots the board _about the grab point_, so the spot being held
is the one spot that never moves. The maths is exported on its own — `yawOf`,
`levelPose`, `beginCarry`, `carriedPose`, `applyLevelPose` — for a scene that
wants to carry something by a rule of its own.

The presses are taken by **handles** rather than by the carried object as a
whole, so that only furniture starts a carry: a board by its floor, a tray by
its rails. A press that bubbled up from anywhere else — a panel that did not
want it, whatever sits behind one — would otherwise carry the board off, which
is a surprising thing for a board to do when the player has just pressed a
button. `handle()` listens; it does not make the object pointable, so
`makeInteractive()` goes in the same list, or the presses bubble up from parts
that already are. A scene that does want any unclaimed press to carry puts
`handle()` on the carried object itself. For furniture that is nothing but a
handle — a floor slab, a rail — `carryHandle(ctx, carried, geometry, material,
position)` is the mesh, pointable and listening, ready to be a child of the
carried group.

The bookkeeping is `drag()`'s: a press from the other hand mid-carry is a
handover, taking the grip afresh from wherever its own ray lands, and only the
carrying hand's release puts the object down; `held()` says which hand has it.
One difference: a carry that is disabled while under way is put down where it
is, since nothing was reparented and there is nothing to undo — and so is one
whose handle leaves the scene, since the release it is waiting for would go to
a handle no longer listening.

## Hands

A headset with hand tracking drives a controller slot with the hand itself
once the controllers are put down. `createXRButton` asks the session for the
`hand-tracking` feature, because without it the hand still arrives — the
runtime reports it as a pointer with a target ray and turns a pinch into
`selectstart` / `selectend`, so pointing and picking up work either way — but
nothing tells it apart from a controller: `XRInputSource.hand` is unset, no
joint is ever reported, and three's controller-model factory draws a
controller for it. With the feature, `render()` fills in a third space per
slot beside the target ray and the grip, and `controllers(ctx)` hands it out:

```js
render(Scene, {
  createControllerModel: (grip) => new XRControllerModelFactory().createControllerModel(grip),
  createHandModel: (hand) => new OculusHandModel(hand),
});

for (const handle of controllers(ctx)) {
  useEffects(handle.grip, [
    // Re-runs when the player picks the controllers up or puts them down.
    effect(() => {
      handle.tracked(); // "controller" | "hand" | null
    }),
  ]);
  useFrame(ctx, () => {
    const wrist = handle.hand.joints["wrist"]; // an Object3D per XRHandJoint
    handle.pinching(); // true while thumb and index tip are together
  });
}
```

`handle.hand` is three's `XRHandSpace`: its `joints` are the twenty-five
`XRHandJoint`s, each an `Object3D` posed in the reference space every frame
the hand is tracked, and empty while a controller is in the slot. Whatever
`createHandModel` returns is added to it, and hears the same `connected` /
`disconnected` events a controller model hears on the grip — three's
`OculusHandModel` and `XRHandModelFactory` both do. `tracked()` and
`pinching()` are reactive readers: `tracked()` says what is driving the slot
and changes only when that changes; `pinching()` is three's own measure of
the pinch (20 mm with 5 mm of hysteresis), state to read rather than input to
act on, since the runtime already turns the pinch into the select events that
`makeInteractive` listens for. The `inputSource` signal underneath is still
there for the gamepad and the handedness.

## Projecting DOM into the scene

`dom(ctx, mountable$, operators)` mounts a
[`@apendua/justdom`](../justdom) component tree onto a Three.js `Group` through a
portal, so ordinary DOM-based UI (menus, HUDs, forms) can be composited
directly into a 3D or WebXR scene and still receive pointer events routed
through `interactions(ctx)`.

An element is a ray target of its own when its computed `cursor` is
`pointer`, the signal a page uses for "clickable", and its
`pointer-events` is not `none`. A press on it arrives as
`mousedown`, `mouseup` and `click` on the element, and the element carries
`data-xr-hover` while the ray is on it and `data-xr-active` while it is held.
Clickable elements nest, if only because `cursor` is inherited, and a press
inside several of them goes where it goes on a page. The innermost one is the
target, its DOM events are sent once and bubble from there, and every
clickable element around it takes `data-xr-active` as well, as `:active`
would. The ray event stops at the outermost of them, so nothing outside the
panel hears a press the panel took.

It does that without depending on `justdom`. What `dom()` takes is a
`Mountable` — a tree that has not been put anywhere yet, exposing one method
that swaps it into a span of sibling nodes — and that type is declared here
rather than imported, so `justdom` is not a peer dependency of this package.
A justdom tree satisfies it, because the two declarations are the same shape
and TypeScript compares them structurally; so does anything else that builds
real DOM nodes and knows how to hand them over.

### Mirroring DOM the page already has

A mountable is for a panel that exists only in the scene. An app that
delivers a flat interface first, and an immersive session as something
extra, already has its DOM — laid out, styled, wired to its state — and has
no reason to build it a second time for the headset. `dom()` takes an
element as well as a tree, and mirrors it where it stands:

```js
const hud = document.getElementById("hud");

dom(ctx, hud, [set({ position })]);
```

Nothing about the element changes hands. It stays in the document, where the
page put it, with the styles the page gave it; the portal watches it with the
same observer it watches its own container with, so whatever the element
holds when the portal is built is the initial content and whatever the page
does to it afterwards — a row arriving, a class swapped, a transition
started, a list scrolled — is followed. A press on the mirrored button is a
click dispatched on the real one, so the handlers the page already has are
the handlers the scene uses, and the hover and press flags the portal writes
are taken off again with the portal. When the session ends the page is as it
was.

The element plays exactly the part the portal's own container plays, and the
one thing to know follows from that: **it is the panel's frame, and what is
drawn is what is inside it.** Its border box is the panel's size — a panel
centred on its origin, a centimetre a px, as ever — and it is what
`getPortalRoot` finds and what the background click lands on, but its own
background and border are not mirrored. A card wants to be the element's
child, not the element:

```html
<div id="hud">
  <div class="card">…</div>
</div>
```

which is where a page's mount point usually leaves things anyway. The
element has to be in the document, and the portal refuses one that is not,
one that is already a panel, one inside a panel and one with a panel inside
it, since every walk the mirror makes climbs to the nearest panel top and
stops. A portal built over such an element does not `mount()`: the page owns
the content.

**And the element has to stay laid out.** The mirror reads the browser's
layout, so an element with none has nothing to give it: `display: none`, or
taking the element out of the document, measures every box at nothing, and
the panel is an empty frame with no error to say why. A page that wants its
own view of the element out of the way while a session runs hides it with
`visibility: hidden`, which keeps the layout and is what the portal's own
container has always been, or covers it — the todo app puts the renderer's
canvas over the page for exactly as long as a session is presenting.

Which element is up to the app, and it can change: `dom()` takes a
subscribable of elements as readily as one of trees, and each emission is a
fresh portal with the previous one taken down and its element released.
`createPortal(ctx, { root: element })` is the same thing without the group,
for a scene that drives portals by hand.

A box is drawn with a border width per side but one border colour: the
colour of the first side that draws a border, in the order top, right,
bottom, left. A side with no width, or a transparent one, draws none. A
divider on one side, `border-bottom: 1px solid #eee`, is drawn in its own
colour, and so is a tab's underline under `border-top: 2px solid
transparent`. Sides bordered in different colours are drawn in the first
side's, and a dashed, dotted or double border is drawn solid.

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

**A row arriving costs the row, by the same kind of contract.** A change to
a child list moves no attribute, so the only selectors it can change the
verdict of on the rows already there are the positional ones, and the mirror
follows those exactly as far as CSS lets them look: forward from the change —
`~`, `+`, `:nth-child`, `:first-child` and their `-of-type` forms restyle the
rows after the arrival, which for a row appended at the end is the row
itself — and one element back, for `:last-child`, `:only-child` and the
`-of-type` pair, which land on whichever row was last before. What it does
not follow is **`:nth-last-child` and `:nth-last-of-type`**: a row appended
at the end shifts every earlier row's position from the end, so mirroring
them would restyle the whole list on every append — and that is exactly the
cost that made a list streaming in one row at a time quadratic in its own
length. Stripe from the top, not the bottom:

```css
.row:nth-child(even) {
  background: #f4f4f5;
} /* fine */
.row:last-child {
  border-bottom: none;
} /* fine */
.row:nth-last-child(2) {
  opacity: 0.5;
} /* ignored — counted from the end */
```

Inserting or removing in the middle restyles the rows from that point on,
which is also the set that moved; prepending restyles the list, correctly,
since every row's `:nth-child` position changed.

**The panel's background is clickable, and it is the panel you should listen
to.** A ray that lands on the panel but on none of its buttons hits the blocker
spanning the container, which dispatches a bubbling `click` on the portal's
root element. That is what "clicked outside" means to a menu that wants to
close itself; there is no other way for the tree inside to learn it happened.

Count only the panel's own clicks as elsewhere, via `getPortalRoot(node)`,
and ask it when the click arrives rather than when the listener goes up:

```js
document.addEventListener("click", (event) => {
  if (root.contains(event.target)) return; // inside
  const panel = getPortalRoot(root);
  if (panel && !panel.contains(event.target)) return; // the page, not the panel
  close();
});
```

Every real mouse click on the page around the scene — the VR button, and in
development an emulator whose every control is a mouse click — also reaches
the document. A menu that counted those would close itself the moment you
reach for the control that was going to choose from it, which looks exactly
like the ray having no effect. `getPortalRoot` returns null off a portal,
where the whole page is the right scope and there is nothing to disambiguate.

Asked per click, because which panel a node is in can change while a
listener is up. A portal that mirrors an element the page already shows (see
above) marks that element when it takes it and unmarks it when it lets go,
so a menu that resolved its scope once, when it opened, would keep the wrong
one across either moment: closed by the emulator's click once the session
begins, or deaf to the page's clicks once it ends. The `dropdown` and
`scrollable` widgets in [`@apendua/justui`](../justui) do it this way.

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

While that runs the panel is *loading*: stopping no rays — nothing inside it
registers as a ray target until it is actually there to press — and, if the
mount takes long enough to be noticed, showing where it is going to be a
**loading frame**: a translucent rounded rectangle the panel's size, with a
black border and three dots in the middle that brighten in turn. A panel
that settles within a quarter of a second appears the moment it is built and
never shows one, since a loader for a wait nobody would have noticed is the
thing that gets noticed. For the rest the frame is there to soften a panel
appearing from nothing rather than to report on progress; it says nothing
about how far along the mount is, because nothing can. It is placed exactly
where the panel will be and goes in the same frame the panel's content
arrives, so the one replaces the other. Once shown it stays up for half a
second at the least: a mount that finishes sooner is held, built and unseen,
until the frame has had its time, because a frame that flashed for three
frames and was gone reads as a glitch rather than as a panel arriving.
Loading ends exactly once, when everything the initial content brought has
been built and settled; the panel appears whole rather than assembling itself
in front of the player. Later updates — rows arriving, a menu opening — go
through the same budgeted pump, and a panel that is already visible never
shows the frame again.

A panel that would rather appear from nothing — a readout that is never in
anybody's way — opts out; one that wants the frame in its own colours, or
shown after a different delay, or up for a different least time, says so:

```js
dom(ctx, readout, [set({ position })], { loadingFrame: false });
dom(ctx, menu, [set({ position })], {
  loadingFrame: { color: "white", fill: "black", fillOpacity: 0.4, radius: 8 },
});
dom(ctx, quick, [set({ position })], { loadingFrame: { delay: 400, minimumTime: 500 } });
```

While a panel's mount is under way — from the first content it is given to
the load — its container element carries `data-xr-loading`, so a page — a
test harness about to photograph the scene, say — can ask whether any panel
is still on its way without holding the handles:
`document.querySelector("[data-xr-loading]")`. A panel given nothing to
mount is not on its way anywhere and never carries it.

**An update lands whole, however many frames it took.** A visible panel
cannot hide while it changes, and a change too big for one frame's budget
used to arrive in instalments: the rows a frame got to were moved, the rest
were not, and the panel slid into its new layout a few boxes at a time. The
panel's channel is *atomic* (`UpdateChannel`'s option of that name in
`@apendua/signal`): each frame's budget goes on resolving what the update
will read — the measurements, the restyles, the rasterized runs, which is
where a panel's cost is — and the writes to the scene happen together, in
the frame that finds nothing left to resolve. Until that frame the panel
stands exactly as it was — the panel's own size and placement included —
and objects built for rows that arrived wait for it too, as do the objects
of rows that left, drawn as they were until then, so an arrival and the
room made for it are one frame. The trade is that a big change is seen later rather
than in pieces; a scroll is the one thing that does not wait, for the reason
the scroll section gives.

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

### Haptics

A button on a page has a click to say it was pressed; a projected one is a
quad at the end of a ray, and the hand holding the controller can be told.
Every control in a panel, which is every element with `cursor: pointer`,
the rule that makes one a ray target, pulses the controller's motors when
the trigger closes on it. Nothing is marked: a panel with buttons in it is
felt, and so is the keyboard.

A pulse when the ray arrives on a control is there too, and off unless a
panel asks for it. A press is always worth telling the hand about. A hover
is worth it where the player aims at one small target after another
without looking, and elsewhere a ray sweeping across a panel on its way
somewhere is a stutter of pulses nobody asked for. The keyboard a field
brings up is the case it is for, and has it on (see the last paragraph
below).

What it feels like is the panel's, or the scene's (see **Panel defaults**
below):

```js
dom(ctx, numberPad, [set({ position })], {
  haptics: { hover: true, strength: 0.6, flavor: "knock" },
});
```

`hover` turns the arrival pulse on and `active` turns the press off; a
press is felt and a hover is not unless told.
`strength` multiplies every pulse, clamped to what the motors can do.
`flavor` picks the pulses: `tick` (a light high-frequency click, the
default), `knock` (the low motor, a thump), `buzz` (longer and softer) or
`key` (a mechanical key, felt closing and opening again), or a
`HapticFlavor` of your own, a `hover` pulse, a `press` pulse and an
optional `release` pulse, each a `duration` in milliseconds and a `strong`
and a `weak` magnitude from 0 to 1. `HAPTIC_FLAVORS` holds the named ones
to start from. `false` is no haptics for the panel whatever the scene says;
there is no `true`, for the reason `loadingFrame` has none.

What plays is the hand's own: the event carries the input source three
connected to the controller, and every actuator of its gamepad gets a
`dual-rumble` effect, or a `pulse` on a runtime that only has that. A
tracked hand has no motors and feels nothing. The pulses are worked out
once per panel, so an element's handler pays for the call and nothing else.
`playHaptic(source, effect)` is that driver on its own, for a scene with
haptics of its own to play, so that one place knows both interfaces and
what to do when a motor refuses.

**A hover is one pulse per arrival on a control.** `cursor` is inherited,
so the label or the icon inside a button is a ray target of its own, and
the ray crossing from it onto the button's own background is an enter as
far as the manager can tell. It is not an arrival: the hand has been on the
button the whole time. So a pulse plays only when the ray comes onto a
control from outside it, from another control or from nothing, which the
enter's `relatedTarget` says (see **Pointing at things**). The control is
the outermost element in the unbroken run of clickable ancestors and
everything in it, so a ray moving between a button's background and its
label, either way round, is moving within one control and plays nothing;
neither does the enter bubbling up from the label, which has played its
own. Coming from anywhere outside that is an arrival, from another control
or from a scrollable list, which is a ray target, to be dragged by, and not
a control, so a button entered from the gap between its rows is entered
whether the ray meets its background or its label first. What the rule
gives up is a distinct control nested in another, a delete button inside a
clickable row, whose hover from the row is not an arrival. Its press still
is. And nothing plays while the hand is scrolling a list, glide included:
the rows passing under the ray were not aimed at, as `:hover` on a page
does not fire on rows scrolling under a pressed pointer.

The keyboard a field brings up is a panel of its own, and its keys follow
the `haptics` of the panel it is typing for, with the hover on: a panel
that does not want its keys felt on hover says `hover: false` by name, and
one with `haptics: false` has a silent board too.

## Baking a panel into a stamp

A portal is not cheap to keep: real DOM in the document, a mutation observer
over it, a resize observer under it, and a scheduler pumping the work of
turning changes into geometry. That is the right price for a panel, which is a
view of something that keeps changing. It is the wrong price for a *picture* —
a card, a number chit, a badge, a label on a map — because a picture is the
same in every copy of itself.

`createBakery` draws each distinct face exactly once, into an oven parked out
of sight, and hands out copies:

```js
const bakery = createBakery(ctx, {
  timber: () => card("TIMBER", "#2f6b3a"),
  clay: () => card("CLAY", "#b4553a"),
});

useEffects(getScene(ctx), [
  children(
    bakery.oven(),
    component(() => {
      const stamp = bakery.stamp("timber");
      return stamp ? $(stamp) : Nothing();
    })(),
  ),
]);
```

`stamp` returns null while the oven is working and a fresh copy afterwards;
`ready()` is reactive, so a component that reads it rebuilds when the oven is
done. A face the bakery was never given is a mistake rather than a wait, and
throws.

What makes it worth doing is what a finished portal *is*: boxes batched into
instanced meshes, text rasterised into texture arrays, every local matrix
composed and none of it going to move again. `clone()` copies that tree while
sharing its geometry, materials and textures, so a stamp costs a handful of
objects and no DOM at all — a hand of fourteen cards is fourteen copies of
five pictures rather than fourteen portals mirroring fourteen subtrees that
never change. Stamps also keep their matrices, the way the panel they came
from does: `clone()` drops the override that arranges that, and the bakery
puts it back.

**The oven's portals are never disconnected, and must not be.** Disconnecting
one tears down the tree it drew and disposes the geometry, the materials and
the texture arrays behind it — which are exactly what every stamp holds a
reference to, so taking the oven down empties every copy on the table. What it
costs to keep is a matrix comparison per portal per frame and nothing else:
the DOM never changes again, so the observers never fire and the pump never
has anything to do. The watching stops because there is nothing left to watch,
not because the machinery was taken away.

Stamps are not interactive. Nothing inside a baked face registers as a ray
target, and a clone would not carry the registration if it did; anything that
has to be pressed wants a plain invisible mesh in front of it, which is
cheaper than an interactive portal ever was.

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

Every other kind of `<input>` is still drawn as a plain box: a range's thumb,
a colour swatch and a file picker's button are chrome the DOM does not
describe, and there is nothing honest to mirror. The text fields are the
other exception, and have a section of their own.

## Text fields and the keyboard

`<input type="text">`, and the other types that hold a line of text
(`search`, `url`, `tel`, `email`, `password`, `number`), are drawn as what
they are: a box with the value in it, or the placeholder while the value is
empty, in the colour the page gives placeholders. A field is a ray target
without asking, like a checkbox, and a disabled one is not.

The value is not a text node, so the observer never hears it change. The
portal follows it two other ways: through the `input` and `change` events a
keystroke dispatches, and through the `value` property itself, which is what
an app writes to clear a field after a submit. The property is intercepted
on the element for as long as the portal watches it — an own accessor over
the prototype's, taken off again with the portal — so that
`input.value = ""` is followed without the app knowing a mirror exists. A
`value` or `placeholder` attribute rewritten from outside is followed too.

Drawing a field is half of it. Typing into one needs a keyboard, and there
is nothing in a headset to type with: the system's keyboard is the
compositor's and never reaches the panel. What reaches it is a board of
ordinary boxes, mirrored by a portal of its own; `keyboard(props)` in
[`@apendua/justui`](../justui) is one. This package has no keyboard and
does not depend on one, so what a scene gives it is a factory, once, for
every panel:

```js
import { keyboard } from "@apendua/justui";

render(Scene, {
  panelOptions: {
    keyboard: {
      create: ({ onKey, field }) => keyboard({ classes, onKey, field }),
    },
  },
});
```

`create` is called when a field is pressed, and hands back the board's DOM
— a justdom tree, or anything with the `Mountable` shape — wired to the
`onKey` it is given. `field` is there for a board that wants to know what
it is typing into: justui's gives a number field its number pad. The rest
is decided here, the same way for every panel.

**There is one board for the whole scene.** A player has one pair of hands,
so whichever field was pressed last is the one being typed into, whatever
panel it is in. Pressing a field in another panel moves the typing there:
the board stays up, `onKey` types into the new field, and `field()` on the
target the factory was handed says which one that is (`element` is the
field it was built for). The board is only built again if that panel's
keyboard has a different `create`.

**It opens in front of the player**, not beside the panel: `reach` ahead of
the eyes (0.45 m) on the level heading they face, `drop` below them
(0.2 m), turned toward them and reclined toward the hands by `tilt` (24°),
like a phone on a stand. Once open it stays where it is in the room, so the
head moving, or the typing moving to another panel, does not move it. Its
size is its own, `scale` metres per CSS px of it — a millimetre by default
— whichever panel opened it. `placement: "panel"` hangs it below the panel
of the field being typed into instead, `gap` px under its bottom edge and at
the panel's scale, and a function poses it yourself when it opens. On a
plain page, or under a test runner, where there is no camera to be in front
of, it hangs below the panel.

**It can be moved.** Four strips along its edges are invisible until a ray
is on the board, show faintly while one is, and fully on the strip a ray is
on; pressing one picks the board up with `carry()`, level, and releasing
puts it down. It opens there again next time, unless the player has since
walked more than a metre or turned more than 60° away. `draggable: false`
turns this off; `draggable: { handleWidth }` changes how wide the strips
are.

**It shows what is being typed.** The board is where the hands are, and the
field it types into is wherever its panel is — a glance up and back down
for every word. So a board in the room carries a copy of the field just
above its keys: the value as it is typed, the placeholder while it is
empty, the caret where the next key goes. It leans toward the player,
hinged at its bottom edge, by `preview.tilt` (15°) beyond the keys' own
recline, `preview.gap` px (8) above them. It is unmasked: a password shows
its characters there, which only the player, in the headset, can see — and
a password typed one aimed click at a time is where seeing what was typed
matters most. It wears the field's own look (font, colours, border,
padding), so it reads as the field it stands for, unless
`preview.className` names a class of the app's for it; either way it
carries `data-xr-keyboard-preview` (`PREVIEW_ATTRIBUTE`) for a stylesheet
to find it by. Its caret is placed by a ray, as the field's is (below), and
goes into the field. `preview: false` leaves it off; a board hung below a
panel has none, since the field is right above it there.

A key goes into the field through `typeIntoInput`, which is exported too —
the character goes in at the caret, backspace takes one out, and `keydown`,
`input` and `keyup` are dispatched in a browser's order, so an app that
listens for `input` or for `keydown` of `Enter` on a page hears the same
thing in the scene. `Enter` asks the field's form to submit, if it is in
one. While the board is up the field carries `data-xr-focus`, a
presentational flag like `data-xr-hover` for a stylesheet to draw a focus
ring with, and a caret, at the end of the text until it is moved.

The board follows focus the way a page does. `Enter` submits and leaves the
field being typed into, so an app that clears the field after a submit can
take the next entry straight away. A press anywhere in a panel other than
on a field — a button, a row, the background — is focus leaving the field,
and the board goes, as the field would blur on a page; a press on another
field moves the typing there instead. It also goes on `Escape`, which a
board can offer as its "done" key, when the field being typed into leaves
the document or its panel goes, and with the scene; `dismiss` on the target
closes it for any other reason a board might have.

A panel can still say something of its own. Its `keyboard` option is laid
over the scene's, so a panel for entering a code can bring a different
board, and `keyboard: false` gives a panel none:

```js
dom(ctx, codeEntry, [], { keyboard: { create: ({ onKey }) => codeKeyboard(onKey) } });
dom(ctx, readout, [], { keyboard: false });
```

A portal built outside `render()` keeps a board of its own, given its own
`keyboard` option, as panels did before there was a scene to share one.

Without a keyboard a field is drawn and pressed like any box, and nothing
in the scene can type into it — which is what a panel with a read-only
readout in an `<input>` wants.

A text field draws no selection, only a caret. Pressing a field puts the
caret at the end of the entry, where a tap on a phone puts it; once the
field is being typed into, the ray moves it — a press puts it between the
two characters nearest where the ray landed, and holding the trigger while
the ray slides along the field drags it, the way a finger drags a phone's
caret. The next key goes in there. A password is measured by its bullets,
and the keyboard's preview places the caret in the field it copies. The
mirror scrolls the value as a page does, only when the caret would leave the
field and only as far as it takes to bring it back, so a caret dragged
about inside what shows moves over text that stays put. The caret blinks as
a page's does, every 530 ms, and stays solid for a moment after each
keystroke. It is a mesh of its own, so a blink only flips its visibility:
nothing on the panel is drawn again.

`number` and `email` fields keep a caret the page cannot reach —
`selectionStart` reads null and `setSelectionRange` throws on them — so one
placed by a ray is kept alongside the field instead, and typing goes in
there all the same. A value the app writes puts it back at the end.

A number field is typed the way a page types one. Its value is sanitized:
`1.` on the way to `1.5` is not a number, so `value` reads `""` while the
browser's own editor goes on showing `1.`. A script cannot reach that
editor, so the field keeps a draft of what was typed, the keyboard edits
the draft, and the mirror draws it. `input` is dispatched for every key,
the ones that leave `value` empty included, which is what a page sees too.
A letter never gets in, since a page's number field filters it before
anything else happens. The draft goes when the app writes the value, `""`
after a submit included.

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
`useFrame(ctx, fn)` rather than with `requestAnimationFrame`, though. Once a
session has the display the page stops being rendered and the page's own
animation frames stop with it, so a `requestAnimationFrame` loop simply
stops running and whatever it was moving sits still. The session's frame
loop keeps going, and `useFrame` is how to draw on it. Nothing warns you:
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
and everything the browser does in its rendering step stops with it. An
animation already running may or may not be carried forward, depending on
what the browser does with the document timeline behind a session — but one
*started* in there is anchored to that timeline by a task belonging to the
same rendering step, so it never moves off its first value at all, which is
what a meter that will not fill and a button that will not light under the
ray have in common. The `transitionrun`/`animationstart`/`transitionend`
events are never dispatched, so nothing would say one had begun; and
`scroll` never fires either, so a dragged list would slide while its
mirrored rows stayed put.

A portal notices and takes over. What it watches is a frame request of its
own: a `requestAnimationFrame` callback runs in the rendering step and
nowhere else, so one that goes unanswered for longer than any frame could
take is that step having stopped, and one that arrives is it having run. It
then finds animations by looking rather than by being told — mutation
observers are microtasks and keep arriving, so a class swap is still a
signal — advances each one by however much of the elapsed time the browser
did not, which is all of it for an animation that has not been given a start
time and none of it for one the timeline is still carrying, and has every
scroll it performs itself — the drag gesture and the `scrollable` widget's
arrows and track alike — announce that scroll, which the portal's listener
cannot tell from the real thing. Nothing here is switched on by asking
whether a session is presenting, which is why it behaves under an emulator,
where the page is presenting and rendering both: the page is being rendered,
the frames come back, and the browser is left to its own animations.

## Revealing text

A letter being typed out is a string being rewritten: one more character into
the DOM per tick, a mutation observed, the run re-measured, the glyphs
rasterized again and the texture uploaded again. It also forces the layout to
be something the app can predict, because a growing string re-wraps — hence
the monospace face and the wrap counted in columns that every typewriter
effect ends up with, so that the line the last character lands on does not
move while it is being typed.

None of that is inherent. The glyphs do not change while a letter is being
typed; only how many of them are drawn does. `makeReveal` is that distinction
made available: the node holds the whole text from the first frame, the
browser wraps it once, and the cursor is answered in the fragment shader.

```js
import { makeReveal } from "@apendua/freedom";
// The element builders are justdom's, as they are for any panel; `$` and
// `children` here are that package's, not the ones freedom hands out for
// Three objects.
import { $, children, set } from "@apendua/justdom";

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

The cursor counts *rendered* characters — the collapsed string the glyphs were
drawn from, not the node's data, so the machine does not stall for three ticks
on an indent nobody can see — and it counts them across every node the handle
owns, in document order. Zero draws nothing, anything past the end draws
everything, and a fractional value interpolates inside one glyph's advance, so
the same primitive serves a discrete typewriter and a smooth wipe. How fast it
moves, whether it eases, what it sounds like and what the skip button does are
all the app's: this answers only what is drawn.

What a tick costs, before and after:

| per character | rewritten | revealed |
| --- | --- | --- |
| DOM mutations | one per node | none |
| observer flushes | one | none |
| re-measurements | one per node | none |
| rasterizations and uploads | one per node | none |
| uniform writes | none | one, of four floats |

And the constraint goes with it. The layout never moves, so nothing has to be
predictable about it: any face, any `white-space`, any alignment, wrapped by
the browser, with no column count anywhere in the app.

Four things to know before reaching for it.

**It is measured per character, once.** A revealed node is measured the way
every text node is — line boxes read back off the browser's own layout — and
then once more, with a range read per character, to find the boundaries the
cut can fall on. That is why it is opt-in: it is the right price for a letter
and quite the wrong one for a label, and a scene where every node paid it
would mount visibly slower. It is paid when the text is laid out, not when the
cursor moves, and it rides the same budgeted mount every other measurement
does — so `onLoadingChanged` covers it, and a panel is ready when it is ready.

**A revealed run draws itself.** Text is normally drawn from a batch, one draw
for a whole panel; a run carrying a cut of its own cannot be, so it keeps its
own mesh and its own draw, exactly as a run with baked colours does. One extra
draw per revealed node. A letter has two or three of them, which is the scale
this is for.

**A line running both ways is revealed as a unit.** The cut is one x on one
line, and the prefix of a line with both directions of text on it is not a
rectangle — no x expresses it. Such a line is not cut: it stays hidden until
the cursor is past it, and then it is drawn whole. A line running entirely
right to left is an ordinary line read from the other end, and cuts from its
right edge. Everything else on the run cuts as normal.

**Tight leading trims descenders until the next line catches up.** Line boxes
that overlap — a `line-height` below the face's content height — share a band
in which the finished line's descenders and the next line's ascenders sit at
the same y. The cut keeps that band hidden until the next line is being typed,
which is the choice that never shows a glyph early; the price is that a
descender's tail past the cut stays hidden until the next line's cut sweeps
over it. Ordinary leading has no such band and no such effect.

Clipping composes with all of it: a revealed run inside a scroller is clipped
by the scroller and cut by the cursor, in the same shader pass. So does a
transform: the footnote on the *Interactions* card in
[`apps/showcase-xr`](../../apps/showcase-xr) types itself out on a card that
can be tilted while it runs, and the cut follows the lines wherever the
transform puts them.

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
of it reaches the scene. Nor can the system keyboard, for a stronger version of
the same reason — it is not even the browser's, it is the compositor's.

Both are in [`@apendua/justui`](../justui), built out of ordinary elements so
that a portal can carry them: `dropdown(props)` is the one the two requirements
above are written for — its `root` is the positioning context, its `menu` is the
layer — and `keyboard(props)` is a phone's board you point at rather than type
on.

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

## Gradients

A `background-image` that is a gradient is drawn, laid out the way CSS lays
it out, over the element's `background-color`:

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

`linear-`, `radial-` and `conic-gradient` and their `repeating-` forms are all
drawn, with stops in `%`, `px` or angles, hard stops, double-position stops and
interpolation hints. Stops interpolate in premultiplied sRGB, and the layer
composites over the background colour in sRGB too, which is what CSS does —
so a fade to `transparent` keeps its hue and a translucent gradient looks the
way it does in the page. `background-size`, `background-position`,
`background-repeat` and `background-origin` place and tile it.

It costs no draw call. A box with a gradient stays one instance in its
panel's batch: the stop list is baked, once, into a row of a texture shared by
the whole page, and what the box carries is which row and a few numbers saying
how its pixels map onto it. Rows are shared by content — a hundred rows
wearing one gradient bake it once — and given back when the last box wearing
them goes. Swapping gradients on hover is a lookup, or one row baked the first
time a new one is seen.

What to know:

- **One layer.** A background that stacks several images is drawn as its
  topmost gradient over its background colour; the others, and any `url()`
  image, are not drawn.
- **`background-clip` is not mirrored.** The background, colour and gradient
  alike, fills the padding box, so a `content-box` clip draws wider than the
  page does. `background-origin` works.
- **`space` repeats as `repeat`.** Tiles are laid edge to edge rather than
  spaced out. `round` works.
- **Interpolation is sRGB whatever the gradient asks for.** `in oklab` and its
  kin are accepted and ignored — the CSS default for gradients written with
  ordinary colours, which is almost all of them. A stop colour in a space
  browsers do not compute to `rgb()`, such as `oklch()`, makes the gradient
  unreadable and the box draws its background colour alone.
- **Prefer percentage stops on anything that resizes.** A `px` stop is a
  different fraction of the gradient at every size, so a box animating its
  width bakes a new row every frame it moves; percentage stops, and anything
  moved with `transform`, bake nothing.
- **Tile edges are antialiased** like every other edge in a panel, so a
  `no-repeat` tile's border is a pixel softer than the page's.

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
`scrollable(props)` in [`@apendua/justui`](../justui): arrows, a track and a
thumb, built out of ordinary elements like the dropdown, over a viewport that
hides its overflow. It scrolls through `scrollElementBy`, which is exported here
and is the write above plus the `scroll` event the browser will not dispatch
while the session has the display.

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

### How sharp the text comes out

The scale you place a panel at is also what decides how finely its text is
rasterized, and you do not have to say anything about that either. A run
used to be drawn at the page's `window.devicePixelRatio`, which is an answer
to a question nobody in a scene is asking: what makes a glyph sharp is how
much of the screen the panel covers, and that is the scale above, the
projection and the distance between the eye and the panel. In an immersive
session the page's ratio is worse than unhelpful — a headset browser reports
1 while the eye buffer paints two or three device pixels across every CSS
pixel of a panel at arm's length, so every label was being magnified, and no
mip level can put back what level 0 never had.

Each panel measures its own, once a frame, and rasterizes at a step of the
ladder 1, √2, 2, 2√2, 4 — the one at or above what it measured. Stepped at
all because crossing a step re-draws every run on the panel, and the answer
has to sit still while the player's head does not; coarsening is held back
until the measurement is a fifth clear of the boundary, so a panel you are
standing in front of does not re-rasterize because you drifted a centimetre,
while one you walk up to sharpens on the frame it needs to.

Root two rather than two because what a step costs is *quadratic* in it. A
panel of forty labels holds about 2 MB — the array texture, the mirror of it
the batch keeps, and the canvas each run holds on to — at one device pixel
to the CSS pixel, and sixteen times that at four. A panel measuring 2.3 gets
2.83 rather than 4, which is half the memory, and half of every upload it
makes for as long as it is open, for a difference nobody has reported
seeing. Four is the ceiling for the same reason there is one at all.

That ceiling is per panel, if you want it to be. A list of hundreds of rows
reaches it with every row at once, and would rather be soft than large:

```js
dom(ctx, List(ctx), [], { maxTextScale: 2 });
```

It only ever lowers — four is what a run is allowed to cost at all.

Off a scene — a portal on a plain page, or a panel under a test runner —
there is nothing to measure against and the page's ratio is the whole
answer, which is the right answer there, because the panel *is* the page.

### Panel defaults

Some of what a panel is told belongs to the scene rather than to any one
panel: the keyboard its fields are typed with, how sharp its text is worth
drawing, whether a slow mount shows a frame. Passing those to every `dom()`
is how one gets forgotten. `render()` takes them once, as `panelOptions`,
and every panel in the scene starts from them:

```js
render(Scene, {
  panelOptions: {
    maxTextScale: 2,
    loadingFrame: { delay: 400 },
    keyboard: { create: ({ onKey, field }) => keyboard({ classes, onKey, field }) },
  },
});
```

`keyboard`, `loadingFrame`, `haptics`, `maxTextScale`, `atomic`,
`opaqueToRays`, `priority` and `budget` can be set this way. A panel's own
options are laid over them: its value wins, except that a `keyboard`, a
`loadingFrame` or a `haptics` given as an object is spread over the scene's,
so a panel can change one thing about them without restating the rest.
`withPanelOptions(ctx, …)` does the same for a part of the scene, over
whatever is in scope already.
`plugins` is not among them — it has `portalPlugins`, whose list a panel's
own is put in front of rather than in place of — and neither are `root` and
`onLoadingChanged`, which are only ever one panel's.

## SVG

Inline `<svg>` is drawn through a plugin, and only through one. Drawing a
shape means triangulating it — three's `ShapePath`, its curves, the earcut
triangulator and the stroker from `SVGLoader`, none of which a panel of
boxes and text has any use for — so the support lives behind a second entry
point that the main one never imports. A scene that has SVG in it registers
it once:

```js
import { render } from "@apendua/freedom";
import { svgElements } from "@apendua/freedom/svg";

render(Scene, { portalPlugins: [svgElements()] });
```

A single panel can carry it instead, through `dom(ctx, tree, [], { plugins:
[svgElements()] })`. Without the plugin an `<svg>` is the CSS box it also is
— background, border, radius, its place in the flow — and nothing inside it
is drawn or measured.

With it, `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`, `<polyline>`
and `<polygon>` are drawn, `<g>` groups them, and the `<svg>` stays the box
it was, its shapes clipped by its own `overflow` and by every scroller above
it like any other content. What is read is the elements' _computed_ style,
not their attributes — which is what makes the ordinary ways of styling a
diagram work: a class on a `<path>`, a `[data-xr-hover]` rule on the button
around an icon, `fill: currentColor`, a CSS keyframe on `stroke-dashoffset`.

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

What is followed: `fill`, `fill-opacity` and `fill-rule`; `stroke`,
`stroke-opacity`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`,
`stroke-miterlimit`, `stroke-dasharray` and `stroke-dashoffset`; `opacity`,
the group's included; `display`; `visibility`, on the shape's own meshes
as on a box's quad, so a shape that says `visible` is drawn under a hidden
`<g>`; `transform` and
`transform-origin` on every element in the chain, the `transform`
_attribute_ included, since the browser computes it as the same property;
`viewBox` and `preserveAspectRatio`, with the viewport at the `<svg>`'s
content box; a nested `<svg>` as a viewport. Geometry is read from the
computed style where the browser exposes it as CSS (`cx`, `r`, `x`,
`width`, `d`) and from the attribute otherwise, so a shape animated by
either follows.

Transforms are matrices, as they are for boxes: a shape's vertices stay in
its own user space, the `<svg>`'s content group carries the viewport, and
each `<g>`, nested `<svg>` and shape carries its own `transform` on its
object. A `transform` animated on a `<g>` is a matrix write per frame, and
nothing under it is rebuilt; the clip follows the shapes there through the
clip patch's matrix. A scale change — animated, or the `<svg>` resizing —
re-samples curves only when it crosses a half-octave, so a zoomed shape
never shows its polygons and a slow zoom does not re-triangulate each frame.

One print of the measuring tape. **Dashes are geometry, not a
shader**, for the reason `svg/dash.js` gives, so a `stroke-dashoffset`
animation rebuilds the stroke each frame — a few hundred vertices, which the
marching ants in the showcase spend without noticing.

A shape with `cursor: pointer` is a ray target of its own, by the rule a
box follows. It forwards the ray to its element exactly as a box does:
`mousedown`, `mouseup` and `click` for a press, `mousemove` while the ray
moves over it, and `data-xr-hover` and `data-xr-active` on the element for
a stylesheet to answer. A press that turns into a drag scrolls the list the
`<svg>` sits in. `pointer-events` decides which of the fill and the stroke
a ray can hit, with SVG's values: the default `visiblePainted` hits
whatever is painted and visible, `none` lets the ray through to what is
behind, `fill` and `stroke` pick one region, and `all` hits a region with
no paint, which is drawn as nothing and hit all the same. The `<svg>`'s
clip trims the hits as it trims the drawing, so a node scrolled out of
view takes no press.

```css
.diagram .node {
  cursor: pointer;
}

.diagram .node[data-xr-hover] {
  fill: rgb(64, 204, 186); /* a colour write; the node keeps its draw order */
}
```

`cursor` is inherited, so the shapes of an icon inside a `cursor: pointer`
button are clickable too. A press on the icon is then a press on the
`<path>`, which bubbles to the button in the DOM and holds the button as
well, the way nested clickable elements always do (see *Projecting DOM into
the scene*). Where the button should be the target itself, put
`pointer-events: none` on the icon's `<svg>`, as a page would. Neither the
`<svg>` nor its shapes are then ray targets of their own, whatever `cursor`
they inherit, and a press on the icon is a press on the button.

Not drawn yet: `<text>`, markers (so an arrowhead is a `<polygon>` of its
own for now), `<use>` and `<symbol>`, gradients and patterns (a `url(#…)`
paint reads as `none`, though it still counts as painted for a ray),
`clip-path`, `mask`, filters, `<image>`, `<foreignObject>` and
`vector-effect`.
[`docs/freedom-svg-plan.md`](../../docs/freedom-svg-plan.md) has the order
they are coming in and why.

## Element plugins

The seam the SVG support goes through is general. A `PortalPlugin` is an
object with one method, `element(ctx, element)`, asked about every element a
portal is about to build, before its own dispatch; it returns the object
tree to mirror the element with — one `Object3D`, emitted synchronously,
kept in step with the element for as long as the subscription lasts, torn
down when it ends — or `null` for an element that is not its. Register one
for a scene with `render()`'s `portalPlugins` or for one panel with
`PortalOptions.plugins`; a panel's are asked first. `box(ctx, element,
options)` is exported for a plugin that wants the CSS box drawn and
something of its own inside it, which is how the checkbox is built.

## Real examples

This package drives several full apps in this monorepo —
[`apps/rubik`](../../apps/rubik), [`apps/blockout-xr`](../../apps/blockout-xr),
[`apps/marblerun`](../../apps/marblerun),
[`apps/todo-vanilla`](../../apps/todo-vanilla) — worth reading for realistic scenes
combining lighting, keyed lists (`list`/`keyedList`), controller/hand input,
and DOM panels projected into 3D space.
[`apps/showcase-xr`](../../apps/showcase-xr) is the sampler: five panels in a
grid demonstrating hover/press transitions, CSS keyframes, a Web Animations
API animation, a `useFrame(ctx, fn)` loop writing inline styles, animated
text colour, a paragraph revealed to a moving cursor, static transforms, a
layout-tier width transition, every `object-fit` an image can be drawn
with, and a card of inline SVG — a diagram with dashed and dotted arrows,
icons through a `viewBox`, marching ants.

## License

MIT — see [LICENSE](../../LICENSE).
