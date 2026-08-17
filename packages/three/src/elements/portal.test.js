import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Derived, UpdateChannel, withChannel } from "@apendua/signal";
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

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable<Node> | undefined} */
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
});
