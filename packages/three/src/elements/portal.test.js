/**
 * `createPortal` as a whole: what a panel projects and how rays reach it,
 * the `Mountable` contract and the order a mount is built in, and a
 * draggable panel. The parts `buildPortal` hands its state to have files of
 * their own: `portalNodes.test.js` (building, the commit, teardown),
 * `portalLoading.test.js` (the loading frame, busy flags, images and fonts),
 * `portalWatchers.test.js` (mutations, scroll, animation and restyles) and
 * `portalContainer.test.js` (the container, claimed or the portal's own).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Derived, Signal, UpdateChannel, withChannel } from "justdom-signal";
import { $, $$, attr, children } from "justdom-core";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { getComputedStyleCached } from "./mirror/styleReads.js";
import { getPortalRoot } from "./portalRoot.js";
import { isBlocker } from "./blocker.js";
import { withPanelOptions } from "./panelOptions.js";
import { DEFAULT_HANDLE_WIDTH } from "./panelHandles.js";
import { RendererContext } from "../scene.js";
import { recordingSource } from "../test/rumble.js";
import { clientRect } from "../test/clientRect.js";
import { fakeClock } from "../test/clock.js";

import {
  countingManager,
  createPortal,
  drain,
  flushFrame,
  nextMacrotask,
  pageCard,
  pump,
  settle,
} from "../test/portalHarness.js";
import { withStart } from "../test/rays.js";

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
    /** @type {import("justdom-core").Mountable | undefined} */
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
    // It writes neither colour nor depth, so it is left out of the draw,
    // and the mesh stays visible, so a ray still meets it.
    assert.equal(/** @type {THREE.Material} */ (blocker.material).visible, false, "and not drawn");
    assert.equal(blocker.visible, true, "while it stays a ray target");

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

    /** @type {import("justdom-core").Mountable | undefined} */
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

  test("a click on the panel background carries the point the ray met", async () => {
    // A `<canvas>` board is not `cursor: pointer`, so its clicks come
    // through the blocker, and it finds the square from the point as it
    // would under a mouse: where the ray met the panel, in the page's
    // layout of the mirrored root.
    const manager = new InteractionManager();
    /** @type {THREE.Object3D[]} */
    const added = [];
    const originalAdd = manager.add.bind(manager);
    manager.add = (object) => {
      added.push(object);
      originalAdd(object);
    };
    const ctx = InteractionContext.set({}, manager);
    // A card the page shows, laid out 30 px in and 50 down.
    const { root } = pageCard();
    root.getBoundingClientRect = () => clientRect(30, 50, 300, 200);
    const portal = createPortal(ctx, { root });
    const parent = new THREE.Group();
    portal.addTo(parent);
    await settle(portal);

    /** @type {string[]} */
    const clicks = [];
    /** @param {Event} event */
    const listener = (event) => {
      const { clientX, clientY } = /** @type {MouseEvent} */ (event);
      // Rounded: the point is worked back out of the panel's world matrix.
      const at = `${Math.round(clientX)},${Math.round(clientY)}`;
      clicks.push(`${event.target === root ? "root" : "elsewhere"} at ${at}`);
    };
    document.addEventListener("click", listener);

    const blocker = added.find(
      (object) => object instanceof THREE.Mesh && object.geometry instanceof THREE.PlaneGeometry,
    );
    assert.ok(blocker);
    // 12 px in and 7 down from the panel's top left corner, in its px.
    parent.updateMatrixWorld(true);
    const point = parent.children[0].localToWorld(new THREE.Vector3(12, 7, 0));
    blocker.dispatchEvent(
      /** @type {any} */ ({ type: "select", intersection: { point, object: blocker } }),
    );
    assert.deepEqual(clicks, ["root at 42,57"]);

    document.removeEventListener("click", listener);
    portal.disconnect();
    root.remove();
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

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [children($("div", [attr("style", () => "padding: 4px")]))]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    await settle(portal);

    assert.equal(added.length, 0, "a readout nobody presses is nothing for a ray to find");
    // Not merely unregistered: there is no blocker in the scene either, so
    // the panel has nothing to keep the size of. The panel's depth quad
    // shares the blocker's plane and takes no rays.
    const planes = [];
    parent.traverse((object) => {
      if (isBlocker(object)) {
        planes.push(object);
      }
    });
    assert.equal(planes.length, 0, "no blocker plane in the scene either");

    subscription.unsubscribe();
    portal.disconnect();
  });

  test("what it projects can find its way back to the panel it is in", async () => {
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
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

    /** @type {import("justdom-core").Mountable | undefined} */
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
    manager.dispatch(
      /** @type {any} */ (control),
      /** @type {any} */ ({ type: "select", originalTarget: control, completedOn: control }),
    );

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

  test("a stylesheet's :checked rule alone restyles a box a ray ticks", async () => {
    // Written for the page alone, with no `[data-xr-checked]` beside it.
    const style = document.createElement("style");
    style.textContent =
      ".checked-only { background-color: rgb(255, 255, 255); }" +
      " .checked-only:checked { background-color: rgb(0, 0, 255); }" +
      " .checked-only:checked + .checked-label { color: rgb(255, 0, 0); }";
    document.head.appendChild(style);
    const { manager, ctx, targets } = countingManager();
    const portal = createPortal(ctx);
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(
        $("input", [attr("type", () => "checkbox"), attr("class", () => "checked-only")]),
        $("div", [attr("class", () => "checked-label")]),
      ),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const input = /** @type {HTMLInputElement} */ (document.querySelector(".checked-only"));
    const label = /** @type {HTMLElement} */ (document.querySelector(".checked-label"));
    const observing = new UpdateChannel({ name: "observing", order: 1 });
    const background = withChannel(
      observing,
      () => new Derived(() => getComputedStyleCached(input).backgroundColor),
    );
    const color = withChannel(
      observing,
      () => new Derived(() => getComputedStyleCached(label).color),
    );
    const watching = [background, color].map((signal) =>
      signal.subscribe({ next: () => signal.get() }),
    );
    assert.equal(background.get(), "rgb(255, 255, 255)");

    const control = [...targets].find(
      (object) => !(object instanceof THREE.Mesh && object.geometry instanceof THREE.PlaneGeometry),
    );
    assert.ok(control);
    manager.dispatch(
      /** @type {any} */ (control),
      /** @type {any} */ ({ type: "select", originalTarget: control, completedOn: control }),
    );
    await pump();
    assert.equal(input.checked, true);
    assert.equal(background.get(), "rgb(0, 0, 255)", "the box follows its :checked rule");
    assert.equal(color.get(), "rgb(255, 0, 0)", "and so does the label after it");

    manager.dispatch(
      /** @type {any} */ (control),
      /** @type {any} */ ({ type: "select", originalTarget: control, completedOn: control }),
    );
    await pump();
    assert.equal(background.get(), "rgb(255, 255, 255)", "and back when unticked");

    for (const subscriptionOf of watching) {
      subscriptionOf.unsubscribe();
    }
    subscription.unsubscribe();
    portal.disconnect();
    style.remove();
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

    /** @type {import("justdom-core").Mountable | undefined} */
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
    /** @type {import("justdom-core").Mountable | undefined} */
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

  test("an svg template the portal does not build is still followed", async () => {
    // A `<marker>` in its `<defs>` is drawn where a path names it, not where
    // it stands, so the portal builds nothing for it. Whatever draws it still
    // has to hear an edit inside it, which only reaches nodes in the mirror.
    const ctx = InteractionContext.set({}, new InteractionManager());
    const portal = createPortal(ctx, { budget: Infinity });
    portal.addTo(new THREE.Group());

    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const tree = $("div", [
      children(
        $$("svg", [
          children(
            $$("defs", [
              children($$("marker", [children($$("path", [attr({ d: "M0 0 L10 5 L0 10 z" })]))])),
            ]),
          ),
        ]),
      ),
    ]);
    const subscription = tree.subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await settle(portal);

    const containers = document.querySelectorAll(`[${"data-xr-portal"}]`);
    const path = containers[containers.length - 1].querySelector("marker path");
    assert.ok(path, "the marker's path is in the panel");
    let reads = 0;
    const style = new Derived(() => {
      getComputedStyleCached(path);
      reads += 1;
      return reads;
    });
    const reader = style.subscribe({});
    const before = style.get();

    path.setAttribute("class", "edited");
    await settle(portal);
    assert.notEqual(style.get(), before, "the edit reached the marker's path");

    reader.unsubscribe();
    subscription.unsubscribe();
    portal.disconnect();
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
      /** @type {import("justdom-core").Mountable | undefined} */
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
        manager.dispatch(
          object,
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
});

/**
 * The mirror reads the DOM, not the library that wrote it. `mount()` takes a
 * `Mountable` — one method, declared in this package rather than imported from
 * `justdom-core` — so anything able to put real elements into a span of siblings can
 * be projected: another framework's renderer, a server-rendered fragment
 * adopted in place, or the dozen lines below.
 *
 * What this guards is narrower than it looks, and worth stating exactly. It is
 * not tree shape: a justdom tree and the raw one below leave the portal's
 * container in the same state — one element, no envelope, nothing to tell them
 * apart — so there is no justdom-shaped structure for an assumption to attach
 * itself to in the first place.
 *
 * It is the *contract*. Every other portal test builds its tree with
 * `justdom-core`, so all of them would keep passing if `mount` quietly grew a
 * second requirement and justdom-core grew the method to satisfy it — and every
 * integration written against the one method in the README would break. That is
 * the regression this catches, and the only portal test that can: it is the
 * sole caller whose mountable was not written by the package on the other side
 * of the seam.
 */
describe("mounting a tree justdom-core did not build", () => {
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
        for (let current = /** @type {Node | null} */ (first); current;) {
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

describe("a draggable panel", () => {
  /**
   * A panel under a renderer that never draws, which is what a carry needs
   * to be set up; the panel never mounts, and need not.
   *
   * @param {import('./portal.js').PortalOptions} options
   * @param {{ renderer?: boolean }} [room]
   */
  function setup(options, { renderer = true } = {}) {
    const { ctx, targets } = countingManager();
    const portal = createPortal(
      renderer ? RendererContext.set(ctx, /** @type {any} */ ({})) : ctx,
      options,
    );
    const parent = new THREE.Group();
    portal.addTo(parent);
    return { portal, parent, targets };
  }

  test("hangs in a frame of its own, with the strips beside it", () => {
    const { portal, parent, targets } = setup({ draggable: true });
    const frame = parent.children[0];
    const top = frame.getObjectByName("panel-handle-top");
    assert.ok(top, "the strips are in the frame");
    assert.ok(targets.has(top), "and ray targets");
    assert.ok(
      frame.children.some((child) => child.name !== "panel-handles"),
      "so is the panel",
    );
    portal.disconnect();
    assert.equal(parent.children.length, 0, "the frame goes with the panel");
    assert.equal(targets.has(top), false);
  });

  test("lays the strips out with the panel while it mounts", async () => {
    // A panel with nothing in it, which grows to 100 by 200 px as it
    // mounts: the loading frame's ticks place it at the new size long
    // before the commit, and the strips have to go with it.
    let height = 0;
    const originalRect = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
      const element = /** @type {HTMLElement} */ (this);
      if (element.closest("[data-xr-portal]")) {
        const width = height / 2;
        return /** @type {DOMRect} */ (
          /** @type {unknown} */ ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: width,
            bottom: height,
            width,
            height,
          })
        );
      }
      return originalRect.call(this);
    };
    try {
      const { ctx } = countingManager();
      const renderer = /** @type {any} */ ({});
      // One node a frame, so the mount takes frames.
      const portal = createPortal(RendererContext.set(ctx, renderer), {
        draggable: true,
        budget: 0,
      });
      const parent = new THREE.Group();
      portal.addTo(parent);
      /** @type {import("justdom-core").Mountable | undefined} */
      let mountable;
      const subscription = $("div", [children($("div"), $("div"), $("div"))]).subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await nextMacrotask();
      height = 200;

      flushFrame(renderer);
      await nextMacrotask();
      assert.equal(portal.isLoading(), true, "still mounting");
      const top = /** @type {THREE.Object3D} */ (parent.getObjectByName("panel-handle-top"));
      const expected = (200 / 2 + DEFAULT_HANDLE_WIDTH / 2) * 0.01;
      assert.ok(
        Math.abs(top.position.y - expected) < 1e-9,
        `along the top edge, ${top.position.y}`,
      );
      subscription.unsubscribe();
      portal.disconnect();
    } finally {
      window.Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  test("keeps its strips out of the raycast until its loading frame shows", async () => {
    // A mount of several frames under a 250 ms delay: at 0 ms nothing is
    // drawn, and a ray must not find strips around the empty space; at
    // 300 ms the frame is up, and the strips go with it.
    const clock = fakeClock();
    try {
      const { ctx } = countingManager();
      const renderer = /** @type {any} */ ({});
      const portal = createPortal(RendererContext.set(ctx, renderer), {
        draggable: true,
        budget: 0,
        loadingFrame: { delay: 250, minimumTime: 1000 },
      });
      const parent = new THREE.Group();
      portal.addTo(parent);
      const group = /** @type {THREE.Object3D} */ (parent.getObjectByName("panel-handles"));
      const loadingFrame = () => parent.getObjectByName("loading-frame");
      /** @type {import("justdom-core").Mountable | undefined} */
      let mountable;
      const subscription = $("div", [children($("div"), $("div"), $("div"))]).subscribe((value) => {
        mountable = value;
      });
      assert.ok(mountable);
      portal.mount(mountable);
      await nextMacrotask();

      clock.set(0);
      flushFrame(renderer);
      await nextMacrotask();
      assert.equal(portal.isLoading(), true);
      assert.equal(loadingFrame(), undefined, "inside the delay, nothing is drawn");
      assert.equal(group.visible, false, "and there are no strips");

      clock.set(300);
      flushFrame(renderer);
      await nextMacrotask();
      assert.equal(portal.isLoading(), true);
      assert.ok(loadingFrame(), "the frame is up");
      assert.equal(group.visible, true, "and the strips with it");

      subscription.unsubscribe();
      portal.disconnect();
      await drain();
    } finally {
      clock.restore();
    }
  });

  test("with no loading frame, keeps its strips out of the raycast until it loads", async () => {
    const { ctx } = countingManager();
    const renderer = /** @type {any} */ ({});
    const portal = createPortal(RendererContext.set(ctx, renderer), {
      draggable: true,
      budget: 0,
      loadingFrame: false,
    });
    const parent = new THREE.Group();
    portal.addTo(parent);
    const group = /** @type {THREE.Object3D} */ (parent.getObjectByName("panel-handles"));
    /** @type {import("justdom-core").Mountable | undefined} */
    let mountable;
    const subscription = $("div", [children($("div"), $("div"), $("div"))]).subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);
    await nextMacrotask();
    flushFrame(renderer);
    await nextMacrotask();
    assert.equal(portal.isLoading(), true, "still mounting");
    assert.equal(group.visible, false, "no strips around a panel not yet drawn");

    await settle(portal, renderer);
    assert.equal(portal.isLoading(), false);
    assert.equal(group.visible, true, "loaded, and the strips are there");
    subscription.unsubscribe();
    portal.disconnect();
  });

  test("does not show its strips for a ray on the keyboard below it", async () => {
    const { ctx, manager, targets } = countingManager();
    const renderer = /** @type {any} */ ({});
    const root = document.createElement("div");
    const input = document.createElement("input");
    input.type = "text";
    root.appendChild(input);
    document.body.appendChild(root);
    const portal = createPortal(RendererContext.set(ctx, renderer), {
      root,
      draggable: true,
      // No scene to be in front of, so it hangs below the panel.
      keyboard: { create: () => $("div", []) },
    });
    const parent = new THREE.Group();
    portal.addTo(parent);
    await settle(portal, renderer);
    const frame = parent.children[0];
    const field = [...targets].find(
      (target) => !(target instanceof THREE.Mesh && target.geometry instanceof THREE.PlaneGeometry),
    );
    assert.ok(field, "the field is a ray target");
    const controller = new THREE.Group();
    for (const type of ["selectstart", "select", "selectend"]) {
      manager.dispatch(
        /** @type {any} */ (field),
        /** @type {any} */ ({
          type,
          controller,
          inputSource: null,
          originalTarget: field,
          completedOn: field,
        }),
      );
    }
    await nextMacrotask();
    // The board's anchor is the last thing hung in the panel's frame.
    const anchor = frame.children[frame.children.length - 1];
    assert.equal(anchor.getObjectByName("panel-handles"), undefined, "the board's anchor");

    manager.dispatch(
      /** @type {any} */ (anchor),
      /** @type {any} */ ({
        type: "pointerenter",
        target: anchor,
        originalTarget: anchor,
        controller,
      }),
    );
    for (const side of ["top", "bottom", "left", "right"]) {
      const bar = /** @type {THREE.Object3D} */ (frame.getObjectByName(`panel-handle-${side}-bar`));
      assert.equal(bar.visible, false, `the ${side} strip stays hidden`);
    }
    portal.disconnect();
    root.remove();
  });

  test("is not by default, nor with nothing to follow the hand by", () => {
    const fixed = setup({});
    assert.equal(fixed.parent.getObjectByName("panel-handle-top"), undefined);
    fixed.portal.disconnect();

    const plain = setup({ draggable: true }, { renderer: false });
    assert.equal(plain.parent.getObjectByName("panel-handle-top"), undefined);
    plain.portal.disconnect();
  });

  test("hands its own options to the strips", () => {
    let putDown = 0;
    const { portal, parent } = setup({ draggable: { onPutDown: () => putDown++ } });
    const top = /** @type {THREE.Object3D} */ (parent.getObjectByName("panel-handle-top"));
    const controller = new THREE.Group();
    for (const type of ["selectstart", "selectend"]) {
      top.dispatchEvent(
        /** @type {any} */ (
          withStart({
            type,
            controller,
            inputSource: {},
            intersection: { object: top, point: new THREE.Vector3() },
          })
        ),
      );
    }
    assert.equal(putDown, 1, "carried, and put down");
    portal.disconnect();
  });
});
