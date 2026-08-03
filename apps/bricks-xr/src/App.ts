/**
 * The scene: a floor to build on, some light to see it by, and the game.
 *
 * The board is scaled by `0.1`, so a one unit brick is ten centimetres in the
 * room and the whole board is a metre across. It floats a little below eye level
 * and about an arm's length ahead — the session runs in a `local` reference
 * space, so the origin is wherever the player's head was when they pressed
 * Start.
 */
import * as THREE from "three";
import { children, $, list, XREventMap, interactions } from "@apendua.dev/three";
import { Signal, observeFn } from "@apendua.dev/signal";
import { on, set, effects, just, component } from "@apendua.dev/signal";
import { ReactiveMap } from "@apendua.dev/signal";

import { PointersContext } from "./elements/context.js";
import { boxGeometry } from "./elements/geometry.js";
import { basicMaterial } from "./elements/material.js";
import { palette } from "./elements/palette.js";
import Game from "./components/Game.js";

const FLOOR_SIZE = 10;
const FLOOR_THICKNESS = 0.2;

const Floor = component((ctx: WeakKey) => {
  const { makeInteractive } = interactions(ctx);
  return $(new THREE.Mesh<THREE.BufferGeometry, THREE.Material, XREventMap>(), [
    effects((o) => {
      // The top of the slab is y = 0, which is where the grid and the bricks sit.
      o.position.set(0, -FLOOR_THICKNESS / 2, 0);
    }),
    set({
      get geometry() {
        return boxGeometry(FLOOR_SIZE, FLOOR_THICKNESS, FLOOR_SIZE);
      },
      get material() {
        return basicMaterial(palette.ground);
      },
    }),
    makeInteractive(),
    PointersContext.get(ctx),
  ]);
});

const App = component((ctx: WeakKey) => {
  const scale = 0.1;
  const pointers = new ReactiveMap<THREE.XRTargetRaySpace, Signal<THREE.Vector3>>();

  // Anything pointable pipes through this, which keeps a note of where each
  // controller's ray last landed so a dot can be drawn there.
  ctx = PointersContext.set(ctx, (source) => {
    return source.pipe(
      on("pointermove", (event) => {
        if (event.intersection) {
          const pointer = pointers.get(event.controller);
          if (pointer) {
            pointer.set(event.intersection.point);
          } else {
            pointers.set(event.controller, Signal.of(event.intersection.point));
          }
        }
      }),
      on("pointerleave", (event) => {
        pointers.delete(event.controller);
      }),
    );
  });

  return just(new THREE.Scene()).pipe(
    children(
      list(observeFn(pointers).values(), (pointer) => {
        return $(new THREE.Mesh(), [
          effects((o) => {
            o.position.copy(pointer.get());
          }),
          set({
            get geometry() {
              return boxGeometry(0.01, 0.01, 0.01);
            },
            get material() {
              return basicMaterial(palette.pointer);
            },
          }),
        ]);
      }),
      $(new THREE.Group<XREventMap>(), [
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
              o.scale.set(scale, scale, scale);
            }),
            children(Floor(ctx), Game(ctx)),
          ]),
        ),
      ]),
    ),
  );
});

export default App;
