import * as THREE from "three";
import { render, $, children, dom, getScene } from "justdom-three";
import { Signal, effects, effectsOnly, useEffects } from "justdom-signal";
import { $ as h, children as kids, set, on, text } from "justdom-core";

const count = Signal.of(0);

const Counter = h("button", [
  set({ className: "counter" }),
  on("click", () => count.set(count.get() + 1)),
  kids(text`Clicked ${() => count.get()} times`),
]);

const Scene = effectsOnly((ctx) => {
  useEffects(getScene(ctx), [
    children(
      $(new THREE.Group(), [
        effects((group) => {
          group.position.set(0, 0, -2);
        }),
        children(dom(ctx, Counter)),
      ]),
    ),
  ]);
});

render(Scene).subscribe((renderer) => {
  document.body.appendChild(renderer.domElement);
});
