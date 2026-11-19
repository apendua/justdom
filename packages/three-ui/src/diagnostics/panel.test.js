import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager, OVERLAY_PANEL_ORDER } from "justdom-three";
import { createDiagnostics } from "./diagnostics.js";
import { Panel } from "./panel.js";

describe("the diagnostics panel", () => {
  test("is an overlay, so the scene cannot hide it", () => {
    // An overlay carries the depth clear that runs before the overlays draw,
    // an empty mesh ordered just under them. Goes red with the panel drawn
    // as an ordinary one, whose own orders a nearer panel draws over.
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
      assert.ok(clear, "the overlay's depth clear");
      assert.ok(clear.renderOrder > OVERLAY_PANEL_ORDER - 1, `the clear at ${clear.renderOrder}`);
    } finally {
      unmount?.();
      subscription.unsubscribe();
    }
  });
});
