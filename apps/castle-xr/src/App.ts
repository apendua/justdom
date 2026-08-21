import * as THREE from "three";
import { animate, camera, children, cursors, $, XREventMap, interactions } from "@apendua/freedom";
import { makeNonReactive, Signal } from "@apendua/signal";
import { on, set, effects, just, use, component } from "@apendua/signal";

import { CastleContext, ListenerContext, SessionContext } from "./elements/context.js";
import { boxGeometry } from "./elements/geometry.js";
import { basicMaterial } from "./elements/material.js";
import { palette } from "./elements/palette.js";
import Game from "./components/Game.js";
import { createMusicControls, Music } from "@apendua.dev/sound/xr";
import { createDiagnostics, Diagnostics } from "@apendua/justui";
import glass_desk_habits from "@apendua.dev/media/glass_desk_habits.mp3";
import GameUI from "./views/GameUI.js";
import CastleStore from "./store/CastleStore.js";
import Session from "./store/Session.js";
import { applyLevelPose, beginCarry, Carry, carriedPose, levelPose } from "./utils/carry.js";

/**
 * The board sits on a floor of its own, a little below eye level and about an
 * arm's length away — the session runs in a `local` reference space, so the
 * origin is wherever the player's head was when they pressed Start. The physics
 * ground is the top of this slab: a brick standing on the grid is standing on
 * the floor of the simulation.
 *
 * The plate is the same square the grid covers: 12 cells of half a unit, which
 * is 60 cm of table in the room. It is also the handle the whole board is
 * carried by, which is why it is a ray target rather than scenery.
 */
const FLOOR_SIZE = 6;
const FLOOR_THICKNESS = 0.2;

/** Where the board stands when the session opens, before anyone moves it. */
const BOARD_HOME = new THREE.Vector3(0, -0.4, -1.1);

/** Taking hold of the board, and letting go of it again. */
interface Grip {
  take: (controller: THREE.Object3D, grabPoint: THREE.Vector3) => void;
  drop: (controller: THREE.Object3D) => void;
}

/**
 * The floor, which is also the handle the board is carried by: a press on it is
 * the player picking the board up.
 *
 * The presses are taken here rather than by the board group as a whole, so that
 * only the floor can start a carry. Anything else the ray might find — a panel
 * that does not want the press, whatever sits behind it — would otherwise reach
 * the board by bubbling and carry it off, which is a surprising thing for a
 * board to do when a player has just pressed a button.
 */
const Floor = component((ctx: WeakKey, grip: Grip) => {
  const { makeInteractive, stopPropagation } = interactions(ctx);
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
    on("selectstart", (event) => {
      stopPropagation(event);
      grip.take(event.controller, event.intersection.point.clone());
    }),
    on("selectend", (event) => {
      stopPropagation(event);
      grip.drop(event.controller);
    }),
  ]);
});

const App = component((ctx: WeakKey) => {
  // One board unit is one cell, and a cell is ten centimetres in the room.
  const scale = 0.1;
  // The ears go where the head is, so the soundtrack rides the camera and a
  // brick landing across the board sounds like it landed across the board.
  const listener = new THREE.AudioListener();
  const music = createMusicControls({ track: glass_desk_habits });
  const diagnostics = createDiagnostics();

  const castle = new CastleStore();
  const gameSession = new Session();

  ctx = CastleContext.set(ctx, castle);
  ctx = SessionContext.set(ctx, gameSession);
  ctx = ListenerContext.set(ctx, listener);

  castle.load();

  /**
   * The board is carried by its floor: a press on any bare part of it takes
   * hold of the whole scene — board, tray, panels and lighting alike — and
   * moves it with the hand, so the player can put the board wherever there is
   * room for it: on the real table in front of them, or off to one side.
   *
   * It stays level while it is carried. A hand reaching out across a board
   * rolls and pitches far more than it feels like it does, and a board handed
   * the wrist's whole pose arrives tipped on its side with the castle sliding
   * off it. Only where the hand is and which way round it is held are taken,
   * and the spot the ray landed on is the one the board is steered by; see
   * `utils/carry.ts`.
   *
   * A press from the other hand while the board is already being carried is a
   * handover, not a mistake: the new hand takes the grip from wherever its own
   * ray lands, and the first hand's release then changes nothing. That is how
   * a board is passed from hand to hand without ever being put down.
   */
  let board: THREE.Object3D | undefined;
  const carried = Signal.of<{ controller: THREE.Object3D; carry: Carry } | null>(null);

  const takeHold = makeNonReactive((controller: THREE.Object3D, grabPoint: THREE.Vector3) => {
    // Building only. During the siege the triggers belong to the slingshot, and
    // a shot lined up across the board would otherwise carry the board off.
    if (!board || gameSession.phase.get() !== "build") {
      return;
    }
    controller.updateWorldMatrix(true, false);
    board.updateWorldMatrix(true, false);
    carried.set({
      controller,
      carry: beginCarry(controller.matrixWorld, grabPoint, levelPose(board.matrixWorld)),
    });
  });

  const letGo = makeNonReactive((controller: THREE.Object3D) => {
    if (carried.get()?.controller === controller) {
      carried.set(null);
    }
  });

  return just(new THREE.Scene()).pipe(
    effects(() => {
      use(camera(ctx).pipe(children($(listener))));
    }),
    // Head-locked, like the ears above and for the same reason: a reading you
    // have to go and look for is a reading nobody takes while playing.
    effects(() => {
      use(Diagnostics(ctx, diagnostics));
    }),
    children(
      Music(ctx, listener, music),
      cursors(ctx, { color: palette.pointer }),
      $(new THREE.Group<XREventMap>(), [
        effects((o) => {
          // Where the board starts. Where it is after that is wherever it was
          // last carried to, which lives in the object's own transform.
          board = o;
          o.position.copy(BOARD_HOME);
        }),
        effects((o) => {
          const held = carried.get();
          // A carry that outlives the building phase is dropped rather than
          // followed: pressing Ready should not leave the board in mid-air.
          if (!held || gameSession.phase.get() !== "build") {
            return;
          }
          use(
            animate(ctx, () => {
              // three.js has written the hand's new pose by now, but only into
              // its local matrix; the world one is still last frame's.
              held.controller.updateWorldMatrix(true, false);
              applyLevelPose(o, carriedPose(held.carry, held.controller.matrixWorld));
            }),
          );
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
              Floor(ctx, { take: takeHold, drop: letGo }),
              Game(ctx),
              // One panel through both phases: the phase only decides which
              // rows it shows, so pressing Ready re-dresses the panel that is
              // already there instead of building a new one.
              GameUI(ctx, music.output, diagnostics, [
                set({
                  position: new THREE.Vector3(-5.5, 3.5, 1.5),
                  rotation: new THREE.Euler(0, Math.PI / 8, 0),
                }),
                effects((ui) => {
                  ui.phase = gameSession.phase.get();
                  ui.bricks = castle.bricks.size;
                  ui.canUndo = castle.history.canUndoSignal.get();
                  ui.canRedo = castle.history.canRedoSignal.get();
                  ui.standing = gameSession.standing.get();
                  ui.total = gameSession.total.get();
                  ui.shots = gameSession.shots.get();
                  ui.won = gameSession.won.get();
                  ui.forkHand = gameSession.forkHand.get();
                  ui.gazeAim = gameSession.gazeAim.get();
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
              ]),
            ),
          ]),
        ),
      ]),
    ),
  );
});

export default App;
