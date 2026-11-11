import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  discardDraft,
  getCaretOffset,
  getShownValue,
  isTextInput,
  moveCaretToEnd,
  setCaretOffset,
  typeIntoInput,
} from "./typing.js";

/**
 * A field in the document, with what a page's handlers would hear recorded
 * in order.
 *
 * @param {string} [value]
 * @param {string} [type]
 */
function field(value = "", type = "text") {
  const input = document.createElement("input");
  input.type = type;
  input.value = value;
  document.body.appendChild(input);
  /** @type {string[]} */
  const heard = [];
  for (const kind of ["keydown", "input", "keyup", "change"]) {
    input.addEventListener(kind, (event) => {
      const detail =
        kind === "input"
          ? /** @type {InputEvent} */ (event).inputType
          : /** @type {KeyboardEvent} */ (event).key;
      heard.push(`${kind}:${detail}`);
    });
  }
  return { input, heard, remove: () => input.remove() };
}

describe("isTextInput", () => {
  test("says yes to the fields that hold a line of text and no to everything else", () => {
    for (const type of ["text", "search", "url", "tel", "email", "password", "number"]) {
      const input = document.createElement("input");
      input.type = type;
      assert.ok(isTextInput(input), type);
    }
    const untyped = document.createElement("input");
    assert.ok(isTextInput(untyped), "an input with no type is a text input");
    for (const type of ["checkbox", "radio", "range", "file", "color", "hidden", "submit"]) {
      const input = document.createElement("input");
      input.type = type;
      assert.equal(isTextInput(input), false, type);
    }
    assert.equal(isTextInput(document.createElement("div")), false);
    assert.equal(isTextInput(document.createTextNode("x")), false);
  });
});

describe("typeIntoInput", () => {
  test("a character goes in at the caret, with the events a keystroke dispatches", () => {
    const { input, heard, remove } = field("ab");
    moveCaretToEnd(input);
    typeIntoInput(input, { key: "c" });
    assert.equal(input.value, "abc");
    assert.equal(getCaretOffset(input), 3, "the caret follows what was typed");
    assert.deepEqual(heard, ["keydown:c", "input:insertText", "keyup:c"]);
    remove();
  });

  test("backspace takes out the character before the caret, or the selection", () => {
    const { input, heard, remove } = field("abc");
    moveCaretToEnd(input);
    typeIntoInput(input, { key: "Backspace" });
    assert.equal(input.value, "ab");
    assert.deepEqual(heard, [
      "keydown:Backspace",
      "input:deleteContentBackward",
      "keyup:Backspace",
    ]);

    input.setSelectionRange(0, 2);
    typeIntoInput(input, { key: "Backspace" });
    assert.equal(input.value, "", "a selection goes as a whole");

    heard.length = 0;
    typeIntoInput(input, { key: "Backspace" });
    assert.equal(input.value, "");
    assert.deepEqual(
      heard,
      ["keydown:Backspace", "keyup:Backspace"],
      "nothing to take out dispatches no input event",
    );
    remove();
  });

  test("enter submits the form the field is in, and only then", () => {
    const form = document.createElement("form");
    const input = document.createElement("input");
    form.appendChild(input);
    document.body.appendChild(form);
    let submitted = 0;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitted += 1;
    });
    typeIntoInput(input, { key: "Enter" });
    assert.equal(submitted, 1);
    form.remove();

    const { input: loose, heard, remove } = field("x");
    typeIntoInput(loose, { key: "Enter" });
    assert.equal(loose.value, "x", "enter types nothing");
    assert.deepEqual(heard, ["keydown:Enter", "keyup:Enter"]);
    remove();
  });

  test("a keydown handler that prevents the default stops the edit", () => {
    const { input, remove } = field("ab");
    input.addEventListener("keydown", (event) => {
      if (event.key === "z") {
        event.preventDefault();
      }
    });
    moveCaretToEnd(input);
    typeIntoInput(input, { key: "z" });
    assert.equal(input.value, "ab");
    typeIntoInput(input, { key: "y" });
    assert.equal(input.value, "aby");
    remove();
  });

  test("a disabled or read-only field is not edited", () => {
    const { input, remove } = field("ab");
    input.disabled = true;
    typeIntoInput(input, { key: "c" });
    assert.equal(input.value, "ab");
    input.disabled = false;
    input.readOnly = true;
    typeIntoInput(input, { key: "c" });
    assert.equal(input.value, "ab");
    remove();
  });

  test("the modifiers ride on the events", () => {
    const { input, remove } = field("");
    /** @type {boolean[]} */
    const shifts = [];
    input.addEventListener("keydown", (event) => {
      shifts.push(/** @type {KeyboardEvent} */ (event).shiftKey);
    });
    typeIntoInput(input, { key: "A", shiftKey: true, code: "KeyA" });
    assert.deepEqual(shifts, [true]);
    assert.equal(input.value, "A");
    remove();
  });

  test("a field whose selection cannot be read is typed into at its end", () => {
    const { input, remove } = field("12", "number");
    typeIntoInput(input, { key: "3" });
    assert.equal(input.value, "123");
    assert.equal(getCaretOffset(input), 3);
    typeIntoInput(input, { key: "Backspace" });
    assert.equal(input.value, "12");
    remove();
  });

  test("beforeinput goes first, and cancelling it refuses the edit", () => {
    const { input, heard, remove } = field("ab");
    input.addEventListener("beforeinput", (event) => {
      heard.push(`beforeinput:${/** @type {InputEvent} */ (event).data}`);
      if (/** @type {InputEvent} */ (event).data === "x") {
        event.preventDefault();
      }
    });
    moveCaretToEnd(input);
    typeIntoInput(input, { key: "c" });
    assert.deepEqual(heard, ["keydown:c", "beforeinput:c", "input:insertText", "keyup:c"]);
    heard.length = 0;
    typeIntoInput(input, { key: "x" });
    assert.equal(input.value, "abc", "a page that filters its input filters the board too");
    assert.deepEqual(heard, ["keydown:x", "beforeinput:x", "keyup:x"], "and no input event");
    remove();
  });

  test("a ctrl or meta chord is a shortcut, not a character", () => {
    const { input, heard, remove } = field("ab");
    moveCaretToEnd(input);
    typeIntoInput(input, { key: "a", ctrlKey: true });
    typeIntoInput(input, { key: "v", metaKey: true });
    assert.equal(input.value, "ab");
    assert.deepEqual(heard, ["keydown:a", "keyup:a", "keydown:v", "keyup:v"], "heard, not typed");
    remove();
  });

  test("a character a number field cannot hold leaves the value as it was", () => {
    const { input, heard, remove } = field("12", "number");
    typeIntoInput(input, { key: "a" });
    assert.equal(input.value, "12", "not emptied by sanitization");
    assert.deepEqual(heard, ["keydown:a", "keyup:a"], "and nothing says it changed");
    remove();
  });

  test("enter submits a form without a button only when this is its one field", () => {
    const form = document.createElement("form");
    const user = document.createElement("input");
    const password = document.createElement("input");
    password.type = "password";
    form.append(user, password);
    document.body.appendChild(form);
    let submitted = 0;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitted += 1;
    });
    typeIntoInput(user, { key: "Enter" });
    assert.equal(submitted, 0, "two fields and no button: a browser submits nothing");

    const button = document.createElement("button");
    form.appendChild(button);
    typeIntoInput(user, { key: "Enter" });
    assert.equal(submitted, 1, "a submit button makes Enter submit");
    form.remove();
  });
});

describe("typing a number", () => {
  /**
   * @param {HTMLInputElement} input
   * @param {string} keys
   */
  const type = (input, keys) => {
    for (const key of keys) {
      typeIntoInput(input, { key });
    }
  };

  test("a number is typed as the keys spell it, through prefixes that are not numbers", () => {
    for (const number of ["1.5", "-3", "1e3", "0.25", "-1.5e-2"]) {
      const { input, remove } = field("", "number");
      type(input, number);
      assert.equal(input.value, number, `${number} arrives whole`);
      assert.equal(getShownValue(input), number);
      remove();
    }
  });

  test("half way through, the field shows what was typed and its value reads empty", () => {
    const { input, heard, remove } = field("", "number");
    /** @type {string[]} */
    const values = [];
    input.addEventListener("input", () => values.push(input.value));
    type(input, "1.");
    assert.equal(input.value, "", "`1.` is not a number, and the browser says so");
    assert.equal(getShownValue(input), "1.", "but it is what the field shows");
    assert.equal(getCaretOffset(input), 2, "and the caret is after it");
    assert.deepEqual(values, ["1", ""], "an input event for every key, as a browser sends");
    assert.deepEqual(heard.filter((kind) => kind.startsWith("input")).length, 2);
    type(input, "5");
    assert.equal(input.value, "1.5");
    remove();
  });

  test("backspace edits the draft, not the empty value", () => {
    const { input, remove } = field("", "number");
    type(input, "-1.");
    assert.equal(getShownValue(input), "-1.");
    typeIntoInput(input, { key: "Backspace" });
    assert.equal(input.value, "-1", "back to a number");
    typeIntoInput(input, { key: "Backspace" });
    assert.equal(getShownValue(input), "-", "the sign alone is shown");
    assert.equal(input.value, "");
    typeIntoInput(input, { key: "Backspace" });
    assert.equal(getShownValue(input), "");
    remove();
  });

  test("a value written by the app replaces the draft", () => {
    const { input, remove } = field("", "number");
    type(input, "1.");
    input.value = "4";
    assert.equal(getShownValue(input), "4", "a different value makes the draft stale");
    type(input, "2");
    assert.equal(input.value, "42", "and typing carries on from what the app wrote");

    type(input, "-");
    assert.equal(getShownValue(input), "42-");
    // Writing the value the field already reads, `""`, cannot be told from
    // nothing having happened; the mirror's setter hook says so instead.
    input.value = "";
    discardDraft(input);
    assert.equal(getShownValue(input), "");
    remove();
  });
});

describe("placing the caret", () => {
  test("in a field whose selection can be written, is the selection", () => {
    const { input, remove } = field("abc");
    setCaretOffset(input, 1);
    assert.equal(input.selectionStart, 1);
    assert.equal(input.selectionEnd, 1);
    assert.equal(getCaretOffset(input), 1);
    typeIntoInput(input, { key: "x" });
    assert.equal(input.value, "axbc", "the next key goes in there");
    assert.equal(getCaretOffset(input), 2, "and the caret after it");

    setCaretOffset(input, 99);
    assert.equal(getCaretOffset(input), 4, "clamped to the value");
    setCaretOffset(input, -3);
    assert.equal(getCaretOffset(input), 0);
    remove();
  });

  test("in a field whose selection cannot be, is kept for it, and typing goes there", () => {
    for (const type of ["email", "number"]) {
      const { input, remove } = field(type === "email" ? "ab@c" : "125", type);
      setCaretOffset(input, 2);
      assert.equal(getCaretOffset(input), 2, type);
      typeIntoInput(input, { key: type === "email" ? "x" : "3" });
      assert.equal(input.value, type === "email" ? "abx@c" : "1235", `${type}: in the middle`);
      assert.equal(getCaretOffset(input), 3, `${type}: after what went in`);
      typeIntoInput(input, { key: "Backspace" });
      assert.equal(input.value, type === "email" ? "ab@c" : "125", `${type}: backspace there`);
      assert.equal(getCaretOffset(input), 2);
      typeIntoInput(input, { key: "Delete" });
      assert.equal(input.value, type === "email" ? "abc" : "12", `${type}: delete ahead of it`);
      remove();
    }
  });

  test("a caret kept for a field goes back to the end when the app writes the value", () => {
    const { input, remove } = field("12", "number");
    setCaretOffset(input, 0);
    typeIntoInput(input, { key: "-" });
    assert.equal(input.value, "-12");
    input.value = "7";
    assert.equal(getCaretOffset(input), 1, "a new value, and the caret at its end");
    setCaretOffset(input, 0);
    moveCaretToEnd(input);
    assert.equal(getCaretOffset(input), 1, "and at the end when a tap puts it there");
    remove();
  });

  test("follows a draft that is not the value yet", () => {
    const { input, remove } = field("", "number");
    for (const key of "15") {
      typeIntoInput(input, { key });
    }
    setCaretOffset(input, 1);
    typeIntoInput(input, { key: "." });
    assert.equal(input.value, "1.5");
    setCaretOffset(input, 3);
    typeIntoInput(input, { key: "e" });
    assert.equal(input.value, "", "`1.5e` is not a number yet");
    assert.equal(getShownValue(input), "1.5e");
    assert.equal(getCaretOffset(input), 4, "measured against what the field shows");
    typeIntoInput(input, { key: "2" });
    assert.equal(input.value, "1.5e2");
    remove();
  });
});
