import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Derived, Effect, Signal, toObservable, UpdateChannel, withChannel } from "@apendua/signal";
import { $, attr, children, className, stylesheet } from "@apendua/justdom";
import { InteractionContext, InteractionManager } from "../interactions.js";
import {
  DomMirror,
  getComputedStyleCached,
  LOADING_ATTRIBUTE,
  resetMeasuringRangeForTests,
} from "./mirror.js";
import { acquireImage, releaseImage } from "./image.js";
import { createPortal as createHeldPortal, getPortalRoot } from "./portal.js";
import { withPanelOptions } from "./panelOptions.js";
import { recordingSource } from "../test/rumble.js";

/**
 * `createPortal`, with the loading frame's delay and minimum time off. A
 * panel here shows its frame on the first frame its mount does not finish
 * in, and loads the moment it is built, so a test can count the frames a
 * mount takes; the delay and the hold have tests of their own, which ask
 * for them by name.
 *
 * @type {typeof createHeldPortal}
 */
const createPortal = (ctx, options = {}) =>
  createHeldPortal(ctx, {
    loadingFrame: { delay: 0, minimumTime: 0 },
    ...options,
  });
import { createPortalScheduler, PortalSchedulerContext } from "./portalScheduler.js";
import {
  countingManager,
  dispatchFontsEvent,
  drain,
  flushFrame,
  frameCallbacks,
  nextMacrotask,
  pageCard,
  pump,
  settle,
} from "../test/portalHarness.js";

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
    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

  test("content mounted mid-build is not lost to an orphaned object", async () => {
    // The race: a node the observer reports directly — content mounted while
    // the initial build is still being sliced across frames — can reach the
    // pump's queue ahead of the parent it belongs under. Built first, it finds
    // no object to attach to; when its parent's turn comes, the parent must
    // adopt it, or it hangs outside the scene forever, mirrored but never
    // drawn. This is exactly how `scrollable`'s bar vanished: its
    // ResizeObserver fires on first layout, mid-mount, and the bar's subtree
    // was queued ahead of the un-built widget root it belonged under.
    //
    // A budget of 0 pins the interleaving: the pump builds exactly one node
    // per frame (the at-least-one guarantee), so each `flushFrame` below is
    // one build, and the insertion lands between two known turns.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);

    // root > a > b, mounted; x arrives under b later, mid-build.
    const root = document.createElement("div");
    const a = document.createElement("div");
    const b = document.createElement("div");
    root.appendChild(a);
    a.appendChild(b);

    /** @type {import("@apendua/justdom").Mountable} */
    const mountable = {
      replace([first, last]) {
        const container = first.parentNode;
        assert.ok(container);
        container.insertBefore(root, first);
        container.removeChild(first);
        if (last !== first) {
          container.removeChild(last);
        }
        return [root, root];
      },
    };
    portal.mount(mountable);

    // The observer reports the mounted tree and queues its root.
    await nextMacrotask();
    // One frame: `root` builds, queueing [a].
    flushFrame();
    await nextMacrotask();

    // Mid-build, content appears under `b` — which is not even queued yet.
    // The observer queues `x` directly: the queue is now [a, x], and `b`
    // only joins it behind `x` when `a`'s turn walks its children. So `x`
    // builds before its parent exists — the race, made deterministic.
    const x = document.createElement("div");
    b.appendChild(x);
    await nextMacrotask();

    await settle(portal);

    // Every element must be reachable from the portal's container: an equal
    // tree mounted whole is the yardstick for what the sliced, raced mount
    // should have produced.
    const control = createPortal(InteractionContext.set({}, new InteractionManager()));
    const controlParent = new THREE.Group();
    control.addTo(controlParent);
    const controlRoot = /** @type {HTMLElement} */ (root.cloneNode(true));
    /** @type {import("@apendua/justdom").Mountable} */
    const controlMountable = {
      replace([first, last]) {
        const container = first.parentNode;
        assert.ok(container);
        container.insertBefore(controlRoot, first);
        container.removeChild(first);
        if (last !== first) {
          container.removeChild(last);
        }
        return [controlRoot, controlRoot];
      },
    };
    control.mount(controlMountable);
    await settle(control);

    /** @param {THREE.Object3D} object */
    const countDescendants = (object) => {
      let count = 0;
      object.traverse(() => {
        count += 1;
      });
      return count;
    };

    assert.equal(
      countDescendants(parent),
      countDescendants(controlParent),
      "the raced mount reaches the scene in full, exactly as the same tree mounted whole",
    );

    portal.disconnect();
    control.disconnect();
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

  test("visibility hides what an element paints, and a child can show itself again", async () => {
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

    const outerStyle = Signal.of("cursor: pointer; visibility: hidden");
    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      attr("style", () => outerStyle.get()),
      children(
        $("div", [attr("style", () => "cursor: pointer; visibility: visible")]),
        $("input", [attr("type", () => "checkbox"), attr("checked", () => "")]),
      ),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const isBlocker = (/** @type {THREE.Object3D} */ object) =>
      object instanceof THREE.Mesh && object.geometry instanceof THREE.PlaneGeometry;
    // The blocker and the inner button. Not the outer button, which is
    // hidden, and not the checkbox, which inherits that.
    assert.equal(registered.length, 2);
    const inner = registered.find((object) => !isBlocker(object));
    assert.ok(inner?.parent?.parent);
    const outer = inner.parent.parent;
    const outerContent = inner.parent;

    /**
     * The meshes an object paints itself with, leaving out its content group.
     *
     * @param {THREE.Object3D} object
     * @returns {THREE.Object3D[]}
     */
    const ownMeshes = (object) => object.children.filter((child) => child instanceof THREE.Mesh);
    const checkboxObject = outerContent.children.find(
      (child) => child !== inner && ownMeshes(child).length === 2,
    );
    assert.ok(checkboxObject, "the checkbox draws its box and its tick");

    assert.deepEqual(
      ownMeshes(outer).map((mesh) => mesh.visible),
      [false],
      "the hidden element's quad",
    );
    assert.deepEqual(
      ownMeshes(checkboxObject).map((mesh) => mesh.visible),
      [false, false],
      "so does a control, tick and all",
    );
    assert.deepEqual(
      ownMeshes(inner).map((mesh) => mesh.visible),
      [true],
      "a child that says visible is drawn",
    );
    assert.equal(outer.visible, true, "nothing prunes the subtree");
    assert.equal(outerContent.visible, true);

    outerStyle.set("cursor: pointer");
    await pump();

    assert.equal(registered.length, 4, "the outer button and the checkbox join");
    assert.deepEqual(
      [...ownMeshes(outer), ...ownMeshes(checkboxObject)].map((mesh) => mesh.visible),
      [true, true, true],
    );

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("the container is out of the page's way without hiding what it holds", async () => {
    const portal = createPortal(InteractionContext.set({}, new InteractionManager()));
    portal.addTo(new THREE.Group());
    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const subscription = $("div", [attr("id", () => "held")]).subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const held = /** @type {HTMLElement} */ (document.getElementById("held"));
    const container = getPortalRoot(held);
    assert.ok(container);
    // Kept out of the tab order, the accessibility tree and find-in-page,
    // which `visibility: hidden` used to do and being off-screen does not.
    assert.ok(container.hasAttribute("inert"));
    assert.equal(container.getAttribute("aria-hidden"), "true");

    // A page hiding its own furniture does not reach into the panel: the
    // container says `visible` for itself, so what is inside inherits that
    // rather than whatever is above.
    document.body.style.visibility = "hidden";
    try {
      assert.equal(window.getComputedStyle(held).visibility, "visible");
    } finally {
      document.body.style.visibility = "";
    }

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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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
    // One range serves every measurement now, so a measurement is a node
    // being selected on it, not a range being made.
    resetMeasuringRangeForTests();
    document.createRange = () => {
      const range = originalCreateRange();
      const select = range.selectNodeContents.bind(range);
      range.selectNodeContents = (node) => {
        rangeMeasurements += 1;
        select(node);
      };
      return range;
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
      resetMeasuringRangeForTests();
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    const loadingFrame = () =>
      containerObject.children.find((child) => child.name === "loading-frame");
    const rootObject = () =>
      containerObject.children.find(
        (child) => !(child instanceof THREE.Mesh) && child.name !== "loading-frame",
      );

    assert.equal(portal.isLoading(), true, "a mounting panel is loading");
    assert.equal(rootObject(), undefined, "with nothing of its content in the scene yet");
    assert.equal(registered.length, 0, "and nothing in it is a ray target yet");
    assert.equal(loadingFrame(), undefined, "and no loading frame before a frame has run");

    // The mount arrived as ONE root carrying eight rows — nine nodes. At a
    // budget of zero the pump builds exactly one per frame, so frames in the
    // tree is still incomplete, and all of that is behind the loading state.
    flushFrame();
    await nextMacrotask();
    flushFrame();
    await nextMacrotask();
    assert.equal(portal.isLoading(), true, "two frames into a nine-node mount, still loading");
    assert.ok(loadingFrame(), "and showing its loading frame, the mount having outrun a frame");
    assert.ok(
      (rootObject()?.children[0]?.children.length ?? 0) < 8,
      "because the single root's subtree is being built a node at a time",
    );

    await settle(portal);

    assert.equal(portal.isLoading(), false, "loaded once everything exists");
    assert.equal(loadingFrame(), undefined, "the loading frame gone with the load");
    assert.equal(rootObject()?.children[0]?.children.length, 8, "with every row built");
    assert.equal(registered.length, 9, "the blocker and eight buttons, registered on load");
    assert.deepEqual(transitions, [false], "one transition, announced once");

    // Later arrivals go through the same budgeted pump but are not a loading
    // state. Each appended row is one node, so a zero budget builds exactly
    // one per frame — and none of them is in the scene until all of them
    // are: the rows a new row pushes down move in the frame the channel
    // sweeps, and the new row appears in that same frame, or the panel would
    // show the arrival before the room made for it. Four rows, four frames of
    // building, then one commit.
    const container = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (container[container.length - 1].firstElementChild);
    for (let index = 0; index < 4; index++) {
      list.appendChild(document.createElement("div"));
    }
    await nextMacrotask();
    assert.equal(portal.isLoading(), false, "a mounted panel does not load again");

    const rows = () => rootObject()?.children[0]?.children.length ?? 0;
    for (let frame = 0; frame < 4; frame++) {
      flushFrame();
      await nextMacrotask();
      assert.equal(rows(), 8, `frame ${frame + 1}: built a row, shown none`);
    }

    await settle(portal);
    assert.equal(rows(), 12, "the whole batch, in the frame the update commits");
    assert.deepEqual(transitions, [false], "with no second announcement");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("an update too big for one frame changes the panel once, not in instalments", async () => {
    // The case this exists for. A restyle that reaches every row queues an
    // effect per row, and a budget that fits three of them a frame used to
    // apply three a frame: the panel changed as a wave, rows sliding a few
    // at a time, where the initial mount — hidden until it had settled —
    // arrived whole. The channel is atomic now: each frame's budget resolves
    // what the effects will read, and the effects run together in the frame
    // that finds nothing left to resolve. Until then the panel stands as it
    // was, however many frames that takes.
    //
    // A zero budget makes that several: the channel warms exactly one effect
    // per frame, and a rule change reaches every effect that reads a style —
    // a good many per row. How many is not the point and not asserted; that
    // no frame before the last shows a row changed, and the last shows every
    // row changed, is.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    // Red at either end of the range, so the linear value the uniform holds
    // is exact whichever way the colour space conversion goes.
    const color = Signal.of("rgb(0, 2, 3)");
    const rowClass = className`
      background-color: ${toObservable(color)};
    `;
    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(...Array.from({ length: 4 }, () => $("div", [attr("class", rowClass)]))),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const rows = rootObject.children[0].children;
    assert.equal(rows.length, 4);
    /**
     * How many boxes the batch is drawing red. Read off the instances the
     * batch draws rather than off each box: a batched box no longer has a
     * material of its own to ask — every one of them wears the same shared,
     * invisible one — and what the batch copied into its instance buffers is
     * what reaches the screen anyway. The root and the list have no
     * background, so red is the rows and only the rows.
     */
    const red = () => {
      let count = 0;
      for (const child of containerObject.children) {
        if (!(child instanceof THREE.InstancedMesh)) {
          continue;
        }
        const fill = child.geometry.getAttribute("aFillColor");
        for (let index = 0; index < child.count; index++) {
          if (fill.getX(index) === 1) {
            count += 1;
          }
        }
      }
      return count;
    };
    assert.equal(red(), 0, "the colour the rule says: no red on any row");

    color.set("rgb(255, 2, 3)");
    await nextMacrotask();
    let frames = 0;
    while (frames < 200 && red() === 0) {
      flushFrame();
      await nextMacrotask();
      frames += 1;
    }
    assert.equal(red(), 4, "the frame that changed one row changed every row");
    assert.ok(frames > 1, `and it was not the first frame — it took ${frames}`);

    await pump();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("an animation of nothing inherited restyles the element, not what is on it", async () => {
    // The clock and the mirror each have tests of their own for this; what
    // this one pins is the wire between them. A card turning under a
    // transform restyles the card and not the label on it; a colour
    // transition, which the label inherits, restyles both.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());
    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const subscription = $("div", [children($("div", []))]).subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const card = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    const label = /** @type {HTMLElement} */ (card.firstElementChild);
    // Where a card is mid-turn: a transform of its own, and none on the
    // label. The clock compares the two to rule out a label that inherits
    // the transform explicitly, and two unset values would compare equal.
    card.style.transform = "matrix(0.996, 0.087, -0.087, 0.996, 0, 0)";
    await pump();
    const reads = { card: 0, label: 0 };
    const holders = [
      new Effect(() => {
        reads.card += 1;
        getComputedStyleCached(card);
      }),
      new Effect(() => {
        reads.label += 1;
        getComputedStyleCached(label);
      }),
    ];
    assert.deepEqual(reads, { card: 1, label: 1 });

    /** @param {string} type @param {string} propertyName */
    const transition = (type, propertyName) =>
      card.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { propertyName }));

    try {
      transition("transitionrun", "transform");
      await pump();
      assert.ok(reads.card > 1, "the card restyles while it turns");
      assert.equal(reads.label, 1, "the label on it does not");
      transition("transitionend", "transform");
      await pump();

      const before = reads.label;
      transition("transitionrun", "color");
      await pump();
      assert.ok(reads.label > before, "a colour reaches the label, which inherits it");
    } finally {
      // Ended whichever way the test went, or the clock goes on asking for
      // frames every test after this one would have to flush.
      transition("transitionend", "transform");
      transition("transitionend", "color");
      await pump();
      holders.forEach((effect) => effect.dispose());
      subscription.unsubscribe();
      portal.disconnect();
    }
  });

  test("a portal that is not atomic changes by instalments, something every frame", async () => {
    // The trade the option is for. An atomic panel under an update that
    // lands on every frame — a layout transition — re-reads everything each
    // frame, and when that does not fit the budget it does not move until
    // the animation ends. Not atomic, the budget runs effects rather than
    // resolving for them: the rows change a few at a time, as they did
    // before there were atomic channels, and the first of them changes in
    // the first frame.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0, atomic: false });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    const color = Signal.of("rgb(0, 2, 3)");
    const rowClass = className`
      background-color: ${toObservable(color)};
    `;
    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(...Array.from({ length: 4 }, () => $("div", [attr("class", rowClass)]))),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    /** How many boxes the batch is drawing red; see the test above. */
    const red = () => {
      let count = 0;
      for (const child of containerObject.children) {
        if (!(child instanceof THREE.InstancedMesh)) {
          continue;
        }
        const fill = child.geometry.getAttribute("aFillColor");
        for (let index = 0; index < child.count; index++) {
          if (fill.getX(index) === 1) {
            count += 1;
          }
        }
      }
      return count;
    };
    assert.equal(red(), 0);

    color.set("rgb(255, 2, 3)");
    await nextMacrotask();
    /** @type {number[]} */
    const seen = [];
    while (seen.length < 200 && red() < 4) {
      flushFrame();
      await nextMacrotask();
      seen.push(red());
    }
    assert.equal(red(), 4, "every row, in the end");
    assert.ok(
      seen.some((count) => count > 0 && count < 4),
      `and some rows before the rest: ${seen.join(", ")}`,
    );

    await pump();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a portal that is not atomic puts a new row in without waiting for a busy channel", async () => {
    // What holds an atomic panel's rows back is the commit, and the commit
    // waits for the channel to empty. A panel that is not atomic changes by
    // instalments anyway; holding its new rows for a channel an animation
    // keeps full would be the very stall it opted out of.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0, atomic: false });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    const color = Signal.of("rgb(0, 2, 3)");
    const rowClass = className`
      background-color: ${toObservable(color)};
    `;
    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(...Array.from({ length: 4 }, () => $("div", [attr("class", rowClass)]))),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const rows = () => rootObject.children[0].children.length;
    assert.equal(rows(), 4);

    // A restyle of every row, which at a zero budget runs one effect a frame
    // and keeps the channel busy for many, and a row arriving meanwhile.
    color.set("rgb(255, 2, 3)");
    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    list.appendChild(document.createElement("div"));
    await nextMacrotask();
    let frames = 0;
    while (frames < 200 && rows() < 5) {
      flushFrame();
      await nextMacrotask();
      frames += 1;
    }
    assert.equal(rows(), 5, "the new row is in the scene");
    assert.ok(frames <= 2, `within a frame or two of arriving — it took ${frames}`);

    await drain();
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a row leaving waits for the same frame as the rows that close over it", async () => {
    // Removing is a change like any other: the row goes and its neighbours
    // move up, and the two have to land together. The object stays in the
    // scene until the update commits — and stays *drawn*, which means it
    // stays whole: its meshes and materials are what its mounting built,
    // and the mounting's teardown takes them with it, so nothing about the
    // row is cleaned up before the commit. Until then it is what the player
    // sees, and what the player sees is pointable.
    const manager = new InteractionManager();
    /** @type {THREE.Object3D[]} */
    const removedTargets = [];
    const originalRemove = manager.remove.bind(manager);
    manager.remove = (object) => {
      removedTargets.push(object);
      originalRemove(object);
    };
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    // Rows the test owns rather than justdom's, since it is going to take
    // them out from under whoever mounted them. Clickable, so that each is
    // a ray target with a registration to watch go.
    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    for (let index = 0; index < 3; index++) {
      const row = document.createElement("div");
      row.style.cursor = "pointer";
      list.appendChild(row);
    }
    await pump();

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const rows = () => rootObject.children[0].children;
    assert.equal(rows().length, 3);
    const last = /** @type {HTMLElement} */ (list.lastElementChild);
    const lastObject = rows()[2];

    const hasQuad = (/** @type {THREE.Object3D} */ row) =>
      row.children.some((child) => child instanceof THREE.Mesh);

    removedTargets.length = 0;
    list.removeChild(last);
    await nextMacrotask();
    assert.equal(rows().length, 3, "still in the scene: the update has not committed");
    assert.ok(hasQuad(lastObject), "and still drawn — its quad is still on it");
    assert.ok(!removedTargets.includes(lastObject), "and still a ray target");
    await drain();
    assert.equal(rows().length, 2, "gone with the commit");
    assert.equal(lastObject.parent, null);
    assert.ok(!hasQuad(lastObject), "taken down whole");
    assert.ok(removedTargets.includes(lastObject), "registration and all");

    // Moved rather than removed, in one flush: the object is kept and goes
    // where the move put it.
    const first = /** @type {HTMLElement} */ (list.firstElementChild);
    const firstObject = rows()[0];
    list.removeChild(first);
    list.appendChild(first);
    await nextMacrotask();
    await drain();
    assert.equal(rows().length, 2, "neither lost nor doubled");
    assert.equal(rows()[1], firstObject, "the same object, at the end");

    // And across two flushes, as long as both land before the commit: the
    // node is back in the tree when the commit looks, so it was moved.
    const again = /** @type {HTMLElement} */ (list.firstElementChild);
    const againObject = rows()[0];
    list.removeChild(again);
    await nextMacrotask();
    list.appendChild(again);
    await nextMacrotask();
    await drain();
    assert.equal(rows().length, 2);
    assert.equal(rows()[1], againObject, "kept, and at the end");
    assert.ok(hasQuad(againObject), "never taken down");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("the batches draw what the commit attached, in the frame it was attached", async () => {
    // A box tells its batch about itself when it is built, and the batch
    // rebuilds by walking the panel — which, with attachment held for the
    // commit, found nothing where the box now hangs. The boxes then stayed
    // out of the draw until something unrelated restyled the panel, while
    // the text that draws itself appeared at once: labels over no card. The
    // commit has to ask for the rebuild itself. The instanced meshes the
    // box batch draws from are the observable: their counts add up to the
    // boxes the walk found.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];
    const drawn = () =>
      containerObject.children
        .filter((child) => child instanceof THREE.InstancedMesh)
        .reduce((sum, mesh) => sum + /** @type {THREE.InstancedMesh} */ (mesh).count, 0);

    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div"), $("div"))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);
    assert.equal(drawn(), 3, "the root and two rows, drawn from the moment the panel shows");

    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    list.appendChild(document.createElement("div"));
    list.appendChild(document.createElement("div"));
    await drain();
    assert.equal(drawn(), 5, "two more, drawn in the frame they were attached");

    // One of the rows the test appended, not one of justdom's.
    list.removeChild(/** @type {ChildNode} */ (list.lastElementChild));
    await nextMacrotask();
    flushFrame();
    await nextMacrotask();
    assert.equal(drawn(), 5, "a frame on, the removed row is still drawn: no commit yet");
    await drain();
    assert.equal(drawn(), 4, "and one fewer in the frame it was taken out");

    subscription.unsubscribe();
    portal.disconnect();
    // Unmounting asked for a frame; let it run so it does not reach the
    // next test's count of the shared stub's queue.
    await drain();
  });

  test("a mounting panel shows a loading frame its own size, where the panel will be", async () => {
    // The container is placed by an effect in the atomic channel, and that
    // effect waits for the commit that ends the mount — so until then the
    // container sat at the origin, unsized. The loading frame needs the
    // panel's size and place before the panel has them, and takes them
    // itself: each of its frames reads the container's size and places the
    // container, and the frame in it, from that. When the mount commits the
    // frame goes in the same tick the content arrives.
    const originalRect = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
      const element = /** @type {HTMLElement} */ (this);
      if (element.closest("[data-xr-portal]")) {
        return /** @type {DOMRect} */ (
          /** @type {unknown} */ ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 100,
            bottom: 200,
            width: 100,
            height: 200,
          })
        );
      }
      return originalRect.call(this);
    };
    try {
      const manager = new InteractionManager();
      const ctx = InteractionContext.set({}, manager);
      const portal = createPortal(ctx, { budget: 0 });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      const loadingFrame = () =>
        containerObject.children.find((child) => child.name === "loading-frame");

      /** @type {import("@apendua/justdom").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children($("div"), $("div"), $("div"))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await nextMacrotask();

      // One frame in: four nodes at a budget of zero is four frames of
      // building, so the panel is nowhere near done.
      flushFrame();
      await nextMacrotask();
      assert.equal(portal.isLoading(), true);
      const frame = loadingFrame();
      assert.ok(frame, "the frame is up");
      const quad = /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>} */ (
        frame.children[0]
      );
      assert.deepEqual(
        [quad.material.uniforms.uSize.value.x, quad.material.uniforms.uSize.value.y],
        [100, 200],
        "sized to the panel",
      );
      assert.deepEqual([quad.scale.x, quad.scale.y], [100, 200]);
      assert.equal(frame.children.length, 4, "a quad and three dots");
      assert.deepEqual(
        [containerObject.position.x, containerObject.position.y],
        [-0.5, 1],
        "and the container placed for a 100 by 200 px panel, at a centimetre a px",
      );
      assert.equal(containerObject.visible, true, "in a container that is not hidden");

      await settle(portal);
      assert.equal(loadingFrame(), undefined, "taken down when the panel loaded");
      assert.deepEqual(
        [containerObject.position.x, containerObject.position.y],
        [-0.5, 1],
        "where the resize effect then placed it: the same place, so nothing moved",
      );

      subscription.unsubscribe();
      portal.disconnect();
    } finally {
      window.Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  test("a mount that finishes early waits for the loading frame's minimum time", async () => {
    // A frame that flashed for three frames and was gone would read as a
    // glitch, so a mount built before the frame has had its time is held —
    // built and unseen — until it has. The hold sits at the commit: nothing
    // is attached, the panel is still loading, the frame is still up. A
    // declined commit is a tick that did not settle, so the pump stays
    // scheduled and asks again each frame until the time is up, and the
    // tick that finds it up commits and loads. On a clock the test drives.
    const originalNow = performance.now;
    let clock = 0;
    performance.now = () => clock;
    try {
      const manager = new InteractionManager();
      const ctx = InteractionContext.set({}, manager);
      /** @type {boolean[]} */
      const transitions = [];
      const portal = createPortal(ctx, {
        budget: 0,
        // No delay, so the frame is up from the first tick and this is a
        // test of the hold alone; the delay has tests of its own below.
        loadingFrame: { delay: 0, minimumTime: 1000 },
        onLoadingChanged: (value) => transitions.push(value),
      });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      const loadingFrame = () =>
        containerObject.children.find((child) => child.name === "loading-frame");
      const content = () =>
        containerObject.children.find(
          (child) => !(child instanceof THREE.Mesh) && child.name !== "loading-frame",
        );

      /** @type {import("@apendua/justdom").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children($("div"), $("div"))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      const containers = document.querySelectorAll("[data-xr-portal]");
      const containerElement = containers[containers.length - 1];
      assert.equal(
        containerElement.hasAttribute(LOADING_ATTRIBUTE),
        false,
        "nothing to mount yet: not on its way anywhere",
      );
      portal.mount(mountable);
      await nextMacrotask();
      assert.ok(containerElement.hasAttribute(LOADING_ATTRIBUTE), "loading, for the DOM to see");

      // Three nodes at a budget of zero: three frames of building, so the
      // first tick ends unfinished and the frame goes up at 0 ms; the third
      // finishes the mount at 32 ms, well inside the second. Held.
      for (const at of [0, 16, 32, 400, 999]) {
        clock = at;
        flushFrame();
        await nextMacrotask();
        assert.equal(portal.isLoading(), true, `still loading at ${at} ms`);
        assert.ok(loadingFrame(), `the frame up at ${at} ms`);
        assert.equal(content(), undefined, `and nothing attached at ${at} ms`);
      }
      assert.deepEqual(transitions, []);

      clock = 1000;
      for (let index = 0; index < 5 && portal.isLoading(); index++) {
        flushFrame();
        await nextMacrotask();
      }
      assert.equal(portal.isLoading(), false, "loaded once the frame had its second");
      assert.equal(loadingFrame(), undefined, "the frame gone");
      assert.ok(content(), "and the content in its place");
      assert.equal(containerElement.hasAttribute(LOADING_ATTRIBUTE), false);
      assert.deepEqual(transitions, [false]);

      subscription.unsubscribe();
      portal.disconnect();
      await drain();
    } finally {
      performance.now = originalNow;
    }
  });

  test("a mount that settles within the delay never shows the frame, and is not held", async () => {
    // Three frames of building at a budget of zero, sixteen milliseconds
    // apart: done at 32 ms, well inside a 250 ms delay. No frame goes up,
    // so the minimum time — which counts from the showing — holds nothing,
    // and the panel loads in the frame it was finished in.
    const originalNow = performance.now;
    let clock = 0;
    performance.now = () => clock;
    try {
      const manager = new InteractionManager();
      const ctx = InteractionContext.set({}, manager);
      const portal = createPortal(ctx, {
        budget: 0,
        loadingFrame: { delay: 250, minimumTime: 1000 },
      });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      /** @type {string[]} */
      const added = [];
      const originalAdd = containerObject.add.bind(containerObject);
      containerObject.add = (...objects) => {
        for (const object of objects) {
          added.push(object.name);
        }
        return originalAdd(...objects);
      };

      /** @type {import("@apendua/justdom").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children($("div"), $("div"))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await nextMacrotask();

      let frames = 0;
      while (frames < 20 && portal.isLoading()) {
        clock = frames * 16;
        frames += 1;
        flushFrame();
        await nextMacrotask();
      }
      assert.equal(portal.isLoading(), false);
      assert.ok(clock < 250, `loaded inside the delay (${clock} ms)`);
      assert.ok(frames > 1, `and the mount did take more than one frame (${frames})`);
      assert.ok(!added.includes("loading-frame"), "without the frame ever put in the scene");

      subscription.unsubscribe();
      portal.disconnect();
      await drain();
    } finally {
      performance.now = originalNow;
    }
  });

  test("a mount that outruns the delay shows the frame from then, for its minimum time", async () => {
    // The first tick, at 0 ms, leaves the mount unfinished but inside the
    // delay: nothing shown. The next, at 300 ms, is past it: the frame goes
    // up then, and its minimum time counts from then — so the mount, done a
    // frame later, is held until 1300 ms, not 1000.
    const originalNow = performance.now;
    let clock = 0;
    performance.now = () => clock;
    try {
      const manager = new InteractionManager();
      const ctx = InteractionContext.set({}, manager);
      const portal = createPortal(ctx, {
        budget: 0,
        loadingFrame: { delay: 250, minimumTime: 1000 },
      });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      const loadingFrame = () =>
        containerObject.children.find((child) => child.name === "loading-frame");
      const content = () =>
        containerObject.children.find(
          (child) => !(child instanceof THREE.Mesh) && child.name !== "loading-frame",
        );

      /** @type {import("@apendua/justdom").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children($("div"), $("div"))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await nextMacrotask();

      clock = 0;
      flushFrame();
      await nextMacrotask();
      assert.equal(portal.isLoading(), true);
      assert.equal(loadingFrame(), undefined, "unfinished at 0 ms, but inside the delay");

      clock = 300;
      flushFrame();
      await nextMacrotask();
      assert.equal(portal.isLoading(), true);
      assert.ok(loadingFrame(), "past the delay at 300 ms, and shown");

      for (const at of [316, 1000, 1299]) {
        clock = at;
        flushFrame();
        await nextMacrotask();
        assert.equal(portal.isLoading(), true, `held at ${at} ms`);
        assert.ok(loadingFrame(), `the frame up at ${at} ms`);
        assert.equal(content(), undefined, `nothing attached at ${at} ms`);
      }

      clock = 1300;
      for (let index = 0; index < 5 && portal.isLoading(); index++) {
        flushFrame();
        await nextMacrotask();
      }
      assert.equal(portal.isLoading(), false, "loaded a second after the frame went up");
      assert.equal(loadingFrame(), undefined, "the frame gone");
      assert.ok(content(), "and the content in its place");

      subscription.unsubscribe();
      portal.disconnect();
      await drain();
    } finally {
      performance.now = originalNow;
    }
  });

  test("a panel built in its first frame appears in that frame, and never shows a loading frame", async () => {
    // The frame is for a mount that outruns a frame. A panel small enough
    // to be built in its first tick has nothing to soften: it lands in that
    // tick, no frame is shown, and the minimum time — which counts from the
    // showing — holds nothing.
    const originalNow = performance.now;
    performance.now = () => 0;
    try {
      const manager = new InteractionManager();
      const ctx = InteractionContext.set({}, manager);
      const portal = createPortal(ctx, {
        budget: Infinity,
        loadingFrame: { minimumTime: 1000 },
      });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      /** @type {string[]} */
      const added = [];
      const originalAdd = containerObject.add.bind(containerObject);
      containerObject.add = (...objects) => {
        for (const object of objects) {
          added.push(object.name);
        }
        return originalAdd(...objects);
      };

      /** @type {import("@apendua/justdom").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children($("div"), $("div"))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await nextMacrotask();
      assert.equal(portal.isLoading(), true);

      flushFrame();
      await nextMacrotask();
      assert.equal(portal.isLoading(), false, "loaded in the first frame, the clock at zero");
      assert.ok(
        containerObject.children.some(
          (child) => !(child instanceof THREE.Mesh) && child.name !== "loading-frame",
        ),
        "the content in the scene",
      );
      assert.ok(!added.includes("loading-frame"), "and the frame never put in it");

      subscription.unsubscribe();
      portal.disconnect();
      await drain();
    } finally {
      performance.now = originalNow;
    }
  });

  test("a portal given nothing to mount asks for no frames and is not marked loading", async () => {
    // Before the loading frame an empty portal cost nothing per frame, and
    // it still must: the ticks that place the panel and its frame start with
    // the first content the observer reports, not with the portal. Nor is
    // such a portal on its way anywhere, so the attribute a harness waits
    // on stays off it — a page with an empty panel is not a page still
    // loading.
    await drain();
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { loadingFrame: { minimumTime: 1000 } });
    portal.addTo(new THREE.Group());
    const containers = document.querySelectorAll("[data-xr-portal]");
    const containerElement = containers[containers.length - 1];

    // In the scene, and never given anything to mount.
    await nextMacrotask();
    await nextMacrotask();
    assert.equal(frameCallbacks.length, 0, "no frame asked for");
    assert.equal(containerElement.hasAttribute(LOADING_ATTRIBUTE), false, "and not loading");
    assert.equal(portal.isLoading(), true, "though not loaded either: nothing ever arrived");

    portal.disconnect();
  });

  test("a panel that opts out of the loading frame shows nothing until it is whole", async () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0, loadingFrame: false });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div"), $("div"))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await nextMacrotask();
    flushFrame();
    await nextMacrotask();
    assert.equal(portal.isLoading(), true);
    assert.equal(
      containerObject.children.filter((child) => !(child instanceof THREE.Mesh)).length,
      0,
      "nothing but the blocker and the batches' meshes in the container",
    );

    await settle(portal);
    assert.equal(portal.isLoading(), false);

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("a panel closed mid-mount takes its loading frame down with it", async () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div"), $("div"))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await nextMacrotask();
    flushFrame();
    await nextMacrotask();
    const frame = containerObject.children.find((child) => child.name === "loading-frame");
    assert.ok(frame, "the frame is up");

    subscription.unsubscribe();
    portal.disconnect();
    assert.equal(frame.parent, null, "and down with the panel");
    // The frames the mount and the indicator asked for are still queued in
    // the shared stub; let them run against the disposed portal.
    await drain();
  });

  test("the panel moves to its new size in the frame its contents change, not before", async () => {
    // The container is placed on its own size — centred on its origin — by
    // a callback that used to be spelled `observable(fn).subscribe()`. That
    // makes it a `Derived` read by an effect, and a `Derived` is what the
    // warm phase resolves: the panel jumped to its new height while every
    // box inside it still waited for the commit. As an effect it is the
    // write, and waits with the rest. The row that grew the panel is the
    // yardstick: the panel may move only in the frame the row appears.
    const originalRect = window.Element.prototype.getBoundingClientRect;
    let panelHeight = 100;
    window.Element.prototype.getBoundingClientRect = function () {
      const element = /** @type {HTMLElement} */ (this);
      // Every element in the portal reports the same box, so a list that
      // grows reports it as resized and the climb reaches the container.
      if (element.closest("[data-xr-portal]")) {
        return /** @type {DOMRect} */ (
          /** @type {unknown} */ ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 100,
            bottom: panelHeight,
            width: 100,
            height: panelHeight,
          })
        );
      }
      return originalRect.call(this);
    };
    try {
      const manager = new InteractionManager();
      const ctx = InteractionContext.set({}, manager);
      const portal = createPortal(ctx, { budget: 0 });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      const drawn = () =>
        containerObject.children
          .filter((child) => child instanceof THREE.InstancedMesh)
          .reduce((sum, mesh) => sum + /** @type {THREE.InstancedMesh} */ (mesh).count, 0);

      /** @type {import("@apendua/justdom").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children($("div"))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await settle(portal);
      assert.equal(containerObject.position.y, 0.5, "half of 100 px, at a centimetre a pixel");
      assert.equal(drawn(), 2);

      const containers = document.querySelectorAll("[data-xr-portal]");
      const containerElement = /** @type {HTMLElement} */ (containers[containers.length - 1]);
      const list = /** @type {HTMLElement} */ (containerElement.firstElementChild);
      // The order matters for what this proves. A style write on the
      // container re-measures the container first and its contents after,
      // so the placement is the *first* effect in the channel's lane; the
      // row appended in a later flush queues its work behind it. At a zero
      // budget the placement is then warmed on the first frame — which is
      // where the old spelling moved the panel, frames before the commit.
      panelHeight = 200;
      containerElement.style.setProperty("--grown", "1");
      await nextMacrotask();
      list.appendChild(document.createElement("div"));
      await nextMacrotask();

      /** The frame the panel moved in, and the frame the row appeared in. */
      let moved = -1;
      let appeared = -1;
      for (let frame = 1; frame <= 500 && frameCallbacks.length > 0; frame++) {
        flushFrame();
        await nextMacrotask();
        if (moved < 0 && containerObject.position.y !== 0.5) {
          moved = frame;
        }
        if (appeared < 0 && drawn() === 3) {
          appeared = frame;
        }
      }
      assert.equal(containerObject.position.y, 1, "half of 200 px in the end");
      assert.ok(appeared > 1, `the row took more than one frame (${appeared})`);
      assert.equal(moved, appeared, "and the panel moved in that frame, not before");

      subscription.unsubscribe();
      portal.disconnect();
      await drain();
    } finally {
      window.Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  test("a child moved under a row that is not built yet lands there at the commit", async () => {
    // Row A goes, and its inner element E is moved into a *new* row that
    // arrives in the same flush. E has an object; the new row has none yet,
    // so there is no parent object to list E against when the observer
    // reports it — if it reports it at all: E appended into the new row
    // *before* the row joins the document is a mutation of a detached node,
    // which the observer never sees. Either way, when the new row's turn
    // comes its walk finds E's object already parented, under A's group.
    // So the attachment is kept by node, listed by whichever of the two
    // saw the move, and resolved at the commit, by which time the new row
    // is built and E's parent is whatever the tree says it is. Both orders
    // below.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    const a = document.createElement("div");
    const e = document.createElement("span");
    a.appendChild(e);
    list.appendChild(a);
    await drain();

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const listObject = rootObject.children[0];
    const [objA] = listObject.children;
    const objE = objA.children[0].children[0];
    assert.ok(objE, "E was built under A");

    const newRow = document.createElement("div");
    list.removeChild(a);
    newRow.appendChild(e);
    list.appendChild(newRow);
    await nextMacrotask();
    await drain();

    assert.equal(listObject.children.length, 1, "A is gone and the new row is in");
    const objNew = listObject.children[0];
    assert.notEqual(objNew, objA);
    assert.equal(objNew.children[0].children[0], objE, "and E's object, the same one, is under it");

    // The other order: the row joins the document first, so the observer
    // does see E arrive under it — under a parent with no object yet.
    const newerRow = document.createElement("div");
    list.removeChild(newRow);
    list.appendChild(newerRow);
    newerRow.appendChild(e);
    await nextMacrotask();
    await drain();

    assert.equal(listObject.children.length, 1);
    const objNewer = listObject.children[0];
    assert.notEqual(objNewer, objNew);
    assert.equal(
      objNewer.children[0].children[0],
      objE,
      "the same object again, under the newer row",
    );

    subscription.unsubscribe();
    portal.disconnect();
    await drain();
  });

  test("a button is felt as the scene's haptics say, with the panel's own laid over", async () => {
    const manager = new InteractionManager();
    const scene = withPanelOptions(InteractionContext.set({}, manager), {
      haptics: { flavor: "knock" },
    });

    /**
     * A panel under the scene with a button in it, and that button's object,
     * ready to be pointed at.
     *
     * @param {import('./portal.js').PortalOptions} options
     */
    const panel = async (options) => {
      const portal = createPortal(scene, { budget: 0, ...options });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const containerObject = parent.children[0];
      /** @type {import("@apendua/justdom").Mountable | undefined} */
      let mountable;
      const subscription = $("div").subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await settle(portal);
      const containers = document.querySelectorAll("[data-xr-portal]");
      const card = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
      const button = document.createElement("div");
      button.style.cursor = "pointer";
      card.appendChild(button);
      await drain();
      const rootObject = /** @type {THREE.Object3D} */ (
        containerObject.children.find((child) => !(child instanceof THREE.Mesh))
      );
      const object = /** @type {THREE.Object3D<import("../core.js").XREventMap>} */ (
        rootObject.children[0].children[0]
      );
      const { source, played } = recordingSource();
      const controller = new THREE.Object3D();
      for (const type of ["pointerenter", "selectstart", "selectend"]) {
        object.dispatchEvent(
          /** @type {any} */ ({
            type,
            controller,
            inputSource: source,
            originalTarget: object,
            registeredTarget: object,
            relatedTarget: null,
          }),
        );
      }
      subscription.unsubscribe();
      portal.disconnect();
      await drain();
      return played;
    };

    assert.deepEqual(
      (await panel({})).map((effect) => [effect.duration, effect.strongMagnitude]),
      [[60, 0.5]],
      "the scene's knock on the press, and no hover, since nobody asked for one",
    );
    assert.deepEqual(
      (await panel({ haptics: { hover: true, strength: 0.5 } })).map((effect) => [
        effect.duration,
        effect.strongMagnitude,
      ]),
      [
        [30, 0.125],
        [60, 0.25],
      ],
      "the panel turns the hover on and halves the scene's knock",
    );
    assert.deepEqual(await panel({ haptics: false }), [], "and can have none");
  });

  test("a removed row is drawn until the commit but a press on it reaches nothing", async () => {
    // Held for the commit, the row's quad is still there for the ray to
    // land on. What must not follow is the click: the element is out of
    // the document and the app has let go of it, so a handler still hanging
    // off it would run against a row the app considers gone.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    const row = document.createElement("div");
    row.style.cursor = "pointer";
    list.appendChild(row);
    await drain();

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const rowObject = /** @type {THREE.Object3D<import("../core.js").XREventMap>} */ (
      rootObject.children[0].children[0]
    );
    let clicks = 0;
    row.addEventListener("click", () => {
      clicks += 1;
    });
    const controller = new THREE.Object3D();
    const press = () => {
      rowObject.dispatchEvent(/** @type {any} */ ({ type: "selectstart", controller }));
      rowObject.dispatchEvent(/** @type {any} */ ({ type: "selectend", controller }));
      rowObject.dispatchEvent(/** @type {any} */ ({ type: "select", controller }));
    };
    press();
    assert.equal(clicks, 1, "a press on a row that is there is a click");

    list.removeChild(row);
    await nextMacrotask();
    assert.equal(rowObject.parent, rootObject.children[0], "still in the scene until the commit");
    press();
    assert.equal(clicks, 1, "but a press on it now reaches nothing");
    assert.equal(row.dataset.xrActive, undefined, "and does not even mark it pressed");

    await drain();
    subscription.unsubscribe();
    portal.disconnect();
    await drain();
  });

  test("a child moved out of a removed row keeps its object", async () => {
    // Row A goes and its inner element E is appended under row B in the
    // same flush. E is in the tree, its new place is only pending, and its
    // object still sits under A's content group — so taking A down by
    // walking that group would take E's object with it, and E would be in
    // the DOM under B with nothing drawn for it and no event left to say
    // so. The removal lets go of moved children first; the commit places
    // them.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: Infinity });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const containerObject = parent.children[0];

    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    const a = document.createElement("div");
    const b = document.createElement("div");
    const e = document.createElement("span");
    a.appendChild(e);
    list.appendChild(a);
    list.appendChild(b);
    await pump();

    const rootObject = /** @type {THREE.Object3D} */ (
      containerObject.children.find((child) => !(child instanceof THREE.Mesh))
    );
    const listObject = rootObject.children[0];
    const [objA, objB] = listObject.children;
    const objE = objA.children[0].children[0];
    assert.ok(objE, "E was built under A");

    list.removeChild(a);
    b.appendChild(e);
    await nextMacrotask();
    assert.equal(
      objA.children[0].children[0],
      objE,
      "until the commit, E's object stays where it was drawn",
    );
    await drain();

    assert.deepEqual(listObject.children, [objB], "A is gone");
    assert.equal(objB.children[0].children[0], objE, "and E's object, the same one, is under B");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("an object built for a commit that never came is taken down with the panel", async () => {
    // Built in one frame, removed before the next: the object is in the
    // tree no longer and in the scene never, so neither of the walks a
    // dispose makes would find it. It waits for the commit like any removed
    // object, and a panel disposed before that commit has to take it down
    // by name. The registration the ray target made is the one thing about
    // that the test can see.
    const manager = new InteractionManager();
    /** @type {THREE.Object3D[]} */
    const removedTargets = [];
    const originalRemove = manager.remove.bind(manager);
    manager.remove = (object) => {
      removedTargets.push(object);
      originalRemove(object);
    };
    /** @type {THREE.Object3D[]} */
    const addedTargets = [];
    const originalAdd = manager.add.bind(manager);
    manager.add = (object) => {
      addedTargets.push(object);
      originalAdd(object);
    };
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx, { budget: 0 });
    portal.addTo(new THREE.Group());

    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div");
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll("[data-xr-portal]");
    const list = /** @type {HTMLElement} */ (containers[containers.length - 1].firstElementChild);
    // Two rows, so that the zero budget leaves the first built and the
    // second still queued: no commit this frame.
    const first = document.createElement("div");
    first.style.cursor = "pointer";
    list.appendChild(first);
    list.appendChild(document.createElement("div"));
    await nextMacrotask();
    addedTargets.length = 0;
    flushFrame();
    await nextMacrotask();
    assert.equal(addedTargets.length, 1, "the first row was built, and registered itself");
    const built = addedTargets[0];

    removedTargets.length = 0;
    list.removeChild(first);
    await nextMacrotask();
    assert.equal(removedTargets.length, 0, "waiting for a commit, registration and all");

    // Disposed with the second row still queued and the first still listed
    // for a commit that will not come.
    subscription.unsubscribe();
    portal.disconnect();
    assert.ok(removedTargets.includes(built), "its registration went with the panel");
    assert.equal(removedTargets.length, 2, "that and the blocker, nothing taken down twice");
    // The frame the removal asked for is still in the shared stub's queue;
    // let it run against the disposed pump so it does not reach the next test.
    await drain();
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    // Builds are counted where they happen rather than read off the scene,
    // which no longer shows an object before the update it belongs to
    // commits. Every build adopts its node into the panel's mirror first,
    // once, so a count of adoptions per mirror is a count of nodes built per
    // panel. Elements only: the comment markers `children()` fences its
    // rows with are adopted too, and build to nothing — the pump does not
    // count them against a frame, and neither does this. The container's
    // own adoption, made when the portal is created, is left out the same
    // way. Mirrors are met in the order the panels were made.
    /** @type {Map<DomMirror, number>} */
    const adoptions = new Map();
    const originalAdopt = DomMirror.prototype.adopt;
    DomMirror.prototype.adopt = function adopt(node) {
      const counts =
        node.nodeType === Node.ELEMENT_NODE &&
        !(/** @type {Element} */ (node).hasAttribute("data-xr-portal"));
      adoptions.set(this, (adoptions.get(this) ?? 0) + (counts ? 1 : 0));
      return originalAdopt.call(this, node);
    };

    const mountPanel = () => {
      const portal = createPortal(ctx);
      const parent = new THREE.Group();
      portal.addTo(parent);
      /** @type {import("@apendua/justdom").Mountable | undefined} */
      let mountable;
      const tree = $("div", [children(...Array.from({ length: 4 }, () => $("div")))]);
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      return { portal, subscription };
    };

    try {
      const a = mountPanel();
      const b = mountPanel();
      await nextMacrotask();

      for (let frame = 0; frame < 4; frame += 1) {
        flushFrame();
        await nextMacrotask();
      }
      const built = [...adoptions.values()];
      assert.equal(built.length, 2, "two panels, two mirrors");
      assert.equal(
        built[0] + built[1],
        4,
        "four frames, four nodes between the two panels — one budget, not two",
      );
      assert.equal(built[0], 2, "split evenly by the rotation");
      assert.equal(built[1], 2);

      await settle(a.portal);
      await settle(b.portal);
      assert.equal(a.portal.isLoading(), false);
      assert.equal(b.portal.isLoading(), false);
      assert.deepEqual([...adoptions.values()], [5, 5], "and every node of both, in the end");

      a.subscription.unsubscribe();
      a.portal.disconnect();
      b.subscription.unsubscribe();
      b.portal.disconnect();
    } finally {
      DomMirror.prototype.adopt = originalAdopt;
    }
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

  test("an attribute the app's own stylesheet selects on restyles the element", async () => {
    // A button greyed out through `[data-off]`: an attribute no part of the
    // portal knows the name of, written after the mount.
    const style = document.createElement("style");
    style.textContent = "#switch[data-off] { cursor: not-allowed; }";
    document.head.appendChild(style);
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("id", () => "switch")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const element = /** @type {HTMLElement} */ (document.getElementById("switch"));
    assert.ok(element);
    const observing = new UpdateChannel({ name: "observing", order: 1 });
    const dependent = withChannel(
      observing,
      () => new Derived(() => getComputedStyleCached(element).cursor),
    );
    const dependentSubscription = dependent.subscribe({ next: () => dependent.get() });
    assert.notEqual(dependent.get(), "not-allowed");

    element.setAttribute("data-off", "");
    await pump();
    assert.equal(dependent.get(), "not-allowed", "switched off");

    element.removeAttribute("data-off");
    await pump();
    assert.notEqual(dependent.get(), "not-allowed", "and on again");

    dependentSubscription.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
    style.remove();
  });

  test("the portal's loading flag on its container restyles nothing", async () => {
    // The container is above every element in the panel, so an author's
    // attribute there would restyle all of them. The portal writes this one
    // twice a mount, and no stylesheet is meant to select on it.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("id", () => "inside")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    const element = /** @type {HTMLElement} */ (document.getElementById("inside"));
    const containerElement = getPortalRoot(element);
    assert.ok(containerElement);

    let reads = 0;
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

    containerElement.setAttribute(LOADING_ATTRIBUTE, "");
    await pump();
    containerElement.removeAttribute(LOADING_ATTRIBUTE);
    await pump();
    assert.equal(reads, 1, "neither write reached the element");

    containerElement.setAttribute("data-anything-else", "");
    await pump();
    assert.equal(reads, 2, "where any other attribute there does");

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
        /** @type {import("@apendua/justdom").Mountable | undefined} */
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
        /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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

    /** @type {import("@apendua/justdom").Mountable | undefined} */
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
 * `@apendua/justdom`, so all of them would keep passing if `mount` quietly grew
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

describe("the order a mount is built in", () => {
  /**
   * Record the order nodes are built in, by watching the first thing every
   * build does: adopt the node into the mirror.
   *
   * There is no public map from object back to node, and the registration
   * order of ray targets says nothing — everything registers at once when
   * the loading state flips. Adoption is the one point the build passes
   * through, once per node, in the order the pump reaches them.
   *
   * @returns {{ names: string[], restore: () => void }}
   */
  function recordBuildOrder() {
    /** @type {string[]} */
    const names = [];
    const original = DomMirror.prototype.adopt;
    DomMirror.prototype.adopt = function adopt(node) {
      const element = node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : null;
      const name = element?.getAttribute("data-n");
      if (name) {
        names.push(name);
      }
      return original.call(this, node);
    };
    return {
      names,
      restore: () => {
        DomMirror.prototype.adopt = original;
      },
    };
  }

  test("siblings are built before their children, level by level", async () => {
    // The property this pins down is a consequence of one line in
    // `portalPump.js` — the queue is drained with `shift` and grown with
    // `push`, so it is FIFO, and `buildQueuedNode` puts a node's children on
    // the tail. That makes the traversal breadth-first, which is not written
    // down anywhere the way an invariant would be, and is exactly the kind of
    // thing an optimization would undo without meaning to: `shift` on a queue
    // of thousands is linear, and swapping it for `pop` to fix that would
    // silently turn the mount depth-first.
    //
    // Whether depth-first would be worse is a separate question — during the
    // initial mount the panel is hidden, so nobody sees either order. It
    // matters for content arriving into a panel that is already up, which is
    // built through the same queue and is visible while it happens.
    const ctx = InteractionContext.set({}, new InteractionManager());
    // A budget of zero still builds one node per frame, which is what makes
    // the order exact rather than "whatever fit in this frame".
    const portal = createPortal(ctx, { budget: 0 });
    const parent = new THREE.Group();
    portal.addTo(parent);

    const probe = recordBuildOrder();
    try {
      const cell = (/** @type {string} */ name) => $("div", [attr("data-n", () => name)]);
      const row = (/** @type {string} */ name) =>
        $("div", [attr("data-n", () => name), children(cell(`${name}a`), cell(`${name}b`))]);
      const tree = $("div", [attr("data-n", () => "root"), children(row("r1"), row("r2"))]);

      /** @type {import("@apendua/justdom").Mountable | undefined} */
      let mountable;
      const subscription = tree.subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await settle(portal);

      assert.deepEqual(
        probe.names,
        ["root", "r1", "r2", "r1a", "r1b", "r2a", "r2b"],
        "level by level — not root, r1, r1a, r1b, r2, r2b, which is what a stack would give",
      );

      subscription.unsubscribe();
      portal.disconnect();
    } finally {
      probe.restore();
    }
  });
});

describe("mirroring an element the page owns", () => {
  test("what the element already holds is the initial content, and the element is left as it was", async () => {
    const { ctx, targets } = countingManager();
    const { root, button } = pageCard();

    const portal = createPortal(ctx, { root });
    const parent = new THREE.Group();
    portal.addTo(parent);

    // Claimed on the spot: the mark the mirror walks up to is there before a
    // single frame has run. The first look at the content follows a
    // microtask later, when an observer's flush would have, and the loading
    // flag a harness waits on goes up with it.
    assert.ok(root.hasAttribute("data-xr-portal"), "the element is the top of the panel");
    assert.equal(portal.isLoading(), true);
    await nextMacrotask();
    assert.ok(root.hasAttribute(LOADING_ATTRIBUTE), "content already there is a mount under way");

    await settle(portal);

    assert.equal(portal.isLoading(), false, "the content it held was mounted");
    assert.equal(root.hasAttribute(LOADING_ATTRIBUTE), false);
    assert.equal(targets.size, 2, "one blocker and the one clickable child");
    assert.equal(getPortalRoot(button), root, "the element is what the panel's scope is");

    // Nothing about the element itself was touched: not where it is, not how
    // it is styled — a page that is showing it goes on showing it.
    assert.equal(root.parentNode, document.body);
    assert.equal(root.style.visibility, "");
    assert.equal(root.style.position, "");
    assert.equal(root.style.overflow, "");

    portal.disconnect();

    assert.equal(root.isConnected, true, "the element is the page's and stays");
    assert.equal(root.hasAttribute("data-xr-portal"), false, "the mark comes off");
    assert.equal(root.hasAttribute(LOADING_ATTRIBUTE), false);
    assert.equal(targets.size, 0, "nothing is left in the raycast set");
    root.remove();
  });

  test("what the page does to the element afterwards is followed", async () => {
    const { ctx, targets } = countingManager();
    const { root, button } = pageCard();
    const portal = createPortal(ctx, { root });
    portal.addTo(new THREE.Group());
    await settle(portal);
    assert.equal(targets.size, 2);

    // A control arriving: the observer's business, exactly as for a mounted
    // tree.
    const another = document.createElement("div");
    another.style.cursor = "pointer";
    root.appendChild(another);
    await drain();
    assert.equal(targets.size, 3, "the new control is a ray target");

    // And one leaving.
    root.removeChild(button);
    await drain();
    assert.equal(targets.size, 2, "the removed control is not");

    portal.disconnect();
    root.remove();
  });

  test("an empty element waits for its first child, like an empty container", async () => {
    const { ctx, targets } = countingManager();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const portal = createPortal(ctx, { root });
    portal.addTo(new THREE.Group());

    // Given nothing, it is on its way nowhere: no loading flag for a harness
    // to wait on, and no blocker over whatever is behind it.
    assert.equal(root.hasAttribute(LOADING_ATTRIBUTE), false);
    await settle(portal);
    assert.equal(portal.isLoading(), true, "nothing arrived, nothing loaded");
    assert.equal(targets.size, 0);

    const button = document.createElement("div");
    button.style.cursor = "pointer";
    root.appendChild(button);
    await settle(portal);
    assert.equal(portal.isLoading(), false, "the first child was the initial content");
    assert.equal(targets.size, 2);

    portal.disconnect();
    root.remove();
  });

  test("the portal's own flags come off the page's elements with it", async () => {
    const { ctx } = countingManager();
    const { root, button } = pageCard();
    const portal = createPortal(ctx, { root });
    portal.addTo(new THREE.Group());
    await settle(portal);

    // What a ray resting on the button when the session ends leaves behind.
    button.dataset.xrHover = "true";
    button.dataset.xrActive = "true";
    portal.disconnect();

    assert.equal(button.hasAttribute("data-xr-hover"), false, "no hover styling left on the page");
    assert.equal(button.hasAttribute("data-xr-active"), false);
    root.remove();
  });

  test("it does not mount: the content is the page's", async () => {
    const { ctx } = countingManager();
    const { root } = pageCard();
    const portal = createPortal(ctx, { root });
    portal.addTo(new THREE.Group());

    /** @type {import("@apendua/justdom").Mountable | undefined} */
    let mountable;
    const subscription = $("div").subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    const tree = mountable;
    assert.throws(() => portal.mount(tree), /does not mount/);
    assert.equal(root.childNodes.length, 2, "nothing was put in or taken out");

    subscription.unsubscribe();
    portal.disconnect();
    root.remove();
  });

  test("an element it cannot honestly mirror is refused", async () => {
    const { ctx } = countingManager();

    // Not in the document: no layout to read, and its arrival would be a
    // mutation of a parent nobody is watching.
    const detached = document.createElement("div");
    assert.throws(() => createPortal(ctx, { root: detached }), /in the document/);

    // Already somebody's panel.
    const { root } = pageCard();
    const portal = createPortal(ctx, { root });
    assert.throws(() => createPortal(ctx, { root }), /already being mirrored/);

    // Inside a panel: every walk would stop at the inner mark and the outer
    // panel would lose the subtree without knowing.
    const inner = document.createElement("div");
    root.appendChild(inner);
    assert.throws(() => createPortal(ctx, { root: inner }), /inside a panel/);

    // Holding a panel, the same problem from above.
    const wrapper = document.createElement("div");
    document.body.appendChild(wrapper);
    wrapper.appendChild(root);
    assert.throws(() => createPortal(ctx, { root: wrapper }), /panel inside it/);

    // None of the refusals left a mark of its own.
    assert.equal(detached.hasAttribute("data-xr-portal"), false);
    assert.equal(inner.hasAttribute("data-xr-portal"), false);
    assert.equal(wrapper.hasAttribute("data-xr-portal"), false);

    portal.disconnect();
    // A released element can be claimed again.
    const again = createPortal(ctx, { root: wrapper });
    assert.ok(wrapper.hasAttribute("data-xr-portal"));
    again.disconnect();
    wrapper.remove();
  });
});

describe("an element the page owns, claimed a second time", () => {
  test("is tracked by the second portal as it was by the first", async () => {
    // The case the feature is for: a session over the page, then another.
    // The mirror's caches are module-level and keyed by node, so a node the
    // first portal adopted would otherwise still carry the first mirror's
    // signals under it, and the second portal's fonts and stylesheets would
    // reach nothing — an empty second session with no error to say why.
    const { ctx } = countingManager();
    const { root, label } = pageCard();

    const first = createPortal(ctx, { root });
    first.addTo(new THREE.Group());
    await settle(first);
    first.disconnect();

    const second = createPortal(ctx, { root });
    second.addTo(new THREE.Group());
    await settle(second);

    // Fonts arriving re-measure every box in the panel; count the label's.
    let measured = 0;
    const original = label.getBoundingClientRect.bind(label);
    label.getBoundingClientRect = () => {
      measured += 1;
      return original();
    };
    dispatchFontsEvent("loadingdone");
    await drain();
    assert.ok(measured > 0, "the second panel re-measured on the second mirror's signal");

    second.disconnect();
    root.remove();
  });

  test("a claim that fails leaves no mark", () => {
    // Without an interaction manager on the context the portal cannot be
    // built. The refusal has to come before the element is marked, or the
    // page would carry a mark with no portal to take it off — and every
    // later claim, the right one included, would be refused as a second.
    const { root } = pageCard();
    assert.throws(() => createPortal({}, { root }), /InteractionContext/);
    assert.equal(root.hasAttribute("data-xr-portal"), false);

    // And the element can still be claimed by a portal that can be built.
    const { ctx } = countingManager();
    const portal = createPortal(ctx, { root });
    assert.ok(root.hasAttribute("data-xr-portal"));
    portal.disconnect();
    root.remove();
  });

  test("the first look waits a microtask, so the handle is in hand when it reports", async () => {
    // Where there are no frames the whole mount is synchronous, and a first
    // look taken during construction would report the load — through
    // `onLoadingChanged(false)` — to a caller not yet holding the portal.
    const { ctx } = countingManager();
    const { root } = pageCard();
    // No frames at all, which is the path that mounts synchronously: the
    // harness's queue stands in for `requestAnimationFrame`, so it goes.
    const raf = globalThis.requestAnimationFrame;
    // @ts-expect-error -- taking the global away for one test.
    delete globalThis.requestAnimationFrame;
    try {
      /** @type {ReturnType<typeof createPortal> | undefined} */
      let portal;
      /** @type {boolean[]} */
      const heard = [];
      portal = createPortal(ctx, {
        root,
        onLoadingChanged: (loading) => {
          heard.push(loading);
          assert.ok(portal, "the handle exists by the time the panel reports");
        },
      });
      portal.addTo(new THREE.Group());
      assert.deepEqual(heard, [], "nothing reported during construction");
      await nextMacrotask();
      assert.deepEqual(heard, [false], "reported once the first look ran");
      portal.disconnect();
    } finally {
      globalThis.requestAnimationFrame = raf;
      root.remove();
    }
  });
});
