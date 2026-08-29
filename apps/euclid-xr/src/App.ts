import * as THREE from "three";
import { $, children, cursors, getCamera, getScene } from "@apendua/freedom";
import { effects, effectsOnly, makeNonReactive, useEffects } from "@apendua/signal";
import { createMusicControls, Music } from "@apendua.dev/sound/xr";
import { createDiagnostics, useDiagnostics } from "@apendua/justui";
import paper_and_running_water from "@apendua.dev/media/paper_and_running_water.mp3";
import Board from "./components/Board.js";
import CodePanel from "./components/CodePanel.js";
import ToolPanel from "./components/ToolPanel.js";
import { palette } from "./elements/palette.js";
import Studio from "./store/Studio.js";

declare global {
  interface Window {
    /** The studio, so headless smoke tests can drive and observe the app. */
    __studio?: Studio;
  }
}

/**
 * The studio room: a drawing board hanging an arm's length away, slightly
 * below eye level and tilted back a little like a drafting table; the program
 * on the left, the tools on the right. The session runs in a `local`
 * reference space, so the origin is wherever the head was at start.
 */
const App = effectsOnly((ctx: WeakKey) => {
  const studio = new Studio();
  // Framing the example reads the scene — carefully outside this component's
  // computation, or the whole app would rebuild (with a fresh studio!) on
  // every code change.
  makeNonReactive(() => studio.fitView())();
  window.__studio = studio;

  // The ears go where the head is, so the soundtrack stays put in the room as
  // the board is looked around.
  const listener = new THREE.AudioListener();
  // Quieter than the games start at: this one is a drawing table, and the track
  // is meant to sit behind the work rather than to be the reason for being here.
  const music = createMusicControls({ track: paper_and_running_water, volume: 0.4 });
  const diagnostics = createDiagnostics();

  useEffects(getScene(ctx), [
    effects((scene) => {
      scene.background = new THREE.Color("#141210");
    }),
    effects(() => {
      useEffects(getCamera(ctx), [children($(listener))]);
    }),
    // The frame rate readout rides the head as well: a panel parked in the room
    // is one the player has to go and find.
    effects(() => {
      useDiagnostics(ctx, diagnostics);
    }),
    children(
      Music(ctx, listener, music),
      // The board and panels are all unlit basic materials; these lights are
      // for the controller models, which are standard materials and would
      // otherwise render pitch black.
      $(new THREE.HemisphereLight(0xfff7e8, 0x4a453c, 1.5)),
      $(new THREE.DirectionalLight(0xffffff, 1.2), [
        effects((light) => {
          light.position.set(0.6, 1.4, 0.8);
        }),
      ]),
      $(new THREE.Group(), [
        effects((group) => {
          group.position.set(0, -0.05, -0.85);
          group.rotation.set(-0.15, 0, 0);
        }),
        children(Board(ctx, studio)),
      ]),
      CodePanel(ctx, studio),
      ToolPanel(ctx, studio, music, diagnostics),
      // The mark at the end of each ray, on the paper and on the panels
      // alike. Half the default size: a drawn point is a centimetre across,
      // and the mark aiming at one should not be the same size as it.
      cursors(ctx, { color: palette.preview, scale: 0.5 }),
    ),
  ]);
});

export default App;
