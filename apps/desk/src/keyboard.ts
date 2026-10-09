import type { Readable } from "./session.js";

/**
 * A key as the rows below write it: the `KeyboardEvent.key` it stands for,
 * its legend, and the classes that size and colour it. A bare string is a
 * character key whose legend is the character in capitals.
 */
type KeySpec = string | [key: string, legend: string, classes: string];

const ROWS: KeySpec[][] = [
  ["`", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", ["Backspace", "⌫", "w2"]],
  [
    ["Tab", "TAB", "w15"],
    "q",
    "w",
    "e",
    "r",
    "t",
    "y",
    "u",
    "i",
    "o",
    "p",
    "[",
    "]",
    ["\\", "\\", "w15"],
  ],
  [
    ["CapsLock", "CAPS", "w18 mod"],
    "a",
    "s",
    "d",
    "f",
    "g",
    "h",
    "j",
    "k",
    "l",
    ";",
    "'",
    ["Enter", "RETURN", "w22 accent"],
  ],
  [
    ["Shift", "SHIFT", "w23 mod"],
    "z",
    "x",
    "c",
    "v",
    "b",
    "n",
    "m",
    ",",
    ".",
    "/",
    ["Shift", "SHIFT", "w27 mod"],
  ],
  [
    ["Control", "CTRL", "w15 mod"],
    ["Alt", "ALT", "w15 mod"],
    [" ", "", "space"],
    ["Alt", "ALT", "w15 mod"],
    ["Control", "CTRL", "w15 mod"],
  ],
];

/**
 * Keys that do something of their own on a page, and are the monitor's
 * instead: Space would scroll, Backspace go back, Tab move focus, and Enter
 * and Space would press whatever button has focus. That is the Enter AR
 * button once it has been clicked, so the first command typed after
 * entering a session would end it.
 */
const OWNED_KEYS = new Set([" ", "Backspace", "Tab", "Enter"]);

/** How long a key stays down after it is pressed, in ms. */
const PRESS_MS = 110;

export interface KeyboardOptions {
  /**
   * Where a key goes when no text field on the page has focus, unless a
   * script typed it into an element without focus, as a session's keyboard
   * does.
   */
  onKey: (key: string) => void;
  /**
   * Whether a session is showing the desk. The caps are the monitor's
   * there, even while a field has the page's focus: the field is typed
   * into with the keyboard freedom opens for it, or with a real keyboard.
   */
  presenting: Readable<boolean>;
}

/**
 * Fill `[data-keys]` with keycaps, and type with them.
 *
 * A key is pressed by a click, which is what a ray's trigger is in a
 * session, or by the same key on a real keyboard. Either way it goes down
 * for a moment (`data-down`, a `transform` in the stylesheet) and types into
 * the text field that has focus, if one does, and into `onKey` otherwise.
 * In a session a field is typed into with the keyboard freedom opens for
 * it, and every cap pressed here goes to `onKey`, even while the field has
 * the page's focus, as it does under `?realfocus`. What that keyboard types
 * is the field's alone, and does not press a cap here or reach `onKey`.
 */
export function mountKeyboard(keys: HTMLElement, { onKey, presenting }: KeyboardOptions) {
  for (const row of ROWS) {
    const line = document.createElement("div");
    line.className = "krow";
    for (const spec of row) {
      const [key, legend, classes] =
        typeof spec === "string" ? [spec, spec.toUpperCase(), ""] : spec;
      const cap = document.createElement("div");
      cap.className = `key ${classes}`.trim();
      cap.dataset.key = key;
      const label = document.createElement("span");
      label.className = "cap";
      label.textContent = legend;
      cap.append(label);
      line.append(cap);
    }
    keys.append(line);
  }

  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const pressDown = (key: string) => {
    for (const cap of keys.querySelectorAll<HTMLElement>(".key")) {
      if (cap.dataset.key?.toLowerCase() !== key.toLowerCase()) {
        continue;
      }
      cap.setAttribute("data-down", "");
      clearTimeout(timers.get(cap));
      timers.set(
        cap,
        setTimeout(() => cap.removeAttribute("data-down"), PRESS_MS),
      );
    }
  };

  const onClick = (event: MouseEvent) => {
    const cap = (event.target as Element).closest<HTMLElement>(".key");
    const key = cap?.dataset.key;
    if (!key) {
      return;
    }
    pressDown(key);
    const field = presenting.get() ? null : focusedField();
    if (field) {
      typeInto(field, key);
    } else {
      onKey(key);
    }
  };
  // A press on a key would take focus from the field it is typing into.
  const onMouseDown = (event: MouseEvent) => event.preventDefault();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey) {
      return;
    }
    if (focusedField()) {
      // The browser types into it. On the page these caps type into the
      // field too, so they go down with it; in a session they are the
      // monitor's and stay up.
      if (!presenting.get()) {
        pressDown(event.key);
      }
      return;
    }
    // A real key goes to what has focus. A keydown aimed at an element
    // without it was dispatched there by a script, and is that element's:
    // in a session, the board freedom opens for a field types into it so.
    // The caps are the monitor's, so they stay up, and cancelling the key
    // would keep it out of the field. The window and the document are not
    // elements, so a key aimed at either is still the monitor's.
    const target = event.target;
    if (target instanceof Element && target !== document.activeElement) {
      return;
    }
    pressDown(event.key);
    // A control with focus, the Look menu say, would act on a character as
    // well: a select takes it as type-ahead and changes its choice. Other
    // keys, F5 or the arrows, are left to the browser and the control.
    if (OWNED_KEYS.has(event.key) || (event.key.length === 1 && controlFocused())) {
      event.preventDefault();
    }
    onKey(event.key);
  };

  keys.addEventListener("click", onClick);
  keys.addEventListener("mousedown", onMouseDown);
  window.addEventListener("keydown", onKeyDown);
  return () => {
    keys.removeEventListener("click", onClick);
    keys.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("keydown", onKeyDown);
    timers.forEach((timer) => clearTimeout(timer));
    keys.replaceChildren();
  };
}

/** The input types a key types into: everything else, a checkbox say, is not a field. */
const TEXT_TYPES = new Set(["text", "search", "url", "tel", "email", "password"]);

/**
 * The text field that has focus, if one does. A checkbox takes focus when
 * it is clicked, as on the ship list, and must not swallow the keys meant
 * for the monitor.
 */
function focusedField(): HTMLInputElement | null {
  const active = document.activeElement;
  return active instanceof HTMLInputElement && TEXT_TYPES.has(active.type) ? active : null;
}

/** Whether something other than the page itself has focus: a select, a checkbox, a button. */
function controlFocused(): boolean {
  const active = document.activeElement;
  return active !== null && active !== document.body;
}

/** What a key does to a field, as the browser would have done it. */
export function typeInto(field: HTMLInputElement, key: string): void {
  if (key === "Enter") {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return;
  }
  if (key === "Backspace") {
    field.value = field.value.slice(0, -1);
  } else if (key.length === 1) {
    field.value += key;
  } else {
    return;
  }
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
