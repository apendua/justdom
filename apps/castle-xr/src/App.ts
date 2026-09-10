import * as THREE from "three";
import {
  carry,
  Carry,
  children,
  cursors,
  $,
  XREventMap,
  interactions,
  getCamera,
  getScene,
} from "@apendua/freedom";
import { effectsOnly, useEffects } from "@apendua/signal";
import { on, set, effects, component } from "@apendua/signal";

import { CastleContext, ListenerContext, SessionContext } from "./elements/context.js";
import { boxGeometry } from "./elements/geometry.js";
import { basicMaterial } from "./elements/material.js";
import { palette } from "./elements/palette.js";
import Game from "./components/Game.js";
import { createMusicControls, Music } from "@apendua.dev/sound/xr";
import { createDiagnostics, useDiagnostics } from "@apendua/justui";
import glass_desk_habits from "@apendua.dev/media/glass_desk_habits.mp3";
import GameUI from "./views/GameUI.js";
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
 * is 60 cm of table in the room. It is also the handle the whole board is
 * carried by, which is why it is a ray target rather than scenery.
 */
const FLOOR_SIZE = 6;
const FLOOR_THICKNESS = 0.2;

/** Where the board stands when the session opens, before anyone moves it. */
const BOARD_HOME = new THREE.Vector3(0, -0.4, -1.1);

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
const Floor = component((ctx: WeakKey, board: Carry) => {
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
    board.handle(),
  ]);
});

const App = effectsOnly((ctx: WeakKey) => {
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
   * It stays level while it is carried, and can change hands on the way: that
   * is freedom's `carry()`. Building only — during the siege the triggers
   * belong to the slingshot, and a shot lined up across the board would
   * otherwise carry the board off; a carry that outlives the building phase
   * is put down, so pressing Ready does not leave the board in mid-air.
   */
  const board = carry(ctx, { enabled: () => gameSession.phase.get() === "build" });

  useEffects(getScene(ctx), [
    effects(() => {
      useEffects(getCamera(ctx), [children($(listener))]);
    }),
    // Head-locked, like the ears above and for the same reason: a reading you
    // have to go and look for is a reading nobody takes while playing.
    effects(() => {
      useDiagnostics(ctx, diagnostics);
    }),
    children(
      Music(ctx, listener, music),
      cursors(ctx, { color: palette.pointer }),
      $(new THREE.Group<XREventMap>(), [
        effects((o) => {
          // Where the board starts. Where it is after that is wherever it was
          // last carried to, which lives in the object's own transform.
          o.position.copy(BOARD_HOME);
        }),
        board.carriable(),
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
              Floor(ctx, board),
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
  ]);
});

export default App;
