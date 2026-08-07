import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { $, attr, children } from "@apendua/justdom";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal, getPortalRoot } from "./portal.js";

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

// jsdom runs no animation frames, and the portal borrows them for the parts
// of itself that sample rather than listen. A queue flushed by hand is both a
// frame source and a clock the tests can stop, which is what lets one of them
// look at the gap between an event arriving and the frame that answers it.
/** @type {Array<FrameRequestCallback>} */
const frameCallbacks = [];
globalThis.requestAnimationFrame = (callback) => frameCallbacks.push(callback);
globalThis.cancelAnimationFrame = () => {};

/**
 * @returns {void}
 */
function flushFrame() {
  for (const callback of frameCallbacks.splice(0, frameCallbacks.length)) {
    callback(0);
  }
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
    // The container is flipped half a turn about x, so the plane faces away
    // from the viewer and a one-sided mesh would never be raycast at all.
    assert.equal(blocker.material.side, THREE.DoubleSide, "the blocker is two-sided");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a click on the panel background is reported to the DOM", async () => {
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
    portal.addTo(new THREE.Group());

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("style", () => "cursor: pointer")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await nextMacrotask();
    await nextMacrotask();

    /** @type {Event[]} */
    const clicks = [];
    /** @param {Event} event */
    const listener = (event) => clicks.push(event);
    document.addEventListener("click", listener);

    // Aiming at the panel but at none of its buttons. Nothing else can tell a
    // menu that the player looked away from it and clicked.
    added[0].dispatchEvent(/** @type {any} */ ({ type: "select" }));

    assert.equal(clicks.length, 1, "the background click reaches the document");
    assert.ok(clicks[0].target instanceof HTMLElement);

    document.removeEventListener("click", listener);
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("what it projects can find its way back to the panel it is in", async () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("id", () => "inside")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await nextMacrotask();

    const inside = document.getElementById("inside");
    assert.ok(inside);
    const root = getPortalRoot(inside);
    assert.ok(root, "a projected node finds the portal it was projected through");
    assert.ok(root.contains(inside));

    // Which matters because the page around a panel is full of clicks that are
    // nothing to do with it: a VR button, an emulator's controls, whatever
    // else the document is showing. A component listening for "clicked
    // elsewhere" has to mean elsewhere in the panel, and off the panel there
    // is nothing to scope to.
    const elsewhere = document.body.appendChild(document.createElement("button"));
    assert.equal(getPortalRoot(elsewhere), null);
    assert.equal(getPortalRoot(null), null);
    document.body.removeChild(elsewhere);

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a checkbox is projected as a control rather than as a box", async () => {
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
    portal.addTo(new THREE.Group());

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
    let mountable;
    // Deliberately without `cursor: pointer`: an ordinary box has to ask to be
    // a ray target, and a checkbox does not.
    const tree = $("div", [children($("input", [attr("type", () => "checkbox")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await nextMacrotask();
    await nextMacrotask();

    assert.equal(added.length, 2, "the blocker, and the checkbox itself");
    const input = /** @type {HTMLInputElement | null} */ (
      document.querySelector('[data-xr-portal] input[type="checkbox"]')
    );
    assert.ok(input);
    assert.equal(input.checked, false);

    added[1].dispatchEvent(/** @type {any} */ ({ type: "select", target: added[1] }));

    // The click the ray sends is a click, so the DOM does the toggling and the
    // scene follows the DOM — the same order of events the page sees.
    assert.equal(input.checked, true);
    assert.equal(input.dataset.xrChecked, "true");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("disabling a mounted checkbox takes it out of the raycast set", async () => {
    const manager = new InteractionManager();
    /** @type {THREE.Object3D[]} */
    const registered = [];
    const originalAdd = manager.add.bind(manager);
    const originalRemove = manager.remove.bind(manager);
    manager.add = (object) => {
      registered.push(object);
      originalAdd(object);
    };
    manager.remove = (object) => {
      const index = registered.indexOf(object);
      if (index >= 0) {
        registered.splice(index, 1);
      }
      originalRemove(object);
    };
    const ctx = InteractionContext.set({}, manager);

    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
    let mountable;
    const tree = $("div", [children($("input", [attr("type", () => "checkbox")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await nextMacrotask();
    await nextMacrotask();

    assert.equal(registered.length, 2, "the blocker, and the checkbox itself");

    const input = /** @type {HTMLInputElement | null} */ (
      document.querySelector('[data-xr-portal] input[type="checkbox"]')
    );
    assert.ok(input);
    // By property, which is how an application does it — `disabled` is a
    // reflected attribute, so the observer hears about this too. Nothing else
    // changes here: the point is that this alone has to carry the news.
    input.disabled = true;

    await nextMacrotask();
    await nextMacrotask();

    assert.equal(registered.length, 1, "only the blocker is left");

    input.disabled = false;

    await nextMacrotask();
    await nextMacrotask();

    assert.equal(registered.length, 2, "and re-enabling brings it back");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("mirroring a change asks for the rays to be cast again", async () => {
    const manager = new InteractionManager();
    let updates = 0;
    const originalUpdate = manager.updateIntersections.bind(manager);
    manager.updateIntersections = () => {
      updates += 1;
      originalUpdate();
    };
    const ctx = InteractionContext.set({}, manager);

    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("style", () => "cursor: pointer")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await nextMacrotask();
    await nextMacrotask();

    // A hand pointing at the button that opened a menu is not moving, and the
    // hit is only recomputed when it does — so a menu appearing underneath it
    // would go unnoticed until the player twitched.
    assert.ok(updates > 0, "the mirrored mutation invalidated the hits");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a panel of pictures announces them once, not once each", async () => {
    // An image arriving re-measures the whole portal, because one that was
    // given no size takes the picture's and moves everything after it. Nine
    // icons landing one at a time would mean nine of those for a layout that
    // settles once, so they are collected onto a frame.
    const manager = new InteractionManager();
    let updates = 0;
    const originalUpdate = manager.updateIntersections.bind(manager);
    manager.updateIntersections = () => {
      updates += 1;
      originalUpdate();
    };
    const ctx = InteractionContext.set({}, manager);

    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
    let mountable;
    const tree = $("div", [
      children(
        $("img", [attr("src", () => "data:image/gif;base64,a")]),
        $("img", [attr("src", () => "data:image/gif;base64,b")]),
        $("img", [attr("src", () => "data:image/gif;base64,c")]),
      ),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await nextMacrotask();
    await nextMacrotask();
    flushFrame();

    const containers = document.querySelectorAll(`[${"data-xr-portal"}]`);
    const images = containers[containers.length - 1].querySelectorAll("img");
    assert.equal(images.length, 3, "three pictures to wait for");

    const before = updates;
    for (const image of images) {
      image.dispatchEvent(new Event("load"));
    }
    // Nothing yet: the announcement costs a frame nobody is waiting on,
    // because a picture that has just decoded cannot be on screen before the
    // next one anyway.
    assert.equal(updates, before, "the loads were not announced synchronously");

    flushFrame();
    assert.equal(updates, before + 1, "three pictures, one announcement");

    // And the frame is given back rather than left ticking.
    flushFrame();
    assert.equal(updates, before + 1, "nothing keeps asking for frames");

    subscription.unsubscribe();
    portal.disconnect();
  });
});
