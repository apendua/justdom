/**
 * The scene: a floor to build on, light to see it by, and the game.
 *
 * The board is scaled by `0.1`, so a one unit brick is ten centimetres in the
 * room and the whole board is a metre across. It floats a little below eye level
 * and about an arm's length ahead — the session runs in a `local` reference
 * space, so the origin is wherever the player's head was when they pressed
 * Start.
 */
import * as THREE from "three";
import { children, $, getScene } from "@apendua/freedom";
import { effects, effectsOnly, use, useEffects } from "@apendua/signal";
import { createDiagnostics, Diagnostics } from "@apendua/justui";
import Game from "./Game.js";
import { CELL, SIZE } from "./grid.js";
import { palette } from "./palette.js";

const THICKNESS = 0.2;
const floor = new THREE.Mesh(
  new THREE.BoxGeometry(SIZE * CELL, THICKNESS, SIZE * CELL),
  new THREE.MeshBasicMaterial({ color: palette.ground }),
);
// The top of the slab is y = 0, which is where the grid and the bricks sit.
floor.position.y = -THICKNESS / 2;

const App = effectsOnly((ctx: WeakKey) => {
  // The frame rate readout, head-locked and up to the left. There is no panel
  // in this scene to hang a switch off, so it is simply always on.
  const diagnostics = createDiagnostics();

  useEffects(getScene(ctx), [
    effects(() => {
      use(Diagnostics(ctx, diagnostics));
    }),
    children(
      $(new THREE.Group(), [
        effects((o) => {
          o.position.set(0, -0.4, -1.1);
        }),
        children(
          $(new THREE.AmbientLight(0xffffff, 0.9)),
          $(new THREE.DirectionalLight(0xffffff, 1.5), [
            effects((o) => {
              o.position.set(0.6, 1.4, 0.8);
            }),
          ]),
          $(new THREE.Group(), [
            effects((o) => {
              o.scale.setScalar(0.1);
            }),
            children($(floor), Game(ctx)),
          ]),
        ),
      ]),
    ),
  ]);
});

export default App;
