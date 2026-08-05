import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";
import { Derived } from "@apendua/signal";
import { getComputedStyleCached, setSubject } from "./cache.js";

describe("getComputedStyleCached", () => {
  test("style invalidations propagate even though the declaration is a live object", () => {
    // Browsers return the *same* live CSSStyleDeclaration on every call, so
    // an equality-gated cache would swallow every invalidation. Simulate the
    // browser behavior explicitly: one stable object whose values follow the
    // element's inline style.
    const element = document.createElement("div");
    element.style.backgroundColor = "rgb(1, 2, 3)";
    document.body.appendChild(element);

    const original = window.getComputedStyle;
    const live = {
      get backgroundColor() {
        return element.style.backgroundColor;
      },
    };
    // @ts-expect-error -- a minimal stand-in for the live declaration.
    window.getComputedStyle = () => live;

    try {
      const subject = new Subject();
      setSubject(element, subject);

      /** @type {string[]} */
      const seen = [];
      const dependent = new Derived(() => {
        return getComputedStyleCached(element).backgroundColor;
      });
      const subscription = dependent.subscribe({
        next: () => {
          seen.push(dependent.get());
        },
      });
      assert.equal(dependent.get(), "rgb(1, 2, 3)");

      element.style.backgroundColor = "rgb(4, 5, 6)";
      subject.next(new Set(["attributes"]));

      assert.equal(dependent.get(), "rgb(4, 5, 6)");
      subscription.unsubscribe();
    } finally {
      window.getComputedStyle = original;
      element.remove();
    }
  });
});
