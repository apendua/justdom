import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { $, attr, children } from "@apendua/justdom";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal } from "./portal.js";

// jsdom-env exposes the common DOM globals, but not MutationObserver, which
// the portal uses to mirror the tree.
if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
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

/**
 * @returns {Promise<void>}
 */
function nextMacrotask() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("createPortal", () => {
  test("only clickable elements become ray targets, plus one blocker plane", async () => {
    const manager = new InteractionManager();
    /** @type {THREE.Object3D[]} */
    const added = [];
    const originalAdd = manager.add.bind(manager);
    manager.add = (object) => {
      added.push(object);
      originalAdd(object);
    };
    const ctx = InteractionContext.set({}, manager);

    const portal = createPortal(ctx);
    const parent = new THREE.Group();
    portal.addTo(parent);

    // A card with one button (cursor: pointer) and one plain label wrapper.
    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
    let mountable;
    const tree = $("div", [
      children(
        $("div", [attr("style", () => "cursor: pointer")]),
        $("div", [attr("style", () => "padding: 4px")]),
      ),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    // The portal mirrors DOM through a MutationObserver; give it a beat.
    await nextMacrotask();
    await nextMacrotask();

    assert.equal(added.length, 2, "one blocker and one clickable div");
    // The blocker is registered first, while the portal is being created.
    const blocker = added[0];
    assert.ok(blocker instanceof THREE.Mesh, "the blocker plane is registered");
    assert.ok(blocker.geometry instanceof THREE.PlaneGeometry, "the blocker is a plane");

    subscription.unsubscribe();
    portal.disconnect();
  });
});
