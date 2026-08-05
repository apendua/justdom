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
it in the raycast set and gets it pointer, select and squeeze events. The
manager raycasts once per controller per update to route those events, and
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

## Real examples

This package drives several full apps in this monorepo —
[`apps/rubik`](../../apps/rubik), [`apps/blockout-xr`](../../apps/blockout-xr),
[`apps/marblerun`](../../apps/marblerun),
[`apps/todo-xr`](../../apps/todo-xr) — worth reading for realistic scenes
combining lighting, keyed lists (`list`/`keyedList`), controller/hand input,
and DOM panels projected into 3D space.

## License

MIT — see [LICENSE](../../LICENSE).
