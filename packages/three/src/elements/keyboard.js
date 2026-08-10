import { distinctUntilChanged, switchMap } from "rxjs";
import { $, attr, children, on, renderText, set, style, text } from "@apendua/justdom";
import { observable, Signal } from "@apendua/signal";

/**
 * @import {MonoTypeOperatorFunction, Observable} from "rxjs";
 * @import {Mountable} from "@apendua/justdom";
 */

/**
 * The base class alone, or the base plus a modifier, following a signal — the
 * same trick `dropdown` uses on its selected row, and for the same reason: a
 * state change has to come out as a class attribute rather than a rebuilt
 * subtree, because a portal re-measures on a tree change and only restyles on
 * an attribute one.
 *
 * @param {Observable<string>} base
 * @param {Observable<string>} modifier
 * @param {() => boolean} active
 * @returns {Observable<string>}
 */
const withModifier = (base, modifier, active) =>
  observable(active).pipe(
    distinctUntilChanged(),
    switchMap((isActive) => (isActive ? renderText`${base} ${modifier}` : base)),
  );

/**
 * The modifiers this keyboard can hold down. `fn` is not a `KeyboardEvent`
 * property — no browser reports it — but a laptop has the key, and a widget
 * claiming that layout is better off saying what was pressed than pretending
 * the key is not there.
 *
 * @typedef {"shift" | "caps" | "ctrl" | "alt" | "meta" | "fn"} KeyboardModifier
 */

/**
 * One key of the layout. The fields mirror `KeyboardEvent`, so that a press
 * can be handed to code that was written for the real thing.
 *
 * @typedef {object} KeyboardKey
 * @property {string} code The physical key, as `KeyboardEvent.code` names it:
 *   `"KeyA"`, `"Digit1"`, `"ShiftLeft"`. Unique within a layout, which is what
 *   makes it the handle callers and tests reach for.
 * @property {string} label What is printed on it, unshifted. Empty for the
 *   space bar, which on a real keyboard is blank too.
 * @property {string} [shiftLabel] What is printed on it with shift down.
 *   Absent means the key looks the same either way.
 * @property {string} [key] What it types, as `KeyboardEvent.key` names it:
 *   `"a"`, `"1"`, `"Enter"`, `"ArrowLeft"`. Absent on modifiers, which type
 *   nothing.
 * @property {string} [shiftKey] What it types with shift down. Defaults to
 *   `key`.
 * @property {boolean} [cased] Whether caps lock applies — true for letters,
 *   false for everything else, which is the whole of what caps lock means.
 * @property {KeyboardModifier} [modifier] Which modifier this key holds, if it
 *   is one.
 * @property {string} [name] Read out to assistive technology, and to anyone
 *   reading the DOM, when the printed label is a glyph or blank.
 * @property {number} [width] How wide, in key units — 1 is a letter key, and
 *   every row of a standard layout adds up to 15. Defaults to 1.
 */

/**
 * A key press, shaped like the `KeyboardEvent` it stands in for.
 *
 * @typedef {object} KeyPress
 * @property {string} key What the key types: `"a"`, `"A"`, `"!"`, `"Enter"`,
 *   `"ArrowLeft"`, `" "`.
 * @property {string} code The physical key, `"KeyA"` and such.
 * @property {boolean} shiftKey
 * @property {boolean} ctrlKey
 * @property {boolean} altKey
 * @property {boolean} metaKey
 * @property {boolean} capsLock Whether caps lock was on. `KeyboardEvent`
 *   reports this through `getModifierState`, which a plain object cannot have.
 * @property {boolean} fnKey Whether the laptop `fn` key was held.
 */

/**
 * What the widget is dressed in — `stylesheet` class names, one per part, on
 * the same terms as the rest of this package: the structure is shared, the
 * looks are yours, because a keyboard on a panel has to look like that panel.
 *
 * Only two things are set from the inside, because they are the layout rather
 * than the dressing: the root and its rows are flex boxes, and every key is
 * given the `flex-grow` its width unit asks for. That is what makes a shift
 * key wider than a letter without the caller having to restate the layout in
 * CSS. Everything else — the gaps, the corners, the colours, the type — is
 * class names.
 *
 * @typedef {object} KeyboardClasses
 * @property {Observable<string>} root The whole board.
 * @property {Observable<string>} row One row of keys.
 * @property {Observable<string>} key One key. Needs `cursor: pointer` to be a
 *   ray target in a scene, the same as any other control projected into one.
 * @property {Observable<string>} [keyActive] Added to a modifier key while it
 *   is engaged. Omit and a held shift looks like a loose one.
 */

/**
 * @typedef {readonly (readonly KeyboardKey[])[]} KeyboardLayout
 */

/**
 * @typedef {object} KeyboardProps
 * @property {(press: KeyPress) => void} onKey Called for every key that types
 *   something. Modifiers are not reported through it — they arrive as flags on
 *   the press that follows.
 * @property {KeyboardClasses} classes
 * @property {KeyboardLayout} [layout] Defaults to {@link LAPTOP_LAYOUT}.
 */

/** @type {Record<KeyboardModifier, boolean>} */
const NO_MODIFIERS = {
  shift: false,
  caps: false,
  ctrl: false,
  alt: false,
  meta: false,
  fn: false,
};

/**
 * A letter. The label follows the case that would be typed, the way a phone's
 * keyboard does rather than the way an engraved one does: on a board you click
 * at, the case you are about to get is worth more than the case the key was
 * manufactured with.
 *
 * @param {string} lower
 * @returns {KeyboardKey}
 */
const letter = (lower) => ({
  code: `Key${lower.toUpperCase()}`,
  label: lower,
  shiftLabel: lower.toUpperCase(),
  key: lower,
  shiftKey: lower.toUpperCase(),
  cased: true,
});

/**
 * A key with two characters printed on it: digits and punctuation.
 *
 * @param {string} code
 * @param {string} lower
 * @param {string} upper
 * @param {number} [width]
 * @returns {KeyboardKey}
 */
const pair = (code, lower, upper, width) => ({
  code,
  label: lower,
  shiftLabel: upper,
  key: lower,
  shiftKey: upper,
  ...(width === undefined ? {} : { width }),
});

/**
 * Everything that does not type a character of its own: the wide keys down the
 * edges, the function row, the arrows, the modifiers.
 *
 * @param {string} code
 * @param {string} label
 * @param {Omit<KeyboardKey, "code" | "label">} [rest]
 * @returns {KeyboardKey}
 */
const special = (code, label, rest) => ({ code, label, ...rest });

/**
 * @param {number} n
 * @returns {KeyboardKey}
 */
const fnKey = (n) => special(`F${n}`, `F${n}`, { key: `F${n}` });

/**
 * The layout of an ordinary US laptop: a function row, no numeric pad, and the
 * arrows crammed into the bottom row where a full-size board would have a
 * cursor block.
 *
 * The widths are the standard ones — 1.5 for tab, 1.75 for caps, 2.25 for the
 * left shift — so every row adds up to the same 15 units and the rows line up
 * under each other without anything measuring anything.
 *
 * @type {KeyboardLayout}
 */
export const LAPTOP_LAYOUT = [
  [
    special("Escape", "esc", { key: "Escape", name: "Escape", width: 1.5 }),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(fnKey),
    special("Delete", "del", { key: "Delete", name: "Delete", width: 1.5 }),
  ],
  [
    pair("Backquote", "`", "~"),
    pair("Digit1", "1", "!"),
    pair("Digit2", "2", "@"),
    pair("Digit3", "3", "#"),
    pair("Digit4", "4", "$"),
    pair("Digit5", "5", "%"),
    pair("Digit6", "6", "^"),
    pair("Digit7", "7", "&"),
    pair("Digit8", "8", "*"),
    pair("Digit9", "9", "("),
    pair("Digit0", "0", ")"),
    pair("Minus", "-", "_"),
    pair("Equal", "=", "+"),
    special("Backspace", "⌫", { key: "Backspace", name: "Backspace", width: 2 }),
  ],
  [
    special("Tab", "tab", { key: "Tab", name: "Tab", width: 1.5 }),
    ...["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"].map(letter),
    pair("BracketLeft", "[", "{"),
    pair("BracketRight", "]", "}"),
    pair("Backslash", "\\", "|", 1.5),
  ],
  [
    special("CapsLock", "caps", { modifier: "caps", name: "Caps Lock", width: 1.75 }),
    ...["a", "s", "d", "f", "g", "h", "j", "k", "l"].map(letter),
    pair("Semicolon", ";", ":"),
    pair("Quote", "'", '"'),
    special("Enter", "enter", { key: "Enter", name: "Enter", width: 2.25 }),
  ],
  [
    special("ShiftLeft", "shift", { modifier: "shift", name: "Shift", width: 2.25 }),
    ...["z", "x", "c", "v", "b", "n", "m"].map(letter),
    pair("Comma", ",", "<"),
    pair("Period", ".", ">"),
    pair("Slash", "/", "?"),
    special("ShiftRight", "shift", { modifier: "shift", name: "Shift", width: 2.75 }),
  ],
  [
    special("ControlLeft", "ctrl", { modifier: "ctrl", name: "Control" }),
    special("Fn", "fn", { modifier: "fn", name: "Fn" }),
    special("MetaLeft", "meta", { modifier: "meta", name: "Meta" }),
    special("AltLeft", "alt", { modifier: "alt", name: "Alt" }),
    special("Space", "", { key: " ", name: "Space", width: 6 }),
    special("AltRight", "alt", { modifier: "alt", name: "Alt" }),
    special("ArrowLeft", "←", { key: "ArrowLeft", name: "Left arrow" }),
    special("ArrowUp", "↑", { key: "ArrowUp", name: "Up arrow" }),
    special("ArrowDown", "↓", { key: "ArrowDown", name: "Down arrow" }),
    special("ArrowRight", "→", { key: "ArrowRight", name: "Right arrow" }),
  ],
];

/**
 * A keyboard made of ordinary elements, clicked rather than typed on, so that
 * it works in a `dom(ctx, …)` portal as well as it does on a page.
 *
 * There is nothing to type into a scene with: a headset has no keys, and the
 * one the system offers is chrome — it belongs to the compositor, not to the
 * DOM, so none of it reaches the panel you put it on. Boxes and clicks do
 * reach it, and that is all this is.
 *
 * The tree is built once and never changes shape: a state change moves a class
 * name and the text inside a key, and nothing is mounted or unmounted. That is
 * deliberate for the 3D side, where a changed tree costs a re-measure of every
 * box in the panel — seventy-odd of them here — and a changed class costs a
 * restyle. Shift is the state that moves most, and it must not be the state
 * that rebuilds the board.
 *
 * Shift, ctrl, alt, meta and fn are one-shot: engaged by a click, reported on
 * the next key that types, and released. Nobody chords on a board they have to
 * point at. Caps lock is the exception, because a lock that let go by itself
 * would not be one.
 *
 * @param {KeyboardProps} props
 * @returns {Observable<Mountable<Node>>}
 */
export function keyboard(props) {
  const { onKey, classes, layout = LAPTOP_LAYOUT } = props;

  /** @type {Record<KeyboardModifier, Signal<boolean>>} */
  const held = {
    shift: Signal.of(false),
    caps: Signal.of(false),
    ctrl: Signal.of(false),
    alt: Signal.of(false),
    meta: Signal.of(false),
    fn: Signal.of(false),
  };

  /**
   * Whether the key would type its shifted face. Caps lock only reaches
   * letters, and it flips with shift rather than winning over it: shift on a
   * locked board types lowercase, on every keyboard ever made.
   *
   * @param {KeyboardKey} entry
   * @returns {boolean}
   */
  const isShifted = (entry) =>
    entry.cased ? held.shift.get() !== held.caps.get() : held.shift.get();

  /**
   * @param {KeyboardKey} entry
   * @returns {string}
   */
  const labelOf = (entry) => (isShifted(entry) ? (entry.shiftLabel ?? entry.label) : entry.label);

  /**
   * @param {KeyboardKey} entry
   * @returns {string}
   */
  const nameOf = (entry) => entry.name ?? labelOf(entry);

  /** @param {KeyboardKey} entry */
  const press = (entry) => {
    if (entry.modifier) {
      const signal = held[entry.modifier];
      signal.set(!signal.get());
      return;
    }
    if (entry.key === undefined) {
      return;
    }
    onKey({
      key: isShifted(entry) ? (entry.shiftKey ?? entry.key) : entry.key,
      code: entry.code,
      shiftKey: held.shift.get(),
      ctrlKey: held.ctrl.get(),
      altKey: held.alt.get(),
      metaKey: held.meta.get(),
      capsLock: held.caps.get(),
      fnKey: held.fn.get(),
    });
    // Released after the key they modified, and only those: a lock that let go
    // would not be a lock.
    for (const name of /** @type {KeyboardModifier[]} */ (Object.keys(NO_MODIFIERS))) {
      if (name !== "caps") {
        held[name].set(false);
      }
    }
  };

  /**
   * @param {KeyboardKey} entry
   * @returns {Observable<Mountable<Node>>}
   */
  const key = (entry) => {
    const { modifier } = entry;
    /** @type {MonoTypeOperatorFunction<HTMLDivElement>[]} */
    const operators = [
      set(
        "className",
        modifier && classes.keyActive
          ? withModifier(classes.key, classes.keyActive, () => held[modifier].get())
          : classes.key,
      ),
      // Zero basis and a share of the row proportional to the key's width: the
      // one number that has to come from in here, because it is the layout the
      // caller asked for by name.
      style({ flexGrow: `${entry.width ?? 1}`, flexBasis: "0" }),
      attr("role", () => "button"),
      attr("data-code", () => entry.code),
      attr("aria-label", () => nameOf(entry)),
      on("click", () => press(entry)),
      children(text`${() => labelOf(entry)}`),
    ];
    if (modifier) {
      operators.push(attr("aria-pressed", () => (held[modifier].get() ? "true" : "false")));
    }
    return $("div", operators);
  };

  /**
   * @param {readonly KeyboardKey[]} keys
   * @returns {Observable<Mountable<Node>>}
   */
  const row = (keys) =>
    $("div", [
      set("className", classes.row),
      style({ display: "flex", flexDirection: "row" }),
      attr("role", () => "row"),
      children(...keys.map(key)),
    ]);

  return $("div", [
    set("className", classes.root),
    style({ display: "flex", flexDirection: "column" }),
    attr("role", () => "group"),
    attr("aria-label", () => "Keyboard"),
    children(...layout.map(row)),
  ]);
}

export default keyboard;
