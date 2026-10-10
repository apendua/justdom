import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { $, attr, children } from "@apendua/justdom";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal as createHeldPortal } from "./portal.js";
import { withPanelOptions } from "./panelOptions.js";
import {
  createKeyboardSlot,
  dismissKeyboardAtSessionEnd,
  disposeKeyboardSlot,
  KeyboardSlotContext,
} from "./keyboardSlot.js";
import { CameraContext, RendererContext, SceneContext } from "../render.js";
import { HANDLE_OPACITY_ACTIVE, HANDLE_OPACITY_NEAR } from "./panelHandles.js";
import { stubCanvas } from "../test/stubCanvas.js";
import { rectGeometry } from "./sdfRect.js";
import { CARET_BLINK_MS } from "./textInput.js";
import { recordingSource } from "../test/rumble.js";
import { PREVIEW_ATTRIBUTE } from "./keyboardPreview.js";
import { getCaretOffset } from "./typing.js";

/**
 * @import {KeyboardTarget} from './portalKeyboard.js';
 * @import {PanelOptions} from './panelOptions.js';
 * @import {PortalOptions} from './portal.js';
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
 * Where a panel's keyboard comes from: its own options, the context's, or
 * both. Handed the factory the test records with.
 *
 * @typedef {(create: (target: KeyboardTarget) => ReturnType<typeof $>) => {
 *   panelOptions?: PanelOptions,
 *   options?: Omit<PortalOptions, "root">,
 * }} Configure
 */

/** @type {Configure} */
const ownKeyboard = (create) => ({ options: { keyboard: { gap: 20, create } } });

/**
 * A panel with a field in it and a keyboard on offer. The keyboard's DOM
 * is one clickable key; what it is handed is recorded.
 *
 * @param {Configure} [configure]
 * @param {import('./keyboardSlot.js').KeyboardSlot} [slot] The scene's
 *   keyboard, for panels that share one; without it the panel has its own.
 * @param {{ scene: THREE.Scene, camera: THREE.Camera, renderer?: object }} [room] A scene and a
 *   camera for the board to open in front of, and a renderer to carry it
 *   with; without them it hangs below the panel, as it does on a plain
 *   page. Put on the slot's context, the first panel's, as `render()`
 *   would.
 */
function keyboardPanel(configure = ownKeyboard, slot, room) {
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
  let ctx = InteractionContext.set({}, manager);

  const root = document.createElement("div");
  const input = document.createElement("input");
  input.type = "text";
  input.value = "ab";
  root.appendChild(input);
  document.body.appendChild(root);

  /** @type {KeyboardTarget[]} */
  const created = [];
  const { panelOptions, options } = configure((target) => {
    created.push(target);
    return $("div", [children($("div", [attr("style", () => "cursor: pointer")]))]);
  });
  if (panelOptions) {
    ctx = withPanelOptions(ctx, panelOptions);
  }
  if (slot) {
    ctx = KeyboardSlotContext.set(ctx, slot);
  }
  if (room) {
    // On the scene's context, as `render()` sets it out, rather than the
    // panel's: a panel with a renderer waits on frames a test cannot give.
    assert.ok(slot, "a room is the scene's, and so is its slot");
    let sceneCtx = SceneContext.set(CameraContext.set(ctx, room.camera), room.scene);
    if (room.renderer) {
      sceneCtx = RendererContext.set(sceneCtx, /** @type {any} */ (room.renderer));
    }
    slot.ctx ??= sceneCtx;
  }
  const portal = createPortal(ctx, { ...options, root });
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
  /**
   * The board's key, once the board is up: the registered object under the
   * hinge that is not the board's blocker plane.
   */
  const keyObject = () => {
    const board = hinge(parent);
    for (const target of targets) {
      const isBlocker =
        target instanceof THREE.Mesh && target.geometry instanceof THREE.PlaneGeometry;
      if (!isBlocker && board.getObjectById(target.id)) {
        return target;
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
  /**
   * A ray's press, as the manager delivers it.
   *
   * @param {THREE.Object3D | undefined} object
   * @param {XRInputSource | null} [inputSource] The hand pressing, for what
   *   it feels.
   */
  const press = (object, inputSource = null) => {
    assert.ok(object, "nothing to press");
    const controller = new THREE.Group();
    for (const type of ["selectstart", "select", "selectend"]) {
      manager.dispatch(
        /** @type {any} */ (object),
        /** @type {any} */ (withStart({ type, controller, inputSource, originalTarget: object })),
      );
    }
  };

  return {
    manager,
    portal,
    parent,
    root,
    input,
    created,
    targets,
    fieldObject,
    keyObject,
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

  test("comes up when a field is pressed, types into it, and goes on Escape", async () => {
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

    // Enter submits, and the field keeps the typing, as it does on a page.
    panel.created[0].onKey({ key: "Enter", code: "Enter" });
    await settle();
    assert.equal(panels(), 2, "the board is still up");
    assert.ok(panel.input.hasAttribute("data-xr-focus"), "and the field still has it");

    // Escape puts it away.
    panel.created[0].onKey({ key: "Escape", code: "Escape" });
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

    const pivot = hinge(panel.parent);
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

  test("a press on anything in the panel but a field puts it away", async () => {
    const panel = keyboardPanel();
    await settle();
    panel.press(panel.fieldObject());
    await settle();
    assert.equal(panels(), 2);

    // A button pressed by a ray is a click on it, bubbling to the panel's
    // root; so is a mouse click on a panel mirrored from the page. Any
    // element will do: what matters is that it is not a field.
    const other = document.createElement("span");
    panel.root.appendChild(other);
    await settle();
    other.click();
    await settle();
    assert.equal(panels(), 1, "the board is gone");
    assert.equal(panel.input.hasAttribute("data-xr-focus"), false);

    panel.cleanup();
  });

  test("a click on a field that takes the typing leaves it up", async () => {
    const panel = keyboardPanel();
    await settle();
    panel.press(panel.fieldObject());
    await settle();

    // The press on a field clicks it before it moves the typing there.
    const other = document.createElement("input");
    other.type = "text";
    panel.root.appendChild(other);
    other.click();
    panel.input.click();
    await settle();
    assert.equal(panels(), 2, "still up");

    // A field that cannot be typed into is anywhere else.
    other.readOnly = true;
    other.click();
    await settle();
    assert.equal(panels(), 1, "a read-only field takes nothing");

    panel.cleanup();
  });

  test("a click on a field's `<label for>` brings it up for that field", async () => {
    const panel = keyboardPanel();
    panel.input.id = "name";
    const label = document.createElement("label");
    label.htmlFor = "name";
    panel.root.appendChild(label);
    await settle();

    // A press on the label is a click on it, as on a page, where the
    // label's activation then focuses the field.
    label.click();
    await settle();
    assert.equal(panels(), 2, "the board is up");
    assert.equal(panel.created.length, 1);
    assert.equal(panel.created[0].element, panel.input, "for the labelled field");
    assert.ok(panel.input.hasAttribute("data-xr-focus"));

    panel.cleanup();
  });

  test("a click on another field's label moves the typing there", async () => {
    const panel = keyboardPanel();
    await settle();
    panel.press(panel.fieldObject());
    await settle();

    // A label around its field, the other way a label names one, with the
    // click on what is inside it.
    const label = document.createElement("label");
    const text = document.createElement("span");
    const other = document.createElement("input");
    other.type = "text";
    label.append(text, other);
    panel.root.appendChild(label);
    await settle();

    text.click();
    await settle();
    assert.equal(panels(), 2, "still one board");
    assert.equal(panel.input.hasAttribute("data-xr-focus"), false);
    assert.ok(other.hasAttribute("data-xr-focus"), "the labelled field has the typing");

    // A label of a field that cannot be typed into is anywhere else.
    other.readOnly = true;
    text.click();
    await settle();
    assert.equal(panels(), 1, "the board is gone");

    panel.cleanup();
  });

  test("a label of a field outside the panel puts it away", async () => {
    const panel = keyboardPanel();
    await settle();
    panel.press(panel.fieldObject());
    await settle();

    const outside = document.createElement("input");
    outside.id = "outside";
    document.body.appendChild(outside);
    const label = document.createElement("label");
    label.htmlFor = "outside";
    panel.root.appendChild(label);
    await settle();

    label.click();
    await settle();
    assert.equal(panels(), 1, "the board is gone: the field is drawn on no panel here");
    assert.equal(outside.hasAttribute("data-xr-focus"), false);

    outside.remove();
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

  test("the caret is faded with the field and what it is in", async () => {
    const panel = keyboardPanel();
    panel.root.style.opacity = "0.5";
    panel.input.style.opacity = "0.5";
    panel.input.style.color = "rgb(0, 0, 0)";
    try {
      await settle();
      panel.press(panel.fieldObject());
      await settle();
      /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | undefined} */
      let caret;
      panel.parent.children[0].traverse((child) => {
        if (child instanceof THREE.Mesh && child.geometry === rectGeometry) {
          caret = /** @type {any} */ (child);
        }
      });
      assert.ok(caret, "the caret is a mesh of its own");
      assert.equal(caret.material.opacity, 0.25);
    } finally {
      // Taken down whatever the assertions said: a caret left blinking holds
      // the runner open.
      panel.cleanup();
    }
  });

  test("the caret blinks, and is solid again after a keystroke", async () => {
    const panel = keyboardPanel();
    await settle();
    panel.press(panel.fieldObject());
    await settle();
    /** @type {THREE.Object3D | undefined} */
    let caret;
    panel.parent.children[0].traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry === rectGeometry) {
        caret = child;
      }
    });
    assert.ok(caret, "the caret is a mesh of its own");
    assert.equal(caret.visible, true, "shown as the typing starts");

    await sleep(CARET_BLINK_MS * 1.4);
    assert.equal(caret.visible, false, "hidden for the second half of the blink");

    panel.created[0].onKey({ key: "c", code: "KeyC" });
    await settle();
    assert.equal(caret.visible, true, "a keystroke brings it back");
    await sleep(CARET_BLINK_MS * 0.6);
    assert.equal(caret.visible, true, "and the blink starts over from there");

    // A key that changes nothing restarts it too: Backspace in an empty
    // field leaves the value and the caret where they were.
    panel.input.value = "";
    await settle();
    await sleep(CARET_BLINK_MS * 1.4);
    assert.equal(caret.visible, false, "hidden again");
    panel.created[0].onKey({ key: "Backspace", code: "Backspace" });
    assert.equal(panel.input.value, "", "nothing to take out");
    assert.equal(caret.visible, true, "and still the key brings it back");
    await sleep(CARET_BLINK_MS * 0.6);
    assert.equal(caret.visible, true, "for the whole of the first half");

    panel.created[0].onKey({ key: "Escape" });
    await settle();
    panel.cleanup();
  });
});

describe("the keyboard from the panel options", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  before(() => {
    canvas = stubCanvas();
  });
  after(() => {
    canvas.restore();
  });

  test("is offered by a panel that names none of its own", async () => {
    const panel = keyboardPanel((create) => ({ panelOptions: { keyboard: { create } } }));
    await settle();
    panel.press(panel.fieldObject());
    await settle();
    assert.equal(panel.created.length, 1, "the context's factory was asked for a board");
    assert.equal(panel.created[0].element, panel.input);
    assert.equal(panels(), 2);
    panel.cleanup();
  });

  test("has the panel's own options laid over it", async () => {
    const panel = keyboardPanel((create) => ({
      panelOptions: { keyboard: { create, gap: 5 } },
      options: { keyboard: { gap: 20 } },
    }));
    await settle();
    panel.press(panel.fieldObject());
    await settle();
    assert.equal(panel.created.length, 1, "the context's factory, still");
    const pivot = hinge(panel.parent);
    assert.ok(Math.abs(pivot.position.y - -0.2) < 1e-9, `the panel's gap, at ${pivot.position.y}`);
    panel.cleanup();
  });

  test("is turned off by a panel's `keyboard: false`", async () => {
    const panel = keyboardPanel((create) => ({
      panelOptions: { keyboard: { create } },
      options: { keyboard: false },
    }));
    await settle();
    panel.press(panel.fieldObject());
    await settle();
    assert.equal(panel.created.length, 0, "no board");
    assert.equal(panels(), 1);
    assert.equal(panel.input.hasAttribute("data-xr-focus"), false);
    panel.cleanup();
  });

  test("is none when nothing names a factory", async () => {
    const panel = keyboardPanel(() => ({
      panelOptions: { keyboard: { gap: 5 } },
      options: { keyboard: { tilt: 0 } },
    }));
    await settle();
    panel.press(panel.fieldObject());
    await settle();
    assert.equal(panels(), 1, "no board, and nothing thrown");
    assert.equal(panel.input.hasAttribute("data-xr-focus"), false);
    panel.cleanup();
  });

  test("the board's keys feel the way the panel's own haptics say, hover included", async () => {
    /**
     * The board of a panel configured so, brought up, and one of its keys
     * arrived on and pressed by a hand that keeps a record.
     *
     * @param {Configure} configure
     */
    const feltKey = async (configure) => {
      const panel = keyboardPanel(configure);
      await settle();
      panel.press(panel.fieldObject());
      await settle();
      const { source, played } = recordingSource();
      const key = panel.keyObject();
      assert.ok(key, "a key to point at");
      panel.manager.dispatch(
        /** @type {any} */ (key),
        /** @type {any} */ ({
          type: "pointerenter",
          controller: new THREE.Group(),
          inputSource: source,
          registeredTarget: key,
          originalTarget: key,
          relatedTarget: null,
        }),
      );
      panel.press(key, source);
      panel.cleanup();
      return played.map((effect) => effect.duration);
    };

    assert.deepEqual(
      await feltKey(ownKeyboard),
      [30, 40],
      "a tick on arriving and on the press: the board turns the hover on for itself",
    );
    assert.deepEqual(
      await feltKey((create) => ({
        panelOptions: { keyboard: { create }, haptics: { flavor: "knock" } },
      })),
      [30, 60],
      "the scene's flavor",
    );
    assert.deepEqual(
      await feltKey((create) => ({
        panelOptions: { keyboard: { create } },
        options: { haptics: { hover: false } },
      })),
      [40],
      "no hover for a panel that turned it off by name",
    );
    assert.deepEqual(
      await feltKey((create) => ({
        panelOptions: { keyboard: { create }, haptics: { flavor: "knock" } },
        options: { haptics: false },
      })),
      [],
      "and nothing for a panel that turned them off",
    );
  });

  test("reaches the portal's other options too", async () => {
    const readout = keyboardPanel(() => ({ panelOptions: { opaqueToRays: false } }));
    await settle();
    assert.equal(readout.blocker(), undefined, "the scene's default: no blocker");
    readout.cleanup();

    const button = keyboardPanel(() => ({
      panelOptions: { opaqueToRays: false },
      options: { opaqueToRays: true },
    }));
    await settle();
    assert.ok(button.blocker(), "the panel's own value wins");
    button.cleanup();
  });
});

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The hinge the board turns on, below a panel: under the anchor that hangs
 * beside the panel's own container.
 *
 * @param {THREE.Object3D} parent
 * @returns {THREE.Object3D}
 */
function hinge(parent) {
  const anchor = parent.children[1];
  assert.ok(anchor, "the board hangs beside the panel");
  return anchor.children[0];
}

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

describe("one keyboard for every panel in a scene", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  before(() => {
    canvas = stubCanvas();
  });
  after(() => {
    canvas.restore();
  });

  /**
   * Two panels sharing a scene's keyboard, both offered the same factory.
   */
  function twoPanels() {
    const slot = createKeyboardSlot();
    /** @type {KeyboardTarget[]} */
    const created = [];
    // One function for both, as a scene's panel options would give them.
    /** @param {KeyboardTarget} target */
    const create = (target) => {
      created.push(target);
      return $("div", [children($("div", [attr("style", () => "cursor: pointer")]))]);
    };
    /** @type {Configure} */
    const configure = () => ({ options: { keyboard: { create } } });
    const a = keyboardPanel(configure, slot);
    const b = keyboardPanel(configure, slot);
    return { slot, created, a, b };
  }

  test("moves the typing to a field in another panel without a second board", async () => {
    const { slot, created, a, b } = twoPanels();
    await settle();
    a.press(a.fieldObject());
    await settle();
    assert.equal(panels(), 3, "two panels and one board");
    assert.ok(a.input.hasAttribute("data-xr-focus"));

    b.press(b.fieldObject());
    await settle();
    assert.equal(panels(), 3, "still one board");
    assert.equal(created.length, 1, "built once");
    assert.equal(a.input.hasAttribute("data-xr-focus"), false, "the first field let go");
    assert.ok(b.input.hasAttribute("data-xr-focus"), "the second one took it");
    assert.equal(created[0].element, a.input, "built for the first field");
    assert.equal(created[0].field(), b.input, "typing into the second");
    assert.equal(a.parent.children.length, 1, "the board left the first panel");
    assert.equal(b.parent.children.length, 2, "and hangs below the second");

    created[0].onKey({ key: "c", code: "KeyC" });
    assert.equal(b.input.value, "abc", "keys go to the field being typed into");
    assert.equal(a.input.value, "ab");

    a.cleanup();
    b.cleanup();
    disposeKeyboardSlot(slot);
  });

  test("builds the board again for a panel that asks for a different one", async () => {
    const slot = createKeyboardSlot();
    const a = keyboardPanel(ownKeyboard, slot);
    const b = keyboardPanel(ownKeyboard, slot);
    await settle();
    a.press(a.fieldObject());
    await settle();
    b.press(b.fieldObject());
    await settle();
    assert.equal(a.created.length, 1);
    assert.equal(b.created.length, 1, "the second panel's factory was asked");
    assert.equal(panels(), 3, "the first board went as the second came");
    a.cleanup();
    b.cleanup();
    disposeKeyboardSlot(slot);
  });

  test("goes on a press on the background of either panel", async () => {
    for (const which of /** @type {const} */ (["a", "b"])) {
      const scene = twoPanels();
      await settle();
      scene.a.press(scene.a.fieldObject());
      await settle();
      assert.equal(panels(), 3);
      scene[which].press(scene[which].blocker());
      await settle();
      assert.equal(panels(), 2, `gone on a press on panel ${which}`);
      assert.equal(scene.a.input.hasAttribute("data-xr-focus"), false);
      scene.a.cleanup();
      scene.b.cleanup();
      disposeKeyboardSlot(scene.slot);
    }
  });

  test("stays while another panel's field or the other panel goes", async () => {
    const { slot, a, b } = twoPanels();
    await settle();
    a.press(a.fieldObject());
    await settle();

    b.input.remove();
    await settle();
    assert.equal(panels(), 3, "not the field being typed into");

    b.portal.disconnect();
    assert.equal(panels(), 2, "the first panel and the board");
    assert.ok(a.input.hasAttribute("data-xr-focus"));

    a.portal.disconnect();
    assert.equal(panels(), 0, "gone with the panel it was typing for");
    assert.equal(a.input.hasAttribute("data-xr-focus"), false);
    a.root.remove();
    b.root.remove();
    disposeKeyboardSlot(slot);
  });

  test("goes with the scene", async () => {
    const { slot, a, b } = twoPanels();
    await settle();
    a.press(a.fieldObject());
    await settle();
    assert.equal(panels(), 3);
    disposeKeyboardSlot(slot);
    assert.equal(panels(), 2, "the board is gone");
    assert.equal(slot.host, null);
    a.cleanup();
    b.cleanup();
  });
});

describe("the scene's keyboard at the end of a session", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  before(() => {
    canvas = stubCanvas();
  });
  after(() => {
    canvas.restore();
  });

  test("goes when the session ends, and takes the field's focus with it", async () => {
    // A page drawn only while presenting runs nothing after its session
    // ends: a board left up would type into the field in the next one,
    // from where the player stood in the last, and the page would show the
    // field focused in between.
    const slot = createKeyboardSlot();
    const xr = new THREE.EventDispatcher();
    const stop = dismissKeyboardAtSessionEnd(slot, /** @type {never} */ (xr));
    const a = keyboardPanel((create) => ({ options: { keyboard: { create } } }), slot);
    await settle();
    a.press(a.fieldObject());
    await settle();
    assert.equal(panels(), 2);
    assert.ok(a.input.hasAttribute("data-xr-focus"));

    xr.dispatchEvent(/** @type {never} */ ({ type: "sessionend" }));
    assert.equal(panels(), 1, "the board is gone");
    assert.equal(a.input.hasAttribute("data-xr-focus"), false);
    stop();
    a.cleanup();
  });
});

describe("the keyboard in front of the player", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  before(() => {
    canvas = stubCanvas();
  });
  after(() => {
    canvas.restore();
  });

  /**
   * A scene with a head in it: standing at the origin, eyes at 1.6 m,
   * looking down -z.
   */
  function room() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.6, 0);
    camera.updateMatrixWorld();
    return { scene, camera };
  }

  /**
   * @param {THREE.Vector3} actual
   * @param {[number, number, number]} expected
   */
  function assertNear(actual, [x, y, z]) {
    assert.ok(
      Math.abs(actual.x - x) < 1e-9 &&
        Math.abs(actual.y - y) < 1e-9 &&
        Math.abs(actual.z - z) < 1e-9,
      `expected (${x}, ${y}, ${z}), got (${actual.x}, ${actual.y}, ${actual.z})`,
    );
  }

  /**
   * Two panels sharing a scene's keyboard and a room, with one factory.
   *
   * @param {Partial<import('./portalKeyboard.js').PortalKeyboardOptions>} [options]
   */
  function scene(options = {}) {
    const slot = createKeyboardSlot();
    const space = room();
    /** @type {KeyboardTarget[]} */
    const created = [];
    /** @param {KeyboardTarget} target */
    const create = (target) => {
      created.push(target);
      return $("div", [children($("div", [attr("style", () => "cursor: pointer")]))]);
    };
    /** @type {Configure} */
    const configure = () => ({ options: { keyboard: { ...options, create } } });
    const a = keyboardPanel(configure, slot, space);
    const b = keyboardPanel(configure, slot, space);
    return {
      ...space,
      created,
      a,
      b,
      cleanup: () => {
        a.cleanup();
        b.cleanup();
        disposeKeyboardSlot(slot);
      },
    };
  }

  test("opens ahead of the eyes and below them, facing the head, a millimetre a px", async () => {
    const s = scene();
    await settle();
    s.a.press(s.a.fieldObject());
    await settle();

    assert.equal(panels(), 3, "two panels and the board");
    assert.equal(s.a.parent.children.length, 1, "nothing hangs below the panel");
    assert.equal(s.scene.children.length, 1, "the board is in the room");
    const anchor = s.scene.children[0];
    assertNear(anchor.position, [0, 1.4, -0.45]);
    assert.ok(Math.abs(anchor.rotation.y) < 1e-9, "facing back down +z, at the head");
    assert.ok(Math.abs(anchor.scale.x - 0.1) < 1e-9, "0.001 m a px over the panel's 0.01 units");
    assert.ok(anchor.children[0].rotation.x < 0, "reclined toward the viewer");

    s.cleanup();
  });

  test("stays where it was put while the head moves and the typing changes panel", async () => {
    const s = scene();
    await settle();
    s.a.press(s.a.fieldObject());
    await settle();
    const anchor = s.scene.children[0];

    s.camera.position.set(2, 1.6, 2);
    s.camera.rotation.set(0, Math.PI / 2, 0);
    s.camera.updateMatrixWorld();
    s.b.press(s.b.fieldObject());
    await settle();

    assert.equal(s.created.length, 1, "the same board");
    assert.equal(s.created[0].field(), s.b.input, "typing into the second panel's field");
    assert.equal(s.scene.children.length, 1);
    assert.equal(s.scene.children[0], anchor);
    assertNear(anchor.position, [0, 1.4, -0.45]);
    assert.equal(s.b.parent.children.length, 1, "not below the second panel either");

    s.cleanup();
  });

  test("opens in front of the head again once it has gone", async () => {
    const s = scene();
    await settle();
    s.a.press(s.a.fieldObject());
    await settle();
    s.created[0].onKey({ key: "Escape" });
    await settle();
    assert.equal(s.scene.children.length, 0, "the room is empty again");

    // Turned a quarter to the left: looking down -x.
    s.camera.rotation.set(0, Math.PI / 2, 0);
    s.camera.updateMatrixWorld();
    s.a.press(s.a.fieldObject());
    await settle();
    const anchor = s.scene.children[0];
    assertNear(anchor.position, [-0.45, 1.4, 0]);
    assert.ok(Math.abs(anchor.rotation.y - Math.PI / 2) < 1e-9, `yaw ${anchor.rotation.y}`);

    s.cleanup();
  });

  test("takes its size, reach and drop from the options", async () => {
    const s = scene({ scale: 0.002, reach: 0.6, drop: 0.3 });
    await settle();
    s.a.press(s.a.fieldObject());
    await settle();
    const anchor = s.scene.children[0];
    assertNear(anchor.position, [0, 1.3, -0.6]);
    assert.ok(Math.abs(anchor.scale.x - 0.2) < 1e-9);
    s.cleanup();
  });

  test('hangs below the panel with `placement: "panel"`, and follows the typing', async () => {
    const s = scene({ placement: "panel", gap: 20 });
    await settle();
    s.a.press(s.a.fieldObject());
    await settle();
    assert.equal(s.scene.children.length, 0, "not in the room");
    assert.ok(Math.abs(hinge(s.a.parent).position.y - -0.2) < 1e-9);

    s.b.press(s.b.fieldObject());
    await settle();
    assert.equal(s.a.parent.children.length, 1, "gone from the first panel");
    assert.ok(Math.abs(hinge(s.b.parent).position.y - -0.2) < 1e-9, "below the second");
    s.cleanup();
  });

  test("is posed by a placement function, once, as it opens", async () => {
    /** @type {import('./portalKeyboard.js').KeyboardPlacement[]} */
    const calls = [];
    const s = scene({
      placement: (placement) => {
        calls.push(placement);
        placement.anchor.position.set(1, 2, 3);
      },
    });
    await settle();
    s.a.press(s.a.fieldObject());
    await settle();
    s.b.press(s.b.fieldObject());
    await settle();

    assert.equal(calls.length, 1, "once, not again for the second field");
    assert.equal(calls[0].camera, s.camera);
    assert.equal(calls[0].field, s.a.input);
    assert.equal(calls[0].panelObject, s.a.parent.children[0]);
    assert.equal(calls[0].anchor, s.scene.children[0]);
    assertNear(s.scene.children[0].position, [1, 2, 3]);
    s.cleanup();
  });

  test("goes from the room with the panel it was typing for", async () => {
    const s = scene();
    await settle();
    s.a.press(s.a.fieldObject());
    await settle();
    s.a.portal.disconnect();
    assert.equal(s.scene.children.length, 0);
    assert.equal(panels(), 1, "the second panel alone");
    s.a.root.remove();
    s.b.cleanup();
  });
});

describe("the keyboard's handles", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  before(() => {
    canvas = stubCanvas();
  });
  after(() => {
    canvas.restore();
  });

  const SIDES = ["top", "bottom", "left", "right"];

  /**
   * A panel in a room with a renderer, which a carry needs, and its board
   * open.
   *
   * @param {Partial<import('./portalKeyboard.js').PortalKeyboardOptions>} [options]
   */
  async function openBoard(options = {}) {
    const slot = createKeyboardSlot();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.6, 0);
    camera.updateMatrixWorld();
    const panel = keyboardPanel(
      (create) => ({ options: { keyboard: { ...options, create } } }),
      slot,
      { scene, camera, renderer: {} },
    );
    await settle();
    panel.press(panel.fieldObject());
    await settle();
    const anchor = scene.children[0];
    const strip = (/** @type {string} */ side) => anchor?.getObjectByName(`panel-handle-${side}`);
    const bar = (/** @type {string} */ side) =>
      /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | undefined} */ (
        anchor?.getObjectByName(`panel-handle-${side}-bar`)
      );
    const controller = new THREE.Group();
    /**
     * An event as the manager dispatches it: from what the ray met, up
     * through its parents.
     *
     * @param {string} type
     * @param {THREE.Object3D} object
     */
    const dispatch = (type, object) => {
      const event = {
        type,
        target: object,
        originalTarget: object,
        controller,
        inputSource: {},
        intersection: { object, point: object.getWorldPosition(new THREE.Vector3()) },
      };
      panel.manager.dispatch(/** @type {any} */ (object), /** @type {any} */ (withStart(event)));
    };
    /**
     * The board's panel itself, beside the strips in the frame they carry
     * it by.
     */
    const board = () =>
      /** @type {THREE.Object3D} */ (
        strip("top")?.parent?.parent?.children.find((child) => child.name !== "panel-handles")
      );
    return {
      slot,
      scene,
      camera,
      panel,
      anchor,
      strip,
      bar,
      board,
      dispatch,
      reopen: async () => {
        panel.created[panel.created.length - 1].onKey({ key: "Escape" });
        await settle();
        panel.press(panel.fieldObject());
        await settle();
        return scene.children[0];
      },
      cleanup: () => {
        panel.cleanup();
        disposeKeyboardSlot(slot);
      },
    };
  }

  /**
   * @param {ReturnType<Awaited<ReturnType<typeof openBoard>>["bar"]>} bar
   */
  const opacity = (bar) => (bar?.visible ? bar.material.opacity : 0);

  test("are there, along the four edges, and invisible until a ray is on the board", async () => {
    const b = await openBoard();
    for (const side of SIDES) {
      assert.ok(b.strip(side), `a ${side} strip`);
      assert.equal(opacity(b.bar(side)), 0, `the ${side} bar is not shown`);
    }
    const top = /** @type {THREE.Object3D} */ (b.strip("top"));
    const bottom = /** @type {THREE.Object3D} */ (b.strip("bottom"));
    assert.ok(top.position.y > 0, "the top strip is above the hinge");
    assert.ok(bottom.position.y < top.position.y, "the bottom one below it");
    b.cleanup();
  });

  test("go idle when the ray leaves, however far it drifted within a key first", async () => {
    const b = await openBoard();
    const key = b.board();
    // A key is a background quad and a label quad, and a ray that arrived on
    // the one and drifted onto the other leaves from the other: the manager
    // says enter and leave per key, and names whichever mesh was met last.
    const label = new THREE.Object3D();
    key.add(label);

    b.dispatch("pointerenter", key);
    b.dispatch("pointermove", label);
    b.dispatch("pointerleave", label);
    try {
      for (const side of SIDES) {
        assert.equal(opacity(b.bar(side)), 0, `${side}, with the ray gone`);
      }
    } finally {
      // A board left open holds the runner up, and hides which assertion
      // it was that failed.
      b.cleanup();
    }
  });

  test("show faintly with a ray on the board, and fully on the one it is on", async () => {
    const b = await openBoard();
    const onBoard = b.board();

    b.dispatch("pointerenter", onBoard);
    for (const side of SIDES) {
      assert.equal(opacity(b.bar(side)), HANDLE_OPACITY_NEAR, `${side}, with a ray on a key`);
    }

    // Off the key and onto the top strip, as the manager says it.
    b.dispatch("pointerleave", onBoard);
    b.dispatch("pointerenter", /** @type {THREE.Object3D} */ (b.strip("top")));
    assert.equal(opacity(b.bar("top")), HANDLE_OPACITY_ACTIVE);
    assert.equal(opacity(b.bar("left")), HANDLE_OPACITY_NEAR);

    b.dispatch("pointerleave", /** @type {THREE.Object3D} */ (b.strip("top")));
    for (const side of SIDES) {
      assert.equal(opacity(b.bar(side)), 0, `${side}, with the ray gone`);
    }
    b.cleanup();
  });

  test("carry the board, and it opens where it was put down", async () => {
    const b = await openBoard();
    const top = /** @type {THREE.Object3D} */ (b.strip("top"));
    /** @type {string[]} */
    const behind = [];
    b.scene.addEventListener(/** @type {any} */ ("selectstart"), () => behind.push("selectstart"));

    b.dispatch("selectstart", top);
    await settle();
    assert.deepEqual(behind, [], "the press is the handle's, not the room's");
    for (const side of SIDES) {
      assert.equal(opacity(b.bar(side)), HANDLE_OPACITY_ACTIVE, `${side}, while carried`);
    }

    // The hand has moved it, as a frame of the carry would.
    b.anchor.position.set(0.3, 1.2, -0.6);
    b.anchor.rotation.set(0, 0.4, 0);
    b.dispatch("selectend", top);
    await settle();
    assert.equal(opacity(b.bar("top")), 0, "put down, and the ray is not on it");

    const again = await b.reopen();
    assert.notEqual(again, b.anchor, "a new board");
    assert.ok(
      again.position.distanceTo(new THREE.Vector3(0.3, 1.2, -0.6)) < 1e-9,
      "where it was put",
    );
    assert.ok(Math.abs(again.rotation.y - 0.4) < 1e-9, "turned as it was put");

    // Two metres on, where it was put is behind the player.
    b.camera.position.set(0, 1.6, -2);
    b.camera.updateMatrixWorld();
    const fresh = await b.reopen();
    assert.ok(fresh.position.distanceTo(new THREE.Vector3(0, 1.4, -2.45)) < 1e-9, "in front again");
    b.cleanup();
  });

  test("a press on a handle neither types nor puts the board away", async () => {
    const b = await openBoard();
    const left = /** @type {THREE.Object3D} */ (b.strip("left"));
    for (const type of ["selectstart", "select", "selectend"]) {
      b.dispatch(type, left);
    }
    await settle();
    assert.equal(panels(), 2, "the panel and the board");
    assert.equal(b.panel.input.value, "ab");
    assert.ok(b.panel.input.hasAttribute("data-xr-focus"));
    b.cleanup();
  });

  test("cannot be turned off, and are not there below a panel", async () => {
    // @ts-expect-error The board is always draggable in the room.
    const fixed = await openBoard({ draggable: false });
    assert.ok(fixed.strip("top"), "still there");
    fixed.cleanup();

    const below = await openBoard({ placement: "panel" });
    assert.equal(below.anchor, undefined, "nothing in the room");
    assert.equal(hinge(below.panel.parent).getObjectByName("panel-handle-top"), undefined);
    below.cleanup();
  });

  test("go with the board", async () => {
    const b = await openBoard();
    const top = /** @type {THREE.Object3D} */ (b.strip("top"));
    assert.ok(b.panel.targets.has(top), "a ray target while the board is up");
    b.panel.created[0].onKey({ key: "Escape" });
    await settle();
    assert.equal(b.panel.targets.has(top), false, "and not after");
    assert.equal(b.scene.children.length, 0);
    b.cleanup();
  });
});

/**
 * Give every `<input>` a width, which jsdom does not: 200 px across and 20
 * down, by client rect and by layout offsets both — a transformed field is
 * measured by the second. Without it a field is 0 px wide and every value
 * is scrolled to its caret, which is true but says nothing about where a
 * character is.
 *
 * @returns {() => void} Take it off again.
 */
function wideInputs() {
  const proto = window.HTMLInputElement.prototype;
  proto.getBoundingClientRect = () => new window.DOMRect(0, 0, 200, 20);
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => 200 });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 20 });
  return () => {
    Reflect.deleteProperty(proto, "getBoundingClientRect");
    Reflect.deleteProperty(proto, "offsetWidth");
    Reflect.deleteProperty(proto, "offsetHeight");
  };
}

/** @type {WeakMap<object, object>} Each hand's last `selectstart`. */
const starts = new WeakMap();

/**
 * A ray event as the manager sends it: a press's `selectstart` is kept for
 * the hand, and the events that end the press carry it as `start`.
 *
 * @template {{ type: string, controller: object }} E
 * @param {E} event
 * @returns {E}
 */
function withStart(event) {
  if (event.type === "selectstart") {
    starts.set(event.controller, event);
  } else if (event.type === "select" || event.type === "selectend") {
    return { ...event, start: starts.get(event.controller) };
  }
  return event;
}

/**
 * An event as the manager dispatches it, from what the ray met up through
 * its parents, landing `x` px into the field `object` draws.
 *
 * @param {InteractionManager} manager
 * @param {string} type
 * @param {THREE.Object3D} object
 * @param {THREE.Object3D} controller
 * @param {number} [x]
 */
function ray(manager, type, object, controller, x) {
  object.updateWorldMatrix(true, false);
  const point = x === undefined ? undefined : object.localToWorld(new THREE.Vector3(x, 10, 0));
  const event = {
    type,
    target: object,
    originalTarget: object,
    controller,
    inputSource: {},
    ...(point ? { intersection: { object, point } } : {}),
  };
  manager.dispatch(/** @type {any} */ (object), /** @type {any} */ (withStart(event)));
}

describe("the caret, placed by a ray", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  /** @type {() => void} */
  let narrow;
  before(() => {
    canvas = stubCanvas();
    narrow = wideInputs();
  });
  after(() => {
    narrow();
    canvas.restore();
  });

  test("goes where the ray presses on the field being typed into, and follows a drag", async () => {
    const panel = keyboardPanel();
    await settle();
    const field = /** @type {THREE.Object3D} */ (panel.fieldObject());
    panel.press(field);
    await settle();
    assert.equal(panel.input.selectionStart, 2, "the press that focused it put it at the end");

    // jsdom's inputs have a px of border and two of padding, so the value
    // starts 3 px in, at seven px a glyph: 8 px in is nearest the gap
    // between `a` and `b`, 10 px in.
    const hand = new THREE.Group();
    ray(panel.manager, "selectstart", field, hand, 8);
    assert.equal(panel.input.selectionStart, 1, "between the two");
    panel.created[0].onKey({ key: "c", code: "KeyC" });
    assert.equal(panel.input.value, "acb", "and the next key goes in there");

    ray(panel.manager, "pointermove", field, hand, 1);
    assert.equal(panel.input.selectionStart, 0, "dragged to the start");
    ray(panel.manager, "pointermove", field, new THREE.Group(), 20);
    assert.equal(panel.input.selectionStart, 0, "another hand's ray is only pointing");
    ray(panel.manager, "pointermove", field, hand, 100);
    assert.equal(panel.input.selectionStart, 3, "past the end is the end");

    ray(panel.manager, "selectend", field, hand);
    ray(panel.manager, "pointermove", field, hand, 1);
    assert.equal(panel.input.selectionStart, 3, "let go, the ray is only pointing again");
    panel.cleanup();
  });

  test("a drag that stays on one character does not place the caret again", async () => {
    const panel = keyboardPanel();
    await settle();
    const field = /** @type {THREE.Object3D} */ (panel.fieldObject());
    panel.press(field);
    await settle();
    let writes = 0;
    const setSelectionRange = panel.input.setSelectionRange.bind(panel.input);
    panel.input.setSelectionRange = (...args) => {
      writes += 1;
      setSelectionRange(...args);
    };
    const hand = new THREE.Group();
    ray(panel.manager, "selectstart", field, hand, 8);
    assert.equal(writes, 1, "the press puts it between `a` and `b`");
    for (const x of [8, 9, 11, 12]) {
      ray(panel.manager, "pointermove", field, hand, x);
    }
    assert.equal(writes, 1, "sliding over the same gap moves nothing");
    ray(panel.manager, "pointermove", field, hand, 1);
    assert.equal(writes, 2, "and the next character over does");
    ray(panel.manager, "selectend", field, hand);
    panel.cleanup();
  });

  test("a press where the selection ends collapses it, so typing appends", async () => {
    const panel = keyboardPanel();
    await settle();
    const field = /** @type {THREE.Object3D} */ (panel.fieldObject());
    panel.press(field);
    await settle();
    // As a page that selects a field's contents on focus does.
    panel.input.select();
    assert.deepEqual([panel.input.selectionStart, panel.input.selectionEnd], [0, 2]);
    ray(panel.manager, "selectstart", field, new THREE.Group(), 100);
    assert.deepEqual(
      [panel.input.selectionStart, panel.input.selectionEnd],
      [2, 2],
      "collapsed at the end, where the ray pressed",
    );
    panel.created[0].onKey({ key: "c", code: "KeyC" });
    assert.equal(panel.input.value, "abc", "appended, not replacing the selection");
    panel.cleanup();
  });

  test("a press that focuses a field puts the caret at the end, wherever it lands", async () => {
    const panel = keyboardPanel();
    await settle();
    const field = /** @type {THREE.Object3D} */ (panel.fieldObject());
    const hand = new THREE.Group();
    ray(panel.manager, "selectstart", field, hand, 1);
    ray(panel.manager, "select", field, hand, 1);
    ray(panel.manager, "selectend", field, hand);
    await settle();
    assert.ok(panel.input.hasAttribute("data-xr-focus"));
    assert.equal(panel.input.selectionStart, 2);
    panel.cleanup();
  });

  test("is placed in a field whose selection a script cannot write", async () => {
    const panel = keyboardPanel();
    panel.input.type = "email";
    panel.input.value = "ab@c";
    await settle();
    const field = /** @type {THREE.Object3D} */ (panel.fieldObject());
    panel.press(field);
    await settle();
    const hand = new THREE.Group();
    ray(panel.manager, "selectstart", field, hand, 15);
    assert.equal(getCaretOffset(panel.input), 2);
    panel.created[0].onKey({ key: "x", code: "KeyX" });
    assert.equal(panel.input.value, "abx@c");
    panel.cleanup();
  });

  test("measures a password by its bullets", async () => {
    const panel = keyboardPanel();
    panel.input.type = "password";
    await settle();
    const field = /** @type {THREE.Object3D} */ (panel.fieldObject());
    panel.press(field);
    await settle();
    // Three px of border and padding, then a bullet seven px wide.
    ray(panel.manager, "selectstart", field, new THREE.Group(), 11);
    assert.equal(panel.input.selectionStart, 1);
    panel.cleanup();
  });
});

describe("the keyboard's preview", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  /** @type {() => void} */
  let narrow;
  before(() => {
    canvas = stubCanvas();
    narrow = wideInputs();
  });
  after(() => {
    narrow();
    canvas.restore();
  });

  const preview = () =>
    /** @type {HTMLInputElement | null} */ (document.querySelector(`[${PREVIEW_ATTRIBUTE}]`));

  /**
   * Two panels sharing a scene's keyboard in a room, the first one's field
   * pressed and its board open.
   *
   * @param {Partial<import('./portalKeyboard.js').PortalKeyboardOptions>} [options]
   * @param {(a: HTMLInputElement, b: HTMLInputElement) => void} [dress]
   */
  async function open(options = {}, dress = () => {}) {
    const slot = createKeyboardSlot();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.6, 0);
    camera.updateMatrixWorld();
    /** @type {KeyboardTarget[]} */
    const created = [];
    /** @param {KeyboardTarget} target */
    const create = (target) => {
      created.push(target);
      return $("div", [children($("div", [attr("style", () => "cursor: pointer")]))]);
    };
    /** @type {Configure} */
    const configure = () => ({ options: { keyboard: { ...options, create } } });
    const a = keyboardPanel(configure, slot, { scene, camera });
    const b = keyboardPanel(configure, slot, { scene, camera });
    b.input.value = "xyz";
    dress(a.input, b.input);
    await settle();
    a.press(a.fieldObject());
    await settle();
    /**
     * What the preview is drawn as: the one ray target on the board with a
     * run of text in it.
     */
    const object = () => {
      const anchor = scene.children[0];
      for (const target of a.targets) {
        if (!anchor?.getObjectById(target.id)) {
          continue;
        }
        let drawsText = false;
        target.traverse((child) => {
          if (
            child instanceof THREE.Mesh &&
            child.geometry !== rectGeometry &&
            !(child.geometry instanceof THREE.PlaneGeometry)
          ) {
            drawsText = true;
          }
        });
        if (drawsText) {
          return target;
        }
      }
      return undefined;
    };
    return {
      scene,
      a,
      b,
      created,
      object,
      cleanup: () => {
        a.cleanup();
        b.cleanup();
        disposeKeyboardSlot(slot);
      },
    };
  }

  test("copies the field above the keys, and follows the typing", async () => {
    const s = await open();
    const copy = preview();
    assert.ok(copy, "a preview on the board");
    assert.equal(panels(), 3, "in the board's own panel, not one of its own");
    assert.equal(copy.value, "ab");
    assert.ok(
      copy.nextElementSibling?.querySelector("[style*='cursor']"),
      "and the board the app made under it",
    );

    s.created[0].onKey({ key: "c", code: "KeyC" });
    await settle();
    assert.equal(copy.value, "abc");
    assert.equal(getCaretOffset(copy), 3, "the caret where the field has it");

    // The typing moving to another panel's field moves the preview with it.
    s.b.press(s.b.fieldObject());
    await settle();
    assert.equal(preview(), copy, "the same preview");
    assert.equal(copy.value, "xyz");

    s.created[0].onKey({ key: "Escape" });
    await settle();
    assert.equal(preview(), null, "gone with the board");
    s.cleanup();
  });

  test("shows a password as it is, and a number as it is typed", async () => {
    const s = await open({}, (a, b) => {
      a.type = "password";
      b.type = "number";
      b.value = "";
    });
    const copy = /** @type {HTMLInputElement} */ (preview());
    assert.equal(copy.type, "text");
    assert.equal(copy.value, "ab", "unmasked");

    s.b.press(s.b.fieldObject());
    await settle();
    for (const key of "1.") {
      s.created[0].onKey({ key });
    }
    await settle();
    assert.equal(s.b.input.value, "", "the field's value is not a number yet");
    assert.equal(copy.value, "1.", "but the preview shows what was typed");
    s.cleanup();
  });

  test("shows the field's placeholder, and wears its look", async () => {
    const s = await open({}, (a) => {
      a.value = "";
      a.placeholder = "Name";
      a.style.color = "rgb(1, 2, 3)";
      a.style.backgroundColor = "rgb(4, 5, 6)";
    });
    const copy = /** @type {HTMLInputElement} */ (preview());
    assert.equal(copy.placeholder, "Name");
    assert.equal(copy.style.color, "rgb(1, 2, 3)");
    assert.equal(copy.style.backgroundColor, "rgb(4, 5, 6)");
    s.cleanup();
  });

  test("wears a class of the app's instead, if it is given one", async () => {
    const s = await open({ preview: { className: "strip" } }, (a) => {
      a.style.color = "rgb(1, 2, 3)";
    });
    const copy = /** @type {HTMLInputElement} */ (preview());
    assert.equal(copy.className, "strip");
    assert.equal(copy.style.color, "", "and none of the field's");
    s.cleanup();
  });

  test("a ray on it places the caret in the field being typed into", async () => {
    await rayOnPreview({ preview: { tilt: 0 } });
  });

  test("and does wherever it leans", async () => {
    await rayOnPreview({});
  });

  /** @param {Partial<import('./portalKeyboard.js').PortalKeyboardOptions>} options */
  async function rayOnPreview(options) {
    const s = await open(options);
    const object = s.object();
    assert.ok(object, "the preview is a ray target");
    const hand = new THREE.Group();
    ray(s.a.manager, "selectstart", object, hand, 8);
    await settle();
    assert.equal(s.a.input.selectionStart, 1, "in the field");
    assert.equal(getCaretOffset(/** @type {HTMLInputElement} */ (preview())), 1, "and shown");
    s.created[0].onKey({ key: "c", code: "KeyC" });
    assert.equal(s.a.input.value, "acb");

    ray(s.a.manager, "pointermove", object, hand, 1);
    await settle();
    assert.equal(s.a.input.selectionStart, 0, "dragged along");
    ray(s.a.manager, "selectend", object, hand);
    await settle();
    assert.ok(s.a.input.hasAttribute("data-xr-focus"), "and the typing is still there");
    assert.equal(panels(), 3, "the board still up");
    s.cleanup();
  }

  test("a press on it where the field's selection ends collapses the field's selection", async () => {
    const s = await open({ preview: { tilt: 0 } });
    s.a.input.select();
    ray(
      s.a.manager,
      "selectstart",
      /** @type {THREE.Object3D} */ (s.object()),
      new THREE.Group(),
      100,
    );
    await settle();
    assert.deepEqual([s.a.input.selectionStart, s.a.input.selectionEnd], [2, 2]);
    s.created[0].onKey({ key: "c", code: "KeyC" });
    assert.equal(s.a.input.value, "abc");
    s.cleanup();
  });

  test("leans toward the player, hinged at its bottom edge", async () => {
    /** @param {number | undefined} tilt */
    const lean = async (tilt) => {
      const s = await open(tilt === undefined ? {} : { preview: { tilt } });
      const object = /** @type {THREE.Object3D} */ (s.object());
      const pivot = s.scene.children[0].children[0];
      s.scene.updateMatrixWorld(true);
      // Ten px up the preview from its bottom edge, and the edge itself, in
      // the hinge's frame, whose +z is the way the board faces.
      const top = pivot.worldToLocal(object.localToWorld(new THREE.Vector3(0, 10, 0)));
      const bottom = pivot.worldToLocal(object.localToWorld(new THREE.Vector3(0, 20, 0)));
      s.cleanup();
      return { forward: top.z - bottom.z, up: top.y - bottom.y };
    };
    const flat = await lean(0);
    assert.ok(Math.abs(flat.forward) < 1e-9, "tilt 0 keeps it in the plane of the keys");
    const leaning = await lean(undefined);
    assert.ok(leaning.forward > 0, `its top toward the player (${leaning.forward})`);
    assert.ok(leaning.up > 0, "and still above its bottom edge");
    assert.ok(
      Math.abs(Math.atan2(leaning.forward, leaning.up) - (15 * Math.PI) / 180) < 1e-6,
      "by fifteen degrees",
    );
  });

  test("is not there with `preview: false`, nor below a panel", async () => {
    const off = await open({ preview: false });
    assert.equal(preview(), null);
    off.cleanup();
    const below = await open({ placement: "panel" });
    assert.equal(preview(), null);
    below.cleanup();
  });
});
