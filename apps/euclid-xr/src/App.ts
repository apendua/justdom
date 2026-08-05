import * as THREE from "three";
import { $, children } from "@apendua/freedom";
import { component, effects, just, makeNonReactive } from "@apendua/signal";
import Board from "./components/Board.js";
import CodePanel from "./components/CodePanel.js";
import ToolPanel from "./components/ToolPanel.js";
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
const App = component((ctx: WeakKey) => {
  const studio = new Studio();
  // Framing the example reads the scene — carefully outside this component's
  // computation, or the whole app would rebuild (with a fresh studio!) on
  // every code change.
  makeNonReactive(() => studio.fitView())();
  window.__studio = studio;

  return just(new THREE.Scene()).pipe(
    effects((scene) => {
      scene.background = new THREE.Color("#141210");
    }),
    children(
      $(new THREE.Group(), [
        effects((group) => {
          group.position.set(0, -0.05, -0.85);
          group.rotation.set(-0.15, 0, 0);
        }),
        children(Board(ctx, studio)),
      ]),
      CodePanel(ctx, studio),
      ToolPanel(ctx, studio),
    ),
  );
});

export default App;
