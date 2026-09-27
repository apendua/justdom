import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal as createHeldPortal } from "./portal.js";
import { stubCanvas, STUB_GLYPH_WIDTH } from "../test/stubCanvas.js";

/**
 * `createPortal` with the loading frame's timing off, as the portal suite
 * has it, so a mount loads the moment it is built.
 *
 * @type {typeof createHeldPortal}
 */
const createPortal = (ctx, options = {}) =>
  createHeldPortal(ctx, {
    loadingFrame: { delay: 0, minimumTime: 0 },
    ...options,
  });

if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}

// Rasterizing reads the document's root font size and resolves colours
// through `getComputedStyle` as a bare global, which a browser has and the
// jsdom setup does not install.
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
 * @param {{ isLoading: () => boolean }} portal
 */
async function settle(portal) {
  await nextMacrotask();
  for (let index = 0; index < 500 && portal.isLoading(); index++) {
    flushFrame();
    await nextMacrotask();
  }
  for (let index = 0; index < 20 && frameCallbacks.length > 0; index++) {
    flushFrame();
    await nextMacrotask();
  }
}

async function pump() {
  await nextMacrotask();
  for (let index = 0; index < 20 && frameCallbacks.length > 0; index++) {
    flushFrame();
    await nextMacrotask();
  }
}

/**
 * A page-owned root with one field in it, and a portal over it.
 *
 * @param {(input: HTMLInputElement) => void} [dress]
 */
function fieldPanel(dress = () => {}) {
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
  dress(input);
  root.appendChild(input);
  document.body.appendChild(root);
  const portal = createPortal(ctx, { root });
  const parent = new THREE.Group();
  portal.addTo(parent);
  return {
    portal,
    parent,
    root,
    input,
    targets,
    /** The meshes drawn for the field: its box, the run, and a caret if any. */
    meshes: () => {
      /** @type {THREE.Mesh[]} */
      const found = [];
      parent.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          found.push(object);
        }
      });
      return found;
    },
    /** The mesh carrying the value's texture. */
    run: () => {
      /** @type {THREE.Mesh | undefined} */
      let run;
      parent.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          const material = /** @type {THREE.MeshBasicMaterial} */ (object.material);
          if (material && (material.alphaMap || material.map)) {
            run = object;
          }
        }
      });
      return run;
    },
    cleanup: () => {
      portal.disconnect();
      root.remove();
    },
  };
}

describe("a text field in a panel", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  before(() => {
    canvas = stubCanvas();
  });
  after(() => {
    canvas.restore();
  });

  test("is a ray target, and its value is drawn", async () => {
    const panel = fieldPanel((input) => {
      input.value = "Buy milk";
    });
    await settle(panel.portal);

    assert.equal(panel.targets.size, 2, "the blocker and the field, with no cursor asked for");
    assert.ok(canvas.drawn.includes("Buy milk"), "the value was rasterized");
    const run = panel.run();
    assert.ok(run, "a run carries the value");
    assert.ok(
      /** @type {THREE.MeshBasicMaterial} */ (run.material).alphaMap,
      "as a mask, tinted by the material",
    );
    // Sized to what was measured — eight glyphs at the stub's width — plus
    // the bleed a texture keeps around its glyphs.
    const positions = run.geometry.getAttribute("position");
    assert.ok(positions.getX(1) >= "Buy milk".length * STUB_GLYPH_WIDTH);

    panel.cleanup();
  });

  test("draws the placeholder while the value is empty, dimmed", async () => {
    const panel = fieldPanel((input) => {
      input.placeholder = "Add a todo";
      input.style.color = "rgb(0, 0, 0)";
    });
    await settle(panel.portal);

    assert.ok(canvas.drawn.includes("Add a todo"));
    const run = panel.run();
    assert.ok(run);
    const material = /** @type {THREE.MeshBasicMaterial} */ (run.material);
    // jsdom has no `::placeholder` rule to answer with, so the fallback: the
    // text colour at reduced opacity.
    assert.ok(material.opacity < 1, "dimmer than the text");

    panel.cleanup();
  });

  test("follows typing, and a value written from script", async () => {
    const panel = fieldPanel();
    await settle(panel.portal);
    canvas.drawn.length = 0;

    // What a keystroke does: the value changes and `input` says so.
    panel.input.setRangeText("hello", 0, 0, "end");
    panel.input.dispatchEvent(new Event("input", { bubbles: true }));
    await pump();
    assert.ok(canvas.drawn.includes("hello"), "re-drawn on the event");

    // What an app does after a submit: the property, with no event at all.
    canvas.drawn.length = 0;
    panel.input.value = "";
    await pump();
    assert.ok(
      canvas.drawn.length === 0 || !canvas.drawn.includes("hello"),
      "the run no longer says hello",
    );
    panel.input.value = "again";
    await pump();
    assert.ok(canvas.drawn.includes("again"), "re-drawn on the setter");

    // The interception is the mounting's, and goes with it.
    assert.ok(Object.prototype.hasOwnProperty.call(panel.input, "value"), "value is intercepted");
    panel.cleanup();
    assert.equal(
      Object.prototype.hasOwnProperty.call(panel.input, "value"),
      false,
      "and the element is left as the browser made it",
    );
    assert.equal(panel.input.value, "again", "with its value");
  });

  test("a disabled field is not a ray target", async () => {
    const panel = fieldPanel((input) => {
      input.disabled = true;
    });
    await settle(panel.portal);
    assert.equal(panel.targets.size, 1, "only the blocker");
    panel.cleanup();
  });

  test("with no keyboard on offer, nothing is focused and no caret is drawn", async () => {
    const panel = fieldPanel((input) => {
      input.value = "x";
    });
    await settle(panel.portal);
    assert.equal(panel.input.hasAttribute("data-xr-focus"), false);
    // One run for the value; the caret, which `portalKeyboard.test.js`
    // counts arriving with a keyboard, is not among the meshes here.
    const runs = panel.meshes().filter((mesh) => {
      const material = /** @type {THREE.MeshBasicMaterial} */ (mesh.material);
      return !!(material.alphaMap || material.map);
    });
    assert.equal(runs.length, 1);
    const caretSized = panel.meshes().filter((mesh) => mesh.scale.x === 1 && mesh.scale.y > 1);
    assert.equal(caretSized.length, 0, "no one-px-wide mark");
    panel.cleanup();
  });

  test("a password is drawn as bullets, never as its characters", async () => {
    const panel = fieldPanel((input) => {
      input.type = "password";
      input.value = "hunter2";
    });
    await settle(panel.portal);
    assert.equal(canvas.drawn.includes("hunter2"), false, "the value never reaches the canvas");
    assert.ok(canvas.drawn.includes("\u2022".repeat(7)), "one bullet a character");
    panel.cleanup();
  });
});

describe("trackValue", () => {
  test("two watchers of one field share the hooks, and the last one out removes them", async () => {
    const { trackValue } = await import("./textInput.js");
    const input = document.createElement("input");
    document.body.appendChild(input);
    const first = trackValue(input);
    const second = trackValue(input);
    assert.ok(Object.prototype.hasOwnProperty.call(input, "value"), "intercepted");
    first();
    assert.ok(
      Object.prototype.hasOwnProperty.call(input, "value"),
      "still intercepted for the watcher that remains",
    );
    first();
    assert.ok(Object.prototype.hasOwnProperty.call(input, "value"), "a second stop is a no-op");
    second();
    assert.equal(Object.prototype.hasOwnProperty.call(input, "value"), false, "gone with the last");
    input.remove();
  });
});
