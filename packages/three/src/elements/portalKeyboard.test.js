import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { $, attr, children } from "@apendua/justdom";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal as createHeldPortal } from "./portal.js";
import { stubCanvas } from "../test/stubCanvas.js";

/**
 * @import {KeyboardTarget} from './portalKeyboard.js';
 */

/** @type {typeof createHeldPortal} */
const createPortal = (ctx, options = {}) =>
  createHeldPortal(ctx, {
    loadingFrame: { delay: 0, minimumTime: 0 },
    ...options,
  });

if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}
if (typeof globalThis.getComputedStyle === "undefined") {
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
}
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
 * Drive frames until nothing asks for another. Bounded.
 */
async function settle() {
  await nextMacrotask();
  for (let index = 0; index < 500 && frameCallbacks.length > 0; index++) {
    flushFrame();
    await nextMacrotask();
  }
}

/** The panels currently in the document. */
const panels = () => document.querySelectorAll("[data-xr-portal]").length;

/**
 * A panel with a field in it and a keyboard on offer. The keyboard's DOM
 * is one clickable key; what it is handed is recorded.
 */
function keyboardPanel() {
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
  const ctx = InteractionContext.set({}, manager);

  const root = document.createElement("div");
  const input = document.createElement("input");
  input.type = "text";
  input.value = "ab";
  root.appendChild(input);
  document.body.appendChild(root);

  /** @type {KeyboardTarget[]} */
  const created = [];
  const portal = createPortal(ctx, {
    root,
    keyboard: {
      gap: 20,
      create: (target) => {
        created.push(target);
        return $("div", [children($("div", [attr("style", () => "cursor: pointer")]))]);
      },
    },
  });
  const parent = new THREE.Group();
  portal.addTo(parent);

  /**
   * The registered object that is not the blocker plane: the field's.
   */
  const fieldObject = () => {
    for (const target of targets) {
      const isBlocker =
        target instanceof THREE.Mesh && target.geometry instanceof THREE.PlaneGeometry;
      if (!isBlocker && parent.getObjectById(target.id)) {
        // Registered under this panel rather than under the board.
        let owner = target;
        while (owner.parent && owner.parent !== parent) {
          owner = owner.parent;
        }
        if (owner.parent === parent && !owner.userData.board) {
          return target;
        }
      }
    }
    return undefined;
  };
  const blocker = () => {
    /** @type {THREE.Mesh | undefined} */
    let found;
    for (const target of targets) {
      if (target instanceof THREE.Mesh && target.geometry instanceof THREE.PlaneGeometry) {
        found = found ?? target;
      }
    }
    return found;
  };
  /** A ray's press, as the manager delivers it. */
  const press = (/** @type {THREE.Object3D | undefined} */ object) => {
    assert.ok(object, "nothing to press");
    const controller = new THREE.Group();
    // @ts-expect-error -- the shape the handlers read, not three's full event.
    object.dispatchEvent({ type: "selectstart", controller });
    // @ts-expect-error -- as above.
    object.dispatchEvent({ type: "select", controller });
    // @ts-expect-error -- as above.
    object.dispatchEvent({ type: "selectend", controller });
  };

  return {
    portal,
    parent,
    root,
    input,
    created,
    targets,
    fieldObject,
    blocker,
    press,
    cleanup: () => {
      portal.disconnect();
      root.remove();
    },
  };
}

describe("the portal's keyboard", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  before(() => {
    canvas = stubCanvas();
  });
  after(() => {
    canvas.restore();
  });

  test("comes up when a field is pressed, types into it, and goes on Enter", async () => {
    const panel = keyboardPanel();
    await settle();
    assert.equal(panels(), 1, "the panel alone");
    assert.equal(panel.created.length, 0, "no board until a field asks");

    // A ray's press on the field.
    const field = panel.fieldObject();
    panel.press(field);
    await settle();

    assert.equal(panel.created.length, 1, "the factory was asked for a board");
    assert.equal(panel.created[0].element, panel.input, "for this field");
    assert.equal(panels(), 2, "the board is a panel of its own");
    assert.ok(panel.input.hasAttribute("data-xr-focus"), "the field says it is being typed into");
    assert.equal(panel.parent.children.length, 2, "the board hangs beside the panel");

    // Typing goes into the field, through the events a page listens for.
    /** @type {string[]} */
    const heard = [];
    panel.input.addEventListener("input", () => heard.push(panel.input.value));
    panel.created[0].onKey({ key: "c", code: "KeyC" });
    assert.equal(panel.input.value, "abc", "at the end, where a tap puts the caret");
    assert.deepEqual(heard, ["abc"]);

    // Enter ends the entry.
    panel.created[0].onKey({ key: "Enter", code: "Enter" });
    await settle();
    assert.equal(panels(), 1, "the board is gone");
    assert.equal(panel.input.hasAttribute("data-xr-focus"), false);
    assert.equal(panel.parent.children.length, 1);

    panel.cleanup();
  });

  test("is placed below the panel's bottom edge, reclined", async () => {
    const panel = keyboardPanel();
    await settle();
    panel.press(panel.fieldObject());
    await settle();

    const pivot = panel.parent.children.find((child) => child !== panel.parent.children[0]);
    assert.ok(pivot, "the hinge is in the scene");
    // jsdom lays nothing out, so the panel is 0px tall: the hinge sits the
    // gap below the origin, in the panel's units — 20px at a centimetre each.
    assert.ok(Math.abs(pivot.position.y - -0.2) < 1e-9, `hinge at ${pivot.position.y}`);
    assert.ok(pivot.rotation.x < 0, "reclined toward the viewer");

    panel.cleanup();
  });

  test("a press on the panel's background puts it away", async () => {
    const panel = keyboardPanel();
    await settle();
    panel.press(panel.fieldObject());
    await settle();
    assert.equal(panels(), 2);

    panel.press(panel.blocker());
    await settle();
    assert.equal(panels(), 1, "the board is gone");
    assert.equal(panel.input.hasAttribute("data-xr-focus"), false);

    panel.cleanup();
  });

  test("the field leaving the document puts it away", async () => {
    const panel = keyboardPanel();
    await settle();
    panel.press(panel.fieldObject());
    await settle();
    assert.equal(panels(), 2);

    panel.input.remove();
    await settle();
    assert.equal(panels(), 1, "nothing left to type into");

    panel.cleanup();
  });

  test("goes with the panel", async () => {
    const panel = keyboardPanel();
    await settle();
    panel.press(panel.fieldObject());
    await settle();
    assert.equal(panels(), 2);

    panel.portal.disconnect();
    assert.equal(panels(), 0, "both taken down");
    assert.equal(panel.input.hasAttribute("data-xr-focus"), false);
    assert.equal(panel.parent.children.length, 0, "and nothing left in the scene");
    panel.root.remove();
  });

  test("the caret is drawn while the field is being typed into", async () => {
    const panel = keyboardPanel();
    await settle();
    const before = countMeshesUnder(panel.parent.children[0]);
    panel.press(panel.fieldObject());
    await settle();
    assert.equal(
      countMeshesUnder(panel.parent.children[0]),
      before + 1,
      "one mark more: the caret",
    );
    panel.created[0].onKey({ key: "Escape" });
    await settle();
    assert.equal(countMeshesUnder(panel.parent.children[0]), before, "and gone with the board");
    panel.cleanup();
  });
});

/**
 * @param {THREE.Object3D} object
 */
function countMeshesUnder(object) {
  let count = 0;
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      count += 1;
    }
  });
  return count;
}
