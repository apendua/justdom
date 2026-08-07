import * as THREE from "three";
import { children, cursors, $, dom } from "@apendua/freedom";
import { effects, just, component } from "@apendua/signal";

import ButtonsPanel from "./ButtonsPanel.js";
import MotionPanel from "./MotionPanel.js";
import BoxesPanel from "./BoxesPanel.js";

/**
 * Three panels arranged like a cockpit: interactions in the middle,
 * self-running motion on the left, the box path and layout animation on the
 * right. Each is ordinary DOM projected through its own portal.
 */
const Scene = component((ctx: WeakKey) => {
  const scale = 0.1;

  return just(new THREE.Scene()).pipe(
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
          dom(ctx, ButtonsPanel(ctx)),
          dom(ctx, MotionPanel(ctx), [
            effects((obj) => {
              obj.position.set(-4.4, 0, 1.4);
              obj.rotation.set(0, 0.55, 0);
            }),
          ]),
          dom(ctx, BoxesPanel(ctx), [
            effects((obj) => {
              obj.position.set(4.4, 0, 1.4);
              obj.rotation.set(0, -0.55, 0);
            }),
          ]),
        ),
      ]),
      cursors(ctx, { color: "#ff0000" }),
    ),
  );
});

export default Scene;
