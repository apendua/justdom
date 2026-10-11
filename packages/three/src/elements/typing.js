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
 * caret is kept here instead (see `carets`).
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
 * The characters a number field lets through at all. A browser filters the
 * key before anything else happens to it — a letter typed into a number
 * field on a page does nothing — and so does this, which is what keeps a
 * stray letter from becoming a draft the field could never hold.
 */
const NUMBER_CHARACTERS = /^[0-9eE+\-.]$/;

/**
 * What a field that sanitizes its value shows while it is being typed into,
 * where that is not the value.
 *
 * A number field is typed a key at a time, and many of the strings on the
 * way to a number are not numbers themselves: `1.` on the way to `1.5`,
 * `-` on the way to `-3`, `1e` on the way to `1e3`. The browser sanitizes
 * each to `""` — so `value` reads `""` — while its own editor goes on
 * showing what was typed, and the next key goes after it. A script cannot
 * reach that editor, so this keeps its text instead: edits apply to the
 * draft, `value` is assigned from it, and the mirror draws the draft rather
 * than the value. `valueAtDraft` is what the field's value was when the
 * draft was written, which is how a draft the app has since overwritten —
 * `input.value = "4"` after a submit — is known to be stale.
 *
 * @type {WeakMap<HTMLInputElement, { text: string, valueAtDraft: string }>}
 */
const drafts = new WeakMap();

/**
 * What the field is showing: its draft, where one is still current, and its
 * value otherwise. For a field whose value is always what was typed — every
 * selectable type — the two are the same and there is never a draft.
 *
 * @param {HTMLInputElement} input
 * @returns {string}
 */
export function getShownValue(input) {
  const draft = drafts.get(input);
  if (!draft) {
    return input.value;
  }
  if (draft.valueAtDraft !== input.value) {
    // The value moved without the draft: somebody other than the keyboard
    // wrote it. What they wrote is what the field shows now.
    drafts.delete(input);
    return input.value;
  }
  return draft.text;
}

/**
 * Forget the field's draft, for a writer that sets the value to what it
 * already was — `""` over a draft of `-` — which `getShownValue` cannot tell
 * from nothing having happened. The mirror's `value` interception calls it.
 *
 * @param {HTMLInputElement} input
 * @returns {void}
 */
export function discardDraft(input) {
  drafts.delete(input);
}

/**
 * Where the caret is in a field whose selection a script cannot touch, for
 * as long as it is somewhere other than the end.
 *
 * `number` and `email` keep a caret like any field, but only the browser's
 * own editor can see it: `selectionStart` reads null and
 * `setSelectionRange` throws. A board of boxes is not that editor, so a
 * caret placed in one of them — by a ray, on the field or on the keyboard's
 * preview of it — is kept here, and typing goes in where it says. `shown`
 * is what the field showed when the caret was put there, which is how a
 * caret the value has since moved out from under — an app clearing the
 * field — is known to be stale: the caret goes back to the end, where a
 * value written by script leaves it on a page.
 *
 * @type {WeakMap<HTMLInputElement, { offset: number, shown: string }>}
 */
const carets = new WeakMap();

/**
 * Where the caret is, as the character offset after it. The end of the
 * value for a field whose selection has never been placed, which reports
 * the end anyway once its value has been set from script — the only way a
 * value gets into a field nobody has typed into. For a field whose
 * selection cannot be read, the end unless the caret was put somewhere
 * else with `setCaretOffset`.
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
  const shown = getShownValue(input);
  const caret = carets.get(input);
  if (caret && caret.shown === shown) {
    return Math.min(caret.offset, shown.length);
  }
  carets.delete(input);
  return shown.length;
}

/**
 * Put the caret at `offset` characters into what the field shows, clamped
 * to it: through the selection where a script may write one, and kept
 * alongside the field where it may not (see `carets`), so that the next key
 * goes in there either way.
 *
 * Says nothing to anyone. The mirror hears of a moved caret the way it
 * hears of a moved value — `touchValue` in textInput.js, which the callers
 * that draw one call.
 *
 * @param {HTMLInputElement} input
 * @param {number} offset
 * @returns {void}
 */
export function setCaretOffset(input, offset) {
  const shown = getShownValue(input);
  const at = Math.max(0, Math.min(Math.round(offset), shown.length));
  if (SELECTABLE_TYPES.has(input.type)) {
    try {
      input.setSelectionRange(at, at);
      return;
    } catch {
      // A type the browser will not place a caret in after all: kept here
      // instead, as for the ones it says so of up front.
    }
  }
  if (at === shown.length) {
    carets.delete(input);
  } else {
    carets.set(input, { offset: at, shown });
  }
}

/**
 * Put the caret at the end of the value, as tapping a field on a phone
 * does.
 *
 * @param {HTMLInputElement} input
 * @returns {void}
 */
export function moveCaretToEnd(input) {
  carets.delete(input);
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
 * A field whose selection cannot be read — `number`, `email` — is edited
 * at the caret kept for it (see `carets`), in what it shows, which for a
 * field that sanitizes its value is its draft (see `drafts`): the edit goes into the draft, the value is
 * assigned from it and comes back sanitized or not, and `input` is
 * dispatched either way, as a browser dispatches it for `1.` on the way to
 * `1.5` while the value reads `""`.
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
  if (SELECTABLE_TYPES.has(input.type)) {
    try {
      input.setRangeText(text, start, end, "end");
    } catch {
      const before = input.value;
      input.value = before.slice(0, start) + text + before.slice(end);
    }
  } else {
    const before = getShownValue(input);
    const candidate = before.slice(0, start) + text + before.slice(end);
    input.value = candidate;
    if (input.value === candidate) {
      // Held as typed: nothing for a draft to add.
      drafts.delete(input);
    } else {
      drafts.set(input, { text: candidate, valueAtDraft: input.value });
    }
    // After what went in, as a browser leaves it; written after the draft,
    // which is what the caret is measured against.
    setCaretOffset(input, start + text.length);
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
 * selected — read where it can be, and where it cannot, the caret
 * `getCaretOffset` keeps for the field.
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
  const caret = getCaretOffset(input);
  return [caret, caret];
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
      if (input.type !== "number" || NUMBER_CHARACTERS.test(press.key)) {
        replaceRange(input, press.key, start, end, "insertText");
      }
    } else if (press.key === "Backspace") {
      if (start !== end) {
        replaceRange(input, "", start, end, "deleteContentBackward");
      } else if (start > 0) {
        replaceRange(input, "", start - 1, start, "deleteContentBackward");
      }
    } else if (press.key === "Delete") {
      if (start !== end) {
        replaceRange(input, "", start, end, "deleteContentForward");
      } else if (end < getShownValue(input).length) {
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

/**
 * Whether a click on this element is a press that will give it the typing:
 * a field the keyboard can type into. Its own press moves the typing there
 * right after the click, so the click is not focus leaving.
 *
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
export function takesTheTyping(target) {
  // By shape rather than `instanceof`: the element may be from another
  // window than the one this module was loaded in.
  const node = /** @type {Node | null} */ (target);
  if (!node || typeof node.nodeType !== "number" || !isTextInput(node)) {
    return false;
  }
  const field = /** @type {HTMLInputElement} */ (node);
  return !field.disabled && !field.readOnly;
}

/**
 * What a label's activation leaves alone: a click on interactive content
 * inside the label, other than the field it names, is that content's, and
 * the label does nothing with it.
 */
const INTERACTIVE = "a[href], button, select, textarea, input";

/**
 * The field a click on this element gives the typing to through a label, as
 * a page's label focuses its field: a `<label>` at or around the element
 * names a field, by `for` or by holding it, and the field is one the
 * keyboard can type into. Null for a click on a button, a link or another
 * control inside the label, which the HTML standard leaves to that control.
 *
 * @param {EventTarget | null} target
 * @returns {HTMLInputElement | null}
 */
export function labelledField(target) {
  const node = /** @type {Node | null} */ (target);
  if (!node || node.nodeType !== 1) {
    return null;
  }
  const element = /** @type {Element} */ (node);
  const label = element.closest("label");
  if (!label) {
    return null;
  }
  const field = /** @type {HTMLLabelElement} */ (label).control;
  const interactive = element.closest(INTERACTIVE);
  if (interactive && interactive !== field && label.contains(interactive)) {
    return null;
  }
  return takesTheTyping(field) ? /** @type {HTMLInputElement} */ (field) : null;
}
