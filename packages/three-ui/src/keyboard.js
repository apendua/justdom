import { $, attr, children, on, renderText, set, style, text } from "@apendua/justdom";
import { Derived, flatMap, observable, Signal } from "@apendua/signal";

/**
 * @import {EntityEffect} from "@apendua/signal";
 * @import {Mountable} from "@apendua/justdom";
 */

/**
 * The base class alone, or the base plus a modifier, following a signal — the
 * same trick `dropdown` uses on its selected row, and for the same reason: a
 * state change has to come out as a class attribute rather than a rebuilt
 * subtree, because a portal re-measures on a tree change and only restyles on
 * an attribute one.
 *
 * @param {import("@apendua/signal").Subscribable<string>} base
 * @param {import("@apendua/signal").Subscribable<string>} modifier
 * @param {() => boolean} active
 * @returns {import("@apendua/signal").Source<string>}
 */
const withModifier = (base, modifier, active) =>
  flatMap((/** @type {boolean} */ isActive) => (isActive ? renderText`${base} ${modifier}` : base))(
    observable(active),
  );

/**
 * The modifiers this keyboard can hold down.
 *
 * `symbols` is the one a hardware board does not have: it is the phone
 * keyboard's `?123`, engaging the alternate faces of every key that carries
 * them. `fn` is not a `KeyboardEvent` property — no browser reports it — but
 * a custom layout may have the key, and a widget claiming that layout is
 * better off saying what was pressed than pretending the key is not there.
 *
 * @typedef {"shift" | "caps" | "ctrl" | "alt" | "meta" | "fn" | "symbols"} KeyboardModifier
 */

/**
 * One face of a key: what it shows and what it types. A key's base fields are
 * its letters-view face; `symbols` on the key is this shape again, for the
 * face it turns when the symbols view is engaged.
 *
 * @typedef {object} KeyboardKeyFace
 * @property {string} label What is printed on it, unshifted.
 * @property {string} [shiftLabel] What is printed on it with shift down.
 * @property {string} [key] What it types, as `KeyboardEvent.key` names it.
 * @property {string} [shiftKey] What it types with shift down. Defaults to
 *   `key`.
 * @property {string} [name] Read out to assistive technology when the label
 *   is a glyph or blank.
 */

/**
 * One key of the layout. The fields mirror `KeyboardEvent`, so that a press
 * can be handed to code that was written for the real thing.
 *
 * @typedef {object} KeyboardKey
 * @property {string} code The physical key, as `KeyboardEvent.code` names it:
 *   `"KeyA"`, `"Space"`, `"ShiftLeft"`. Unique within a layout, which is what
 *   makes it the handle callers and tests reach for. It names the position
 *   rather than the face: a key showing its symbols face still reports the
 *   code it was built with, exactly as a hardware key reports where it is and
 *   not what the layout painted on it.
 * @property {string} label What is printed on it, unshifted. Empty for the
 *   space bar, which on a real keyboard is blank too.
 * @property {string} [shiftLabel] What is printed on it with shift down.
 *   Absent means the key looks the same either way.
 * @property {string} [key] What it types, as `KeyboardEvent.key` names it:
 *   `"a"`, `"1"`, `"Enter"`. Absent on modifiers, which type nothing.
 * @property {string} [shiftKey] What it types with shift down. Defaults to
 *   `key`.
 * @property {boolean} [cased] Whether caps lock applies — true for letters,
 *   false for everything else, which is the whole of what caps lock means.
 * @property {KeyboardKeyFace} [symbols] The key's face while the symbols view
 *   is engaged. Absent means the key looks and types the same in both views —
 *   space, enter, backspace.
 * @property {KeyboardModifier} [modifier] Which modifier this key holds, if it
 *   is one.
 * @property {string} [name] Read out to assistive technology, and to anyone
 *   reading the DOM, when the printed label is a glyph or blank.
 * @property {boolean} [spacer] Not a key at all: empty space holding its
 *   `width` in the row, the way a phone board centres its middle row. Renders
 *   with no class, no role and no click, so it is not a ray target either.
 * @property {number} [width] How wide, in key units — 1 is a letter key, and
 *   every row of the default layout adds up to 10. Defaults to 1.
 */

/**
 * A key press, shaped like the `KeyboardEvent` it stands in for.
 *
 * @typedef {object} KeyPress
 * @property {string} key What the key types: `"a"`, `"A"`, `"!"`, `"Enter"`,
 *   `" "`.
 * @property {string} code The physical key, `"KeyA"` and such.
 * @property {boolean} shiftKey
 * @property {boolean} ctrlKey
 * @property {boolean} altKey
 * @property {boolean} metaKey
 * @property {boolean} capsLock Whether caps lock was on. `KeyboardEvent`
 *   reports this through `getModifierState`, which a plain object cannot have.
 * @property {boolean} fnKey Whether a layout's `fn` key was held.
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
 * @property {import("@apendua/signal").Subscribable<string>} root The whole board.
 * @property {import("@apendua/signal").Subscribable<string>} row One row of keys.
 * @property {import("@apendua/signal").Subscribable<string>} key One key. Needs `cursor: pointer` to be a
 *   ray target in a scene, the same as any other control projected into one.
 * @property {import("@apendua/signal").Subscribable<string>} [keyActive] Added to a modifier key while it
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
 * @property {KeyboardLayout} [layout] The one layout the board always shows.
 *   Defaults to {@link MOBILE_LAYOUT}, or, with `field`, to whichever of
 *   `MOBILE_LAYOUT` and `numericLayout` the field asks for.
 * @property {() => HTMLInputElement | null} [field] The field being typed
 *   into, read reactively — `field` on the target `@apendua/freedom` hands a
 *   board's factory is exactly this. A board given one follows it the way a
 *   phone's keyboard follows the field it pops up for: a number field gets
 *   the number pad, and nothing else. See {@link isNumericField}. Ignored
 *   when `layout` is given, which is a board that asked for one layout by
 *   name.
 * @property {KeyboardLayout} [numericLayout] What a numeric field gets.
 *   Defaults to {@link NUMERIC_LAYOUT}.
 */

/** @type {Record<KeyboardModifier, boolean>} */
const NO_MODIFIERS = {
  shift: false,
  caps: false,
  ctrl: false,
  alt: false,
  meta: false,
  fn: false,
  symbols: false,
};

/**
 * The modifiers that stay engaged until they are clicked off, where every
 * other one lets go after the key it modified. A lock that let go by itself
 * would not be one, and a symbols view that snapped back after one character
 * would have the player re-engaging it for every digit of a number.
 *
 * @type {ReadonlySet<KeyboardModifier>}
 */
const STICKY = new Set(/** @type {KeyboardModifier[]} */ (["caps", "symbols"]));

/**
 * A symbols-view face. `upper` is what shift turns it into, for the faces
 * that pair the way an engraved keyboard pairs them.
 *
 * @param {string} lower
 * @param {string} [upper]
 * @returns {KeyboardKeyFace}
 */
const sym = (lower, upper) => ({
  label: lower,
  key: lower,
  ...(upper === undefined ? {} : { shiftLabel: upper, shiftKey: upper }),
});

/**
 * A letter, carrying its symbols-view face. The label follows the case that
 * would be typed, the way a phone's keyboard does rather than the way an
 * engraved one does: on a board you click at, the case you are about to get
 * is worth more than the case the key was manufactured with.
 *
 * @param {string} lower
 * @param {KeyboardKeyFace} symbols
 * @returns {KeyboardKey}
 */
const letter = (lower, symbols) => ({
  code: `Key${lower.toUpperCase()}`,
  label: lower,
  shiftLabel: lower.toUpperCase(),
  key: lower,
  shiftKey: lower.toUpperCase(),
  cased: true,
  symbols,
});

/**
 * Everything that does not type a character of its own: the wide keys down the
 * edges and the modifiers.
 *
 * @param {string} code
 * @param {string} label
 * @param {Omit<KeyboardKey, "code" | "label">} [rest]
 * @returns {KeyboardKey}
 */
const special = (code, label, rest) => ({ code, label, ...rest });

/**
 * @param {string} code
 * @param {number} width
 * @returns {KeyboardKey}
 */
const spacer = (code, width) => ({ code, label: "", spacer: true, width });

/**
 * The layout of a phone's keyboard, which is the right one for a board you
 * point at: four rows, no function row, no arrows, no chording modifiers —
 * every key either types or changes what the board types next. What a laptop
 * spreads over six rows of engraved pairs, this folds into two views: letters
 * under the fingers, and behind the `?123` key a symbols view where the same
 * positions turn digits and punctuation — with shift flipping each view's
 * faces, so the full character set is never more than two clicks away.
 *
 * The two views are the same keys wearing different faces, not two boards:
 * switching moves labels and nothing else, which on a panel is a restyle
 * rather than the re-measure a swapped subtree would cost.
 *
 * Every row adds up to 10 units — the middle row's nine letters are centred
 * by half-unit spacers, the way a phone centres them.
 *
 * @type {KeyboardLayout}
 */
export const MOBILE_LAYOUT = [
  [
    letter("q", sym("1", "!")),
    letter("w", sym("2", "@")),
    letter("e", sym("3", "#")),
    letter("r", sym("4", "$")),
    letter("t", sym("5", "%")),
    letter("y", sym("6", "^")),
    letter("u", sym("7", "&")),
    letter("i", sym("8", "*")),
    letter("o", sym("9", "(")),
    letter("p", sym("0", ")")),
  ],
  [
    spacer("SpacerLeft", 0.5),
    letter("a", sym("-", "_")),
    letter("s", sym("=", "+")),
    letter("d", sym("[", "{")),
    letter("f", sym("]", "}")),
    letter("g", sym("\\", "|")),
    letter("h", sym(";", ":")),
    letter("j", sym("'", '"')),
    letter("k", sym("`", "~")),
    letter("l", sym("/", "?")),
    spacer("SpacerRight", 0.5),
  ],
  [
    special("ShiftLeft", "⇧", { modifier: "shift", name: "Shift", width: 1.5 }),
    letter("z", sym(",", "<")),
    letter("x", sym(".", ">")),
    letter("c", sym("?")),
    letter("v", sym("!")),
    letter("b", sym("'")),
    letter("n", sym('"')),
    letter("m", sym("@")),
    special("Backspace", "⌫", { key: "Backspace", name: "Backspace", width: 1.5 }),
  ],
  [
    special("Symbols", "?123", {
      modifier: "symbols",
      name: "Symbols",
      width: 1.5,
      symbols: { label: "ABC", name: "Letters" },
    }),
    special("Escape", "esc", { key: "Escape", name: "Escape" }),
    special("Space", "", { key: " ", name: "Space", width: 5 }),
    special("Period", ".", { key: "." }),
    special("Enter", "enter", { key: "Enter", name: "Enter", width: 1.5 }),
  ],
];

/**
 * @param {string} value
 * @returns {KeyboardKey}
 */
const digit = (value) => ({ code: `Digit${value}`, label: value, key: value });

/**
 * The layout a number field gets: a phone's number pad, four keys across.
 * Nothing on it types anything a number field would refuse, and everything a
 * number is written with — digits, a sign, a decimal point — is one click
 * away, with no view to switch and no shift to hold. `esc` and `enter` are
 * where they are on the letters board, bottom left and bottom right, so the
 * hand that knows one board knows this one.
 *
 * Every row adds up to 4 units, the zero spanning two of them the way it
 * does on a pad.
 *
 * @type {KeyboardLayout}
 */
export const NUMERIC_LAYOUT = [
  [digit("1"), digit("2"), digit("3"), special("Minus", "-", { key: "-", name: "Minus" })],
  [
    digit("4"),
    digit("5"),
    digit("6"),
    special("Backspace", "⌫", { key: "Backspace", name: "Backspace" }),
  ],
  [digit("7"), digit("8"), digit("9"), special("Period", ".", { key: ".", name: "Decimal point" })],
  [
    special("Escape", "esc", { key: "Escape", name: "Escape" }),
    { ...digit("0"), width: 2 },
    special("Enter", "enter", { key: "Enter", name: "Enter" }),
  ],
];

/**
 * The `inputmode` values that ask for a number pad rather than a board of
 * letters, as they do of a phone.
 *
 * @type {ReadonlySet<string>}
 */
const NUMERIC_INPUT_MODES = new Set(["numeric", "decimal"]);

/**
 * Whether a field is one a number pad is the board for: an
 * `<input type="number">`, or any field whose `inputmode` says `numeric` or
 * `decimal` — which is how a page asks a phone for the pad on a field that
 * holds digits but is not a number, a PIN or a code.
 *
 * By attribute rather than `instanceof`, because the field may be from
 * another document than the one this code's globals belong to.
 *
 * @param {HTMLInputElement | null | undefined} field
 * @returns {boolean}
 */
export function isNumericField(field) {
  if (!field) {
    return false;
  }
  if (field.type === "number") {
    return true;
  }
  const mode = field.getAttribute("inputmode");
  return mode !== null && NUMERIC_INPUT_MODES.has(mode.trim().toLowerCase());
}

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
 * box in the panel, and a changed class or label costs a restyle. It holds for
 * the symbols view exactly as it holds for shift: flipping the whole board to
 * digits is the same keys wearing different faces, not a different board.
 *
 * Shift, ctrl, alt, meta and fn are one-shot: engaged by a click, reported on
 * the next key that types, and released. Nobody chords on a board they have to
 * point at. Caps lock and the symbols view are the exceptions — sticky until
 * clicked off — because a lock that let go by itself would not be one, and a
 * symbols view that snapped back after one character would be re-engaged for
 * every digit of a number.
 *
 * Given the `field` it types into, the board also follows what kind of field
 * that is: a number field gets `NUMERIC_LAYOUT` and a text field the letters,
 * as on a phone. That one change is a different board rather than new faces
 * — the pad and the letters have nothing in common to re-label — so it is
 * the one time the tree is built again, and it happens only as the typing
 * moves between a number field and a text one, never while typing.
 *
 * @param {KeyboardProps} props
 * @returns {import("@apendua/signal").Source<Mountable>}
 */
export function keyboard(props) {
  const { onKey, classes, layout, field, numericLayout = NUMERIC_LAYOUT } = props;

  /** @type {Record<KeyboardModifier, Signal<boolean>>} */
  const held = {
    shift: Signal.of(false),
    caps: Signal.of(false),
    ctrl: Signal.of(false),
    alt: Signal.of(false),
    meta: Signal.of(false),
    fn: Signal.of(false),
    symbols: Signal.of(false),
  };

  /**
   * The face the key is currently wearing: its symbols face while the view is
   * engaged and the key has one, its base fields otherwise.
   *
   * @param {KeyboardKey} entry
   * @returns {KeyboardKeyFace}
   */
  const faceOf = (entry) => (held.symbols.get() && entry.symbols ? entry.symbols : entry);

  /**
   * Whether the key would type its shifted face. Caps lock only reaches
   * letters, and it flips with shift rather than winning over it: shift on a
   * locked board types lowercase, on every keyboard ever made. A symbols face
   * is never cased — caps lock has nothing to say about a digit — so there
   * shift alone decides.
   *
   * @param {KeyboardKey} entry
   * @returns {boolean}
   */
  const isShifted = (entry) => {
    if (held.symbols.get() && entry.symbols) {
      return held.shift.get();
    }
    return entry.cased ? held.shift.get() !== held.caps.get() : held.shift.get();
  };

  /**
   * @param {KeyboardKey} entry
   * @returns {string}
   */
  const labelOf = (entry) => {
    const face = faceOf(entry);
    return isShifted(entry) ? (face.shiftLabel ?? face.label) : face.label;
  };

  /**
   * @param {KeyboardKey} entry
   * @returns {string | undefined}
   */
  const keyOf = (entry) => {
    const face = faceOf(entry);
    return isShifted(entry) ? (face.shiftKey ?? face.key) : face.key;
  };

  /**
   * @param {KeyboardKey} entry
   * @returns {string}
   */
  const nameOf = (entry) => faceOf(entry).name ?? entry.name ?? labelOf(entry);

  /** @param {KeyboardKey} entry */
  const press = (entry) => {
    if (entry.modifier) {
      const signal = held[entry.modifier];
      signal.set(!signal.get());
      return;
    }
    const key = keyOf(entry);
    if (key === undefined) {
      return;
    }
    onKey({
      key,
      code: entry.code,
      shiftKey: held.shift.get(),
      ctrlKey: held.ctrl.get(),
      altKey: held.alt.get(),
      metaKey: held.meta.get(),
      capsLock: held.caps.get(),
      fnKey: held.fn.get(),
    });
    // Released after the key they modified, and only those: the sticky ones
    // hold until they are clicked off.
    for (const name of /** @type {KeyboardModifier[]} */ (Object.keys(NO_MODIFIERS))) {
      if (!STICKY.has(name)) {
        held[name].set(false);
      }
    }
  };

  /**
   * @param {KeyboardKey} entry
   * @returns {import("@apendua/signal").Source<Mountable>}
   */
  const key = (entry) => {
    // Zero basis and a share of the row proportional to the key's width: the
    // one number that has to come from in here, because it is the layout the
    // caller asked for by name.
    /** @type {EntityEffect<HTMLDivElement>} */
    const flex = style({ flexGrow: `${entry.width ?? 1}`, flexBasis: "0" });
    if (entry.spacer) {
      // Space, not a key: undressed, unnamed, unclickable — and therefore not
      // a ray target, since it is the `cursor` a class supplies that makes
      // one.
      return $("div", [flex]);
    }
    const { modifier } = entry;
    /** @type {EntityEffect<HTMLDivElement>[]} */
    const operators = [
      set(
        "className",
        modifier && classes.keyActive
          ? withModifier(classes.key, classes.keyActive, () => held[modifier].get())
          : classes.key,
      ),
      flex,
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
   * @returns {import("@apendua/signal").Source<Mountable>}
   */
  const row = (keys) =>
    $("div", [
      set("className", classes.row),
      style({ display: "flex", flexDirection: "row" }),
      attr("role", () => "row"),
      children(...keys.map(key)),
    ]);

  /**
   * @param {KeyboardLayout} rows
   * @returns {import("@apendua/signal").Source<Mountable>}
   */
  const board = (rows) =>
    $("div", [
      set("className", classes.root),
      style({ display: "flex", flexDirection: "column" }),
      attr("role", () => "group"),
      attr("aria-label", () => "Keyboard"),
      children(...rows.map(row)),
    ]);

  if (layout || !field) {
    return board(layout ?? MOBILE_LAYOUT);
  }

  // A `Derived` for its equality cutoff: the typing moving from one text
  // field to another lands on the layout it already had, and tells nobody.
  const chosen = new Derived(() => (isNumericField(field()) ? numericLayout : MOBILE_LAYOUT));
  return flatMap((/** @type {KeyboardLayout} */ rows) => {
    // A new board starts clean: a shift or a symbols view held on the old
    // one has no key to be released by on this one.
    for (const signal of Object.values(held)) {
      signal.set(false);
    }
    return board(rows);
  })(observable(() => chosen.get()));
}

export default keyboard;
