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
