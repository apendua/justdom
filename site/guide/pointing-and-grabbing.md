# Pointing and grabbing

A controller points a ray into the scene, a tracked hand points one too, and on a page the mouse
stands in for both. [`justdom-three`](/api/three/input) casts those rays once a frame and turns what
they meet into events on the objects, the way a browser turns a mouse into events on elements.

## Making an object answer a ray

`interactions(ctx)` gives the scene the `makeInteractive()` operator, which puts an object in the
raycast set and gets it pointer, select and squeeze events:

```js
import { interactions, cursors } from "justdom-three";
import { on } from "justdom-signal";

const { makeInteractive } = interactions(ctx);

$(mesh, [
  makeInteractive(() => props.enabled), // a boolean, a getter or an observable
  on("pointerenter", () => highlight.set(true)),
  on("pointerleave", () => highlight.set(false)),
  on("select", (event) => choose(event.registeredTarget)),
]);
```

The events are the registered object's, whichever of its meshes the ray met: `pointerenter`,
`pointermove` and `pointerleave`, `selectstart`, `selectend` and `select` for the trigger, and the
`squeeze` trio for the grip. Each carries the `controller` it came from, the `inputSource` three
connected to it, and `registeredTarget`, the object the hit belongs to. Hiding an object with
`visible = false` takes it out of the raycast as it takes it out of the draw, and a hand that
disconnects, as every hand does when a session ends, lets go of whatever it held with a release that
says `lost`.

`cursors(ctx)` puts a mark where each ray meets something interactive, one per hand, gone with the
hit, and `mouse(ctx)` registers the mouse as one more controller, so a scene that is also a page
answers clicks on the canvas with the same handlers:

```js
useEffects(getScene(ctx), [children(mouse(ctx), cursors(ctx, { color: "#ff0000" }))]);
```

## Picking things up

`drag(ctx, options)` is the carry a press makes: a press picks the object up, the hand's own
movement moves it, and the release puts it back where it is in the room. The object does not know
where it goes. It says where it is, `dragstart`, `dragmove` once a frame and `dragend`, each with
its world matrix, and the scene decides what that means: a cell to snap to, a preview to show, a
drop to refuse with the `reset()` the end event carries.

```js
const { draggable, held } = drag(ctx, { enabled: () => props.movable });

$(mesh, [
  makeInteractive(),
  draggable(),
  effects((o) => {
    if (!held()) o.position.copy(props.position); // the props place it whenever a hand does not
  }),
  on("dragend", (event) => board.drop(event.matrixWorld, event.reset)),
]);
```

A press from the other hand mid-drag is a handover, and the press that picks the object up never
reaches whatever is behind it, so picking up a brick does not also pick up the board it sits on.

## Carrying things level

`carry(ctx, options)` is the other way of moving something: for a board with a floor and things
standing on it, which a drag would tip over. A carry takes only two things from the hand, where it
has got to and how far it has turned about the vertical, and poses the board once a frame from them,
so a level board stays level. The presses are taken by **handles**, so only furniture starts a
carry:

```js
const board = carry(ctx, { enabled: () => phase.get() === "build" });

$(new THREE.Group(), [
  board.carriable(),
  children(
    $(floor, [makeInteractive(), board.handle()]), // what the board is carried by
    Game(ctx),
  ),
]);
```

The same mechanism moves a [DOM panel](./dom-panels) the player is allowed to pick up, by the strips
along its edges.

## Hands

With the `hand-tracking` feature, which `createXRButton` asks for, a headset drives a controller
slot with the hand itself once the controllers are put down. The hand still points and pinches, and
a pinch arrives as `selectstart` and `selectend`, so everything above works unchanged.
`controllers(ctx)` hands out a `ControllerHandle` per slot, whose `tracked()` says whether a
controller or a hand is driving it, whose `hand.joints` are the twenty-five joints three poses every
frame, and whose `pinching()` is three's own measure of the pinch. `render()`'s `createHandModel`
option says what to draw on a tracked hand.

[Pointing, grabbing and hands](/api/three/input) in the reference lists every option, every event
field and every rule about what a release reaches.
