/**
 * A panel's container, as `portalContainer.js` claims and releases it: the
 * portal's own container, an element the page owns, and what a closed panel
 * lets go of.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { $, attr, children } from "justdom-core";
import { InteractionContext, InteractionManager } from "../../interactions.js";
import { LOADING_ATTRIBUTE } from "../mirror/mutationRules.js";
import { getPortalRoot } from "./portalRoot.js";

import {
  countingManager,
  createPortal,
  dispatchFontsEvent,
  drain,
  nextMacrotask,
  pageCard,
  settle,
} from "../../test/portalHarness.js";

describe("createPortal", () => {
  test("the container is out of the page's way without hiding what it holds", async () => {
    const portal = createPortal(InteractionContext.set({}, new InteractionManager()));
    portal.addTo(new THREE.Group());
    /** @type {import("justdom-core").Mountable | undefined} */
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

    /** @type {import("justdom-core").Mountable | undefined} */
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

    /** @type {import("justdom-core").Mountable | undefined} */
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
