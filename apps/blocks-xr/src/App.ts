import * as THREE from "three";
import { children, $, list, XREventMap, interactions } from "@apendua.dev/three";
import { Signal, observeFn } from "@apendua.dev/signal";
import { on, set, effects, just, component } from "@apendua.dev/signal";
import { ReactiveMap } from "@apendua.dev/signal";

import { CastleContext, PointersContext, SessionContext } from "./elements/context.js";
import { boxGeometry } from "./elements/geometry.js";
import { basicMaterial } from "./elements/material.js";
import Game from "./components/Game.js";
import BuildUI from "./views/BuildUI.js";
import SiegeUI from "./views/SiegeUI.js";
import CastleStore from "./store/CastleStore.js";
import Session from "./store/Session.js";

/**
 * The board sits on a floor of its own, a little below eye level and about an
 * arm's length away — the session runs in a `local` reference space, so the
 * origin is wherever the player's head was when they pressed Start. The physics
 * ground is the top of this slab: a brick standing on the grid is standing on
 * the floor of the simulation.
 */
/** The same square the grid covers: 24 cells of half a unit. */
const FLOOR_SIZE = 12;
const FLOOR_THICKNESS = 0.2;

const Floor = component((ctx: WeakKey) => {
  const { makeInteractive } = interactions(ctx);
  return $(new THREE.Mesh<THREE.BufferGeometry, THREE.Material, XREventMap>(), [
    effects((o) => {
      o.position.set(0, -FLOOR_THICKNESS / 2, 0);
    }),
    set({
      get geometry() {
        return boxGeometry(FLOOR_SIZE, FLOOR_THICKNESS, FLOOR_SIZE);
      },
      get material() {
        return basicMaterial("#2f4032");
      },
    }),
    makeInteractive(),
    PointersContext.get(ctx),
  ]);
});

const App = component((ctx: WeakKey) => {
  // One board unit is one cell, and a cell is ten centimetres in the room.
  const scale = 0.1;
  const pointers = new ReactiveMap<THREE.XRTargetRaySpace, Signal<THREE.Vector3>>();
  const position = Signal.of(new THREE.Vector3(0, -0.4, -1.1));
  const castle = new CastleStore();
  const gameSession = new Session();

  ctx = CastleContext.set(ctx, castle);
  ctx = SessionContext.set(ctx, gameSession);
  ctx = PointersContext.set(ctx, (source) => {
    return source.pipe(
      on("pointermove", (event) => {
        if (event.intersection) {
          let pointer = pointers.get(event.controller);
          if (pointer) {
            pointer.set(event.intersection.point);
          } else {
            pointer = Signal.of(event.intersection.point);
            pointers.set(event.controller, pointer);
          }
        }
      }),
      on("pointerleave", (event) => {
        pointers.delete(event.controller);
      }),
    );
  });

  castle.load();

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
              return basicMaterial("#ff0000");
            },
          }),
        ]);
      }),
      $(new THREE.Group<XREventMap>(), [
        effects((o) => {
          o.position.copy(position.get());
        }),
        children(
          $(new THREE.AmbientLight(0xffffff, 1.8)),
          $(new THREE.DirectionalLight(0xffffff, 2), [
            effects((o) => {
              o.position.set(0.6, 1.4, 0.8);
            }),
          ]),
          $(new THREE.PointLight(0xffffff, 6, 8), [
            effects((o) => {
              o.position.set(-0.6, 0.8, 0.6);
            }),
          ]),
          $(new THREE.Group(), [
            effects((o) => {
              o.scale.set(scale, scale, scale);
            }),
            children(
              Floor(ctx),
              Game(ctx),
              // One panel at a time: the phase decides which, so nothing has to
              // be hidden and the player only ever sees what applies.
              component(() => {
                const panel = {
                  position: new THREE.Vector3(-8.5, 4.5, 1.5),
                  rotation: new THREE.Euler(0, Math.PI / 8, 0),
                };
                if (gameSession.phase.get() === "build") {
                  return BuildUI(ctx, [
                    set(panel),
                    effects((ui) => {
                      ui.bricks = castle.bricks.size;
                      ui.canUndo = castle.history.canUndoSignal.get();
                      ui.canRedo = castle.history.canRedoSignal.get();
                    }),
                    on("ready", () => {
                      if (castle.size === 0) {
                        return;
                      }
                      castle.rememberStanding();
                      gameSession.beginSiege();
                    }),
                    on("undo", () => {
                      castle.history.undo();
                    }),
                    on("redo", () => {
                      castle.history.redo();
                    }),
                    on("clear", () => {
                      castle.clear();
                    }),
                  ]);
                }
                return SiegeUI(ctx, [
                  set(panel),
                  effects((ui) => {
                    ui.standing = gameSession.standing.get();
                    ui.total = gameSession.total.get();
                    ui.shots = gameSession.shots.get();
                    ui.won = gameSession.won.get();
                    ui.forkHand = gameSession.forkHand.get();
                  }),
                  on("rebuild", () => {
                    gameSession.beginBuilding();
                    castle.restoreStanding();
                  }),
                  on("swapHands", () => {
                    gameSession.swapHands();
                  }),
                ]);
              })(),
            ),
          ]),
        ),
      ]),
    ),
  );
});

export default App;
