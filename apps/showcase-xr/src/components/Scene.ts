import * as THREE from "three";
import { children, cursors, $, dom } from "@apendua/freedom";
import { effects, just, component, use } from "@apendua/signal";

import { createDiagnostics, Diagnostics } from "@apendua.dev/diagnostics";
import ButtonsPanel from "./ButtonsPanel.js";
import MotionPanel from "./MotionPanel.js";
import BoxesPanel from "./BoxesPanel.js";
import ImagesPanel from "./ImagesPanel.js";

/**
 * Four panels in a two-by-two grid, each column turned in towards the middle
 * so the set reads as a shallow cockpit rather than a flat wall: interactions
 * and pictures along the top, self-running motion and the box path along the
 * bottom. Each is ordinary DOM projected through its own portal.
 *
 * Panels are positioned by their centres — a portal puts its object's origin
 * there — so the two rows are separated by more than half of the tallest one
 * plus half of the one below it, and the columns by rather more than a panel
 * is wide, which is where these numbers come from.
 */
const Scene = component((ctx: WeakKey) => {
  const scale = 0.1;
  // The frame rate readout, head-locked and up to the left. There is no music
  // card here to hang a switch off, so it is simply always on — and on a page
  // whose whole subject is what a portal costs to draw, that is the point.
  const diagnostics = createDiagnostics();

  /** Half the horizontal distance between the two columns, in container px. */
  const column = 3.0;
  /** Half the vertical distance between the two rows. */
  const row = 2.2;
  /** How far each column is turned in towards the viewer. */
  const yaw = 0.32;
  /** How far forward the turn brings them, so the grid curves rather than shears. */
  const depth = 1.2;

  return just(new THREE.Scene()).pipe(
    effects(() => {
      use(Diagnostics(ctx, diagnostics));
    }),
    children(
      $(new THREE.AmbientLight(0xffffff, 2)),
      $(new THREE.PointLight(0xffffff, 60, 8), [
        effects((o) => {
          o.position.set(0, 1.5, 1);
        }),
      ]),
      $(new THREE.Group(), [
        effects((o) => {
          o.scale.set(scale, scale, scale);
          // The XR button asks for a `local` reference space: the head sits at
          // the origin, so straight ahead is y = 0.
          o.position.set(0, 0, -0.65);
        }),
        children(
          dom(ctx, ButtonsPanel(ctx), [
            effects((obj) => {
              obj.position.set(-column, row, depth);
              obj.rotation.set(0, yaw, 0);
            }),
          ]),
          dom(ctx, ImagesPanel(ctx), [
            effects((obj) => {
              obj.position.set(column, row, depth);
              obj.rotation.set(0, -yaw, 0);
            }),
          ]),
          dom(ctx, MotionPanel(ctx), [
            effects((obj) => {
              obj.position.set(-column, -row, depth);
              obj.rotation.set(0, yaw, 0);
            }),
          ]),
          dom(ctx, BoxesPanel(ctx), [
            effects((obj) => {
              obj.position.set(column, -row, depth);
              obj.rotation.set(0, -yaw, 0);
            }),
          ]),
        ),
      ]),
      cursors(ctx, { color: "#ff0000" }),
    ),
  );
});

export default Scene;
