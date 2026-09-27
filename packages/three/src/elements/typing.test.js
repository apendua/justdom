import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getCaretOffset, isTextInput, moveCaretToEnd, typeIntoInput } from "./typing.js";

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
