import * as THREE from "three";
import { NEVER } from "rxjs";
import { children, camera, cursors, $, animate, dom } from "justdom-three";
import { Signal } from "justdom-signal";
import { effects, use, just, component } from "justdom-signal";

import { createDiagnostics, Diagnostics, type DiagnosticsControls } from "justdom-three-ui";
import TodoApp from "./TodoApp.js";
import TodoKeyboard from "./TodoKeyboard.js";
import { createTodoState } from "./todoState.js";

declare global {
  interface Window {
    /**
     * The frame rate readout, so a photograph of the scene can put it down
     * first. The reading is a live number and the chart is a minute of live
     * numbers, so a photograph with the panel in it is a photograph that
     * never matches the one before — and what a photograph of this scene is
     * for is the panel and the board, not the instrument in front of them.
     */
    __diagnostics?: DiagnosticsControls;
  }
}

// Where the board hangs, in the panel group's units (portal pixels × 0.01).
// The numbers redo what the CSS layer used to say — just below the panel,
// spanning its width, reclined toward the hands — with the panel's own
// geometry: the panel is 464×412px centred at y = 1, so its bottom edge is
// at 1 − 2.06, and the board's top edge hangs a 12px gap below that. The
// recline hinges on that top edge, exactly as `transform-origin: center top`
// did, so the pivot sits at the hinge and the board hangs half its 166px
// height below it.
const KEYBOARD_HINGE_Y = 1 - 2.06 - 0.12;
const KEYBOARD_TILT = (-24 * Math.PI) / 180;
const KEYBOARD_DROP = 0.83;

const Scene = component((ctx: WeakKey) => {
  const scale = 0.1;

  const listener = new THREE.AudioListener();
  const position = Signal.of(new THREE.Vector3(0, 0, -0.5));
  // The frame rate readout, head-locked and up to the left. There is no music
  // card here to hang a switch off, so it is simply always on.
  const diagnostics = createDiagnostics();
  window.__diagnostics = diagnostics;
  const todoState = createTodoState();

  return just(new THREE.Scene()).pipe(
    effects(() => {
      use(camera(ctx).pipe(children($(listener))));
    }),
    effects(() => {
      use(Diagnostics(ctx, diagnostics));
    }),
    effects(() => {
      let lastTime = performance.now();
      let accumulator = 0;
      const fixedTimeStep = 1 / 60; // 60Hz physics update rate
      use(
        animate(ctx, () => {
          const currentTime = performance.now();
          const deltaTime = (currentTime - lastTime) / 1000; // Convert to seconds
          lastTime = currentTime;

          accumulator += deltaTime;
          while (accumulator >= fixedTimeStep) {
            accumulator -= fixedTimeStep;
          }
        }),
      );
    }),
    children(
      $(new THREE.PointLight(0xffffff, 100, 5), [
        effects((o) => {
          o.position.set(0, 1, 3);
        }),
      ]),
      $(new THREE.PointLight(0xffffff, 50, 5), [
        effects((o) => {
          o.position.set(2, -2, -2);
        }),
      ]),
      $(new THREE.AmbientLight(0xffffff, 2)),
      $(new THREE.Group(), [
        effects((o) => {
          o.position.set(2, -2, -2);
        }),
      ]),
      $(new THREE.AmbientLight(0xffffff, 2)),
      $(new THREE.Group(), [
        effects((o) => {
          o.scale.set(scale, scale, scale);
          o.position.copy(position.get());
        }),
        children(
          dom(ctx, TodoApp(ctx, todoState), [
            effects((obj) => {
              // Slightly above the group's origin, which puts the middle of
              // the panel a little under eye level once the whole thing is
              // scaled down and pushed away — the panel is centred on its own
              // origin, so this is the offset that decides where it sits.
              obj.position.set(0, 1, 0);
              obj.rotation.set(0, 0, 0);
            }),
          ]),
          // The keyboard, in a portal of its own. The pivot is the hinge: it
          // sits where the board's top edge belongs and carries the recline,
          // so everything below it swings toward the viewer and nothing
          // swings behind the panel — what `transform-origin: center top`
          // used to arrange, in scene coordinates.
          $(new THREE.Group(), [
            effects((pivot) => {
              pivot.position.set(0, KEYBOARD_HINGE_Y, 0);
              pivot.rotation.set(KEYBOARD_TILT, 0, 0);
            }),
            children(
              // The portal is created the first time the board opens, not
              // when the scene mounts: a board nobody has asked for costs
              // nothing to mirror, and its first mount is its portal's
              // *initial* content — which is the moment a portal that knows
              // how to defer its mounting gets to build it hidden and show
              // it whole.
              component(() => {
                if (!todoState.typing.get()) {
                  return NEVER;
                }
                return dom(ctx, TodoKeyboard(todoState), [
                  effects((obj) => {
                    obj.position.set(0, -KEYBOARD_DROP, 0);
                    obj.rotation.set(0, 0, 0);
                  }),
                ]);
              })(),
            ),
          ]),
        ),
      ]),
      cursors(ctx, { color: "#ff0000" }),
    ),
  );
});

export default Scene;
