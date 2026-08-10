import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { children } from "@apendua/justdom";
import { just } from "@apendua/signal";
import * as THREE from "three";
import { keyboard, LAPTOP_LAYOUT } from "./keyboard.js";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal } from "./portal.js";

// jsdom-env exposes the common DOM globals, but not MutationObserver, which
// the portal uses to mirror the tree.
if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}

// `getComputedStyle` is a window method rather than a global under jsdom-env;
// the text mirror reaches for the bare name, as it may on a page.
if (typeof globalThis.getComputedStyle === "undefined") {
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
}

// jsdom lays nothing out, so a Range measures nothing either. The portal's own
// fixtures are text-free and never reach this; a board that says "shift" on a
// key does. Zeroes are the honest answer here — nothing about this test is
// about where the glyphs landed.
if (typeof window.Range.prototype.getBoundingClientRect !== "function") {
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  window.Range.prototype.getClientRects = () => /** @type {any} */ ([]);
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

/**
 * @returns {Promise<void>}
 */
function nextMacrotask() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** The dressing a panel would supply. Only `cursor` is load-bearing here. */
function dressBoard() {
  const style = document.createElement("style");
  style.textContent = ".key { cursor: pointer; }";
  document.head.appendChild(style);
  return () => style.remove();
}

/**
 * @import {Observable} from "rxjs";
 * @import {Mountable} from "@apendua/justdom";
 * @import {KeyPress} from "./keyboard.js";
 */

/** Class names as a panel would supply them: one observable per part. */
const classes = {
  root: just("board"),
  row: just("row"),
  key: just("key"),
  keyActive: just("held"),
};

/**
 * @param {Observable<Mountable<Node>>} tree
 */
function mount(tree) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const subscription = just(host, [children(tree)]).subscribe();
  const root = /** @type {HTMLElement} */ (host.firstElementChild);
  return {
    root,
    cleanup: () => {
      subscription.unsubscribe();
      host.remove();
    },
  };
}

/**
 * @param {HTMLElement} root
 * @param {string} code
 */
function keyEl(root, code) {
  const element = root.querySelector(`[data-code="${code}"]`);
  assert.ok(element instanceof HTMLElement, `expected a key for ${code}`);
  return element;
}

/**
 * @param {HTMLElement} root
 * @param {string} code
 */
function click(root, code) {
  keyEl(root, code).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/**
 * Mounts a board and collects what it types.
 */
function typing() {
  /** @type {KeyPress[]} */
  const pressed = [];
  const { root, cleanup } = mount(keyboard({ classes, onKey: (press) => pressed.push(press) }));
  return {
    root,
    pressed,
    cleanup,
    /** @param {string} code */
    press: (code) => click(root, code),
    /** The characters typed so far, in order. */
    typed: () => pressed.map((press) => press.key).join(""),
  };
}

describe("LAPTOP_LAYOUT", () => {
  test("is six rows of equal width", () => {
    assert.equal(LAPTOP_LAYOUT.length, 6);
    for (const [index, row] of LAPTOP_LAYOUT.entries()) {
      const width = row.reduce((total, entry) => total + (entry.width ?? 1), 0);
      assert.equal(width, 15, `row ${index} should be 15 units wide`);
    }
  });

  test("names every physical key exactly once", () => {
    const codes = LAPTOP_LAYOUT.flat().map((entry) => entry.code);
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe("keyboard", () => {
  test("types what is printed on the key", () => {
    const board = typing();

    board.press("KeyH");
    board.press("KeyI");
    board.press("Space");
    board.press("Digit1");
    board.press("Enter");

    assert.equal(board.typed(), "hi 1Enter");
    assert.deepEqual(
      board.pressed.map(({ code }) => code),
      ["KeyH", "KeyI", "Space", "Digit1", "Enter"],
    );

    board.cleanup();
  });

  test("holds shift for exactly one key, and says so on the press", () => {
    const board = typing();

    board.press("ShiftLeft");
    assert.equal(keyEl(board.root, "ShiftLeft").getAttribute("aria-pressed"), "true");
    assert.ok(keyEl(board.root, "ShiftLeft").className.split(" ").includes("held"));
    // The face of the board follows the modifier, so that what will be typed
    // is legible before it is.
    assert.equal(keyEl(board.root, "KeyA").textContent, "A");
    assert.equal(keyEl(board.root, "Digit1").textContent, "!");

    board.press("KeyA");
    board.press("KeyB");

    assert.equal(board.typed(), "Ab");
    assert.equal(board.pressed[0].shiftKey, true);
    assert.equal(board.pressed[1].shiftKey, false, "released by the key it modified");
    assert.equal(keyEl(board.root, "ShiftLeft").getAttribute("aria-pressed"), "false");
    assert.equal(keyEl(board.root, "KeyA").textContent, "a");

    board.cleanup();
  });

  test("locks caps until it is clicked again, and only over letters", () => {
    const board = typing();

    board.press("CapsLock");
    board.press("KeyA");
    board.press("Digit1");
    board.press("KeyB");

    assert.equal(board.typed(), "A1B", "the lock outlives the key it capitalised");
    assert.equal(board.pressed[0].capsLock, true);

    // Shift flips the lock rather than winning over it, on this board as on
    // every other one.
    board.press("ShiftLeft");
    assert.equal(keyEl(board.root, "KeyA").textContent, "a");
    board.press("KeyA");

    board.press("CapsLock");
    board.press("KeyA");

    assert.equal(board.typed(), "A1Baa");

    board.cleanup();
  });

  test("reports the chording modifiers and lets them go", () => {
    const board = typing();

    board.press("ControlLeft");
    board.press("AltLeft");
    board.press("MetaLeft");
    board.press("Fn");
    board.press("KeyC");
    board.press("KeyC");

    assert.deepEqual(
      board.pressed.map(({ ctrlKey, altKey, metaKey, fnKey }) => [ctrlKey, altKey, metaKey, fnKey]),
      [
        [true, true, true, true],
        [false, false, false, false],
      ],
    );

    board.cleanup();
  });

  test("clicking a modifier twice takes it back", () => {
    const board = typing();

    board.press("ShiftLeft");
    board.press("ShiftLeft");
    board.press("KeyA");

    assert.equal(board.typed(), "a");
    assert.equal(board.pressed[0].shiftKey, false);

    board.cleanup();
  });

  test("shares one state between the two shift keys", () => {
    const board = typing();

    board.press("ShiftRight");
    assert.equal(keyEl(board.root, "ShiftLeft").getAttribute("aria-pressed"), "true");
    board.press("KeyA");

    assert.equal(board.typed(), "A");

    board.cleanup();
  });

  test("sends the keys that type nothing printable", () => {
    const board = typing();

    board.press("Backspace");
    board.press("ArrowLeft");
    board.press("Escape");
    board.press("F5");

    assert.deepEqual(
      board.pressed.map(({ key }) => key),
      ["Backspace", "ArrowLeft", "Escape", "F5"],
    );

    board.cleanup();
  });

  test("keeps its shape while state moves through it", () => {
    const board = typing();
    const count = () => board.root.querySelectorAll("[data-code]").length;
    const before = count();

    board.press("ShiftLeft");
    board.press("CapsLock");
    board.press("KeyA");

    // A changed tree costs a portal a re-measure of every box in the panel;
    // a changed class costs it a restyle. Shift is the state that moves most,
    // so it had better be the cheap one.
    assert.equal(count(), before);
    assert.equal(before, LAPTOP_LAYOUT.flat().length);

    board.cleanup();
  });

  test("lays the rows out from the widths, so no CSS has to restate them", () => {
    const board = typing();

    assert.equal(keyEl(board.root, "KeyA").style.flexGrow, "1");
    assert.equal(keyEl(board.root, "ShiftLeft").style.flexGrow, "2.25");
    assert.equal(keyEl(board.root, "Space").style.flexGrow, "6");
    assert.equal(keyEl(board.root, "KeyA").style.flexBasis, "0px");

    board.cleanup();
  });

  test("names the keys whose labels are glyphs", () => {
    const board = typing();

    assert.equal(keyEl(board.root, "Space").getAttribute("aria-label"), "Space");
    assert.equal(keyEl(board.root, "Backspace").getAttribute("aria-label"), "Backspace");
    assert.equal(keyEl(board.root, "ArrowLeft").getAttribute("aria-label"), "Left arrow");
    assert.equal(keyEl(board.root, "KeyA").getAttribute("aria-label"), "a");

    board.cleanup();
  });

  test("takes a layout of its own", () => {
    /** @type {KeyPress[]} */
    const pressed = [];
    const { root, cleanup } = mount(
      keyboard({
        classes,
        onKey: (press) => pressed.push(press),
        layout: [[{ code: "KeyY", label: "y", key: "y" }]],
      }),
    );

    assert.equal(root.querySelectorAll("[data-code]").length, 1);
    click(root, "KeyY");
    assert.deepEqual(
      pressed.map(({ key }) => key),
      ["y"],
    );

    cleanup();
  });
});

/**
 * The board is built out of ordinary elements on the argument that ordinary
 * elements are the only thing a portal can carry. This is that argument
 * checked: a whole board projected through a real portal, rather than the
 * two-`div` fixtures the portal's own tests use.
 */
describe("projecting a keyboard", () => {
  test("gives every key of a keyboard its own ray target, and types the one that is pointed at", async () => {
    const undress = dressBoard();
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

    /** @type {KeyPress[]} */
    const pressed = [];
    /** @type {Mountable<Node> | undefined} */
    let mountable;
    const subscription = keyboard({
      classes,
      onKey: (press) => pressed.push(press),
    }).subscribe((value) => {
      mountable = value;
    });
    assert.ok(mountable);
    portal.mount(mountable);

    // The portal mirrors DOM through a MutationObserver; give it a beat.
    await nextMacrotask();
    await nextMacrotask();

    const keys = LAPTOP_LAYOUT.flat();
    assert.equal(added.length, keys.length + 1, "one blocker plane, then a mesh per key");

    // A ray landing on a key is a `select` on the mesh, which the portal turns
    // back into a click on the element it was mirrored from. Pointing at all
    // of them in turn is the whole board being usable in a headset, which is
    // the only claim here that a flat-page test cannot make.
    for (const target of added.slice(1)) {
      target.dispatchEvent(/** @type {any} */ ({ type: "select" }));
    }

    // By code rather than by character, because the modifiers among them were
    // pressed too, and a board that ignored those would be the wrong one.
    assert.deepEqual(
      pressed.map(({ code }) => code).sort(),
      keys
        .filter(({ key }) => key !== undefined)
        .map(({ code }) => code)
        .sort(),
    );

    subscription.unsubscribe();
    portal.disconnect();
    undress();
  });
});
