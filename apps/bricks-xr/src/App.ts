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
import { camera, children, $ } from "@apendua/freedom";
import { component, effects, just, use } from "@apendua/signal";
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

const App = component((ctx: WeakKey) => {
  // The ears ride the camera, so a brick landing across the board sounds like
  // it landed across the board rather than in the middle of your head.
  const listener = new THREE.AudioListener();

  return just(new THREE.Scene()).pipe(
    effects(() => {
      use(camera(ctx).pipe(children($(listener))));
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
            children($(floor), Game(ctx, listener)),
          ]),
        ),
      ]),
    ),
  );
});

export default App;
