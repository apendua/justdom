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
  /** Where a key goes when no text field on the page has focus. */
  onKey: (key: string) => void;
}

/**
 * Fill `[data-keys]` with keycaps, and type with them.
 *
 * A key is pressed by a click, which is what a ray's trigger is in a
 * session, or by the same key on a real keyboard. Either way it goes down
 * for a moment (`data-down`, a `transform` in the stylesheet) and types into
 * the text field that has focus, if one does, and into `onKey` otherwise.
 * Only the page has focus to give: in a session a field is typed into with
 * the keyboard freedom opens for it, and every key here goes to `onKey`.
 */
export function mountKeyboard(keys: HTMLElement, { onKey }: KeyboardOptions) {
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
    const field = focusedField();
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
    pressDown(event.key);
    if (focusedField()) {
      return; // the browser types into it
    }
    // A control with focus, the Look menu say, would act on the key as well:
    // a select takes a letter as type-ahead and changes its choice.
    if (OWNED_KEYS.has(event.key) || controlFocused()) {
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
