import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { HUD_PANEL_ORDER, InteractionContext, InteractionManager } from "justdom-three";
import { createDiagnostics } from "./diagnostics.js";
import { Panel } from "./panel.js";

describe("the diagnostics panel", () => {
  test("is in the HUD, so neither the scene nor an overlay can hide it", () => {
    // A HUD panel carries the depth clear that runs before the HUD draws, an
    // empty mesh ordered just under it. Goes red with the panel drawn in the
    // world, which has no clear, or as an overlay, whose clear runs before
    // the overlays and leaves a nearer menu card to hide the readout.
    const ctx = InteractionContext.set({}, new InteractionManager());
    const camera = new THREE.Group();
    /** @type {(() => void) | undefined} */
    let unmount;
    const subscription = Panel(ctx, createDiagnostics()).subscribe((component) => {
      unmount = component.addTo(camera);
    });
    try {
      /** @type {THREE.Mesh | undefined} */
      let clear;
      camera.traverse((object) => {
        if (object instanceof THREE.Mesh && object.geometry.drawRange.count === 0) {
          clear = object;
        }
      });
      assert.ok(clear, "the HUD's depth clear");
      assert.ok(clear.renderOrder > HUD_PANEL_ORDER - 1, `the clear at ${clear.renderOrder}`);
    } finally {
      unmount?.();
      subscription.unsubscribe();
    }
  });
});
