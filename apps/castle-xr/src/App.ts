import * as THREE from "three";
import { camera, children, cursors, $, XREventMap, interactions } from "@apendua/freedom";
import { Signal } from "@apendua/signal";
import { on, set, effects, just, use, component } from "@apendua/signal";

import { CastleContext, ListenerContext, SessionContext } from "./elements/context.js";
import { boxGeometry } from "./elements/geometry.js";
import { basicMaterial } from "./elements/material.js";
import { palette } from "./elements/palette.js";
import Game from "./components/Game.js";
import { createMusicControls, Music } from "@apendua.dev/sound/xr";
import glass_desk_habits from "@apendua.dev/media/glass_desk_habits.mp3";
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
 *
 * The plate is the same square the grid covers: 12 cells of half a unit, which
 * is 60 cm of table in the room.
 */
const FLOOR_SIZE = 6;
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
        return basicMaterial(palette.ground);
      },
    }),
    makeInteractive(),
  ]);
});

const App = component((ctx: WeakKey) => {
  // One board unit is one cell, and a cell is ten centimetres in the room.
  const scale = 0.1;
  const position = Signal.of(new THREE.Vector3(0, -0.4, -1.1));
  // The ears go where the head is, so the soundtrack rides the camera and a
  // brick landing across the board sounds like it landed across the board.
  const listener = new THREE.AudioListener();
  const music = createMusicControls({ track: glass_desk_habits });

  const castle = new CastleStore();
  const gameSession = new Session();

  ctx = CastleContext.set(ctx, castle);
  ctx = SessionContext.set(ctx, gameSession);
  ctx = ListenerContext.set(ctx, listener);

  castle.load();

  return just(new THREE.Scene()).pipe(
    effects(() => {
      use(camera(ctx).pipe(children($(listener))));
    }),
    children(
      Music(ctx, listener, music),
      cursors(ctx, { color: palette.pointer }),
      $(new THREE.Group<XREventMap>(), [
        effects((o) => {
          o.position.copy(position.get());
        }),
        children(
          // Enough fill to read the shaded sides, and one clear key light so
          // the flat faces of a brick do not all come out the same value.
          $(new THREE.AmbientLight(0xffffff, 0.9)),
          $(new THREE.DirectionalLight(0xffffff, 1.5), [
            effects((o) => {
              o.position.set(0.6, 1.4, 0.8);
            }),
          ]),
          $(new THREE.PointLight(0xffffff, 2.5, 8), [
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
                  position: new THREE.Vector3(-5.5, 3.5, 1.5),
                  rotation: new THREE.Euler(0, Math.PI / 8, 0),
                };
                if (gameSession.phase.get() === "build") {
                  return BuildUI(ctx, music.output, [
                    set(panel),
                    effects((ui) => {
                      ui.bricks = castle.bricks.size;
                      ui.canUndo = castle.history.canUndoSignal.get();
                      ui.canRedo = castle.history.canRedoSignal.get();
                      ui.volume = music.volume.get();
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
                    on("quieter", () => {
                      music.step(-1);
                    }),
                    on("louder", () => {
                      music.step(1);
                    }),
                  ]);
                }
                return SiegeUI(ctx, music.output, [
                  set(panel),
                  effects((ui) => {
                    ui.standing = gameSession.standing.get();
                    ui.total = gameSession.total.get();
                    ui.shots = gameSession.shots.get();
                    ui.won = gameSession.won.get();
                    ui.forkHand = gameSession.forkHand.get();
                    ui.gazeAim = gameSession.gazeAim.get();
                    ui.volume = music.volume.get();
                  }),
                  on("rebuild", () => {
                    gameSession.beginBuilding();
                    castle.restoreStanding();
                  }),
                  on("swapHands", () => {
                    gameSession.swapHands();
                  }),
                  on("toggleGazeAim", () => {
                    gameSession.toggleGazeAim();
                  }),
                  on("quieter", () => {
                    music.step(-1);
                  }),
                  on("louder", () => {
                    music.step(1);
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
