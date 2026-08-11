import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Derived } from "@apendua/signal";
import { $, attr, children } from "@apendua/justdom";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { getComputedStyleCached } from "./mirror.js";
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

  test("a panel that is not opaque to rays keeps none of the background out of their way", async () => {
    const manager = new InteractionManager();
    /** @type {THREE.Object3D[]} */
    const added = [];
    const originalAdd = manager.add.bind(manager);
    manager.add = (object) => {
      added.push(object);
      originalAdd(object);
    };
    const ctx = InteractionContext.set({}, manager);

    const portal = createPortal(ctx, { opaqueToRays: false });
    const parent = new THREE.Group();
    portal.addTo(parent);

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("style", () => "padding: 4px")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await nextMacrotask();
    await nextMacrotask();

    assert.equal(added.length, 0, "a readout nobody presses is nothing for a ray to find");
    // Not merely unregistered: there is no plane in the scene either, so the
    // panel has nothing to keep the size of.
    const planes = [];
    parent.traverse((object) => {
      if (object instanceof THREE.Mesh && object.geometry instanceof THREE.PlaneGeometry) {
        planes.push(object);
      }
    });
    assert.equal(planes.length, 0, "no blocker plane is drawn either");

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

  test("a scroll is one translation of the content group, and measures nothing", async () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    const parent = new THREE.Group();
    portal.addTo(parent);

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
    let mountable;
    const tree = $("div", [
      children(
        $("div", [
          attr("class", () => "list"),
          attr("style", () => "overflow: hidden"),
          children($("div"), $("div"), $("div")),
        ]),
      ),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await nextMacrotask();
    await nextMacrotask();

    const containers = document.querySelectorAll("[data-xr-portal]");
    const container = containers[containers.length - 1];
    const scroller = /** @type {HTMLElement} */ (container.querySelector(".list"));
    assert.ok(scroller);
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop });

    // containerObject carries the blocker mesh and the root element's
    // object; each element object carries its content group first, then its
    // own quad.
    const containerObject = parent.children[0];
    const rootObject = containerObject.children.find((child) => !(child instanceof THREE.Mesh));
    assert.ok(rootObject);
    const scrollerObject = /** @type {THREE.Object3D} */ (rootObject.children[0].children[0]);
    const contentGroup = scrollerObject.children[0];
    assert.equal(contentGroup.children.length, 3, "the rows ride in the content group");
    assert.deepEqual([contentGroup.position.x, contentGroup.position.y], [0, 0]);

    // The regression this pins down: scrolling used to re-measure the
    // scroller's whole subtree, a cost linear in the length of the list.
    // Now the stored geometry is scroll-invariant, so a scroll reads nothing
    // back from the DOM — it is one signal write and one translation.
    // Off `window`, because that is where jsdom keeps the constructor — the
    // `Element` global is not defined under the test setup.
    const originalGetRect = window.Element.prototype.getBoundingClientRect;
    const originalCreateRange = document.createRange.bind(document);
    let rectReads = 0;
    let rangeMeasurements = 0;
    window.Element.prototype.getBoundingClientRect = function () {
      rectReads += 1;
      return originalGetRect.call(this);
    };
    document.createRange = () => {
      rangeMeasurements += 1;
      return originalCreateRange();
    };
    try {
      scrollTop = 40;
      scroller.dispatchEvent(new Event("scroll"));

      assert.deepEqual(
        [contentGroup.position.x, contentGroup.position.y],
        [0, -40],
        "the content slides by exactly the offset",
      );
      assert.equal(rectReads, 0, "no rects are read back");
      assert.equal(rangeMeasurements, 0, "no text is re-measured");
    } finally {
      window.Element.prototype.getBoundingClientRect = originalGetRect;
      document.createRange = originalCreateRange;
    }

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("re-writing an attribute with the value it already has invalidates nothing", async () => {
    // The hover handlers write `data-xr-*` back on every pointer event, and
    // the observer reports every write. The mirror compares against the
    // record's oldValue, so only the first write — the actual change — costs
    // a restyle.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("id", () => "hovered")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await nextMacrotask();
    await nextMacrotask();

    const element = /** @type {HTMLElement} */ (document.getElementById("hovered"));
    assert.ok(element);

    let reads = 0;
    const dependent = new Derived(() => {
      reads += 1;
      return getComputedStyleCached(element).cursor;
    });
    const dependentSubscription = dependent.subscribe({ next: () => dependent.get() });
    dependent.get();
    assert.equal(reads, 1);

    element.dataset.xrHover = "true";
    await nextMacrotask();
    assert.equal(reads, 2, "the first write is a change");

    element.dataset.xrHover = "true";
    await nextMacrotask();
    assert.equal(reads, 2, "the second is not");

    dependentSubscription.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
  });
});
