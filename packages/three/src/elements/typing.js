/**
 * Typing into a real `<input>` from a keyboard that is made of boxes.
 *
 * A key on a projected keyboard is a click on a `<div>`; nothing about it
 * reaches the field it was meant for. This is the part in between: given
 * the field and a press shaped like a `KeyboardEvent`, it does to the field
 * what the real key would have done — the character goes in at the caret,
 * backspace takes one out, enter submits the form the field is in — and it
 * dispatches the events the field's handlers are written for, in the order
 * a browser dispatches them, so an app that listens for `input` or for
 * `keydown` of `Enter` on a page hears exactly the same thing in a scene.
 */

/**
 * A key press, as a keyboard reports it and as `typeIntoInput` reads it —
 * the `KeyboardEvent` fields that decide what is typed. `key` is the one
 * that matters: a single character types itself, and the named keys
 * (`"Backspace"`, `"Enter"`, `"Escape"`, …) do what their names say.
 * Everything else is carried onto the events dispatched, so a handler that
 * asks whether shift was down gets an answer.
 *
 * @typedef {object} KeyPress
 * @property {string} key
 * @property {string} [code]
 * @property {boolean} [shiftKey]
 * @property {boolean} [ctrlKey]
 * @property {boolean} [altKey]
 * @property {boolean} [metaKey]
 */

/**
 * The input types that hold a line of text a keyboard can type into and a
 * scene can draw. Everything else an `<input>` can be is a control with
 * chrome of its own — a checkbox, a slider, a file picker — or hidden.
 *
 * @type {ReadonlySet<string>}
 */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/**
 * Whether the element is an `<input>` holding a line of text.
 *
 * By tag and type rather than `instanceof`, because the element may come
 * from another document than the one this code's globals belong to — a
 * test runner's, an iframe's — and its `type` property already normalizes
 * an unknown or missing attribute to `text`, which is what the browser
 * draws it as.
 *
 * @param {Node} node
 * @returns {node is HTMLInputElement}
 */
export function isTextInput(node) {
  if (node.nodeType !== 1 || /** @type {Element} */ (node).tagName !== "INPUT") {
    return false;
  }
  return TEXT_INPUT_TYPES.has(/** @type {HTMLInputElement} */ (node).type);
}

/**
 * The types whose selection a script may read and write. `number` and the
 * others outside this set throw on `setSelectionRange`, so on those the
 * caret is always the end of the value.
 *
 * @type {ReadonlySet<string>}
 */
const SELECTABLE_TYPES = new Set(["text", "search", "url", "tel", "password"]);

/**
 * The input types that block implicit submission besides the text fields:
 * the ones the HTML standard lists and `isTextInput` does not cover.
 *
 * @type {ReadonlySet<string>}
 */
const BLOCKING_TYPES = new Set(["date", "datetime-local", "month", "time", "week"]);

/**
 * Where the caret is, as the character offset after it. The end of the
 * value for a field whose selection cannot be read, and for one whose
 * selection has never been placed, which reports the end anyway once its
 * value has been set from script — the only way a value gets into a field
 * nobody has typed into.
 *
 * @param {HTMLInputElement} input
 * @returns {number}
 */
export function getCaretOffset(input) {
  if (SELECTABLE_TYPES.has(input.type)) {
    const end = input.selectionEnd;
    if (typeof end === "number") {
      return end;
    }
  }
  return input.value.length;
}

/**
 * Put the caret at the end of the value, as tapping a field on a phone
 * does. A no-op for a field whose selection cannot be written.
 *
 * @param {HTMLInputElement} input
 * @returns {void}
 */
export function moveCaretToEnd(input) {
  if (!SELECTABLE_TYPES.has(input.type)) {
    return;
  }
  const end = input.value.length;
  try {
    input.setSelectionRange(end, end);
  } catch {
    // A type the browser will not place a caret in after all.
  }
}

/**
 * The window the element belongs to, whose event constructors are the ones
 * its listeners expect. Not the global: under a test runner the element's
 * document is a jsdom window's and the globals may be nobody's.
 *
 * @param {Node} node
 * @returns {Window & typeof globalThis}
 */
function viewOf(node) {
  return /** @type {Window & typeof globalThis} */ (node.ownerDocument?.defaultView ?? window);
}

/**
 * Replace the selection — or, where the selection cannot be read, the end
 * of the value — with `text`, leaving the caret after it, and say so, as a
 * browser does: `beforeinput` first, which a page may cancel to refuse the
 * edit, then the edit, then `input`.
 *
 * A field the browser sanitizes — `number`, whose value is emptied rather
 * than set to something that is not a number — refuses an edit it would
 * have sanitized away: the old value stays and nothing says it changed,
 * which is what a page's own key does with a letter typed into a number
 * field.
 *
 * @param {HTMLInputElement} input
 * @param {string} text What goes in; empty to only take the selection out.
 * @param {number} start
 * @param {number} end
 * @param {string} inputType What the events say happened.
 * @returns {void}
 */
function replaceRange(input, text, start, end, inputType) {
  const view = viewOf(input);
  const Constructor = view.InputEvent ?? view.Event;
  const data = text || null;
  const proceed = input.dispatchEvent(
    new Constructor("beforeinput", { bubbles: true, cancelable: true, inputType, data }),
  );
  if (!proceed) {
    return;
  }
  const before = input.value;
  const candidate = before.slice(0, start) + text + before.slice(end);
  if (SELECTABLE_TYPES.has(input.type)) {
    try {
      input.setRangeText(text, start, end, "end");
    } catch {
      input.value = candidate;
    }
  } else {
    input.value = candidate;
    if (input.value === "" && candidate !== "") {
      // Sanitized away: not a value this field can hold. Put the old one
      // back, and say nothing, since nothing changed.
      input.value = before;
      return;
    }
  }
  input.dispatchEvent(new Constructor("input", { bubbles: true, inputType, data }));
}

/**
 * Whether Enter in this field submits its form, by the rule browsers apply:
 * a form with a submit button is submitted by it, and a form without one
 * only when this is the one field in it that would block implicit
 * submission — otherwise a two-field login form with no button, submitted
 * by a script of its own, would be submitted by a keyboard's Enter where
 * the page's own Enter does nothing.
 *
 * @param {HTMLFormElement} form
 * @returns {boolean}
 */
function submitsImplicitly(form) {
  if (
    form.querySelector(
      "button:not([type]), button[type=submit], input[type=submit], input[type=image]",
    )
  ) {
    return true;
  }
  let blocking = 0;
  for (const element of Array.from(form.elements)) {
    if (
      isTextInput(element) ||
      (element.nodeType === 1 &&
        /** @type {Element} */ (element).tagName === "INPUT" &&
        BLOCKING_TYPES.has(/** @type {HTMLInputElement} */ (element).type))
    ) {
      blocking += 1;
    }
  }
  return blocking === 1;
}

/**
 * The selection to edit: what is selected, or the caret with nothing
 * selected — read where it can be, the end of the value where it cannot.
 *
 * @param {HTMLInputElement} input
 * @returns {[number, number]}
 */
function selectionOf(input) {
  if (SELECTABLE_TYPES.has(input.type)) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (typeof start === "number" && typeof end === "number") {
      return [start, end];
    }
  }
  const end = input.value.length;
  return [end, end];
}

/**
 * Do to the field what the key would have done, and dispatch what a
 * browser would have dispatched: `keydown`, then `beforeinput`, the edit
 * and its `input` event, then `keyup`. A `keydown` listener that calls `preventDefault`
 * stops the edit, as it does on a page.
 *
 * What the named keys do: `Backspace` and `Delete` take out the selection,
 * or one character behind or ahead of the caret; `Enter` asks the field's
 * form to submit, if it is in one, which is a browser's implicit
 * submission; `Escape`, `Tab` and the rest edit nothing and only dispatch.
 * Whether a keyboard should close on `Enter` or `Escape` is not decided
 * here — the portal's keyboard does — because a search box that filters as
 * you type wants `Enter` to mean nothing at all.
 *
 * @param {HTMLInputElement} input
 * @param {KeyPress} press
 * @returns {void}
 */
export function typeIntoInput(input, press) {
  const view = viewOf(input);
  const init = {
    key: press.key,
    code: press.code ?? "",
    shiftKey: press.shiftKey ?? false,
    ctrlKey: press.ctrlKey ?? false,
    altKey: press.altKey ?? false,
    metaKey: press.metaKey ?? false,
    bubbles: true,
    cancelable: true,
  };
  const proceed = input.dispatchEvent(new view.KeyboardEvent("keydown", init));
  // A chord with ctrl or meta is a shortcut, not a character: the keydown
  // says so to whoever handles shortcuts, and nothing is typed, as on a
  // page. Alt is left to type, since on a real layout it is also how some
  // characters are reached.
  const chord = init.ctrlKey || init.metaKey;
  if (proceed && !chord && !input.disabled && !input.readOnly) {
    const [start, end] = selectionOf(input);
    if (press.key.length === 1) {
      replaceRange(input, press.key, start, end, "insertText");
    } else if (press.key === "Backspace") {
      if (start !== end) {
        replaceRange(input, "", start, end, "deleteContentBackward");
      } else if (start > 0) {
        replaceRange(input, "", start - 1, start, "deleteContentBackward");
      }
    } else if (press.key === "Delete") {
      if (start !== end) {
        replaceRange(input, "", start, end, "deleteContentForward");
      } else if (end < input.value.length) {
        replaceRange(input, "", end, end + 1, "deleteContentForward");
      }
    } else if (press.key === "Enter") {
      // Implicit submission: what a browser does with Enter in a text field
      // that nobody prevented, and only where there is a form to submit.
      // `requestSubmit` runs the validation and the `submit` event that a
      // press of the form's own button would.
      const form = input.form;
      if (form && typeof form.requestSubmit === "function" && submitsImplicitly(form)) {
        form.requestSubmit();
      }
    }
  }
  input.dispatchEvent(new view.KeyboardEvent("keyup", { ...init, cancelable: false }));
}
