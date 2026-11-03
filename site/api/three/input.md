# Pointing, grabbing and hands

How a controller's ray, a tracked hand or the mouse acts on objects in the scene: what makes an
object a ray target, the events it gets, the cursor on the hit, and the two ways of moving something
with a hand. The [guide](/guide/pointing-and-grabbing) introduces them; this page lists every option
and every rule.

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
  chose to let go: a puzzle that turns a layer on release can swing it home instead, and one that
  snaps pieces together can leave the piece unsnapped.
- **A release goes no further than its press did.** The manager sends a release along the press's
  path and no further, so whatever is behind an object that swallowed a press hears neither.
- **Hits are worked out once per frame**, after every `useFrame(ctx, fn)` callback has run and with
  world matrices refreshed, the last thing before the frame is drawn, so a cursor lands where the
  hand is pointing now and not a frame ago. Nested ray targets cost no extra casts: a registered
  object inside another is reached by the outer one's walk.
- The ray each controller draws is cut at the hit, and stretches back out to a fixed reach when the
  hand is pointing at nothing. It is the handle's `ray`, so an app can hide it while a hand is busy
  with something else.

`cursors(ctx, options)` puts a mark where each ray meets something interactive, one per hand that is
pointing at something, gone with the hit:

```js
import { cursors, pointers } from "justdom-three";

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
  press (see [Pointing at things](#pointing-at-things)). So an object taken out of the scene
  mid-drag leaves the hand too, and its release still stops where the press did.
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

A `ControllerHandle` carries `index`, `controller` (the target ray space), `grip`, `ray` (the line
drawn down the target ray), `hand`, `inputSource` (a signal, for the gamepad and the handedness),
`tracked()` and `pinching()`. Setting `ray.visible = false` hides the line and nothing else: the
hand still points, hovers and presses, and its cursor still shows. `handle.hand` is three's
`XRHandSpace`: its `joints` are the twenty-five `XRHandJoint`s, each an `Object3D` posed in the
reference space every frame the hand is tracked, and empty while a controller is in the slot.
Whatever `createHandModel` returns is added to it, and hears the same `connected` / `disconnected`
events a controller model hears on the grip — three's `OculusHandModel` and `XRHandModelFactory`
both do. `tracked()` changes only when what drives the slot changes; `pinching()` is three's own
measure of the pinch (20 mm with 5 mm of hysteresis), state to read rather than input to act on,
since the runtime already turns the pinch into the select events `makeInteractive` listens for.
