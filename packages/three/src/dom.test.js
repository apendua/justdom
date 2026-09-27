import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { observable, Signal } from "@apendua/signal";
import { $, attr } from "@apendua/justdom";
import { InteractionContext, InteractionManager } from "./interactions.js";
import { LOADING_ATTRIBUTE, getPortalRoot } from "./elements/portal.js";
import { dom } from "./dom.js";

// jsdom-env exposes the common DOM globals, but not MutationObserver, which
// the portal under `dom()` uses to mirror the tree.
if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}

// jsdom has no FontFaceSet, and VisualProperties consults it for x-height.
// Nothing here closes a loading period, so the stub only has to exist.
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

// jsdom runs no animation frames, and a portal borrows them to slice its
// mount across. A queue flushed by hand is a frame source the test drives.
/** @type {Array<FrameRequestCallback>} */
const frameCallbacks = [];
globalThis.requestAnimationFrame = (callback) => frameCallbacks.push(callback);
globalThis.cancelAnimationFrame = () => {};

function flushFrame() {
  for (const callback of frameCallbacks.splice(0, frameCallbacks.length)) {
    callback(0);
  }
}

function nextMacrotask() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Drive frames until nothing asks for another. `dom()` hands out no portal
 * handle to ask `isLoading()` of, so the quiet frame queue is the sign that
 * whatever it mounted has settled. Bounded, so a panel that never settles
 * fails its test rather than hanging it.
 */
async function settle() {
  await nextMacrotask();
  for (let index = 0; index < 500 && frameCallbacks.length > 0; index++) {
    flushFrame();
    await nextMacrotask();
  }
}

/**
 * A card the page already has: a clickable box in a root, in the document.
 *
 * @returns {{ root: HTMLDivElement, button: HTMLDivElement }}
 */
function pageCard() {
  const root = document.createElement("div");
  const button = document.createElement("div");
  button.style.cursor = "pointer";
  root.appendChild(button);
  document.body.appendChild(root);
  return { root, button };
}

/**
 * An interaction manager that keeps count of what is registered with it.
 */
function countingManager() {
  const manager = new InteractionManager();
  /** @type {Set<THREE.Object3D>} */
  const targets = new Set();
  const originalAdd = manager.add.bind(manager);
  const originalRemove = manager.remove.bind(manager);
  manager.add = (object) => {
    targets.add(object);
    originalAdd(object);
  };
  manager.remove = (object) => {
    targets.delete(object);
    originalRemove(object);
  };
  return { ctx: InteractionContext.set({}, manager), targets };
}

describe("dom", () => {
  test("given an element the page owns, mirrors it where it stands", async () => {
    const { ctx, targets } = countingManager();
    const { root, button } = pageCard();
    const scene = new THREE.Group();

    /** @type {(() => void) | undefined} */
    let unmount;
    const subscription = dom(ctx, root).subscribe((component) => {
      unmount = component.addTo(scene);
    });
    assert.ok(unmount, "nothing was mounted");
    assert.ok(root.hasAttribute("data-xr-portal"), "the element is the panel");
    assert.ok(root.hasAttribute(LOADING_ATTRIBUTE), "its content is the mount");

    await settle();

    assert.equal(root.hasAttribute(LOADING_ATTRIBUTE), false);
    assert.equal(targets.size, 2, "one blocker and the one clickable child");
    assert.equal(scene.children.length, 1, "the panel's group is in the scene");
    assert.equal(getPortalRoot(button), root);

    unmount();
    assert.equal(scene.children.length, 0, "and out of it");
    assert.equal(targets.size, 0);
    assert.equal(root.isConnected, true, "the element is the page's and stays");
    assert.equal(root.hasAttribute("data-xr-portal"), false);

    subscription.unsubscribe();
    root.remove();
  });

  test("a subscribable of elements moves the panel from one to the next", async () => {
    const { ctx } = countingManager();
    const first = pageCard();
    const second = pageCard();
    const which = Signal.of(first.root);
    const scene = new THREE.Group();

    /** @type {(() => void) | undefined} */
    let unmount;
    const subscription = dom(
      ctx,
      observable(() => which.get()),
    ).subscribe((component) => {
      unmount = component.addTo(scene);
    });
    assert.ok(unmount);
    await settle();
    assert.ok(first.root.hasAttribute("data-xr-portal"));
    assert.equal(second.root.hasAttribute("data-xr-portal"), false);

    which.set(second.root);
    await settle();
    assert.equal(first.root.hasAttribute("data-xr-portal"), false, "the first is released");
    assert.ok(second.root.hasAttribute("data-xr-portal"), "the second is the panel now");
    assert.equal(scene.children.length, 1, "one group, whichever element it shows");

    unmount();
    subscription.unsubscribe();
    first.root.remove();
    second.root.remove();
  });

  test("given a tree, mounts it into a container of its own, as before", async () => {
    const { ctx, targets } = countingManager();
    const scene = new THREE.Group();
    const before = document.body.childElementCount;

    /** @type {(() => void) | undefined} */
    let unmount;
    const subscription = dom(ctx, $("div", [attr("style", () => "cursor: pointer")])).subscribe(
      (component) => {
        unmount = component.addTo(scene);
      },
    );
    assert.ok(unmount);
    await settle();

    assert.equal(document.body.childElementCount, before + 1, "a container of the portal's own");
    assert.equal(targets.size, 2);

    unmount();
    assert.equal(document.body.childElementCount, before, "which goes with the panel");
    subscription.unsubscribe();
  });
});
