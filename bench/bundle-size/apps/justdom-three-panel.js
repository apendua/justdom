import * as THREE from "three";
import { render, $, children, dom, getScene, mouse } from "justdom-three";
import { Signal, effects, effectsOnly, useEffects } from "justdom-signal";
import { $ as h, children as kids, set, style, on, text } from "justdom-core";

const count = Signal.of(0);

const Counter = h("button", [
  // A panel element is a ray target when its computed cursor is a pointer.
  set({ className: "counter" }),
  style({ cursor: "pointer" }),
  on("click", () => count.set(count.get() + 1)),
  kids(text`Clicked ${() => count.get()} times`),
]);

const Scene = effectsOnly((ctx) => {
  useEffects(getScene(ctx), [
    children(
      // The mouse on the canvas is one more controller.
      mouse(ctx),
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
