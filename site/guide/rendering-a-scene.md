# Rendering a scene

[`justdom-three`](/api/three/) is the same model for a Three.js scene graph. `$` takes an `Object3D`
instead of a tag name, `children` adds objects to it, and `set`, `effects` and `on` are the ones
`justdom-core` uses, from `justdom-signal`. Every reactive value is wired directly to a Three.js
mutation through a signal effect.

```
npm install justdom-three justdom-signal three
```

```js
import * as THREE from "three";
import { render, $, children, getScene, useFrame } from "justdom-three";
import { effects, effectsOnly, useEffects } from "justdom-signal";

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

## What `render()` owns

`render(fn, options)` owns the `WebGLRenderer`, the scene, the camera, resize handling and, when the
device supports it, the WebXR session. It emits the renderer once it is built, which is when the
page puts its canvas somewhere. A page with other things on it passes `container` instead, and
`render()` puts the canvas in that element and sizes it to the element rather than the window. The
tree it is given decorates that scene rather than producing one: a root reads the scene from the
context it is handed and mounts effects on it, which is what `effectsOnly` is for, a component with
no value to hand back.

Everything the tree needs comes down through `ctx`, a `WeakKey` the context mechanism of
`justdom-signal` hangs values on:

| Getter              | Gives                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `getScene(ctx)`     | The scene.                                                                                  |
| `getCamera(ctx)`    | The camera, kept for the life of the renderer.                                              |
| `getXRSession(ctx)` | The session being presented, or null. Reactive: an effect reading it re-runs at either end. |
| `size(ctx)`         | The renderer's size, as a source.                                                           |
| `controllers(ctx)`  | A handle per controller slot: its spaces, its hand and what is driving it.                  |
| `useFrame(ctx, fn)` | Runs `fn` once a frame.                                                                     |

Use `useFrame` rather than `requestAnimationFrame`. Once a session has the display, the page stops
being rendered and its own animation frames stop with it, so a `requestAnimationFrame` loop stands
still. Under an emulator the page is presenting and still rendering, so both work there and the
difference only shows on a headset.

## Objects and their effects

`$(object, effects)` mounts the list on the object. `effects((o) => …)` is where a scene places
things, reading whatever signals it likes; `set` writes a property; `copy(key, value)` writes a
source's values into a property with a `copy` method, a `Vector3` or a `Color`; `on` listens for the
object's events, the interaction events among them. `children(...)` adds the objects the sources
emit and removes them when a source emits something else or the parent goes.

`list` and `keyedList` are the keyed lists `justdom-core` has, for Three objects. `when` and
`branch` are its conditionals, for Three objects too: `when(condition, render)` mounts what `render`
makes while `condition` holds, and `branch(select, render)` mounts `render(key)` for the key
`select` gives and replaces it when the key changes. `Nothing()` is a component that mounts nothing,
for an alternative that has nothing to show.

```js
import { set } from "justdom-signal";
import { branch, children, Nothing, when } from "justdom-three";

children(
  when(
    () => game.phase.get() === "build",
    () => Palette(ctx),
  ),
  branch(
    () => preview.type,
    (type) => (type ? Brick(ctx, [set({ type })]) : Nothing()),
  ),
);
```

Both leave what is mounted alone while the answer stays the same, and build it again the next time.
`component(() => …)` also picks reactively, and builds again when anything its body read changes, as
the demos do to mount a panel only while a session is presenting.

## Placing things

An object placed by an effect has its matrix composed once, in that effect, and not recomposed every
frame on the chance it moved. `place(object, x, y, z)` and
`placeAndScale(object, x, y, z, sx, sy, sz)` are exported for a scene's own static objects, and both
commit the matrix they set, since a bare `position.set` on an object that has opted out of automatic
updates would leave it where it last was. [Placing a panel](/api/three/panels#placing-a-panel) in
the reference says how a portal keeps that cheap for everything under it.

## Where to look next

- [Headset sessions](./headset-sessions): the Enter button, the emulator and the session.
- [Pointing and grabbing](./pointing-and-grabbing): making objects answer a ray.
- [DOM panels](./dom-panels): ordinary DOM in the scene.
- [Rendering and sessions](/api/three/rendering) in the reference lists every `render()` option.
