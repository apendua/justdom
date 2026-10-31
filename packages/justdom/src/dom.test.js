import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { just } from "@apendua/signal";
import { $, $$, children } from "./dom.js";
import { text } from "./text.js";

/**
 * @param {Element} root
 * @returns {string}
 */
function markup(root) {
  return root.innerHTML.replace(/<!---->/g, "");
}

/**
 * Records the tag of every element created while `fn` runs. `fn` receives the
 * untouched `createElement` for building scaffolding that should not be
 * recorded, plus the live list of tags recorded so far.
 *
 * @param {(createElement: (tag: string) => Element, created: string[]) => void} fn
 * @returns {string[]}
 */
function recordCreatedElements(fn) {
  /** @type {string[]} */
  const created = [];
  const realCreateElement = document.createElement.bind(document);
  document.createElement = /** @type {typeof document.createElement} */ (
    (/** @type {string} */ tag) => {
      created.push(tag);
      return realCreateElement(tag);
    }
  );
  try {
    fn(realCreateElement, created);
  } finally {
    document.createElement = realCreateElement;
  }
  return created;
}

describe("$()", () => {
  it("should not create the element before it is subscribed to", () => {
    const created = recordCreatedElements((createElement, recorded) => {
      const element = $("section");
      assert.deepEqual(recorded, [], "expected nothing to be created yet");

      const root = createElement("main");
      just(root, [children(element)]).subscribe();
    });

    assert.deepEqual(created, ["section"]);
  });

  it("should acquire elements in document order", () => {
    const created = recordCreatedElements((createElement) => {
      const tree = $("div", [children($("section", [children($("span"))]))]);

      const root = createElement("main");
      just(root, [children(tree)]).subscribe();
    });

    // Outermost first. Argument evaluation alone would give the reverse.
    assert.deepEqual(created, ["div", "section", "span"]);
  });

  it("should give every subscriber its own element", () => {
    const shared = $("span", [children(text`shared`)]);

    const root = document.createElement("main");
    just(root, [children(shared, shared)]).subscribe();

    assert.strictEqual(root.querySelectorAll("span").length, 2);
    assert.strictEqual(markup(root), "<span>shared</span><span>shared</span>");
  });

  it("should still render a plain element", () => {
    const root = document.createElement("main");
    just(root, [children($("p", [children(text`hello`)]))]).subscribe();

    assert.strictEqual(markup(root), "<p>hello</p>");
  });
});

describe("$$()", () => {
  it("should create svg elements lazily, in their own namespace", () => {
    const element = $$("circle");

    const root = document.createElement("main");
    just(root, [children(element)]).subscribe();

    const circle = root.querySelector("circle");
    assert.ok(circle);
    assert.strictEqual(circle.namespaceURI, "http://www.w3.org/2000/svg");
  });

  it("should give every subscriber its own element", () => {
    const shared = $$("circle");

    const root = document.createElement("main");
    just(root, [children(shared, shared)]).subscribe();

    assert.strictEqual(root.querySelectorAll("circle").length, 2);
  });
});
