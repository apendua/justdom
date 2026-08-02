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
