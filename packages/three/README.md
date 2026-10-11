# @apendua/freedom

A reactive Three.js scene graph, built on [`@apendua/signal`](../signal) with the same operator
vocabulary as [`@apendua/justdom`](../justdom) — `$`, `set`, `children`, `effects`, `on` — except
targeting `THREE.Object3D` instead of DOM nodes. No VDOM, no diffing: every reactive value is wired
directly to a Three.js mutation through a signal effect.

This README is a reference. Each section says what a part of the package does, lists its options
with their defaults, and ends with what it follows of the page and what it does not. The reasoning
behind the choices is in the source headers it names and in
[`docs/freedom-design-notes.md`](../../docs/freedom-design-notes.md).

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

## Rendering

`render(fn, options)` owns the `WebGLRenderer`, the scene, the camera, resize handling, and — when
the device supports it — the WebXR session lifecycle. The tree it is given decorates that scene
rather than producing one. `getCamera(ctx)`, `getScene(ctx)`, `getXRSession(ctx)`, `size(ctx)`,
`controllers(ctx)` and `useFrame(ctx, fn)` read from the context it hands the tree, through the
`createProperty` context mechanism the rest of this monorepo's stack shares.

| Option                  | Default                                         | What it does                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `antialias`             | `true`                                          | The renderer's antialiasing.                                                                                                                                                             |
| `foveation`             | `0`                                             | Fixed foveation for the headset's layer, 0 to 1.                                                                                                                                         |
| `presentingOnly`        | `false`                                         | Draw, run `useFrame` and pump portals only while a session is presenting. For a page with a flat interface of its own.                                                                   |
| `portalBudget`          | three tenths of a frame, clamped to 1.5 to 8 ms | Milliseconds of each frame every portal in the scene shares for mounting and settling content; a number or a getter read at the top of every frame. See **Loading, budget and updates**. |
| `portalPlugins`         | none                                            | Element plugins for every portal; `svgElements()` from `@apendua/freedom/svg` is the one so far. See **Element plugins**.                                                                |
| `panelOptions`          | none                                            | What every panel starts from. See **Panel defaults**.                                                                                                                                    |
| `createControllerModel` | none                                            | Something to draw on a controller's grip space.                                                                                                                                          |
| `createHandModel`       | none                                            | Something to draw on a tracked hand's space. See **Hands**.                                                                                                                              |
| `onBeforeRender`        | none                                            | Called with the renderer before each draw.                                                                                                                                               |
| `onAfterRender`         | none                                            | Called with the renderer after each draw.                                                                                                                                                |

`useFrame(ctx, fn)` runs `fn` once a frame, on the session's frame loop while one is presenting. Use
it rather than `requestAnimationFrame`: once a session has the display the page stops being rendered
and the page's own animation frames stop with it, so a `requestAnimationFrame` loop stands still.
Under an emulator the page is presenting _and_ still rendering, so both work there and the
difference only appears on a headset.

`RendererContext` is the property behind `useFrame` and the once-a-frame events below; it is
exported so a test can mount a scene without a renderer: `RendererContext.set(ctx, {})` is enough
for a frame callback to be registered and never called. `runFrame(renderer, time, frame)` runs one
frame for such a renderer — the renderer's frame stream, then every `useFrame` callback, as
`render()`'s loop does before the late callbacks and the draw — so a test can see a carry follow the
hand or a panel mount.

### Entering and leaving a session

`createXRButton(renderer, options)` builds the Enter AR / Enter VR button and sets the session up
the way the scenes here expect. It is freedom's own button, `createSessionButton`, rather than
three's `ARButton` or `VRButton`: it keeps three's ids and wording, so anything selecting
`#ARButton` / `#VRButton` or reading the label works unchanged, records the session only
synchronously, and gives up the focus the click left on it once the session starts, so the first
`Enter` typed in the session does not press it and end the session. `button.js` says what three's
buttons get wrong.

| Option         | Default  | What it does                                                                                                                                                                                                                                                               |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ar`, `vr`     | none     | The `XRSessionInit` for each mode. `hand-tracking` and `local-floor` are added as optional features unless the options below say otherwise, and a VR session asks for the default features `xr.js` lists.                                                                  |
| `anchor`       | `true`   | Re-anchor the `local` origin to the first trustworthy viewer pose (`anchorToViewer`).                                                                                                                                                                                      |
| `frameRate`    | `"high"` | Ask the runtime for its fastest rate; `"mid"`, a number in Hz, or `false` to leave the default (`requestFrameRate`).                                                                                                                                                       |
| `offerSession` | `false`  | Let the browser offer the session from its own chrome, from a state of rest only.                                                                                                                                                                                          |
| `autoEnter`    | `false`  | Ask for the session as soon as the button is built, where the platform hands the page an activation to spend (an installed PWA on Horizon OS). The button is built and returned either way.                                                                                |
| `crashPanel`   | `true`   | A throw out of the frame loop, an uncaught exception or an unhandled rejection ends the session and writes the error, stack and all, onto the page, where it can be read on the headset. The panel's Copy button puts it on the clipboard, or selects it where it may not. |
| `handTracking` | `true`   | Ask for the `hand-tracking` feature. See **Hands**.                                                                                                                                                                                                                        |

**Ending a session from inside it.** The system menu ends a session, and so does `end()` on the
session itself, which is how a control in the room — a power button on a desk, the × on a menu card
— lets the player leave with a press rather than through the headset's own menu:

```js
getXRSession(ctx)?.end();
```

`getXRSession(ctx)` is reactive and null between sessions. A page mounted before there is a renderer
to ask reads the session from `xrSession` in `@apendua.dev/headset/session` instead, which the scene
writes: minesweeper, Euclid and turntable through `enterSession(getXRSession(ctx))`, the desk with
`xrSession.set` in its `components/Scene.ts`. `apps/minesweeper`'s × and `apps/desk`'s power button
both call `end()` on the session that signal holds.

The parts of `createXRButton` are exported for an app that builds its own button:
`requestFrameRate(renderer, preference)`, `anchorToViewer(renderer)`, `installCrashPanel(renderer)`
with `CRASH_PANEL_ID`, `createUnsupportedButton(mode)` for a platform with no session to offer, and
`createSessionButton(renderer, { mode, init, offerSession, autoEnter })`. Such an app asks for
`local-floor` as an optional feature of its session, AR included, as `createXRButton` does:
`anchorToViewer` measures upright in it, and in a session without it the anchor falls back to
`local`, which IWER leaves tilted when a session is entered with the head tipped.
`suppressSessionOffers()` is for a page that mounts three's own buttons; `xr.js` says what hazard it
closes.

## Pointing at things

`interactions(ctx)` gives an object the `makeInteractive()` operator, which puts it in the raycast
set and gets it pointer, select and squeeze events. It takes an optional argument saying whether the
object is pointable right now — a boolean, a reactive getter, or an observable — so a ghost, a
disabled control, or anything else that comes and goes can leave and rejoin the raycast set without
leaving the scene:

```js
$(new THREE.Mesh(), [makeInteractive(() => props.draggable)]);
```

The events are the registered object's, whichever of its meshes the ray met. A projected button is a
quad of background and a quad of text, and a hand drifting from the one onto the other gets a
`pointermove`, not a `pointerleave` and a `pointerenter`; a press on the label released on the
background is a `select`. Every event carries:

- `controller`, the hand it came from, and `inputSource`, what three connected to it, so what is
  pointed at can reach the hand's gamepad. `inputSource` is null while nothing is connected: a
  controller under a test, and the `pointerleave` a hand gets once three has disconnected it, which
  every hand gets when a session ends.
- `registeredTarget`, the registered object the hit belongs to, since `originalTarget` is the mesh
  and `target` is, as three's dispatcher writes it, the object whose listener is running.
- `relatedTarget` on `pointerenter` and `pointerleave`, as the web's do: the registered object the
  ray was on before, or is on now, or null for nothing.
- `lost`, on the `selectend`, `squeezeend` and miss a disconnecting hand sends for whatever it held.

The rules:

- **Hiding something takes it out of the raycast**, as it takes it out of the draw:
  `object.visible = false` on anything — the ray target itself, a group several levels above it, a
  panel the app hangs a whole card off — and nothing under it answers a ray or takes the cursor.
  Nothing is deregistered, so what was pointable before is pointable again.
- **A hand three is not tracking points at nothing.** three hides a controller's target ray space
  before it connects, after it disconnects — every one of them when a session ends — and for any
  frame it has lost the pose. The manager casts no ray from a hidden space, for the hover or for a
  press, and looks again the frame its visibility changes. A trigger pulled by such a hand presses
  nothing, and one let go after the hand was lost is a `selectmissed`, as a release off the button
  is.
- **A hand that disconnects lets go.** three sends `disconnected` for a hand it has lost, and for
  every hand when a session ends, and sends no release for whatever the hand held. So the manager
  ends each press the hand holds there and then, as a `selectend` or `squeezeend` and a miss, both
  saying `lost`, and the hand leaves what its ray was on, with its cursor, in the same event. A
  `drag()` lets go of what the hand carried, where it is in the room, and a `carry()` puts its
  object down. A release handler that commits something asks the event's `lost` first, since nobody
  chose to let go: `apps/rubik` swings the layer home and `apps/polytope-xr` leaves the piece
  unsnapped.
- **A release goes no further than its press did.** The manager sends a release along the press's
  path and no further, so whatever is behind an object that swallowed a press hears neither.
- **Hits are worked out once per frame**, after every `useFrame(ctx, fn)` callback has run and with
  world matrices refreshed, the last thing before the frame is drawn, so a cursor lands where the
  hand is pointing now and not a frame ago. Nested ray targets cost no extra casts: a registered
  object inside another is reached by the outer one's walk.
- The ray each controller draws is cut at the hit, and stretches back out to a fixed reach when the
  hand is pointing at nothing.

`cursors(ctx, options)` puts a mark where each ray meets something interactive, one per hand that is
pointing at something, gone with the hit:

```js
import { cursors, pointers } from "@apendua/freedom";

children(
  cursors(ctx), // a white ball, 1 cm across, on every ray hit
  cursors(ctx, { scale: 2, color: "#ff0000" }), // bigger, red
  cursors(ctx, { object: myArrow }), // one clone of your own object per hand
);
```

| Option   | Default      | What it does                                                                                                                                                                           |
| -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `object` | a white ball | Cloned per hand, so its geometry and materials are shared; the clone's materials are dressed as pointer chrome, drawn over everything and ignoring depth. The template is never added. |
| `scale`  | `1`          | Multiplies whatever scale `object` already carries.                                                                                                                                    |
| `color`  | white        | The default ball's colour; ignored with `object`.                                                                                                                                      |

`pointers(ctx)` is the data behind it: a reactive map from target ray space to a signal holding that
controller's current `THREE.Intersection`, for a snapping preview, a measurement or a sound.

### Pointing with the mouse

The manager casts only from XR controllers, so a scene that is also a page puts `mouse(ctx)` among
the scene's children: a group parked at the camera and turned to face the point under the mouse on
every move over the canvas, registered with the manager as one more controller. A left press and
release on the canvas are its `selectstart`, `selectend` and `select`, so anything that answers a
ray answers the mouse, and `cursors(ctx)` puts the hover mark on the page too.

```js
useEffects(getScene(ctx), [children(mouse(ctx), cursors(ctx))]);
```

- It writes its pose as its own, so it hangs straight off the scene.
- It is hidden, and so points at nothing, until the mouse first moves onto the canvas and whenever
  the mouse is anywhere else; a release heard off the canvas, such as one over the page's own panel,
  is a miss.
- It stands down while a session is presenting, since a click on the canvas then is not a click in
  the room.
- Nothing but a mouse move re-aims it, so the camera is expected to stand still between sessions.

`followMouse(pointer, camera, canvas)` is the part that keeps a group on the mouse, for a test or
for a scene that registers the group itself.

## Picking things up

`drag(ctx, options)` is the carry a press makes: a press on an object picks it up, the hand's own
movement is what moves it, and the release puts it back — where it is in the room, not where it was.
It hands back `draggable()`, the operator for the object's list, and `held()`, a reactive reader
saying which hand has it, or null.

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

| Option    | Default      | What it does                                                                                                                                                        |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buttons` | `["select"]` | Which buttons pick the object up: the trigger, the grip (`"squeeze"`) or both. The events' `button` says which it was.                                              |
| `enabled` | `true`       | Whether a press can pick the object up right now — a boolean, a reactive getter or an observable. It gates picking up; a drag under way always runs to its release. |

The object does not know where it goes. It says where it is — `dragstart` when it is picked up,
`dragmove` once a frame while it is held, `dragend` when it is let go, each with its world matrix —
and the scene decides what that means: a cell to snap to, a preview to show, a drop to refuse.
`dragend` also carries `reset()`, which puts the object back at the local pose it had before it was
picked up. The events go to the object itself and do not bubble. Interactivity is separate, since an
object that can be pointed at without being carriable is common: `makeInteractive()` goes in the
same list.

- **It remembers which hand, not merely that it is held.** A press from the other hand while the
  object is carried is a handover — the object moves to that hand and the drag carries on, one
  `dragstart` and one `dragend` for the whole of it — and only the holding hand's release, of the
  button it is holding with, ends the drag.
- **It swallows the presses it takes.** The press that picks the object up and the release that lets
  it go never reach whatever is behind, so picking up a brick never also picks up the board it sits
  on. A release is swallowed if and only if its press was, whatever `enabled` says in between, so
  whatever is behind hears a press and its release or neither; the manager keeps that rule for every
  press (see **Pointing at things**). So an object taken out of the scene mid-drag leaves the hand
  too, and its release still stops where the press did.
- A hand that disconnects, as every hand does when a session ends, lets go of what it holds, with a
  `dragend`, as though it had been released where it was.

## Carrying things level

`carry(ctx, options)` is the other way of moving something with a hand: for a board with a floor and
things standing on it, which a drag would tip over. A carry takes only two things from the hand —
where it has got to, and how far it has turned about the vertical — and poses the board once a frame
from them rather than reparenting it, so a level board stays level.

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

| Option    | Default | What it does                                                                                                                                                                                                |
| --------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled` | `true`  | Whether a press on a handle can take hold right now, as `makeInteractive` takes it. A carry disabled while under way is put down where it is, and its release is still swallowed when it comes.             |
| `level`   | `true`  | Keep the hand's tilt from the carried thing. `false` gives it the hand's whole rotation, as `drag()` does, still posed once a frame and still taken by handles; `beginFreeCarry(hand, object)` is its grip. |

- The reference for everything is the **grab point**, the spot the ray landed on when the trigger
  closed. It stays pinned to the ray, as far out along it as it was taken hold of, and the turn
  about the vertical pivots the board _about the grab point_, so the spot being held never moves.
  The maths is exported — `yawOf`, `levelPose`, `beginCarry`, `carriedPose`, `applyLevelPose` — for
  a scene that carries something by a rule of its own.
- The presses are taken by **handles**, so that only furniture starts a carry: a board by its floor,
  a tray by its rails. `handle()` listens; it does not make the object pointable, so
  `makeInteractive()` goes in the same list. A scene that wants any unclaimed press to carry puts
  `handle()` on the carried object itself. `carryHandle(ctx, carried, geometry, material, position)`
  is a mesh that is nothing but a handle, pointable and listening.
- The bookkeeping is `drag()`'s (`createHold` in `hold.js`): a press from the other hand mid-carry
  is a handover, taking the grip afresh from wherever its own ray lands, only the carrying hand's
  release puts the object down, `held()` says which hand has it, and the release is swallowed if and
  only if its press was. A carry whose handle leaves the scene is put down, and so is one whose hand
  disconnects.

## Hands

A headset with hand tracking drives a controller slot with the hand itself once the controllers are
put down. `createXRButton` asks for the `hand-tracking` feature, since without it the hand still
arrives as a pointer with a target ray and a pinch as `selectstart` / `selectend`, but nothing tells
it apart from a controller: `XRInputSource.hand` is unset, no joint is reported, and three's
controller-model factory draws a controller for it. With the feature, `render()` fills in a third
space per slot beside the target ray and the grip, and `controllers(ctx)` hands it out:

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

A `ControllerHandle` carries `index`, `controller` (the target ray space), `grip`, `hand`,
`inputSource` (a signal, for the gamepad and the handedness), `tracked()` and `pinching()`.
`handle.hand` is three's `XRHandSpace`: its `joints` are the twenty-five `XRHandJoint`s, each an
`Object3D` posed in the reference space every frame the hand is tracked, and empty while a
controller is in the slot. Whatever `createHandModel` returns is added to it, and hears the same
`connected` / `disconnected` events a controller model hears on the grip — three's `OculusHandModel`
and `XRHandModelFactory` both do. `tracked()` changes only when what drives the slot changes;
`pinching()` is three's own measure of the pinch (20 mm with 5 mm of hysteresis), state to read
rather than input to act on, since the runtime already turns the pinch into the select events
`makeInteractive` listens for.

## Projecting DOM into the scene

`dom(ctx, source, effects, options)` mounts a [`@apendua/justdom`](../justdom) component tree, or
mirrors an element the page already has, onto a Three.js `Group` through a portal, so ordinary
DOM-based UI (menus, HUDs, forms) is composited into a 3D or WebXR scene and still receives pointer
events routed through `interactions(ctx)`. `source` is a `Mountable`, a subscribable of them, an
element or a subscribable of elements; each emission is a fresh portal with the previous one taken
down. `effects` go on the group, as for any `$()`. `createPortal(ctx, options)` is the same thing
without the group, for a scene that drives portals by hand.

It does that without depending on `justdom`. A `Mountable` — a tree that has not been put anywhere
yet, exposing one method that swaps it into a span of sibling nodes — is declared here rather than
imported, so `justdom` is not a peer dependency of this package. A justdom tree satisfies it,
because the two declarations are the same shape and TypeScript compares them structurally; so does
anything else that builds real DOM nodes and knows how to hand them over.

The options, each with the section that says what it does:

| Option             | Default     | What it does                                                                                         |
| ------------------ | ----------- | ---------------------------------------------------------------------------------------------------- |
| `root`             | none        | An element of the page to mirror where it stands. **Mirroring DOM the page already has**.            |
| `opaqueToRays`     | `true`      | Whether the panel's background stops rays. **The panel's background**.                               |
| `keyboard`         | the scene's | The keyboard its fields are typed with, or `false`. **Text fields and the keyboard**.                |
| `thumbstickWheel`  | `false`     | The thumbstick as a mouse wheel on this panel. **What a ray sends the page**.                        |
| `haptics`          | the scene's | What the hand feels from the panel's controls, or `false`. **Haptics**.                              |
| `loadingFrame`     | the scene's | The frame shown while a long mount runs, or `false`. **Loading, budget and updates**.                |
| `onLoadingChanged` | none        | Told once, with `false`, when the initial mount lands. **Loading, budget and updates**.              |
| `budget`           | `5`         | Milliseconds per frame, only for a portal outside `render()`. **Loading, budget and updates**.       |
| `priority`         | `0`         | This panel's say in the scene's shared budget. **Loading, budget and updates**.                      |
| `atomic`           | `true`      | Whether an update lands whole. **Loading, budget and updates**.                                      |
| `maxTextScale`     | `4`         | The ceiling on how finely this panel's text is rasterized. **How sharp the text comes out**.         |
| `draggable`        | `false`     | Whether the player can move the panel, or a `PanelDragOptions`. **Letting the player move a panel**. |
| `plugins`          | none        | Element plugins for this panel alone, asked before the scene's. **Element plugins**.                 |

`keyboard`, `loadingFrame`, `haptics`, `thumbstickWheel`, `maxTextScale`, `atomic`, `opaqueToRays`,
`priority` and `budget` can also be set for the whole scene; see **Panel defaults**.

### What a ray sends the page

An element is a ray target of its own when its computed `cursor` is `pointer`, the signal a page
uses for "clickable", when it is `draggable="true"` (see **Dragging and dropping**), or when it is
the `<label>` of a text field (see **Text fields and the keyboard**), and its `pointer-events` is
not `none`. Checkboxes and text fields are targets without asking. A clickable element built outside
any portal is a ray target and nothing more: each element a ray acts on registers with its panel's
forwarder, which listens on the portal's container object and reads which of its elements each ray
event went through (`createPanelForwarder` in `elements/pointerForwarding.js`), so the panel does
all of the below once, for every element in it.

**A press.** Closing the trigger on a target sends `pointerdown` and `mousedown`; opening it sends
`pointerup`, `mouseup` and `click`. The element carries `data-xr-hover` while a ray is on it and
`data-xr-active` while it is held, each hand's flags its own: a button two hands are on, or two
hands press, keeps each flag until the last of them leaves or lets go. Clickable elements nest, if
only because `cursor` is inherited: the innermost one is the target, its events are sent once and
bubble from there, and every clickable element around it takes both flags, as `:hover` and `:active`
would. An ancestor that is not a ray target takes neither.

**The grip** is the mouse's other button: a press of it, let go on the element it started on,
arrives as `contextmenu`, which is where a page already flags a tile or opens a menu of its own. Not
a grip that something above the panel took as it closed — a `drag()` with `squeeze` among its
`buttons` picking up what the panel hangs from — and not one closed while the trigger carries a row
or moves a list, gliding included, on any panel: a page in the middle of a drag hears no other
button. A trigger only resting on a row moves nothing yet, and a grip under it is a right-click. The
grip's start is the one ray event that goes on past the panel, so that a scene can pick up with the
grip what the panel hangs from; a grip nothing took is the panel's, and its end, completion and miss
stop at the panel as a press's do.

**The point.** Every event carries the point the ray met as `clientX` and `clientY`, mapped onto the
page's own layout, so a page that finds what was pressed from where it was pressed — a board drawn
as one `<svg>` path — reads the place a mouse over the same spot would have given it. A press, its
release, its click, a right-click, a press on a scrolling list and the ray's arrival on a control
(by the rule the hover pulse follows, see **Haptics**) each read where the page lays the panel out;
a move, sent every frame, reads no layout and takes its point where the panel was last read, so a
hover starts exact and drifts only by what the page moves while the ray stays.

**Pointers.** A press, its release and a move each send, ahead of their mouse event, the pointer
event a browser sends ahead of it, at the same point, so a page written for pointers hears the ray
as well. They say `pointerType` `"mouse"`, but each hand is a pointer of its own, with a `pointerId`
from 2 on, since 1 is the mouse's, so a page that follows a drag by its pointer is not thrown when
the other hand's ray crosses the same element. Every event a hand sends carries the `buttons` it
holds, the trigger as 1 and the grip as 2.

One hand is the primary one, as a browser has a primary touch among several: the first hand whose
ray reaches a control while the primary one holds no button and points at no panel, or a hand whose
trigger closes while the primary one holds no button. Only its pointer events say `isPrimary`, and
only it sends `mousedown`, `mousemove`, `mouseup` and the mouse's enter and leave, so a page that
follows the mouse follows one hand and not two rays taking turns. When another hand takes over, the
mouse leaves what the first hand was over, on every panel, and is over what the new hand is over,
its captor if it holds a capture, before anything the new hand sends. A `click` and a `contextmenu`
go for either hand.

**Crossings.** As the ray moves from element to element, the page hears what a browser sends for a
mouse: `pointerout` and `pointerleave` from what the ray left and `pointerover` and `pointerenter`
on what it is on, then `mouseout`, `mouseleave`, `mouseover` and `mouseenter`, each naming the other
element as `relatedTarget`. The element a hand is over is the innermost control under its ray, with
the elements around it up to the panel's root; a ray that slides off the controls onto the panel's
background, or off the panel, leaves them all, at the point where the page last heard the pointer.
These hold still while the hand holds something draggable, as `:hover` does under a drag, and catch
up at the release.

**Cancels.** A page that cancels `pointerdown` hears no `mousedown`, `mousemove` or `mouseup` from
that hand until its trigger opens, and hears the `click` all the same. A press that becomes a scroll
or a drag and drop is taken from the page the way a browser takes one: the page hears
`pointercancel` where the press went, the pointer leaves what it was over on every panel, and
nothing more of that hand is sent, `pointerup` and `mouseup` included, until the trigger opens; then
the pointer and the mouse catch up with where the ray is, on every panel. A hand lost in the middle
of a press sends no release, and its pointer is cancelled the same way, the elements it held lose
`data-xr-active`, and the mouse leaves what the hand was over on every panel. `pointercancel` and
the leaves after it say where the page last heard the pointer: the last move or crossing before a
press became a scroll, and the press for a drag and drop, which `dragstart` says too. A release that
sends no `pointerup` catches the pointer and the mouse up where the ray is if it is on the panel,
and otherwise where the page last heard the pointer. The crossings that catch a panel up carry the
point where the ray crosses that panel, as a move does, and where the page last heard the pointer on
a panel the hand is over nothing on.

**Capture.** A browser knows nothing of the hands' pointers, so `setPointerCapture` with a hand's
`pointerId` would throw. Once a hand sends anything while a panel is up, the three capture methods
on `Element` are wrapped, and the last panel to go puts the browser's back. A capture the browser
refuses for a hand is kept here instead, starting before the hand's next event with
`gotpointercapture` on the captor. While it holds, the hand's moves and its release go to the
captor, and the pointer is over the captor and nothing else, as is `data-xr-hover`. The moves and
the release come from where the ray crosses the plane of the captor's panel, the moves once a frame
the ray has moved, wherever the ray is; a release whose ray crosses that plane nowhere says where
the pointer last was. The capture ends with `lostpointercapture` at the release, after its
`pointerup` and `mouseup`, at `releasePointerCapture`, when the press becomes a scroll or a drag and
drop, or when the hand is lost. `gotpointercapture` and `lostpointercapture` say where the page last
heard the pointer. Releasing a pointer that holds no capture does nothing, as for a pointer the
browser knows. The grip's `contextmenu` comes alone, as before.

**The wheel.** A panel with `thumbstickWheel: true` hears a hand's thumbstick as a mouse wheel, for
a page that zooms or pans on `wheel`:

```js
dom(ctx, drawing, [set({ position })], { thumbstickWheel: true });
```

While the hand's ray is on the panel and the hand holds no button, pushing the stick forward or
pulling it back sends `wheel` once a frame to the element under the ray: the innermost control the
ray is on, or, on a list's gaps or the panel's background, whatever element is there. A ray on an
object the scene hangs in the panel turns nothing, and on a panel with `opaqueToRays: false` only a
ray on a control or a list does. `deltaY` is in px (`deltaMode` 0) and negative for the stick pushed
forward, following how far the stick is pushed: nothing inside a small dead zone, 1000 px a second
at the stop. `clientX` and `clientY` are where the ray crosses the panel. Either hand turns it. The
wheel scrolls nothing of itself, since a list is scrolled by pulling it (see **Clipping and
scrolling**); a page that wants it to scroll one does that in its handler, with `scrollElementBy`.
It is off unless a panel asks, because a scene may read the stick for something else.

**In development**, a press that lands on an element of a panel's page with no ray target under it
warns once per element, naming the element. A press on the panel's empty root, or on an object of
the scene's own hung in the panel, is not one. Development is Vite's `import.meta.env.DEV`, or
`NODE_ENV` set to `development` where Vite is not used.

Followed:

- The browser's order and pairing of pointer and mouse events, their `buttons`, `pointerId`,
  `isPrimary` and `relatedTarget`, and `click` and `contextmenu` for either hand.
- `pointercancel` when a press becomes a scroll or a drag and drop, and for a hand that is lost,
  with the leaves a browser sends after it.
- Pointer capture per hand, kept beside the browser's, with `gotpointercapture` and
  `lostpointercapture`.
- The point on the page, exact for a press and a crossing, and where the panel was last read for a
  move.
- A scale on the mirrored root, or above it, in the mapping, so on a page scaled to fit its window
  the point is where the page draws that spot.

Not followed:

- The point is on screen only for a panel mirroring an element the page shows. A panel built from a
  tree lives in a container the portal parks off screen, so its points are right against the page's
  own rects but `document.elementFromPoint` and `caretPositionFromPoint` find nothing at them.
- A rotation, a skew, a flip or a perspective on the mirrored root's chain is left out of the point,
  as the mirror leaves it out (see **Mirroring DOM the page already has**).
- The ray event stops at the panel, except the grip's start, so nothing outside the panel hears a
  press the panel took.
- `pointerType` is `"mouse"` for a hand, and a hand's pointer is unknown to the browser, so only the
  capture methods wrapped above take its `pointerId`.
- The wheel is the thumbstick alone, and `deltaX` is always 0.

### Mirroring DOM the page already has

A mountable is for a panel that exists only in the scene. An app that delivers a flat interface
first, and an immersive session as something extra, already has its DOM — laid out, styled, wired to
its state — and `dom()` mirrors it where it stands:

```js
const hud = document.getElementById("hud");

dom(ctx, hud, [set({ position })]);
```

Nothing about the element changes hands. It stays in the document with the styles the page gave it;
the portal watches it with the same observer it watches its own container with, so whatever the
element holds when the portal is built is the initial content and whatever the page does to it
afterwards is followed. A press on the mirrored button is a click dispatched on the real one, and
the flags the portal writes are taken off again with the portal. When the session ends the page is
as it was. The portal marks the element `data-xr-portal` while it watches.

- **The element is the panel's frame, and what is drawn is what is inside it.** Its border box is
  the panel's size — a panel centred on its origin, a centimetre a px — and it is what
  `getPortalRoot` finds and what the background click lands on, but its own background and border
  are not mirrored. A card wants to be the element's child, not the element:

  ```html
  <div id="hud">
    <div class="card">…</div>
  </div>
  ```

- **It has to be in the document**, and the portal refuses one that is not, one that is already a
  panel, one inside a panel and one with a panel inside it, since every walk the mirror makes climbs
  to the nearest panel top and stops. A portal built over such an element does not `mount()`: the
  page owns the content.
- **It has to stay laid out.** `display: none`, or taking the element out of the document, measures
  every box at nothing, and the panel is an empty frame with no error to say why. Hide the page's
  own view with `visibility: hidden`, which keeps the layout, or cover it — the todo app puts the
  renderer's canvas over the page for exactly as long as a session is presenting.
- **Neither it nor anything above it may be turned.** Every box inside the element is measured
  through its client rect, which the browser reports with every transform above the box applied,
  while the element itself is placed as though it had none. A scale is undone: a page that scales
  itself to fit the window, by a `transform` that only scales and translates or by the `scale`
  property, on the root or anywhere above it, is measured at its layout size. A rotation, a skew, a
  flip or a perspective cannot be divided out, so a root on a chain that carries one has every
  offset, size and baseline inside the panel slightly wrong, and the portal says so once, with a
  `console.warn` naming the root and the element that carries the transform. It looks at the next
  measurement after it claims the root, the window resizes, the document's stylesheets change, or
  the root's own attributes or a transition on it change, and at once when the ray presses or
  arrives on a control, so a transform that arrives after the claim is caught at the next of those.
  Mirror an untransformed wrapper and transform what is inside it, or take the transform off for as
  long as a session runs, which is what the desk app does. A `perspective` counts only above the
  root: one on the root itself projects what is inside the panel, which the mirror draws as real
  depth, so it is neither refused nor warned about.
- The CSS `zoom` property is not read: a root under a `zoom` is measured at its zoomed size, with no
  warning.

### What a panel follows

A box is drawn from its computed style: background colour, a gradient (see **Gradients**), a border
width per side, `border-radius`, `opacity`, `visibility`, `transform` (see **Transforms**),
`overflow` (see **Clipping and scrolling**), and its place in the page's paint order (see
**Layers**). Text is rasterized once as a mask and coloured by its material, so animating `color`
re-draws nothing; text with a `text-shadow`, or a decoration coloured other than the text, keeps its
colours baked into the texture and re-draws per change.

**A change to the DOM is followed as far as it can reach.** Every attribute is followed: a class, an
inline style, `hidden`, an app's own `data-*` or `aria-*` flag. Changing one restyles the element,
its subtree and its siblings (apart from the SVG geometry below), and re-measures the element's
subtree. Then the element and what comes after it in its parent re-measure where they are, every
item in the row when the parent is a flex row. The change climbs on to the parent's own siblings if
the parent changed size or is an inline box, and so on up to the panel, which resizes with what it
holds. So a menu opened by a class, or a section shown by taking `hidden` off, resizes the panel as
it would if it were mounted. A change that moved nothing costs a client rect for the element, for
each element after it and for the parent, a text measurement for each text node after it, and a
client rect for each positioned box in the panel.

Two changes stay cheaper. An inline `style` write that moves no box but the element's own
re-measures the element's subtree and nothing around it: a write of properties that move no box at
all — `transform`, `opacity`, a `visibility` other than `collapse`, the colours — and a write of the
offsets, sizes and margins, physical or logical, on an element positioned `absolute` or `fixed`. So
a gauge that writes `style.transform` every frame, and a scrollbar thumb that writes `top` and
`height` on every scroll, pay for re-measuring themselves alone. Changing `position` itself moves
what follows. Inside an `<svg>`, the attributes that place and size what it draws — `x`, `y`,
`width`, `height`, `x1`, `y1`, `x2`, `y2`, `cx`, `cy`, `r`, `rx`, `ry`, `d`, `points`, `dx`, `dy`,
`rotate` and `transform` — restyle the element and its subtree but not its siblings, since a shape
is placed in user space and moves none of the shapes beside it; on the `<svg>` root itself, `width`
and `height` size a box in the page and reach its siblings as any attribute does.

**Hover and press are presentational, by contract.** The four attributes the portal writes itself —
`data-xr-hover`, `data-xr-active`, `data-xr-checked` and `data-xr-focus` — restyle the panel but are
declared unable to move it. Colour, background, border colour, opacity and `transform` all work; a
width, a padding or a font size that changes under the ray is not mirrored, and the boxes stay the
size they were. Three of the four carry a second restriction: **`data-xr-hover`, `data-xr-active`
and `data-xr-focus` may only style the element they match and its subtree.**

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

.button[data-xr-hover] {
  transform: translateZ(4px) scale(1.04); /* fine — a matrix write */
  padding: 12px; /* ignored — this is layout */
}
```

These are the most frequent mutations a panel sees — one per element the ray crosses, three more on
a press — and how far a change may style is how far the portal must go looking; `mirror.js` says
what the contract saves and why `data-xr-checked` is left out of the second restriction.

**A row arriving costs the row.** A change to a child list can only change the verdict of the
positional selectors, and the mirror follows those exactly as far as CSS lets them look: forward
from the change — `~`, `+`, `:nth-child`, `:first-child` and their `-of-type` forms restyle the rows
after the arrival — and one element back, for `:last-child`, `:only-child` and the `-of-type` pair.
Inserting or removing in the middle restyles the rows from that point on; prepending restyles the
list, correctly, since every row's `:nth-child` position changed. A change restyles what sits beside
the list as well only when it may have made the list empty or ended its being empty: when the list
holds no element or text that it held before the change. A comment does not count toward `:empty`,
so the first row into an empty list that holds only a framework's comment anchor restyles the list's
neighbours. A log that drops its oldest row as each new one arrives keeps its other rows, so it
restyles its rows and leaves the rest of the panel alone.

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

Followed:

- Every attribute change, with the restyle and re-measure above; `hidden` and `display` changes
  resize the panel around them.
- The document's stylesheets changing (see **Stylesheets**).
- `opacity`, as the product of the element's and every ancestor's up to the panel's top, on each box
  and run of text.
- A border width per side, and one border colour: the colour of the first side that draws a border,
  in the order top, right, bottom, left. A side with no width, or a transparent one, draws none, so
  a divider under `border-top: 2px solid transparent` is drawn in its own colour.

Not followed:

- A layout change under `data-xr-hover`, `data-xr-active`, `data-xr-checked` or `data-xr-focus`, and
  a sibling combinator on all but `data-xr-checked`.
- `:nth-last-child` and `:nth-last-of-type`: a row appended at the end shifts every earlier row's
  position from the end, and following them would restyle the whole list on every append.
- `:has()`: a change to the rows does not restyle a list or an ancestor matched by what it contains.
- A rule like `circle[cx="3"] ~ circle` on an SVG geometry attribute.
- A rule that selects on `data-xr-portal`, `data-xr-loading` or `data-xr-busy`: the container is
  above every element in the panel, and the mirror ignores it.
- Sides bordered in different colours are drawn in the first side's, and a dashed, dotted or double
  border is drawn solid.
- `opacity` where what is inside overlaps: a browser fades the subtree as one layer, and a panel
  fades each box and run, so a child shows through the one under it.
- A classic scrollbar brought in by a positioned box grown past the bottom of a scroller, on a
  desktop page.

### The panel's background

A ray that lands on the panel but on none of its buttons hits the blocker spanning the container,
which dispatches a bubbling `click` on the portal's root element. That is what "clicked outside"
means to a menu that wants to close itself. The click carries the point the ray met, so a `<canvas>`
board, which is not `cursor: pointer` and takes its clicks this way, finds the square from `clientX`
and `clientY`; so does the click a press on a scrolling list's own padding sends when it became no
scroll, and the one a press on an overlay's own background sends the overlay.

Count only the panel's own clicks as elsewhere, via `getPortalRoot(node)`, and ask it when the click
arrives rather than when the listener goes up, since which panel a node is in changes as a session
starts and ends:

```js
document.addEventListener("click", (event) => {
  if (root.contains(event.target)) return; // inside
  const panel = getPortalRoot(root);
  if (panel && !panel.contains(event.target)) return; // the page, not the panel
  close();
});
```

Every real mouse click on the page around the scene — the VR button, and in development an emulator
whose every control is a mouse click — also reaches the document, and a menu that counted those
would close itself the moment you reach for the control that was going to choose from it.
`getPortalRoot` returns null off a portal, where the whole page is the right scope. The `dropdown`
and `scrollable` widgets in [`@apendua/justui`](../justui) do it this way.

A panel with nothing to press can say so and stop stopping rays:

```js
dom(ctx, panel, [set({ position })], { opaqueToRays: false });
```

That is for readouts, and mainly for a head-locked overlay, which rides between the eye and the
whole scene. What goes is the panel's own background, and only that: a `cursor: pointer` element
inside is still a ray target.

### Loading, budget and updates

Building a mirrored element costs real work — an object, its measurements, its place in the batches
— so the portal queues what the observer reports and spends a budget of each frame on it, and the
frame keeps its rate however large the mount.

| Option             | Default                                           | What it does                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portalBudget`     | three tenths of the frame, clamped to 1.5 to 8 ms | On `render()`: milliseconds of each frame every portal in the scene shares, a number or a getter read at the top of every frame; the default is 5 ms at 60 Hz and 8 ms at 30 (`createFrameShareBudget`). |
| `priority`         | `0`                                               | Pumps of higher priority are offered each frame's pool before lower ones; within a priority the offer rotates frame by frame.                                                                            |
| `budget`           | `5`                                               | Milliseconds per frame for a portal built outside a rendering context, which paces itself; ignored under `render()`.                                                                                     |
| `atomic`           | `true`                                            | An update lands whole, in the frame that finds nothing left to read; `false` runs the writes under the budget and lets the panel change in instalments.                                                  |
| `loadingFrame`     | `{ delay: 250, minimumTime: 500 }`                | The frame shown where the panel will be while a long mount runs; `false` for none. Also `color` (black), `fill` (white), `fillOpacity` (0.2), `borderWidth` (2), `radius` (12).                          |
| `onLoadingChanged` | none                                              | Called once, with `false`, when everything the initial content brought has been built and settled.                                                                                                       |

```js
render(Scene, {
  // A sliver while a hand is busy, generous otherwise; `Infinity` would
  // finish every mount in flight within the next frame.
  portalBudget: () => (interacting.get() ? 1 : 8),
});

dom(ctx, panel, [set({ position })], { priority: 1 });
dom(ctx, readout, [set({ position })], { loadingFrame: false });
dom(ctx, menu, [set({ position })], {
  loadingFrame: { color: "white", fill: "black", fillOpacity: 0.4, radius: 8 },
});
```

- **The budget is the scene's, not the panel's.** `render()` installs one scheduler per rendering
  context, and every portal under it draws frame time from the same pool, since three panels each
  honouring a private five milliseconds would cost the frame fifteen. The budget bounds when work
  stops being started, not how long a piece takes: at least one element is built and at least one
  update runs per frame. The grain is the element, not the inserted subtree. Where there are no
  frames to slice across — no renderer and no `requestAnimationFrame`, as under a test runner — the
  portal mounts synchronously.
- **A panel is loading until its initial content is whole.** While that runs it stops no rays and,
  if the mount outruns `delay`, shows the loading frame: a translucent rounded rectangle the panel's
  size, with three dots that brighten in turn, placed exactly where the panel will be and replaced
  by the panel in the same frame. Once shown it stays up for `minimumTime` at the least, the mount
  held built and unseen until then. Loading ends exactly once; a panel that is already visible never
  shows the frame again. The container carries `data-xr-loading` from the first content it is given
  to the load, so a harness can ask `document.querySelector("[data-xr-loading]")`. A panel given
  nothing to mount never carries it.
- **An update lands whole.** The panel's channel is atomic (`UpdateChannel`'s option of that name in
  `@apendua/signal`): each frame's budget goes on resolving what the update will read, and the
  writes to the scene happen together, in the frame that finds nothing left to resolve. Until then
  the panel stands exactly as it was, its own size and placement included, and objects built for
  rows that arrived wait for it too, as do the objects of rows that left. The wait has a bound. Once
  a panel has nothing left to build and has waited a second (`MAX_COMMIT_WAIT` in `portalPump.js`)
  for its reading to finish, the next frame reads everything at once and the update lands, so under
  input that never stops — an endless animation, a timer faster than a slow frame, a drag — the
  panel lands in one long frame about once a second. Once the page adds a node five seconds or more
  into a mount (`MAX_BUILD_WAIT`), one frame builds everything queued. A loading frame still up for
  its minimum time holds both. A drag whose reading fits the budget commits every frame on an atomic
  panel too; one whose reading overruns it on every frame wants `atomic: false`.
- **`data-xr-busy`** is on the container while a panel has work it will do on a coming frame — an
  animation the clock is sampling, an update the pump has not yet brought into the scene — and comes
  off on the frame that draws the last of it. A harness pins the page's animations, then waits for
  `document.querySelector("[data-xr-busy]")` to come back empty.
- **A scroll is never deferred.** Everything the offset moves — the content group's translation, the
  clip boxes, the culling at the window's edges — is arithmetic on cached values and settles
  synchronously in the event that carried the scroll, whatever the budget.

### Dragging and dropping

A page that sorts a list or moves cards between columns with the browser's drag and drop works in a
panel unchanged: the panel sends the same events the browser would, in the same order, to the same
elements.

```html
<div class="column">
  <div class="card" draggable="true">…</div>
</div>
```

```js
card.addEventListener("dragstart", (event) => {
  event.dataTransfer.setData("text/plain", card.id);
  event.dataTransfer.effectAllowed = "move";
});
column.addEventListener("dragover", (event) => {
  event.preventDefault(); // this column takes drops
  event.dataTransfer.dropEffect = "move";
});
column.addEventListener("drop", (event) => {
  event.preventDefault();
  const id = event.dataTransfer.getData("text/plain");
  column.append(document.getElementById(id));
});
```

The gesture is a mouse drag done with the trigger. Closing it on a `draggable="true"` element, or on
anything inside one, is a `mousedown`. While the hand has moved less than the scroll gesture's few
px the press is still a press, and letting go is a click. Past that the page gets `dragstart` on the
draggable element and, right after one it let through, `pointercancel`. After it, once a frame, the
source gets `drag` and the element under the ray gets `dragover`, with `dragenter` and `dragleave`
as the ray moves from one element to the next. Opening the trigger sends `drop` to the element under
the ray, if its last `dragover` was cancelled, and `dragleave` to it otherwise. `dragend` goes to
the source either way. A drag sends no `mouseup` and no `click`.

Followed, as the browser's rules:

- Cancelling `mousedown` stops the press from becoming a drag, and cancelling `dragstart` leaves an
  ordinary press that ends in a click.
- An element takes a drop only by cancelling `dragover`. Its `dropEffect` then has to be one the
  source's `effectAllowed` allows, or the drop is refused. `dragend` carries the operation that
  happened in its `dropEffect`, `"none"` for a drop nobody took.
- `dataTransfer` is writable in `dragstart` only. During the drag a handler sees `types` but
  `getData` returns `""`, and `drop` reads the data.
- The element under the ray can be any element in the panel, not only a ray target, found the way a
  page hit-tests: later siblings over earlier ones, children over their parents,
  `pointer-events: none` and `visibility: hidden` letting the ray through, and nothing found where
  an overflow-clipping ancestor cuts an element off.
- The events carry `clientX` and `clientY`. `dragstart`, a drag's arrival on another panel and
  `drop` read where the page lays the panel out; the other frames take the corner last read, as a
  `mousemove` does.
- `:hover` does not change under a drag: the elements the ray crosses take no `data-xr-hover` and
  hear no `mousemove` until the trigger opens, and the control the ray is on then takes it on the
  next move.
- What a page draws while it drags — a class, an inline style, an attribute of its own — and
  `draggable` itself: a row made draggable after the panel was built can be picked up.
- A drag can end on another panel in the scene, or on nothing, where letting go drops nothing. A
  drag whose panel is taken down, or whose controller is lost, is cancelled with a `dragleave` and a
  `dragend` whose `dropEffect` is `"none"`.
- A translucent card the size of the source, or of what `setDragImage` was given, follows the ray in
  the panel the ray is on, and in the plane of the last panel it was on while it is on none. It is a
  picture of the source taken once, at `dragstart`, by rendering the source's panel into a texture
  through a camera framed on the element's box: one render pass per drag, nothing per frame, with
  the shaders compiled when the press begins. Every panel in the scene knows a hand is carrying
  something, so no control takes hover under a drag.

Not followed:

- Only `draggable="true"` makes an element draggable. Images and links are not, since what a browser
  drags out of them is a URL for another application, and counting them would take scrolling away
  from every list of links.
- `dataTransfer.files` is always empty and there is no `dataTransfer.items`: nothing is dragged in
  from outside the page.
- A drag does not scroll a list it is held near the edge of.
- The ghost pictures what the panel draws behind the element inside its box, the card it sits on
  included, where a browser's has the element and its descendants alone. It is the element's outline
  instead where there is nothing to take a picture of: without a WebGL renderer, as under a test
  runner, and for a drag image the source's panel does not draw.

### Haptics

Every control in a panel — every element the ray-target rule covers — pulses the controller's motors
when the trigger closes on it, and the grip as well, as it closes and as it opens. Not a grip that
something above the panel took as a grab, nor one closed while the trigger carries a row or moves a
list; a grip not felt closing is not felt opening either. Nothing is marked: a panel with buttons in
it is felt, and so is the keyboard.

```js
dom(ctx, numberPad, [set({ position })], {
  haptics: { hover: true, strength: 0.6, flavor: "knock" },
});
```

| Option     | Default  | What it does                                                                                                                                                                                                                                                                                                               |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hover`    | `false`  | Whether the ray arriving on a control is felt. On for the keyboard a field brings up unless the panel says `hover: false` by name.                                                                                                                                                                                         |
| `active`   | `true`   | Whether a press is felt, and its release where the flavor has one.                                                                                                                                                                                                                                                         |
| `strength` | `1`      | Multiplies every pulse, clamped to what the motors can do.                                                                                                                                                                                                                                                                 |
| `flavor`   | `"tick"` | `tick` (a light high-frequency click), `knock` (the low motor, a thump), `buzz` (longer and softer), `key` (a mechanical key, felt closing and opening), or a `HapticFlavor`: a `hover` pulse, a `press` pulse and an optional `release` pulse, each a `duration` in ms and a `strong` and a `weak` magnitude from 0 to 1. |

`false` is no haptics for the panel whatever the scene says; there is no `true`, for the reason
`loadingFrame` has none. `HAPTIC_FLAVORS` holds the named flavors to start from.

- **What plays is the hand's own.** The event carries the input source three connected to the
  controller, and every actuator of its gamepad gets a `dual-rumble` effect, or a `pulse` on a
  runtime that only has that. A tracked hand has no motors and feels nothing.
  `playHaptic(source, effect)` is that driver on its own, for a scene with haptics of its own to
  play, and `playHapticAll(session, effect)` plays one effect on every input source of a session,
  doing nothing when the session is null.
- **A hover is one pulse per arrival on a control.** The control is the outermost element in the
  unbroken run of clickable ancestors and everything in it, so a ray moving between a button's
  background and its label plays nothing; coming from another control or from a scrollable list,
  which is a ray target to be dragged by and not a control, is an arrival. Nothing on the panel
  being scrolled plays while the hand is scrolling it, glide included; a control on another panel
  the ray crosses meanwhile is entered as usual. `haptics.js` says how the enter's `relatedTarget`
  decides it.
- The keyboard a field brings up follows the `haptics` of the panel it is typing for, with the hover
  on; a panel with `haptics: false` has a silent board too.

Not followed: a distinct control nested in another — a delete button inside a clickable row — whose
hover from the row is not an arrival. Its press still is.

## Baking a panel into a stamp

A portal is the right price for a panel, which is a view of something that keeps changing, and the
wrong price for a _picture_ — a card, a number chit, a badge — which is the same in every copy of
itself. `createBakery(ctx, faces, options)` draws each distinct face exactly once, into an oven
parked out of sight, and hands out copies:

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

| Option         | Default | What it does                                                                                                      |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `settleFrames` | `3`     | How many frames to wait after the last face reports itself mounted; a test driving its own frames may want fewer. |

- `oven()` is mounted once, anywhere in the scene, and draws nothing anybody sees. `stamp(name)`
  returns null while the oven is working and a fresh copy afterwards; `ready()` is reactive. A face
  the bakery was never given throws.
- A stamp is a `clone()` of the finished portal's tree, sharing its geometry, materials and
  textures, so it costs a handful of objects and no DOM. Stamps keep their matrices the way the
  panel they came from does (see **Placing a panel**).
- **The oven's portals are never disconnected, and must not be**: disconnecting one disposes what
  every stamp holds a reference to. Keeping them costs a matrix comparison per portal per frame and
  nothing else, since the DOM never changes again.

Not followed: stamps are not interactive. Nothing inside a baked face registers as a ray target, and
a clone would not carry the registration if it did; anything that has to be pressed wants a plain
invisible mesh in front of it.

## Checkboxes

`<input type="checkbox">` is projected as a component of its own — a box with a mark in it — and the
tick is drawn in the scene, in the element's own `color`:

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

- Everything but the tick comes from the same declarations any other box is drawn from.
  `appearance: none` is implied in a scene and is what the flat build needs to match.
- A checkbox is a ray target without asking; `cursor: pointer` is still worth writing for the page,
  and a disabled checkbox is not pointable however it is dressed.
- The ticked state is written back onto the element as `data-xr-checked`, since `:checked` changes
  no attribute. It carries the presentational contract `data-xr-hover` does — a ticked box may
  change colour, not size — but not hover's other restriction: `input[data-xr-checked] + .label`
  works and is the form to reach for.
- The DOM stays the thing that is true. A ray's click is a click, so the browser toggles and fires
  `change`, and an app reads `checked` and listens for `change` as on a page, `set("checked", …)`
  from the other direction included: the portal hears an assignment through an accessor of its own
  on the element, there while a panel shows the box and taken off once none does.

Not followed: every other kind of `<input>` but the text fields below is drawn as a plain box. A
range's thumb, a colour swatch and a file picker's button are chrome the DOM does not describe.

## Text fields and the keyboard

`<input type="text">`, and the other types that hold a line of text (`search`, `url`, `tel`,
`email`, `password`, `number`), are drawn as a box with the value in it, or the placeholder while
the value is empty, in the colour the page gives placeholders. A field is a ray target without
asking, and a disabled one is not. The value is not a text node, so the portal follows it through
the `input` and `change` events a keystroke dispatches and through the `value` property itself,
intercepted on the element for as long as the portal watches it, so that `input.value = ""` after a
submit is followed. A `value` or `placeholder` attribute rewritten from outside is followed too.

Typing into one needs a keyboard, and the system's never reaches the panel. What does is a board of
ordinary boxes, mirrored by a portal of its own; `keyboard(props)` in [`@apendua/justui`](../justui)
is one. This package has no keyboard and does not depend on one, so a scene gives it a factory,
once, for every panel:

```js
import { keyboard } from "@apendua/justui";

render(Scene, {
  panelOptions: {
    keyboard: {
      create: ({ onKey, field }) => keyboard({ classes, onKey, field }),
    },
  },
});

dom(ctx, codeEntry, [], { keyboard: { create: ({ onKey }) => codeKeyboard(onKey) } });
dom(ctx, readout, [], { keyboard: false });
```

| Option      | Default    | What it does                                                                                                                                                                                          |
| ----------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`    | required   | Builds the board's DOM for a field, wired to the `onKey` it is given. `field()` says which field it is typing into, `element` the one it was built for, `dismiss()` closes it.                        |
| `placement` | `"viewer"` | `"viewer"` opens the board in front of the player and leaves it there; `"panel"` hangs it below the panel of the field being typed into; a function poses it when it opens (see `KeyboardPlacement`). |
| `reach`     | `0.45`     | Metres ahead of the eyes the board's top edge opens, with `"viewer"`.                                                                                                                                 |
| `drop`      | `0.2`      | Metres below the eyes, with `"viewer"`.                                                                                                                                                               |
| `tilt`      | 24°        | How far the board is reclined toward the viewer, in radians, hinged at its top edge.                                                                                                                  |
| `scale`     | `0.001`    | Metres per CSS px of the board, with `"viewer"`; `"panel"` uses the panel's scale.                                                                                                                    |
| `gap`       | `12`       | Px between the panel's bottom edge and the board's top, with `"panel"`.                                                                                                                               |
| `preview`   | `true`     | Whether a board in the room carries a copy of the field above its keys; an object sets `tilt` (15°), `gap` (8 px) and `className`. Not used by `"panel"`.                                             |

A panel's `keyboard` is laid over the scene's, so a panel for entering a code can bring a different
board, and `keyboard: false` gives a panel none. A portal built outside `render()` keeps a board of
its own, given its own `keyboard` option. Without a keyboard a field is drawn and pressed like any
box, and nothing in the scene can type into it, which is what a read-only readout in an `<input>`
wants.

- **There is one board for the whole scene.** Whichever field was pressed last is the one being
  typed into, whatever panel it is in: the board stays up, `onKey` types into the new field, and
  `field()` says which. The board is only built again if that panel's keyboard has a different
  `create`.
- **It opens in front of the player**, turned toward them and reclined by `tilt`, and stays where it
  is in the room until it goes. The `placement` the board opens with is the opening panel's and
  holds until the board goes: a field pressed in a panel that asks for another placement types into
  the board where it already is. A board in the room keeps the opening panel's `scale` and `tilt`
  too. A board below a panel moves to the panel of the field being typed into, and takes `gap`,
  `tilt` and its scale from whichever panel it hangs below. On a plain page, or under a test runner,
  it hangs below the panel.
- **It can be moved.** A board in the room has the strips a draggable panel has (see **Letting the
  player move a panel**), and always has them. The carry takes the anchor the board hangs from, so
  the next board opens where the player put the last one down, unless they have since walked more
  than a metre or turned more than 60° away. A board below a panel has no strips, moves with the
  panel, and does not show the panel's strips when a ray is on its keys.
- **It shows what is being typed.** A board in the room carries a copy of the field above its keys:
  the value as it is typed, the placeholder while it is empty, the caret where the next key goes,
  hinged toward the player. It is unmasked, since only the player can see it. It wears the field's
  own look unless `preview.className` names a class of the app's, and carries
  `data-xr-keyboard-preview` (`PREVIEW_ATTRIBUTE`) either way. Its caret is placed by a ray, as the
  field's is, and goes into the field.
- **A key goes into the field through `typeIntoInput(input, press)`**, exported too: the character
  goes in at the caret, backspace takes one out, and `keydown`, `input` and `keyup` are dispatched
  in a browser's order. `Enter` asks the field's form to submit, if it is in one, and keeps the
  field being typed into, so an app that clears the field after a submit can take the next entry
  straight away. While the board is up the field carries `data-xr-focus` (`FOCUS_ATTRIBUTE`), a
  presentational flag like `data-xr-hover`, and a caret.
- **The board follows focus the way a page does.** A press anywhere in a panel with a keyboard other
  than on a field — a button, a row, the background — is focus leaving the field, and the board
  goes; a press on another field moves the typing there, and so does a press on a field's `<label>`,
  which is a ray target whatever its `cursor` unless it is under `pointer-events: none`. A label of
  a field outside the panel, or of one that is read-only or disabled, is anywhere else, and so is a
  button, a link or another control inside a label. The board also goes on `Escape`, which a board
  can offer as its "done" key, when the field leaves the document or its panel goes, when the
  session ends, and with the scene; `dismiss` on the target closes it for any other reason.
- **The caret.** Pressing a field puts the caret at the end of the entry; once the field is being
  typed into, a press puts it between the two characters nearest where the ray landed, and holding
  the trigger while the ray slides along the field drags it, for as long as the ray is on the field.
  A password is measured by its bullets. The mirror scrolls the value as a page does, only when the
  caret would leave the field and only as far as it takes to bring it back. The caret blinks every
  530 ms, stays solid for a moment after each keystroke, and is a mesh of its own, so a blink flips
  its visibility and nothing on the panel is drawn again.
- **A number field is typed the way a page types one.** `1.` on the way to `1.5` is not a number, so
  `value` reads `""` while the field keeps a draft of what was typed and the mirror draws it.
  `input` is dispatched for every key, the ones that leave `value` empty included. A letter never
  gets in. The draft goes when the app writes the value.

Not followed:

- No selection, only a caret.
- `number` and `email` fields keep a caret the page cannot reach — `selectionStart` reads null and
  `setSelectionRange` throws on them — so one placed by a ray is kept alongside the field instead,
  and typing goes in there all the same. A value the app writes puts it back at the end.
- A press in a panel with `keyboard: false`, or on the scene outside every panel, leaves the board
  up: only a panel with a keyboard listens for the press that dismisses it.
- The keyboard's preview shows a password unmasked, by design.
- A `<textarea>` is a plain box: its value is not drawn, and it cannot be typed into or scrolled.

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
  deep, and the depth buffer clips it into the panel. Give anything 3D-rotated enough `translateZ`
  to keep the swing in front.
- A transformed element paints over the earlier siblings it overlaps, the way a positioned one does
  (see **Layers**).
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
- A transformed element's clip box turns with it (see **Clipping and scrolling**).

## Stylesheets

A panel follows its document's stylesheets, not only its own elements. Rewriting a `<style>`
element's text, adding or removing a `<style>` or a `<link rel="stylesheet">`, and a `<link>`
finishing its load each restyle the panels, which is how the `className` and `stylesheet` tags in
[`@apendua/justdom`](../justdom) reach a panel.

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

**Theming mode** follows those too, by reading the text of every rule on a timer:

```js
import { enableThemingMode } from "@apendua/freedom";

if (new URLSearchParams(location.search).has("theming")) {
  enableThemingMode(); // returns a function that turns it off again
}
```

| Option     | Default | What it does                                                                     |
| ---------- | ------- | -------------------------------------------------------------------------------- |
| `interval` | `250`   | Milliseconds between reads; anything that is not a positive number reads as 250. |

While it is on and a panel is mounted, it reads every rule's text each interval and restyles the
panels when the text changed, so a drag across the developer tools' colour picker lands as one
restyle per read. The read takes a few milliseconds on a large stylesheet, on a timer outside the
frame loop, which is fine at a desk and not worth paying in a headset. Sheets brought in by
`@import` are read with the sheet that imports them; a sheet from another origin served without CORS
hides its rules from script, and edits to it are not followed. The apps here turn it on with
`?theming`, through `followThemingQuery()` in `@apendua.dev/headset`.

## Outlines

Outlines mode draws a rectangle round each element of a panel that changed, so a developer can see
which parts of a panel change more often than they should, and which the mirror measures again for
nothing:

```js
import { enableOutlinesMode, outlinesReport } from "@apendua/freedom";

const off = enableOutlinesMode(); // returns a function that turns it off again
console.table(outlinesReport()); // the busiest elements so far, for a headset
```

The apps here turn it on with `?outlines`, through `followOutlinesQuery()` in
`@apendua.dev/headset`. Each outline is decided at a commit of its panel, from what happened to the
element since the commit before. The line says why the element is outlined, and the colour how
often:

| Line                                | Kind          | What it means                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Solid, coloured by rate             | changed       | The page changed the element: one of its attributes, its text or its children.                                                                                                                                                                                                                                                       |
| Dashed (6 px on, 4 off), by rate    | ripple        | The page did not touch the element, and something the panel reads for it came out different all the same: a row moved down by the row above it growing, or a label that inherits a colour its card changed.                                                                                                                          |
| Dotted (1.5 px on, 3 off), by rate  | wasted        | The page did not touch the element, the panel read it again, and everything came out as it was. Something told the mirror the element may have changed and it had not. That is where a gap in the mirror's filtering shows: a restyle that reached further than it had to, or a layout walk that told more rows they moved than did. |
| Grey, solid                         | no-op write   | The page wrote to the element what was already there. The mirror drops such a write, so it costs the panel nothing past the observer, but the page is still doing work for nothing, often on every frame.                                                                                                                            |
| Magenta, round the whole panel edge | forced commit | The panel's commit had to be forced, because the reading before it never finished within `MAX_COMMIT_WAIT` or the page kept adding rows past `MAX_BUILD_WAIT`. Something in it changes on every frame.                                                                                                                               |

- A commit sees an element by the strongest thing that happened to it, in the order of the table. An
  element the layout walk told it may have moved, and that nothing read again, cost nothing and is
  not drawn, though the report counts it.
- The rate counts the commits that outlined the element over about the last second: blue under two a
  second, green from two, yellow from five and red from ten. Each outline fades over a second. An
  HTML element, and an `<svg>` root, is outlined round its border box; an SVG element inside the
  root round its `getBBox`, in its own user space.
- An outline goes up in the frame its commit is drawn in, never before, since an atomic panel shows
  the page as it was at its last commit. A write of what was already there leaves no commit coming,
  so its grey line goes up as the observer reports it.
- `outlinesReport(limit)` lists what the mode has counted since it was turned on, one row per
  element still in the document, the most often outlined first, with `limit` 20 by default: a short
  path to the element, how many commits outlined it, and its totals of changes, writes of what was
  there, layout ripples, reads run again, and reads that came out unchanged.
- Three outlines are expected and not a bug: a hovered element flashes blue, since the portal writes
  `data-xr-hover` on it; the children of an element whose class changed often go dotted, since the
  mirror restyles them to learn that nothing they inherit changed; and an animated element stays lit
  while it runs.

Not counted: an effect that writes to a mesh on every frame from `useFrame` changes no DOM and reads
no mirror, and draws no outline. Off, the mode costs the mirror one check per thing it would count.
On, a panel is slower than it would be, so measure frame times with it off.

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
  [`apps/showcase-xr`](../../apps/showcase-xr) types itself out on a card that can be tilted while
  it runs.

Not followed:

- A line running both ways is revealed as a unit: the prefix of a line with both directions of text
  on it is not a rectangle, so the line stays hidden until the cursor is past it and is then drawn
  whole. A line running entirely right to left cuts from its right edge.
- Tight leading trims descenders until the next line catches up. Line boxes that overlap share a
  band in which the finished line's descenders and the next line's ascenders sit at the same y, and
  the cut keeps that band hidden until the next line is being typed.

## Layers

An element that is positioned and stacked above — `position` other than `static` plus a positive
`z-index`, the same declaration the flat build needs anyway — becomes a layer of its own:

```css
.menu {
  position: absolute;
  z-index: 1;
  top: 100%;
}
```

It is pushed clear of the surface it covers, so the depth buffer and stereo both agree that it
floats; its whole subtree is drawn in a band above everything below it; and it is opaque to rays,
through a blocker of its own, so the ray that lands between two menu rows does not carry through to
a panel button a few millimetres behind. Layers stack by nesting, not by how big the number is: a
menu inside a modal is two layers up, `z-index: 1000` is still one. `elevation.js` is the model in
full, with every limit.

Followed:

- Siblings that a page paints over one another are stacked in depth in the same order. An element
  that is positioned or has a `transform` of its own is drawn in front of every such sibling it
  overlaps and a page paints under it, one content step (2 px) in front of the farthest thing that
  sibling draws, its pins and badges included. Siblings that do not overlap stay at the ordinary
  step, so a board of separate cards stays flat however many it holds. That keeps a clock's hands on
  its dial, a card laid over another card in front of the first card's text and pin, and a modal in
  front of a later `position: relative` page that covers it.
- The page's order: a negative `z-index` under the rest, a positive one over it, and tree order
  within each. To bring a card to the front, append it to the end of its parent again.
- A pin with a positive `z-index` inside a card that is no stacking context (no `z-index`, no
  transform of its own, `opacity` 1 and `position` other than `fixed` or `sticky`) stays over the
  later card, as on a page.
- A card that is not opaque, stepped over another, is drawn after everything the other card draws,
  so the other card's content shows through it tinted, as on a page. A caption with no background
  keeps its text, which writes no depth, in front of the boxes it is laid over, at any alpha. An
  opaque card hides what it covers in either order.
- A box anchored above a scroller that its siblings scroll in counts as covering all of them, so its
  lift and theirs stay put while the list scrolls.

Not followed:

- **Flow siblings are not stepped.** Only an element that is positioned or transformed clears its
  siblings, and only those that are too. A box pulled over a neighbour by a negative margin stays on
  the plane of what it covers, and so does a positioned box over a flow sibling, which puts it
  behind that sibling's descendants, a step per level of nesting: the positioned box's own text can
  sit behind a child of the box it covers.
- Only the sign of `z-index` counts, and boxes with a negative `z-index` stay on one plane.
- A transformed element counts as covering the axis-aligned box around its corners, and a descendant
  that overflows its parent's box does not count towards what the parent overlaps.
- Text that overflows an opaque card is the one mark the card does not cover.
- Only the stepped box itself is asked whether it is opaque, so a positioned wrapper with no
  background around an opaque card draws after what it covers, and a board of such cards takes two
  box buckets and a text bucket per card, each a draw call per eye, where opaque cards alone would
  share them.
- **A layer that hangs outside its panel's silhouette is drawn at that panel's depth.** A panel
  placed in front of it hides it and takes its rays, however high the layer's `z-index`. Keep an
  overlay within the silhouette of the panel it belongs to where you can, and keep it out of the
  flow — a menu that grew the panel would re-centre it under the ray that opened it. Where an
  overlay has to overhang, the remedy is the app's placement: Euclid's toolbar sits 18 cm nearer the
  viewer than its drawing.
- A native `<select>` cannot work here: `<option>` has no CSS box, and the list the browser pops up
  is chrome. Nor can the system keyboard. Both are in [`@apendua/justui`](../justui), built out of
  ordinary elements: `dropdown(props)`, whose `root` is the positioning context and `menu` the
  layer, and `keyboard(props)`.

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
- A box's `background-image: url()` (see **Gradients**).

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
[`@apendua/justui`](../justui): arrows, a track and a thumb, over a viewport that hides its
overflow. It scrolls through `scrollElementBy(element, dx, dy)`, which is exported here and is the
write above plus the `scroll` event the browser will not dispatch while the session has the display.

## Placing a panel

Everything a portal draws composes its local matrix once, in the effect that placed it, rather than
being recomposed every frame on the chance it moved, which is most of what makes an idle panel
cheap. Place the panel however you like:

```js
$(new THREE.Group(), [
  effects((group) => {
    group.position.set(0, 1, -2);
    group.scale.setScalar(0.01);
  }),
  children(dom(ctx, App(ctx))),
]);
```

three propagates a recompute downwards, so a group left on three's defaults would hand a panel below
it back all the work it opted out of. A portal declines that at its own perimeter: it recomputes its
own world matrix each pass and passes the recompute on only when that matrix came out different, so
a panel that is not moving costs a matrix multiply (`place.js` says how). `place` and
`placeAndScale` are exported for a scene's own static objects:

```js
import { place, placeAndScale } from "@apendua/freedom";

placeAndScale(group, 0, 1, -2, 0.01, 0.01, 0.01);
```

Both take the object first and commit its matrix, since a bare `position.set` on such an object
would leave it wherever it last was. Set a rotation before the call if you need one: they compose
from position, quaternion and scale.

### Letting the player move a panel

```js
dom(ctx, Settings(ctx), [], { draggable: true });
dom(ctx, Map(ctx), [], { draggable: { level: false, handleWidth: 20 } });
```

| Option        | Default   | What it does                                                                                                         |
| ------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `handleWidth` | `14`      | The strips' width, in the panel's px.                                                                                |
| `level`       | `true`    | Turn only about the vertical and keep the tilt the scene gave the panel; `false` gives it the hand's whole rotation. |
| `carried`     | the panel | An ancestor to move instead, so the panel moves together with whatever it hangs from.                                |
| `onPutDown`   | none      | Called when a carry ends, which is where a scene saves the panel's new place.                                        |

- Four strips along the panel's edges are invisible until a ray is on the panel, faint while one is,
  and full on the strip the ray is on and on all four while the panel is held. A press on a strip
  picks the panel up with `carry()`, and the release puts it down; a press on the panel itself means
  what it always meant.
- The portal puts a group of its own between the parent and the panel, and the carry moves that
  group, so whatever the scene does to place the parent still applies.
- Dragging is off unless a panel asks for it, and it is not one of the scene's panel defaults. A
  carry follows the hand in the renderer's frames, so a portal without a renderer has no strips. The
  keyboard uses the same strips and always has them in the room.

### How sharp the text comes out

The scale a panel is placed at is also what decides how finely its text is rasterized. Each panel
measures how many device pixels it paints per CSS pixel, once a frame, and rasterizes at a step of
the ladder 1, √2, 2, 2√2, 4, the one at or above what it measured. Coarsening is held back until the
measurement is a fifth clear of the boundary, so a panel you are standing in front of does not
re-rasterize because you drifted a centimetre. `textScale.js` says why the ladder is in steps of
root two and why four is the ceiling.

```js
dom(ctx, List(ctx), [], { maxTextScale: 2 });
```

`maxTextScale` lowers that ceiling for a panel that would rather be soft than large, such as a list
of hundreds of rows, which reaches the ceiling with every row at once; what a step costs is
quadratic in it. It only ever lowers. Off a scene — a portal on a plain page, or under a test runner
— the page's `devicePixelRatio` is the whole answer, since the panel _is_ the page.

### Panel defaults

Some of what a panel is told belongs to the scene rather than to any one panel. `render()` takes
them once, as `panelOptions`, and every panel in the scene starts from them:

```js
render(Scene, {
  panelOptions: {
    maxTextScale: 2,
    loadingFrame: { delay: 400 },
    keyboard: { create: ({ onKey, field }) => keyboard({ classes, onKey, field }) },
  },
});
```

`keyboard`, `loadingFrame`, `haptics`, `thumbstickWheel`, `maxTextScale`, `atomic`, `opaqueToRays`,
`priority` and `budget` can be set this way. A panel's own options are laid over them: its value
wins, except that a `keyboard`, a `loadingFrame` or a `haptics` given as an object is spread over
the scene's, so a panel can change one thing about them without restating the rest; `false` at
either level is none. `withPanelOptions(ctx, options)` does the same for a part of the scene, over
whatever is in scope already. `plugins` is not among them — it has `portalPlugins`, whose list a
panel's own is put in front of rather than in place of — and neither are `root`, `draggable` and
`onLoadingChanged`, which are only ever one panel's.

## SVG

Inline `<svg>` is drawn through a plugin, and only through one. Drawing a shape means triangulating
it — three's `ShapePath`, the earcut triangulator and the stroker from `SVGLoader`, none of which a
panel of boxes and text has any use for — so the support lives behind a second entry point that the
main one never imports:

```js
import { render } from "@apendua/freedom";
import { svgElements } from "@apendua/freedom/svg";

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
  [`docs/freedom-svg-plan.md`](../../docs/freedom-svg-plan.md) says what each would take.
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

## Element plugins

The seam the SVG support goes through is general. A `PortalPlugin` is an object with one method,
`element(ctx, element)`, asked about every element a portal is about to build, before its own
dispatch; it returns the object tree to mirror the element with — one `Object3D`, emitted
synchronously, kept in step with the element for as long as the subscription lasts, torn down when
it ends — or `null` for an element that is not its. Register one for a scene with `render()`'s
`portalPlugins` or for one panel with `PortalOptions.plugins`; a panel's are asked first.
`box(ctx, element, options)` is exported for a plugin that wants the CSS box drawn and something of
its own inside it, which is how the checkbox is built: `clickable` says whether the element is a ray
target, `content` what else belongs inside the box, and `contentMatrix` where the element's children
are drawn from, if not from its border-box corner. A plugin cannot rebuild the built-in controls:
the checkbox's and the text field's helpers are internal.

## Also exported

Named here so that nothing public goes unmentioned; each has its JSDoc.

- `fragment(...sources)` mounts several components as one. `copy(key, value)` writes a
  subscribable's values into a property that has a `copy` method, a `Vector3` or a `Color`, the way
  `set` assigns a plain one. `layoutEffects(fn)` runs an effect once the object is in the scene, and
  not again when `attach` moves it. `list` and `keyedList` are the keyed lists justdom has, for
  Three objects, and `Nothing()` is a component that mounts nothing.
- `size(ctx)` is the renderer's size as a source. `InteractionContext` and `InteractionManager` are
  the manager behind `interactions(ctx)`, for a test or a scene that drives one by hand.
  `setLocalMatrix` and `setWorldMatrix` put an object at a matrix without allocating.
- `PortalPluginsContext`, `PanelOptionsContext` and `PortalSchedulerContext` are the properties
  `render()` sets from `portalPlugins`, `panelOptions` and `portalBudget`, for a scene built without
  `render()`; `createPortalScheduler` and `createFrameShareBudget` are what it installs there.
- `getContentGroup(object)` is where a node's projected children hang, and where a plugin attaches
  its own. `isTextInput(node)` is the rule the portal draws a field by. `solveCut(layout, cursor)`
  is the arithmetic behind `makeReveal`.
- From `@apendua/freedom/page`: `getPortalRoot` and `scrollElementBy` again, the two functions a
  widget on a page asks of a portal, and `FOCUS_ATTRIBUTE`, from an entry point that imports nothing
  from three.js. A widget a page shows before any session, and a panel may mirror during one,
  imports them from there, so that the page's own bundle does not carry the renderer; the dropdown
  and the scrolling list in `@apendua/justui` do.
- From `@apendua/freedom/svg`: `shape`, `group`, `image` and `drawText` are the builders
  `svgElements()` dispatches to, for a plugin that draws one SVG element its own way and hands the
  rest to them.

## Real examples

This package drives several full apps in this monorepo — [`apps/rubik`](../../apps/rubik),
[`apps/blockout-xr`](../../apps/blockout-xr), [`apps/marblerun`](../../apps/marblerun),
[`apps/todo-vanilla`](../../apps/todo-vanilla) — worth reading for realistic scenes combining
lighting, keyed lists (`list`/`keyedList`), controller/hand input, and DOM panels projected into 3D
space. [`apps/showcase-xr`](../../apps/showcase-xr) is the sampler: six panels in a grid
demonstrating hover/press transitions, CSS keyframes, a Web Animations API animation, a
`useFrame(ctx, fn)` loop writing inline styles, animated text colour, a paragraph revealed to a
moving cursor, static transforms, a layout-tier width transition, every `object-fit` an image can be
drawn with, a card of inline SVG (a diagram of boxes joined by dashed and dotted arrows with marker
heads, nodes labelled through `<text>`, two pictures through `<image>`, a bar cut in half by a
`clip-path`, an icon through a `viewBox` at three sizes, a star spun by a CSS animation on its
`<g>`, a symbol drawn three times by `<use>`, marching ants and a stroke colour animated by
keyframes), and a card of bulleted and numbered lists whose steps are numbered as they arrive.
[`apps/desk`](../../apps/desk) is the same features in one scene, and mirrors a page that already
exists rather than building panels for the scene: a desk whose monitor reveals its program, whose
keys are pressed with the ray, whose floppies are dragged from one panel onto another, with a layer
menu, live SVG charts, draggable cards, a text field with the scene's keyboard and a memo that can
be picked up and tipped to read.

Five apps are run on every pull request that changes what this package ships, in an emulated headset
in headless Chromium; a change only to its docs, tests or benchmarks runs none of them.
`.github/workflows/visual.yml` photographs the showcase and holds the picture against the one on
record. `.github/workflows/driven.yml` plays [`apps/minesweeper`](../../apps/minesweeper), puts the
desk up, draws in [`apps/euclid`](../../apps/euclid) and fights in
[`apps/knights`](../../apps/knights), with each app's `tests/xr-check.mjs`; each app's README says
what its check does.

## License

MIT — see [LICENSE](../../LICENSE).
