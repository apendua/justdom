import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { $, attr, children, className, set, text } from "@apendua.dev/dom";
import { Signal, store } from "@apendua.dev/signal";
import TodoApp from "./components/TodoApp.js";
import { renderToString } from "./renderToString.js";
import { addTodo, todos, toggleTodo } from "./todos.js";

/**
 * @import { Todo } from "./todos.js";
 */

/**
 * @returns {Todo[]}
 */
function createFixture() {
  return [
    store({ id: "1", text: "Completed todo", completed: true }),
    store({ id: "2", text: "Active todo", completed: false }),
  ];
}

/**
 * The renderer brackets every rendered child with an empty placeholder comment,
 * which it needs to be able to swap a subtree out later on. They carry no
 * meaning for a server rendered page, so drop them to keep assertions readable.
 *
 * @param {string} html
 * @returns {string}
 */
function withoutPlaceholders(html) {
  return html.replace(/<!---->/g, "");
}

describe("renderToString()", () => {
  it("should render a complete html document", () => {
    const html = renderToString(() => $("h1", [children(text`Hello`)]));

    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<html lang="en">/);
    assert.match(withoutPlaceholders(html), /<h1>Hello<\/h1>/);
  });

  it("should render into the mount point", () => {
    const html = renderToString(() => $("span", [children(text`mounted`)]));

    assert.match(withoutPlaceholders(html), /<div id="root"><span>mounted<\/span><\/div>/);
  });

  it("should throw when the mount point does not exist", () => {
    assert.throws(
      () => renderToString(() => $("span"), { rootSelector: "#missing" }),
      /Mount point not found/,
    );
  });

  it("should forward errors thrown while rendering", () => {
    assert.throws(
      () =>
        renderToString(() => {
          throw new Error("boom");
        }),
      /boom/,
    );
  });

  it("should accept a custom template", () => {
    const html = renderToString(() => $("span", [children(text`hi`)]), {
      template:
        "<!doctype html><html><head><title>Custom</title></head><body><main></main></body></html>",
      rootSelector: "main",
    });

    assert.match(html, /<title>Custom<\/title>/);
    assert.match(withoutPlaceholders(html), /<main><span>hi<\/span><\/main>/);
  });

  it("should inline the styles injected by className into the head", () => {
    const style = className`
      color: red;
    `;
    const html = renderToString(() => $("p", [set("className", style), children(text`styled`)]));

    const [, generatedClassName] = html.match(/<p class="(class_[^"]+)">/) ?? [];
    assert.ok(generatedClassName, "expected the paragraph to carry a generated class name");
    assert.match(
      html,
      new RegExp(`<style>\\.${generatedClassName} \\{\\s*color: red;\\s*\\}</style>`),
    );
  });

  it("should render reactive values as they are at render time", () => {
    const value = Signal.of("first");
    const render = () => $("span", [children(text`${() => value.get()}`)]);

    assert.match(withoutPlaceholders(renderToString(render)), /<span>first<\/span>/);

    value.set("second");
    assert.match(withoutPlaceholders(renderToString(render)), /<span>second<\/span>/);
  });

  it("should serialize attributes, but not dom properties", () => {
    // A reminder of why the components in this app use `attr()` and not `set()`
    // for anything that has to survive serialization: `input.value = "..."`
    // does not update the `value` attribute, so it would be lost.
    const withAttr = renderToString(() => $("input", [attr({ value: "kept" })]));
    const withSet = renderToString(() => $("input", [set({ value: "lost" })]));

    assert.match(withAttr, /<input value="kept">/);
    assert.doesNotMatch(withSet, /lost/);
  });
});

describe("TodoApp", () => {
  beforeEach(() => {
    todos.set(createFixture());
  });

  it("should render every todo", () => {
    const html = renderToString(() => TodoApp("all"));

    assert.match(html, /1\. Completed todo/);
    assert.match(html, /2\. Active todo/);
    assert.match(html, /1 of 2 remaining/);
  });

  it("should render the active todos only", () => {
    const html = renderToString(() => TodoApp("active"));

    assert.doesNotMatch(html, /Completed todo/);
    assert.match(html, /1\. Active todo/);
  });

  it("should render the completed todos only", () => {
    const html = renderToString(() => TodoApp("completed"));

    assert.match(html, /1\. Completed todo/);
    assert.doesNotMatch(html, /Active todo/);
  });

  it("should mark the current filter", () => {
    const html = renderToString(() => TodoApp("active"));

    assert.match(html, /<a [^>]*href="\/\?filter=active"[^>]*aria-current="page"/);
  });

  it("should strike through the completed todos", () => {
    const html = renderToString(() => TodoApp("all"));

    assert.match(html, /style="text-decoration: line-through; color: rgb\(136, 136, 136\);"/);
  });

  it("should preserve the current filter in the forms", () => {
    const html = renderToString(() => TodoApp("completed"));

    assert.match(html, /<input type="hidden" name="filter" value="completed">/);
  });

  it("should point the delete buttons at the matching route", () => {
    const html = renderToString(() => TodoApp("all"));

    assert.match(html, /formaction="\/todos\/2\/delete"/);
  });

  it("should reflect state mutations in the next render", () => {
    addTodo("Written by the test");
    toggleTodo("2");

    const html = renderToString(() => TodoApp("all"));

    assert.match(html, /3\. Written by the test/);
    assert.match(html, /1 of 3 remaining/);
  });
});
