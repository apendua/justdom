import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Derived, Signal, toObservable, UpdateChannel, withChannel } from "justdom-signal";
import { $, attr, children, className, stylesheet } from "justdom";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { getComputedStyleCached } from "./mirror.js";
import { acquireImage, releaseImage } from "./image.js";
import { createPortal, getPortalRoot } from "./portal.js";
import { createPortalScheduler, PortalSchedulerContext } from "./portalScheduler.js";

// jsdom-env exposes the common DOM globals, but not MutationObserver, which
// the portal uses to mirror the tree.
if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}

// jsdom has no FontFaceSet; VisualProperties consults it for x-height, and
// one test below closes a loading period by hand, so the stub keeps real
// listeners rather than swallowing them.
/** @type {Map<string, Set<(event: unknown) => void>>} */
const fontListeners = new Map();
if (!document.fonts) {
  Object.defineProperty(document, "fonts", {
    value: {
      status: "loaded",
      ready: Promise.resolve(),
      /**
       * @param {string} event
       * @param {(event: unknown) => void} handler
       */
      addEventListener(event, handler) {
        let handlers = fontListeners.get(event);
        if (!handlers) {
          handlers = new Set();
          fontListeners.set(event, handlers);
        }
        handlers.add(handler);
      },
      /**
       * @param {string} event
       * @param {(event: unknown) => void} handler
       */
      removeEventListener(event, handler) {
        fontListeners.get(event)?.delete(handler);
      },
    },
  });
}

/**
 * Stand in for the browser closing a font-loading period.
 *
 * @param {string} event
 * @returns {void}
 */
function dispatchFontsEvent(event) {
  for (const handler of [...(fontListeners.get(event) ?? [])]) {
    handler({ type: event });
  }
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

/**
 * Drive frames and microtasks until the portal has projected everything.
 * Mounting is sliced across frames — the observer's flush queues work and
 * the portal's pump spends a budget of each frame on it — so a test that
 * mounts and then asserts must first stand in for the frame loop. Bounded,
 * so a portal that never settles fails its test instead of hanging it.
 *
 * @param {{ isLoading: () => boolean }} portal
 * @returns {Promise<void>}
 */
async function settle(portal) {
  await nextMacrotask();
  for (let index = 0; index < 500 && portal.isLoading(); index++) {
    flushFrame();
    await nextMacrotask();
  }
  // The load transition queues one more round of its own — ray-target
  // registrations are gated on the panel being ready, and re-evaluate,
  // through the same budgeted channel, the moment it becomes so — and a
  // frame with work left queues its successor. Drain until a frame queues
  // nothing, so a test starts from a genuinely quiet panel and no live pump
  // entry leaks into its counting.
  for (let index = 0; index < 20 && frameCallbacks.length > 0; index++) {
    flushFrame();
    await nextMacrotask();
  }
}

/**
 * Let a change made after the initial mount reach the scene: changes queue
 * in the portal's channel and drain at the top of a frame, so the frame has
 * to happen. Two rounds, because the first frame's work can queue a second's
 * — a restyle that flips what is registered, say.
 *
 * @returns {Promise<void>}
 */
async function pump() {
  await nextMacrotask();
  for (let index = 0; index < 20 && frameCallbacks.length > 0; index++) {
    flushFrame();
    await nextMacrotask();
  }
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
    /** @type {import("justdom").Mountable | undefined} */
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

    // The portal mirrors DOM through a MutationObserver, and projects what
    // the observer reports a budget per frame; drive the frames.
    await settle(portal);

    assert.equal(added.length, 2, "one blocker and one clickable div");
    // The blocker is registered when the panel finishes loading — a loading
    // panel is hidden, and the raycast set is a flat list an ancestor's
    // `visible` cannot shield, so registering it earlier would leave an
    // invisible plate for rays to land on.
    const blocker = /** @type {THREE.Mesh | undefined} */ (
      added.find(
        (object) => object instanceof THREE.Mesh && object.geometry instanceof THREE.PlaneGeometry,
      )
    );
    assert.ok(blocker);
    // The container is flipped half a turn about x, so the plane faces away
    // from the viewer and a one-sided mesh would never be raycast at all.
    assert.equal(
      /** @type {THREE.Material} */ (blocker.material).side,
      THREE.DoubleSide,
      "the blocker is two-sided",
    );

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

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("style", () => "cursor: pointer")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    /** @type {Event[]} */
    const clicks = [];
    /** @param {Event} event */
    const listener = (event) => clicks.push(event);
    document.addEventListener("click", listener);

    // Aiming at the panel but at none of its buttons. Nothing else can tell a
    // menu that the player looked away from it and clicked.
    const blocker = added.find(
      (object) => object instanceof THREE.Mesh && object.geometry instanceof THREE.PlaneGeometry,
    );
    assert.ok(blocker);
    blocker.dispatchEvent(/** @type {any} */ ({ type: "select" }));

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

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("style", () => "padding: 4px")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

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

    /** @type {import("justdom").Mountable | undefined} */
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

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    // Deliberately without `cursor: pointer`: an ordinary box has to ask to be
    // a ray target, and a checkbox does not.
    const tree = $("div", [children($("input", [attr("type", () => "checkbox")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    assert.equal(added.length, 2, "the blocker, and the checkbox itself");
    const input = /** @type {HTMLInputElement | null} */ (
      document.querySelector('[data-xr-portal] input[type="checkbox"]')
    );
    assert.ok(input);
    assert.equal(input.checked, false);

    const control = added.find(
      (object) => !(object instanceof THREE.Mesh && object.geometry instanceof THREE.PlaneGeometry),
    );
    assert.ok(control);
    control.dispatchEvent(/** @type {any} */ ({ type: "select", target: control }));

    // The click the ray sends is a click, so the DOM does the toggling and the
    // scene follows the DOM — the same order of events the page sees. The DOM
    // is true immediately; the scene's write-back of the flag rides the
    // panel's channel and lands at the top of the next frame.
    assert.equal(input.checked, true);
    await pump();
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

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("input", [attr("type", () => "checkbox")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    assert.equal(registered.length, 2, "the blocker, and the checkbox itself");

    const input = /** @type {HTMLInputElement | null} */ (
      document.querySelector('[data-xr-portal] input[type="checkbox"]')
    );
    assert.ok(input);
    // By property, which is how an application does it — `disabled` is a
    // reflected attribute, so the observer hears about this too. Nothing else
    // changes here: the point is that this alone has to carry the news.
    input.disabled = true;

    await pump();

    assert.equal(registered.length, 1, "only the blocker is left");

    input.disabled = false;

    await pump();

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

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("style", () => "cursor: pointer")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

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

    // An unlimited budget keeps the slicing frame-deferred but never
    // budget-cut, so how many frames the settling takes stops depending on
    // the wall clock and the counting below is exact.
    const portal = createPortal(ctx, { budget: Infinity });
    portal.addTo(new THREE.Group());

    /** @type {import("justdom").Mountable | undefined} */
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

    await settle(portal);

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

    // Two recasts however many pictures landed: the announcement's own, and
    // one for the frame in which the panel's channel settles what the
    // announcement invalidated. Announced one at a time, each load would
    // have cost its own announcement and its own settling frame.
    flushFrame();
    await pump();
    assert.equal(updates, before + 2, "three pictures, one announcement, one settling pass");

    // And the frames are given back rather than left ticking: a settled
    // panel must not keep a loop alive.
    flushFrame();
    await nextMacrotask();
    assert.equal(updates, before + 2, "nothing keeps asking for frames");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a panel that is closed lets go of the raycast set, even if its DOM went first", async () => {
    // Closing a panel and opening it again is where this bites. The portal is
    // told to disconnect by the component that owned the tree — and that
    // component has usually already unmounted its nodes, so the container is
    // empty by the time the portal walks it. Walking the DOM alone then
    // reaches nothing, every object the panel made keeps its subscription,
    // and each one stays registered as a ray target: detached from the scene
    // and from the document, but still hit-tested, still sitting exactly
    // where the panel was. The reopened panel draws underneath a full set of
    // ghosts that swallow every hover and every click.
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

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(
        $("div", [attr("style", () => "cursor: pointer")]),
        $("div", [attr("style", () => "cursor: pointer")]),
      ),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    assert.equal(registered.length, 3, "the blocker and two buttons");

    const containers = document.querySelectorAll("[data-xr-portal]");
    const container = containers[containers.length - 1];
    // What the component that owns the tree does on its way out, before the
    // portal hears anything about it.
    subscription.unsubscribe();
    container.replaceChildren();

    portal.disconnect();

    assert.deepEqual(registered, [], "nothing the panel made is still a ray target");
  });

  test("a scroll is one translation of the content group, and measures nothing", async () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    const parent = new THREE.Group();
    portal.addTo(parent);

    /** @type {import("justdom").Mountable | undefined} */
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

    await settle(portal);

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
      // The scroll settles in the event that carried it: the content group
      // has moved before the handler returns, and so has everything else the
      // offset decides — clipping, culling — because a scroll flushes the
      // panel's channel rather than waiting for the pump. Content that slid
      // this frame with clipping catching up over the next several is the
      // tear that makes a scroller unusable, and no budget is worth it.
      assert.deepEqual(
        [contentGroup.position.x, contentGroup.position.y],
        [0, -40],
        "the content slides by exactly the offset, synchronously",
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

  test("a large mount is sliced across frames, behind a loading state", async () => {
    // The case this exists for: a panel's worth of content arriving in one
    // observer flush used to be built in one task, which is one very long
    // frame. Now the flush queues it, the pump builds a budget's worth of
    // nodes per frame — at least one per frame, however small the budget,
    // which is what a budget of zero pins down — and the panel is hidden
    // and out of the raycast set until everything the mount asked for
    // exists. The grain is the node, not the inserted root: a whole panel
    // usually arrives as exactly one root, and a slicer that only sliced
    // between roots would build it whole.
    const manager = new InteractionManager();
    /** @type {THREE.Object3D[]} */
    const registered = [];
    const originalAdd = manager.add.bind(manager);
    manager.add = (object) => {
      registered.push(object);
      originalAdd(object);
    };
    const ctx = InteractionContext.set({}, manager);

    /** @type {boolean[]} */
    const transitions = [];
    const portal = createPortal(ctx, {
      budget: 0,
      onLoadingChanged: (value) => transitions.push(value),
    });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(
        ...Array.from({ length: 8 }, () => $("div", [attr("style", () => "cursor: pointer")])),
      ),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await nextMacrotask();

    assert.equal(portal.isLoading(), true, "a mounting panel is loading");
    assert.equal(containerObject.visible, false, "and hidden while it is");
    assert.equal(registered.length, 0, "and nothing in it is a ray target yet");

    const rootObject = () =>
      containerObject.children.find((child) => !(child instanceof THREE.Mesh));

    // The mount arrived as ONE root carrying eight rows — nine nodes. At a
    // budget of zero the pump builds exactly one per frame, so frames in the
    // tree is still incomplete, and all of that is behind the loading state.
    flushFrame();
    await nextMacrotask();
    flushFrame();
    await nextMacrotask();
    assert.equal(portal.isLoading(), true, "two frames into a nine-node mount, still loading");
    assert.ok(
      (rootObject()?.children[0]?.children.length ?? 0) < 8,
      "because the single root's subtree is being built a node at a time",
    );

    await settle(portal);

    assert.equal(portal.isLoading(), false, "loaded once everything exists");
    assert.equal(containerObject.visible, true, "and shown");
    assert.equal(rootObject()?.children[0]?.children.length, 8, "with every row built");
    assert.equal(registered.length, 9, "the blocker and eight buttons, registered on load");
    assert.deepEqual(transitions, [false], "one transition, announced once");

    // Later arrivals go through the same budgeted pump but are not a loading
    // state. Each appended row is one node, so a zero budget builds exactly
    // one per frame — the climb that proves the batch is genuinely spread
    // across frames rather than deferred whole to the first one.
    const container = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (container[container.length - 1].firstElementChild);
    for (let index = 0; index < 4; index++) {
      list.appendChild(document.createElement("div"));
    }
    await nextMacrotask();
    assert.equal(portal.isLoading(), false, "a mounted panel does not load again");

    const rows = () => rootObject()?.children[0]?.children.length ?? 0;
    flushFrame();
    await nextMacrotask();
    const afterOne = rows();
    flushFrame();
    await nextMacrotask();
    const afterTwo = rows();
    assert.equal(afterOne, 9, "one appended row is built in the first frame");
    assert.equal(afterTwo, afterOne + 1, "and exactly one more in the next");

    await settle(portal);
    assert.equal(rows(), 12, "until the whole batch has arrived");
    assert.deepEqual(transitions, [false], "with no second announcement");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a node that leaves the tree before its frame is never built", async () => {
    // A row added and filtered out in the same breath: the queue entry
    // outlives the node's place in the tree, and building it anyway would
    // make an object for DOM nobody can see — the ghost problem, one frame
    // early. The containment check drops it instead.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await nextMacrotask();

    // Two rows arrive — appended directly, so each is queued as its own
    // root — and one of them leaves again before any frame has happened.
    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    list.appendChild(document.createElement("div"));
    list.appendChild(document.createElement("div"));
    await nextMacrotask();
    assert.equal(portal.isLoading(), true, "no frame yet, so still loading");
    list.removeChild(/** @type {ChildNode} */ (list.lastElementChild));
    await nextMacrotask();

    await settle(portal);

    const rootObject = containerObject.children.find((child) => !(child instanceof THREE.Mesh));
    assert.equal(rootObject?.children[0]?.children.length, 1, "only the row that stayed was built");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("the budget is read every frame, so the trade is adjustable mid-mount", async () => {
    // A number is a decision made once; a getter is one the app keeps
    // making — the same contract `makeInteractive` uses. What it buys is a
    // live trade between mount time and frame rate: spend generously while
    // the player watches a loading panel, drop to a sliver when a hand is
    // busy, or say Infinity and have the mount finish within a frame.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    let budget = 0;
    const portal = createPortal(ctx, { budget: () => budget });
    portal.addTo(new THREE.Group());

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children(...Array.from({ length: 8 }, () => $("div")))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await nextMacrotask();

    flushFrame();
    await nextMacrotask();
    flushFrame();
    await nextMacrotask();
    assert.equal(portal.isLoading(), true, "at a zero budget, a nine-node mount takes nine frames");

    budget = Infinity;
    flushFrame();
    await nextMacrotask();
    assert.equal(portal.isLoading(), false, "raised to Infinity, the next frame finishes it");

    await settle(portal);
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("portals under one scheduler share one budget instead of spending one each", async () => {
    // The frame is shared, so the budget has to be: two panels mounting at
    // once — which is scene startup, not an edge case — must cost the frame
    // one budget between them, not one apiece. At a budget of zero that is
    // one node per frame *total*, the rotation deciding whose, where two
    // self-paced portals would build two.
    const manager = new InteractionManager();
    let ctx = InteractionContext.set({}, manager);
    const scheduler = createPortalScheduler({
      budget: 0,
      requestFrames: (tick) => {
        let active = true;
        const loop = () => {
          if (active) {
            tick();
            requestAnimationFrame(loop);
          }
        };
        requestAnimationFrame(loop);
        return () => {
          active = false;
        };
      },
    });
    ctx = PortalSchedulerContext.set(ctx, scheduler);

    const mountPanel = () => {
      const portal = createPortal(ctx);
      const parent = new THREE.Group();
      portal.addTo(parent);
      /** @type {import("justdom").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children(...Array.from({ length: 4 }, () => $("div")))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      const containerObject = parent.children[0];
      return {
        portal,
        subscription,
        built: () => {
          const root = containerObject.children.find((child) => !(child instanceof THREE.Mesh));
          if (!root) {
            return 0;
          }
          return 1 + root.children[0].children.length;
        },
      };
    };

    const a = mountPanel();
    const b = mountPanel();
    await nextMacrotask();

    for (let frame = 0; frame < 4; frame += 1) {
      flushFrame();
      await nextMacrotask();
    }
    assert.equal(
      a.built() + b.built(),
      4,
      "four frames, four nodes between the two panels — one budget, not two",
    );
    assert.equal(a.built(), 2, "split evenly by the rotation");
    assert.equal(b.built(), 2);

    await settle(a.portal);
    await settle(b.portal);
    assert.equal(a.portal.isLoading(), false);
    assert.equal(b.portal.isLoading(), false);
    assert.equal(a.built(), 5);
    assert.equal(b.built(), 5);

    a.subscription.unsubscribe();
    a.portal.disconnect();
    b.subscription.unsubscribe();
    b.portal.disconnect();
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

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("id", () => "hovered")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const element = /** @type {HTMLElement} */ (document.getElementById("hovered"));
    assert.ok(element);

    let reads = 0;
    // In a channel of the same order as the portal's, because the style
    // cache it reads belongs to the panel's channel — a default-channel
    // reader of panel state is a backwards edge, and `Derived` would
    // rightly warn about it.
    const observing = new UpdateChannel({ name: "observing", order: 1 });
    const dependent = withChannel(
      observing,
      () =>
        new Derived(() => {
          reads += 1;
          return getComputedStyleCached(element).cursor;
        }),
    );
    const dependentSubscription = dependent.subscribe({ next: () => dependent.get() });
    dependent.get();
    assert.equal(reads, 1);

    element.dataset.xrHover = "true";
    await pump();
    assert.equal(reads, 2, "the first write is a change");

    element.dataset.xrHover = "true";
    await pump();
    assert.equal(reads, 2, "the second is not");

    dependentSubscription.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a font loading period closing reaches surviving panels after the first asker is gone", async () => {
    // The x-height metric is one Derived per (family, weight), shared by
    // every panel and built lazily — under whichever panel first asked. It
    // must live in the default channel: captured into that panel's private
    // channel instead, `loadingdone` would queue its re-measure in a channel
    // that stops being pumped when the panel is disposed, and no surviving
    // panel would ever re-measure its text.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);

    // The probe span measures 0 in jsdom, so a re-measure would be both
    // invisible and value-equal — and a value that never changes stops the
    // invalidation from travelling. Give it a height that moves.
    const originalRect = window.Element.prototype.getBoundingClientRect;
    let probeHeight = 50;
    let probeReads = 0;
    window.Element.prototype.getBoundingClientRect = function () {
      const element = /** @type {HTMLElement} */ (this);
      if (
        element.tagName === "SPAN" &&
        element.textContent === "x" &&
        element.style.top === "-9999px"
      ) {
        probeReads += 1;
        return /** @type {DOMRect} */ (
          /** @type {unknown} */ ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 0,
            bottom: probeHeight,
            width: 0,
            height: probeHeight,
          })
        );
      }
      return originalRect.call(this);
    };
    try {
      /**
       * @returns {{ portal: ReturnType<typeof createPortal>, subscription: { unsubscribe: () => void } }}
       */
      const mountPanel = () => {
        const portal = createPortal(ctx);
        portal.addTo(new THREE.Group());
        /** @type {import("justdom").Mountable | undefined} */
        let mountable;
        const tree = $("div", [children($("div", []))]);
        const subscription = tree.subscribe((value) => {
          mountable = value;
        });
        assert.ok(mountable);
        portal.mount(mountable);
        return { portal, subscription };
      };

      const first = mountPanel();
      await settle(first.portal);
      const second = mountPanel();
      await settle(second.portal);

      first.subscription.unsubscribe();
      first.portal.disconnect();

      const readsBefore = probeReads;
      probeHeight = 60;
      dispatchFontsEvent("loadingdone");
      await pump();

      assert.ok(probeReads > readsBefore, "the metric re-measured after the loading period closed");
      assert.equal(frameCallbacks.length, 0, "the surviving panel drained back to quiet");

      second.subscription.unsubscribe();
      second.portal.disconnect();
    } finally {
      window.Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  test("an image landing after the first asking panel is gone still reaches the others", async () => {
    // One texture entry per URL, shared across panels and built lazily —
    // during whichever panel's flush asked first. Like the font metric
    // above, it must never end up owned by that panel's private channel:
    // the panel that triggered the load is free to die before the load
    // resolves, and the panels still standing must hear about the texture
    // anyway. This pins the whole journey — one load per URL however many
    // panels ask, and a completion that lands after the first asker is gone
    // still reaching the rest.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);

    /** @type {Array<{ url: string, onLoad: ((texture: THREE.Texture) => void) | undefined }>} */
    const pendingLoads = [];
    const originalLoad = THREE.TextureLoader.prototype.load;
    THREE.TextureLoader.prototype.load = /** @type {typeof originalLoad} */ (
      function (/** @type {string} */ url, /** @type {(texture: THREE.Texture) => void} */ onLoad) {
        pendingLoads.push({ url, onLoad });
        return new THREE.Texture();
      }
    );
    try {
      /**
       * @returns {{ portal: ReturnType<typeof createPortal>, subscription: { unsubscribe: () => void } }}
       */
      const mountImage = () => {
        const portal = createPortal(ctx);
        portal.addTo(new THREE.Group());
        /** @type {import("justdom").Mountable | undefined} */
        let mountable;
        const tree = $("div", [children($("img", [attr("src", () => "/shared-icon.png")]))]);
        const subscription = tree.subscribe((value) => {
          mountable = value;
        });
        assert.ok(mountable);
        portal.mount(mountable);
        return { portal, subscription };
      };

      const first = mountImage();
      await settle(first.portal);
      const second = mountImage();
      await settle(second.portal);

      assert.equal(pendingLoads.length, 1, "one URL, one load, however many panels show it");
      const { url, onLoad } = pendingLoads[0];
      assert.ok(onLoad);

      // Watch the shared entry the way a panel does: from a channel of the
      // panel's own order.
      const entry = acquireImage(url);
      const observing = new UpdateChannel({ name: "observing", order: 1 });
      const status = withChannel(observing, () => new Derived(() => entry.state.get().status));
      const statusSubscription = status.subscribe({ next: () => status.get() });
      assert.equal(status.get(), "loading");

      first.subscription.unsubscribe();
      first.portal.disconnect();

      onLoad(new THREE.Texture());
      await pump();

      assert.equal(status.get(), "loaded", "the surviving panel's image arrived");

      statusSubscription.unsubscribe();
      releaseImage(url);
      second.subscription.unsubscribe();
      second.portal.disconnect();
    } finally {
      THREE.TextureLoader.prototype.load = originalLoad;
    }
  });

  test("a rule rewritten behind a stable class name restyles the panel", async () => {
    // What a styling library that hands out class names does when the value
    // inside one of its templates changes: it rewrites the rule in the head
    // and leaves the `class` attribute exactly as it was. That is the whole
    // point of the stable name — one attribute across a lifetime of style
    // updates — and it means the panel's own subtree, which is all the
    // observer watches, does not move by so much as a character.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    const color = Signal.of("rgb(1, 2, 3)");
    const card = className`
      background-color: ${toObservable(color)};
    `;

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("id", () => "card"), attr("class", card)]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const element = /** @type {HTMLElement} */ (document.getElementById("card"));
    assert.ok(element);
    const classBefore = element.getAttribute("class");

    let reads = 0;
    const observing = new UpdateChannel({ name: "observing", order: 1 });
    const dependent = withChannel(
      observing,
      () =>
        new Derived(() => {
          reads += 1;
          return getComputedStyleCached(element).backgroundColor;
        }),
    );
    const dependentSubscription = dependent.subscribe({ next: () => dependent.get() });
    assert.equal(dependent.get(), "rgb(1, 2, 3)");
    assert.equal(reads, 1);

    color.set("rgb(4, 5, 6)");
    await pump();

    assert.equal(
      element.getAttribute("class"),
      classBefore,
      "the class attribute is not what changed",
    );
    assert.equal(dependent.get(), "rgb(4, 5, 6)", "the panel wears the colour the rule now says");
    assert.equal(reads, 2, "and read it once more, not once per element in the head");

    dependentSubscription.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a head mutation that is not a stylesheet restyles nothing", async () => {
    // The head is a busy place — a title, a meta tag, a preload hint — and a
    // whole-panel restyle is far too expensive to spend on any of them.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("id", () => "plain")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const element = /** @type {HTMLElement} */ (document.getElementById("plain"));
    assert.ok(element);

    let reads = 0;
    const observing = new UpdateChannel({ name: "observing", order: 1 });
    const dependent = withChannel(
      observing,
      () =>
        new Derived(() => {
          reads += 1;
          return getComputedStyleCached(element).backgroundColor;
        }),
    );
    const dependentSubscription = dependent.subscribe({ next: () => dependent.get() });
    dependent.get();
    assert.equal(reads, 1);

    const meta = document.createElement("meta");
    meta.setAttribute("name", "description");
    document.head.appendChild(meta);
    await pump();
    assert.equal(reads, 1, "a meta tag says nothing about how the panel looks");

    meta.remove();
    dependentSubscription.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a stylesheet arriving after the panel, and leaving again, both reach it", async () => {
    // The other half of the same event, and the other tag: `stylesheet`
    // writes whole rules rather than the body of one, and a sheet of them
    // can be mounted and unmounted while the panel it dresses stands still.
    // A component whose styles are subscribed alongside it is exactly that.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children($("div", [attr("id", () => "late"), attr("class", () => "late")])),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const element = /** @type {HTMLElement} */ (document.getElementById("late"));
    assert.ok(element);

    const observing = new UpdateChannel({ name: "observing", order: 1 });
    const dependent = withChannel(
      observing,
      () => new Derived(() => getComputedStyleCached(element).backgroundColor),
    );
    const dependentSubscription = dependent.subscribe({ next: () => dependent.get() });
    assert.equal(dependent.get(), "rgba(0, 0, 0, 0)", "nothing dresses it yet");

    const sheet = stylesheet`
      .late {
        background-color: rgb(7, 8, 9);
      }
    `;
    const sheetSubscription = sheet.subscribe(() => {});
    await pump();
    assert.equal(dependent.get(), "rgb(7, 8, 9)", "the sheet landed on a panel already standing");

    sheetSubscription.unsubscribe();
    await pump();
    assert.equal(dependent.get(), "rgba(0, 0, 0, 0)", "and the rule left with it");

    dependentSubscription.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
  });
});

/**
 * The mirror reads the DOM, not the library that wrote it. `mount()` takes a
 * `Mountable` — one method, declared in this package rather than imported from
 * `justdom` — so anything able to put real elements into a span of siblings can
 * be projected: another framework's renderer, a server-rendered fragment
 * adopted in place, or the dozen lines below.
 *
 * What this guards is narrower than it looks, and worth stating exactly. It is
 * not tree shape: a justdom tree and the raw one below leave the portal's
 * container in the same state — one element, no envelope, nothing to tell them
 * apart — so there is no justdom-shaped structure for an assumption to attach
 * itself to in the first place.
 *
 * It is the *contract*. Every other test in this file builds its tree with
 * `justdom`, so all of them would keep passing if `mount` quietly grew
 * a second requirement and justdom grew the method to satisfy it — and every
 * integration written against the one method in the README would break. That is
 * the regression this catches, and the only test here that can: it is the sole
 * caller whose mountable was not written by the package on the other side of
 * the seam.
 */
describe("mounting a tree justdom did not build", () => {
  /**
   * The whole `Mountable` contract, over a single element: put the node where
   * the span is, take the span's own nodes out, and report the span the node
   * now occupies.
   *
   * @param {Node} node
   * @returns {import('../core.js').Mountable}
   */
  function mountableFor(node) {
    return {
      replace([first, last]) {
        const parent = first.parentNode;
        if (!parent) {
          throw new Error("Cannot replace a segment that is not in a tree.");
        }
        parent.insertBefore(node, first);
        for (let current = /** @type {Node | null} */ (first); current; ) {
          const next = current.nextSibling;
          parent.removeChild(current);
          current = current === last ? null : next;
        }
        return [node, node];
      },
    };
  }

  test("projects it exactly as it projects a justdom one", async () => {
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

    // The same card the first test in this file builds with `$` and
    // `children`: one button and one plain wrapper, in plain DOM calls.
    const root = document.createElement("div");
    const button = document.createElement("div");
    button.setAttribute("style", "cursor: pointer");
    const label = document.createElement("div");
    label.setAttribute("style", "padding: 4px");
    root.appendChild(button);
    root.appendChild(label);

    portal.mount(mountableFor(root));
    await settle(portal);

    assert.equal(
      getPortalRoot(button)?.contains(root),
      true,
      "the tree went into the portal's own container",
    );
    assert.equal(
      added.length,
      2,
      "one blocker and one clickable div, the same as for a justdom tree",
    );
    assert.ok(
      added.some(
        (object) => object instanceof THREE.Mesh && object.geometry instanceof THREE.PlaneGeometry,
      ),
      "the blocker plane is among them",
    );

    portal.disconnect();
  });
});
