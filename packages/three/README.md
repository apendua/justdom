# justdom-three

A reactive Three.js scene graph, built on [`justdom-signal`](../signal) with the same operator
vocabulary as [`justdom-core`](../core) — `$`, `set`, `children`, `effects`, `on` — except targeting
`THREE.Object3D` instead of DOM nodes. No VDOM, no diffing: every reactive value is wired directly
to a Three.js mutation through a signal effect. On top of the scene graph it has the WebXR session
lifecycle, controller and hand rays with pointer events on the objects they hit, and a portal that
projects ordinary DOM into the scene as panels a ray can click.

## Installation

```
npm install justdom-three justdom-signal three
```

`three` and `justdom-signal` are peer dependencies. The range for `three` is closed at both ends,
`>=0.185.0 <0.188.0`, because the package leans on three's internals: it overrides
`updateMatrixWorld`, rewrites three's built-in shaders at their chunk includes, and relies on how
the render list treats `material.visible`. A release of three can change any of these without a
major version. CI runs the tests of every package that takes `three` as a peer against both ends of
the range: its floor and the newest three on npm inside it (the `three-range` job in
`.github/workflows/ci.yml`, which reads both from this package's range). The floor is where they
pass: before 0.185, `ShapePath.toShapes` did not read the fill rule the SVG plugin writes. The
ceiling is the next minor above the newest version tested; raising it puts the newer three in the
job.

The package has three entry points: `justdom-three`, `justdom-three/page` for the parts that import
nothing from three.js, and `justdom-three/svg` for the inline SVG plugin.

## Usage

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

## Learn more

- The guide: [Rendering a scene](https://justdom.dev/guide/rendering-a-scene),
  [Headset sessions](https://justdom.dev/guide/headset-sessions),
  [Pointing and grabbing](https://justdom.dev/guide/pointing-and-grabbing),
  [DOM panels](https://justdom.dev/guide/dom-panels) and
  [Writing CSS for a panel](https://justdom.dev/guide/panel-css).
- The [API reference](https://justdom.dev/api/three/) in six pages: rendering and sessions, input,
  panels, what a panel draws, and the theming and outlines modes for working on a panel's CSS.

## License

MIT — see [LICENSE](../../LICENSE).
