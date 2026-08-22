import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { children } from "@apendua/justdom";
import { just } from "@apendua/signal";
import * as THREE from "three";
import { keyboard, MOBILE_LAYOUT } from "./keyboard.js";
import { createPortal, InteractionContext, InteractionManager } from "@apendua/freedom";

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
// fixtures are text-free and never reach this; a board that says "enter" on a
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
 * @import {KeyPress, KeyboardLayout} from "./keyboard.js";
 */

/** Class names as a panel would supply them: one observable per part. */
const classes = {
  root: just("board"),
  row: just("row"),
  key: just("key"),
  keyActive: just("held"),
};

/**
 * @param {Observable<Mountable>} tree
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
 *
 * @param {KeyboardLayout} [layout]
 */
function typing(layout) {
  /** @type {KeyPress[]} */
  const pressed = [];
  const { root, cleanup } = mount(
    keyboard({ classes, onKey: (press) => pressed.push(press), ...(layout ? { layout } : {}) }),
  );
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

describe("MOBILE_LAYOUT", () => {
  test("is four rows of equal width", () => {
    assert.equal(MOBILE_LAYOUT.length, 4);
    for (const [index, row] of MOBILE_LAYOUT.entries()) {
      const width = row.reduce((total, entry) => total + (entry.width ?? 1), 0);
      assert.equal(width, 10, `row ${index} should be 10 units wide`);
    }
  });

  test("names every position exactly once", () => {
    const codes = MOBILE_LAYOUT.flat().map((entry) => entry.code);
    assert.equal(new Set(codes).size, codes.length);
  });

  test("keeps nothing a pointed-at board cannot use", () => {
    // No function row, no arrows, no chording modifiers: every key either
    // types or changes what the board types next.
    for (const entry of MOBILE_LAYOUT.flat()) {
      assert.ok(
        entry.key !== undefined || entry.modifier !== undefined || entry.spacer,
        `${entry.code} neither types nor modifies`,
      );
      if (entry.modifier) {
        assert.ok(
          entry.modifier === "shift" || entry.modifier === "symbols",
          `${entry.code} holds a modifier nobody can chord with`,
        );
      }
    }
  });

  test("reaches the printable ASCII set within two clicks", () => {
    // Every character a form could ask for is on the board somewhere: as a
    // base face, a shifted face, or the same two on the symbols view.
    const printable = new Set();
    for (const entry of MOBILE_LAYOUT.flat()) {
      for (const face of [entry, entry.symbols]) {
        if (!face) {
          continue;
        }
        if (face.key !== undefined) {
          printable.add(face.key);
        }
        if (face.shiftKey !== undefined) {
          printable.add(face.shiftKey);
        }
      }
    }
    for (let charCode = 0x20; charCode < 0x7f; charCode += 1) {
      const character = String.fromCharCode(charCode);
      if (/[a-zA-Z]/.test(character)) {
        continue;
      }
      assert.ok(printable.has(character), `no key types ${JSON.stringify(character)}`);
    }
  });
});

describe("keyboard", () => {
  test("types what is printed on the key", () => {
    const board = typing();

    board.press("KeyH");
    board.press("KeyI");
    board.press("Space");
    board.press("Period");
    board.press("Enter");

    assert.equal(board.typed(), "hi .Enter");
    assert.deepEqual(
      board.pressed.map(({ code }) => code),
      ["KeyH", "KeyI", "Space", "Period", "Enter"],
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

    board.press("KeyA");
    board.press("KeyB");

    assert.equal(board.typed(), "Ab");
    assert.equal(board.pressed[0].shiftKey, true);
    assert.equal(board.pressed[1].shiftKey, false, "released by the key it modified");
    assert.equal(keyEl(board.root, "ShiftLeft").getAttribute("aria-pressed"), "false");
    assert.equal(keyEl(board.root, "KeyA").textContent, "a");

    board.cleanup();
  });

  test("turns the symbols view like a phone, and holds it", () => {
    const board = typing();

    // Engaging the view is a restyle: every key that carries a symbols face
    // turns it, and the toggle reads the way back.
    board.press("Symbols");
    assert.equal(keyEl(board.root, "Symbols").getAttribute("aria-pressed"), "true");
    assert.equal(keyEl(board.root, "Symbols").textContent, "ABC");
    assert.equal(keyEl(board.root, "KeyQ").textContent, "1");
    assert.equal(keyEl(board.root, "KeyA").textContent, "-");

    // Sticky, unlike shift: a view that snapped back after one character
    // would be re-engaged for every digit of a number.
    board.press("KeyQ");
    board.press("KeyW");
    board.press("KeyE");
    assert.equal(board.typed(), "123");

    // Shift flips the symbols faces exactly as it flips the letters, and is
    // still one-shot.
    board.press("ShiftLeft");
    assert.equal(keyEl(board.root, "KeyQ").textContent, "!");
    board.press("KeyQ");
    board.press("KeyQ");
    assert.equal(board.typed(), "123!1");

    // The keys that carry no symbols face type what they always type.
    board.press("Space");
    board.press("Backspace");
    assert.equal(board.typed(), "123!1 Backspace");

    // And the way back is the same key.
    board.press("Symbols");
    assert.equal(keyEl(board.root, "Symbols").textContent, "?123");
    assert.equal(keyEl(board.root, "KeyQ").textContent, "q");
    board.press("KeyQ");
    assert.equal(board.typed(), "123!1 Backspaceq");

    board.cleanup();
  });

  test("reports the position, not the face", () => {
    const board = typing();

    board.press("Symbols");
    board.press("KeyQ");

    // Exactly as a hardware key reports where it is and not what the layout
    // painted on it.
    assert.equal(board.pressed[0].key, "1");
    assert.equal(board.pressed[0].code, "KeyQ");

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

  test("sends the keys that type nothing printable", () => {
    const board = typing();

    board.press("Backspace");
    board.press("Escape");
    board.press("Enter");

    assert.deepEqual(
      board.pressed.map(({ key }) => key),
      ["Backspace", "Escape", "Enter"],
    );

    board.cleanup();
  });

  test("keeps its shape while state moves through it", () => {
    const board = typing();
    const count = () => board.root.querySelectorAll("[data-code]").length;
    const before = count();

    board.press("ShiftLeft");
    board.press("Symbols");
    board.press("KeyA");
    board.press("Symbols");

    // A changed tree costs a portal a re-measure of every box in the panel;
    // a changed class or label costs it a restyle. The symbols view moves the
    // whole board's faces at once, so it above all must be the cheap one.
    assert.equal(count(), before);
    assert.equal(before, MOBILE_LAYOUT.flat().filter((entry) => !entry.spacer).length);

    board.cleanup();
  });

  test("lays the rows out from the widths, so no CSS has to restate them", () => {
    const board = typing();

    assert.equal(keyEl(board.root, "KeyA").style.flexGrow, "1");
    assert.equal(keyEl(board.root, "ShiftLeft").style.flexGrow, "1.5");
    assert.equal(keyEl(board.root, "Space").style.flexGrow, "5");
    assert.equal(keyEl(board.root, "KeyA").style.flexBasis, "0px");

    board.cleanup();
  });

  test("holds the middle row in from the edges with spaces that are not keys", () => {
    const board = typing();

    const rows = board.root.querySelectorAll('[role="row"]');
    const middle = rows[1];
    const edges = [middle.firstElementChild, middle.lastElementChild];
    for (const edge of edges) {
      assert.ok(edge instanceof HTMLElement);
      assert.equal(edge.style.flexGrow, "0.5");
      // Undressed and unclickable: no class means no `cursor`, and no
      // `cursor` means no ray target.
      assert.equal(edge.className, "");
      assert.equal(edge.getAttribute("role"), null);
      assert.equal(edge.getAttribute("data-code"), null);
    }

    board.cleanup();
  });

  test("names the keys whose labels are glyphs", () => {
    const board = typing();

    assert.equal(keyEl(board.root, "Space").getAttribute("aria-label"), "Space");
    assert.equal(keyEl(board.root, "Backspace").getAttribute("aria-label"), "Backspace");
    assert.equal(keyEl(board.root, "ShiftLeft").getAttribute("aria-label"), "Shift");
    assert.equal(keyEl(board.root, "KeyA").getAttribute("aria-label"), "a");
    // The toggle's name follows its face: it reads as where it goes.
    assert.equal(keyEl(board.root, "Symbols").getAttribute("aria-label"), "Symbols");
    board.press("Symbols");
    assert.equal(keyEl(board.root, "Symbols").getAttribute("aria-label"), "Letters");

    board.cleanup();
  });

  test("locks caps until it is clicked again, and only over letters, on a layout that has it", () => {
    const board = typing([
      [
        { code: "CapsLock", label: "caps", modifier: "caps", name: "Caps Lock" },
        { code: "ShiftLeft", label: "shift", modifier: "shift", name: "Shift" },
        { code: "KeyA", label: "a", shiftLabel: "A", key: "a", shiftKey: "A", cased: true },
        { code: "Digit1", label: "1", shiftLabel: "!", key: "1", shiftKey: "!" },
      ],
    ]);

    board.press("CapsLock");
    board.press("KeyA");
    board.press("Digit1");
    board.press("KeyA");

    assert.equal(board.typed(), "A1A", "the lock outlives the key it capitalised");
    assert.equal(board.pressed[0].capsLock, true);

    // Shift flips the lock rather than winning over it, on this board as on
    // every other one.
    board.press("ShiftLeft");
    assert.equal(keyEl(board.root, "KeyA").textContent, "a");
    board.press("KeyA");

    board.press("CapsLock");
    board.press("KeyA");

    assert.equal(board.typed(), "A1Aaa");

    board.cleanup();
  });

  test("reports the chording modifiers of a custom layout, and lets them go", () => {
    const board = typing([
      [
        { code: "ControlLeft", label: "ctrl", modifier: "ctrl", name: "Control" },
        { code: "AltLeft", label: "alt", modifier: "alt", name: "Alt" },
        { code: "MetaLeft", label: "meta", modifier: "meta", name: "Meta" },
        { code: "Fn", label: "fn", modifier: "fn", name: "Fn" },
        { code: "KeyC", label: "c", key: "c" },
      ],
    ]);

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

  test("shares one state between two keys holding the same modifier", () => {
    const board = typing([
      [
        { code: "ShiftLeft", label: "shift", modifier: "shift", name: "Shift" },
        { code: "ShiftRight", label: "shift", modifier: "shift", name: "Shift" },
        { code: "KeyA", label: "a", shiftLabel: "A", key: "a", shiftKey: "A", cased: true },
      ],
    ]);

    board.press("ShiftRight");
    assert.equal(keyEl(board.root, "ShiftLeft").getAttribute("aria-pressed"), "true");
    board.press("KeyA");

    assert.equal(board.typed(), "A");

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
    /** @type {Mountable | undefined} */
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

    const keys = MOBILE_LAYOUT.flat().filter((entry) => !entry.spacer);
    assert.equal(added.length, keys.length + 1, "one blocker plane, then a mesh per key");

    // A ray landing on a key is a `select` on the mesh, which the portal turns
    // back into a click on the element it was mirrored from. Pointing at all
    // of them in turn is the whole board being usable in a headset, which is
    // the only claim here that a flat-page test cannot make. The toggle among
    // them flips the view mid-walk and the modifiers flip their state — the
    // codes still come back one per typing key, which is the point: the
    // position reports itself whatever face it is wearing.
    for (const target of added.slice(1)) {
      target.dispatchEvent(/** @type {any} */ ({ type: "select" }));
    }

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
