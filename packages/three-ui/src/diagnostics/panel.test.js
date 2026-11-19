import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager, OVERLAY_PANEL_ORDER } from "justdom-three";
import { createDiagnostics } from "./diagnostics.js";
import { Panel } from "./panel.js";

// jsdom-env exposes the common DOM globals, but not MutationObserver, which
// the portal uses to mirror the tree.
if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}

// `getComputedStyle` is a window method rather than a global under jsdom-env;
// the text mirror reaches for the bare name, as it may on a page.
if (typeof globalThis.getComputedStyle === "undefined") {
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
}

// jsdom lays nothing out, so a Range measures nothing either.
if (typeof window.Range.prototype.getBoundingClientRect !== "function") {
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  window.Range.prototype.getClientRects = () => /** @type {any} */ ([]);
}

// jsdom has no FontFaceSet; VisualProperties consults it for x-height.
if (!document.fonts) {
  Object.defineProperty(document, "fonts", {
    value: {
      status: "loaded",
      ready: Promise.resolve(),
      addEventListener() {},
      removeEventListener() {},
    },
  });
}

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
