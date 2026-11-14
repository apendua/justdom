import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { children } from "justdom-core";
import { just, Signal } from "justdom-signal";
import * as THREE from "three";
import { isNumericField, keyboard, MOBILE_LAYOUT, NUMERIC_LAYOUT } from "./keyboard.js";
import { createPortal, InteractionContext, InteractionManager } from "justdom-three";

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
 * @import {Mountable} from "justdom-core";
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
 * @param {import("justdom-signal").Subscribable<Mountable>} tree
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
 * A pointer going down on a key, as a ray's trigger closing on it sends it.
 *
 * @param {HTMLElement} root
 * @param {string} code
 * @param {PointerEventInit} [init]
 */
function down(root, code, init = {}) {
  keyEl(root, code).dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, button: 0, ...init }),
  );
}

/**
 * A pointer event on a key, other than the press: its release, its cancel,
 * its leave.
 *
 * @param {HTMLElement} root
 * @param {string} code
 * @param {"pointerup" | "pointercancel" | "pointerleave"} type
 * @param {number} [pointerId]
 */
function up(root, code, type = "pointerup", pointerId = 2) {
  keyEl(root, code).dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId }));
}

/**
 * A key pressed and let go, and the click that follows.
 *
 * @param {HTMLElement} root
 * @param {string} code
 */
function tap(root, code) {
  down(root, code);
  up(root, code);
  keyEl(root, code).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/**
 * Mounts a board and collects what it types.
 *
 * @param {KeyboardLayout} [layout]
 * @param {Partial<import("./keyboard.js").KeyboardProps>} [props]
 */
function typing(layout, props = {}) {
  /** @type {KeyPress[]} */
  const pressed = [];
  const { root, cleanup } = mount(
    keyboard({
      classes,
      onKey: (press) => pressed.push(press),
      ...(layout ? { layout } : {}),
      ...props,
    }),
  );
  return {
    root,
    pressed,
    cleanup,
    /** @param {string} code */
    press: (code) => tap(root, code),
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
    tap(root, "KeyY");
    assert.deepEqual(
      pressed.map(({ key }) => key),
      ["y"],
    );

    cleanup();
  });
});

describe("a key held down", () => {
  /**
   * Lets `ms` go by a millisecond at a time: the mock clock runs a timer a
   * timer sets for later in the same tick at the next tick, not this one.
   *
   * @param {import("node:test").TestContext} t
   * @param {number} ms
   */
  const elapse = (t, ms) => {
    for (let i = 0; i < ms; i += 1) {
      t.mock.timers.tick(1);
    }
  };

  /**
   * A board with the timers in the test's hands.
   *
   * @param {import("node:test").TestContext} t
   * @param {Partial<import("./keyboard.js").KeyboardProps>} [props]
   * @param {KeyboardLayout} [layout]
   */
  const held = (t, props, layout) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    return typing(layout, props);
  };

  test("types as it goes down, before it is let go", (t) => {
    const board = held(t);
    down(board.root, "KeyA");
    assert.equal(board.typed(), "a", "typed at the press");
    up(board.root, "KeyA");
    keyEl(board.root, "KeyA").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(board.typed(), "a", "and not again at the release or the click");
    board.cleanup();
  });

  test("engages a modifier as it goes down", (t) => {
    const board = held(t);
    down(board.root, "ShiftLeft");
    assert.equal(keyEl(board.root, "ShiftLeft").getAttribute("aria-pressed"), "true");
    up(board.root, "ShiftLeft");
    elapse(t, 2000);
    assert.equal(keyEl(board.root, "ShiftLeft").getAttribute("aria-pressed"), "true");
    down(board.root, "KeyA");
    assert.equal(board.typed(), "A");
    board.cleanup();
  });

  test("types again after the delay, and at the interval after that, until let go", (t) => {
    const board = held(t);
    down(board.root, "Backspace");
    elapse(t, 499);
    assert.equal(board.pressed.length, 1, "once, until the delay is up");
    elapse(t, 1);
    assert.equal(board.pressed.length, 2, "again at the delay");
    elapse(t, 49);
    assert.equal(board.pressed.length, 2);
    elapse(t, 1);
    assert.equal(board.pressed.length, 3, "and at the interval");
    elapse(t, 100);
    assert.equal(board.pressed.length, 5);
    up(board.root, "Backspace");
    elapse(t, 1000);
    assert.equal(board.pressed.length, 5, "and stops when let go");
    assert.ok(board.pressed.every(({ key }) => key === "Backspace"));
    board.cleanup();
  });

  test("stops when the press is cancelled, or the pointer leaves the key", (t) => {
    const board = held(t);
    for (const type of /** @type {const} */ (["pointercancel", "pointerleave"])) {
      board.pressed.length = 0;
      down(board.root, "KeyB");
      elapse(t, 500);
      assert.equal(board.pressed.length, 2);
      up(board.root, "KeyB", type);
      elapse(t, 1000);
      assert.equal(board.pressed.length, 2, `${type} ends the repeat`);
    }
    board.cleanup();
  });

  test("goes on while another pointer lets go of the same key", (t) => {
    const board = held(t);
    down(board.root, "KeyC");
    up(board.root, "KeyC", "pointerup", 3);
    up(board.root, "KeyC", "pointerleave", 3);
    elapse(t, 550);
    assert.equal(board.typed(), "ccc");
    up(board.root, "KeyC");
    board.cleanup();
  });

  test("repeats one key at a time, the one pressed last", (t) => {
    const board = held(t);
    down(board.root, "KeyD");
    down(board.root, "KeyE", { pointerId: 3 });
    elapse(t, 500);
    assert.equal(board.typed(), "dee", "the second press took over");
    up(board.root, "KeyD");
    elapse(t, 50);
    assert.equal(board.typed(), "deee", "the first one's release is not the repeat's");
    down(board.root, "Enter", { pointerId: 4 });
    elapse(t, 1000);
    assert.equal(board.typed(), "deeeEnter", "a key that does not repeat ends it too");
    board.cleanup();
  });

  test("types what it typed at the press, shift included", (t) => {
    const board = held(t);
    board.press("ShiftLeft");
    down(board.root, "KeyF");
    elapse(t, 550);
    assert.equal(board.typed(), "FFF");
    assert.ok(board.pressed.every(({ shiftKey }) => shiftKey));
    assert.equal(keyEl(board.root, "KeyF").textContent, "f", "the one-shot shift let go");
    up(board.root, "KeyF");
    board.cleanup();
  });

  test("does not repeat enter, esc or a modifier", (t) => {
    const board = held(t);
    for (const code of ["Enter", "Escape", "Symbols"]) {
      down(board.root, code);
      elapse(t, 1000);
      up(board.root, code);
    }
    assert.deepEqual(
      board.pressed.map(({ key }) => key),
      ["Enter", "Escape"],
    );
    assert.equal(keyEl(board.root, "Symbols").getAttribute("aria-pressed"), "true");
    board.cleanup();
  });

  test("on the number pad, repeats the digits and not enter or esc", () => {
    const repeating = NUMERIC_LAYOUT.flat()
      .filter((entry) => entry.repeat === false)
      .map(({ code }) => code)
      .sort();
    assert.deepEqual(repeating, ["Enter", "Escape"]);
  });

  test("takes a delay and an interval of its own", (t) => {
    const board = held(t, { repeat: { delay: 200, interval: 100 } });
    down(board.root, "KeyG");
    elapse(t, 200);
    assert.equal(board.typed(), "gg");
    elapse(t, 99);
    assert.equal(board.typed(), "gg");
    elapse(t, 1);
    assert.equal(board.typed(), "ggg");
    up(board.root, "KeyG");
    board.cleanup();
  });

  test("types once with repeat turned off", (t) => {
    const board = held(t, { repeat: false });
    down(board.root, "KeyH");
    elapse(t, 5000);
    assert.equal(board.typed(), "h");
    board.cleanup();
  });

  test("is pressed by the primary button alone", (t) => {
    const board = held(t);
    down(board.root, "KeyI", { button: 2 });
    elapse(t, 1000);
    assert.equal(board.typed(), "");
    board.cleanup();
  });

  test("stops when the key is unmounted", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const text = document.createElement("input");
    const number = document.createElement("input");
    number.type = "number";
    const current = Signal.of(text);
    /** @type {string[]} */
    const typed = [];
    const { root, cleanup } = mount(
      keyboard({ classes, onKey: ({ key }) => typed.push(key), field: () => current.get() }),
    );
    down(root, "KeyJ");
    current.set(number);
    elapse(t, 2000);
    assert.deepEqual(typed, ["j"], "the board it was on has gone");
    cleanup();

    const board = typing();
    down(board.root, "KeyK");
    board.cleanup();
    elapse(t, 2000);
    assert.equal(board.typed(), "k", "and so has this one");
  });
});

/**
 * The board is built out of ordinary elements on the argument that ordinary
 * elements are the only thing a portal can carry. This is that argument
 * checked: a whole board projected through a real portal, rather than the
 * two-`div` fixtures the portal's own tests use.
 */
describe("NUMERIC_LAYOUT", () => {
  test("is four rows of equal width", () => {
    assert.equal(NUMERIC_LAYOUT.length, 4);
    for (const [index, row] of NUMERIC_LAYOUT.entries()) {
      const width = row.reduce((total, entry) => total + (entry.width ?? 1), 0);
      assert.equal(width, 4, `row ${index} should be 4 units wide`);
    }
  });

  test("names every position exactly once", () => {
    const codes = NUMERIC_LAYOUT.flat().map((entry) => entry.code);
    assert.equal(new Set(codes).size, codes.length);
  });

  test("types every digit, a sign and a point in one click, and nothing else", () => {
    const typed = NUMERIC_LAYOUT.flat()
      .map((entry) => entry.key)
      .filter((key) => key !== undefined && key.length === 1)
      .sort();
    assert.deepEqual(typed, [..."-.0123456789"].sort());
    for (const entry of NUMERIC_LAYOUT.flat()) {
      assert.equal(entry.modifier, undefined, `${entry.code} is a modifier`);
      assert.equal(entry.symbols, undefined, `${entry.code} has a second face`);
    }
  });
});

describe("isNumericField", () => {
  /**
   * @param {string} type
   * @param {string} [inputMode]
   */
  const field = (type, inputMode) => {
    const input = document.createElement("input");
    input.type = type;
    if (inputMode !== undefined) {
      input.setAttribute("inputmode", inputMode);
    }
    return input;
  };

  test("is a number field, or a field whose inputmode asks for digits", () => {
    assert.equal(isNumericField(field("number")), true);
    assert.equal(isNumericField(field("text", "numeric")), true);
    assert.equal(isNumericField(field("text", "decimal")), true);
    assert.equal(isNumericField(field("password", "numeric")), true, "a PIN");
  });

  test("is not anything else", () => {
    assert.equal(isNumericField(field("text")), false);
    assert.equal(isNumericField(field("email")), false);
    assert.equal(isNumericField(field("text", "text")), false);
    assert.equal(isNumericField(null), false);
  });
});

describe("a keyboard that follows its field", () => {
  /**
   * A board typing into whichever of two fields `current` names.
   *
   * @param {Partial<import("./keyboard.js").KeyboardProps>} [props]
   */
  function following(props = {}) {
    const text = document.createElement("input");
    text.type = "text";
    const number = document.createElement("input");
    number.type = "number";
    const current = Signal.of(/** @type {HTMLInputElement | null} */ (text));
    /** @type {KeyPress[]} */
    const pressed = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const subscription = just(host, [
      children(
        keyboard({
          classes,
          onKey: (press) => pressed.push(press),
          field: () => current.get(),
          ...props,
        }),
      ),
    ]).subscribe();
    const root = () => /** @type {HTMLElement} */ (host.firstElementChild);
    return {
      text,
      number,
      current,
      pressed,
      root,
      /** The codes on the board, in document order. */
      codes: () =>
        Array.from(root().querySelectorAll("[data-code]")).map((key) =>
          key.getAttribute("data-code"),
        ),
      cleanup: () => {
        subscription.unsubscribe();
        host.remove();
      },
    };
  }

  /** @param {KeyboardLayout} layout */
  const codesOf = (layout) =>
    layout
      .flat()
      .filter((entry) => !entry.spacer)
      .map((entry) => entry.code);

  test("shows the letters for a text field and the pad for a number field", () => {
    const board = following();
    assert.deepEqual(board.codes(), codesOf(MOBILE_LAYOUT));

    board.current.set(board.number);
    assert.deepEqual(board.codes(), codesOf(NUMERIC_LAYOUT), "the pad, and nothing else");
    tap(board.root(), "Digit7");
    tap(board.root(), "Period");
    assert.deepEqual(
      board.pressed.map(({ key }) => key),
      ["7", "."],
    );

    board.current.set(board.text);
    assert.deepEqual(board.codes(), codesOf(MOBILE_LAYOUT), "and back");
    board.cleanup();
  });

  test("builds the board again only when the layout changes", () => {
    const board = following();
    const letters = board.root();
    const other = document.createElement("input");
    board.current.set(other);
    assert.equal(board.root(), letters, "one text field to another is the same board");
    board.current.set(null);
    assert.equal(board.root(), letters, "and so is no field at all");
    board.current.set(board.number);
    assert.notEqual(board.root(), letters);
    board.cleanup();
  });

  test("lets go of what was held on the board it leaves", () => {
    const board = following();
    tap(board.root(), "Symbols");
    tap(board.root(), "ShiftLeft");
    board.current.set(board.number);
    board.current.set(board.text);
    assert.equal(keyEl(board.root(), "KeyQ").textContent, "q", "letters, unshifted");
    board.cleanup();
  });

  test("takes a numeric layout of its own", () => {
    /** @type {KeyboardLayout} */
    const pad = [[{ code: "Digit1", label: "1", key: "1" }]];
    const board = following({ numericLayout: pad });
    board.current.set(board.number);
    assert.deepEqual(board.codes(), ["Digit1"]);
    board.cleanup();
  });

  test("is the one layout it was given, whatever the field", () => {
    const board = following({ layout: MOBILE_LAYOUT });
    board.current.set(board.number);
    assert.deepEqual(board.codes(), codesOf(MOBILE_LAYOUT));
    board.cleanup();
  });
});

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

    // A ray pressing a key is a `selectstart` sent from the mesh up through
    // the panel, which the portal turns back into a `pointerdown` on the
    // element it was mirrored from, and the board types at that. Pressing
    // all of them in turn is the whole board being usable in a headset,
    // which is the only claim here that a flat-page test cannot make. The
    // toggle among them flips the view mid-walk and the modifiers flip their
    // state — the codes still come back one per typing key, which is the
    // point: the position reports itself whatever face it is wearing. The
    // release and the click after it type nothing more.
    const controller = new THREE.Group();
    for (const target of added.slice(1)) {
      /** @type {any} */
      const start = { type: "selectstart", controller, originalTarget: target };
      for (const event of [
        start,
        { type: "selectend", controller, originalTarget: target, start },
        { type: "select", controller, originalTarget: target, completedOn: target, start },
      ]) {
        manager.dispatch(/** @type {any} */ (target), /** @type {any} */ (event));
      }
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
