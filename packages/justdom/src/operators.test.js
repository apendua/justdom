import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { userEvent } from "@testing-library/user-event";
import { just, Signal } from "@apendua/signal";
import { rx } from "@apendua/signal/rxjs";
import { map, Subject } from "rxjs";
import { on, set, attr, data, style } from "./operators.js";
import { children, toMountable } from "./dom.js";

describe("DOM Operators", () => {
  describe("operator: on()", () => {
    it("should handle click events", async () => {
      const handleClick = mock.fn();
      const button = document.createElement("button");
      const subscription = just(button, [on("click", handleClick)]).subscribe();

      await userEvent.click(button);
      assert.strictEqual(handleClick.mock.calls.length, 1);

      subscription.unsubscribe();
      await userEvent.click(button);
      assert.strictEqual(handleClick.mock.calls.length, 1);
    });
  });

  describe("operator: set()", () => {
    it("should set input value", () => {
      const input = document.createElement("input");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const subscription = just(input, [set("value", value$)]).subscribe();

      value$.next("test value");
      assert.strictEqual(input.value, "test value");

      subscription.unsubscribe();
      assert.strictEqual(input.value, "test value");
    });
  });

  describe("operator: attr()", () => {
    it("should set attribute", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const subscription = just(div, [attr("data-test", value$)]).subscribe();

      value$.next("test value");
      assert.strictEqual(div.getAttribute("data-test"), "test value");

      subscription.unsubscribe();
    });

    it("should remove attribute", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const subscription = just(div, [attr("data-test", value$)]).subscribe();

      value$.next("test value");
      assert.strictEqual(div.getAttribute("data-test"), "test value");

      value$.next(undefined);
      assert.strictEqual(div.getAttribute("data-test"), null);

      subscription.unsubscribe();
    });

    it("should persist last value after unsubscribing", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const subscription = just(div, [attr("data-test", value$)]).subscribe();

      value$.next("test value");
      assert.strictEqual(div.getAttribute("data-test"), "test value");

      subscription.unsubscribe();
      assert.strictEqual(div.getAttribute("data-test"), "test value");
    });

    it("should follow a getter, and stop following it when the mounting comes down", () => {
      // The getter form is a derivation, not a source: no observable is built
      // for it and nothing is subscribed. What it needs from the operator is
      // exactly what an effect gives — read, write, re-run when the read moves.
      const div = document.createElement("div");
      const value = Signal.of("first");
      const subscription = just(div, [attr("data-test", () => value.get())]).subscribe();

      assert.strictEqual(div.getAttribute("data-test"), "first");

      value.set("second");
      assert.strictEqual(div.getAttribute("data-test"), "second");

      subscription.unsubscribe();
      value.set("third");
      assert.strictEqual(div.getAttribute("data-test"), "second");
    });

    it("should not write a getter's value again when it has not moved", () => {
      // The cutoff a `Derived` brings, and the reason the getter form wants one
      // at all: a write upstream that leaves this value alone must not touch
      // the attribute, because in a portal a touched attribute is a mutation
      // record and a re-measure.
      const div = document.createElement("div");
      const source = Signal.of({ label: "a", unrelated: 0 });
      let writes = 0;
      const observer = { setAttribute: div.setAttribute.bind(div) };
      const subscription = just(
        /** @type {any} */ ({
          setAttribute: (/** @type {string} */ key, /** @type {string} */ v) => {
            writes += 1;
            observer.setAttribute(key, v);
          },
          removeAttribute: div.removeAttribute.bind(div),
        }),
        [attr("data-test", () => source.get().label)],
      ).subscribe();

      assert.strictEqual(writes, 1);
      assert.strictEqual(div.getAttribute("data-test"), "a");

      source.set({ label: "a", unrelated: 1 });
      assert.strictEqual(writes, 1, "the label did not move, so nothing was written");

      source.set({ label: "b", unrelated: 1 });
      assert.strictEqual(writes, 2);
      assert.strictEqual(div.getAttribute("data-test"), "b");

      subscription.unsubscribe();
    });

    it("should update dataset when data-* attribute is set", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const subscription = just(div, [attr("data-test-key", value$)]).subscribe();

      value$.next("test value");
      assert.strictEqual(div.dataset.testKey, "test value");

      subscription.unsubscribe();
    });

    it("should remove dataset when data-* attribute is removed", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const subscription = just(div, [attr("data-test-key", value$)]).subscribe();

      value$.next("test value");
      assert.strictEqual(div.dataset.testKey, "test value");

      value$.next(undefined);
      assert.strictEqual(div.dataset.testKey, undefined);

      subscription.unsubscribe();
    });
  });

  describe("operator: data()", () => {
    it("should set dataset value", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const subscription = just(div, [data("testKey", value$)]).subscribe();

      value$.next("test value");
      assert.strictEqual(div.dataset.testKey, "test value");

      subscription.unsubscribe();
    });

    it("should remove dataset value", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const subscription = just(div, [data("testKey", value$)]).subscribe();

      value$.next("test value");
      assert.strictEqual(div.dataset.testKey, "test value");

      value$.next(undefined);
      assert.strictEqual(div.dataset.testKey, undefined);

      subscription.unsubscribe();
    });

    it("should update data-* attribute when dataset value is updated", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const subscription = just(div, [data("testKey", value$)]).subscribe();

      value$.next("test value");
      assert.strictEqual(div.getAttribute("data-test-key"), "test value");

      subscription.unsubscribe();
      assert.strictEqual(div.getAttribute("data-test-key"), "test value");
    });

    it("should remove data-* attribute when dataset value is undefined", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const subscription = just(div, [data("testKey", value$)]).subscribe();

      value$.next("test value");
      assert.strictEqual(div.getAttribute("data-test-key"), "test value");

      value$.next(undefined);
      assert.strictEqual(div.getAttribute("data-test-key"), null);

      subscription.unsubscribe();
    });
  });

  describe("operator: style()", () => {
    it("should set and remove style properties", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const subscription = just(div, [style("backgroundColor", value$)]).subscribe();

      value$.next("red");
      assert.strictEqual(div.style.backgroundColor, "red");

      subscription.unsubscribe();
      assert.strictEqual(div.style.backgroundColor, "red");
    });

    it("should set a custom property", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const subscription = just(div, [style("--accent", value$)]).subscribe();

      value$.next("red");
      assert.strictEqual(div.style.getPropertyValue("--accent"), "red");

      value$.next("blue");
      assert.strictEqual(div.style.getPropertyValue("--accent"), "blue");

      subscription.unsubscribe();
    });

    it("should serialize a custom property into the style attribute", () => {
      const div = document.createElement("div");
      const subscription = just(div, [style("--accent", () => "rebeccapurple")]).subscribe();

      assert.strictEqual(div.getAttribute("style"), "--accent: rebeccapurple;");

      subscription.unsubscribe();
    });

    it("should remove a custom property when the value goes away", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const subscription = just(div, [style("--accent", value$)]).subscribe();

      value$.next("red");
      assert.strictEqual(div.style.getPropertyValue("--accent"), "red");

      value$.next(undefined);
      assert.strictEqual(div.style.getPropertyValue("--accent"), "");

      subscription.unsubscribe();
    });

    it("should accept custom properties alongside regular ones in the object form", () => {
      const div = document.createElement("div");
      const subscription = just(div, [style({ color: "red", "--accent": "blue" })]).subscribe();

      assert.strictEqual(div.style.color, "red");
      assert.strictEqual(div.style.getPropertyValue("--accent"), "blue");

      subscription.unsubscribe();
    });

    it("should coerce non-string custom property values", () => {
      const div = document.createElement("div");
      const subscription = just(div, [style("--count", () => 3)]).subscribe();

      assert.strictEqual(div.style.getPropertyValue("--count"), "3");

      subscription.unsubscribe();
    });
  });

  describe("operator: append()", () => {
    it("should append and remove child elements", () => {
      const parent = document.createElement("div");
      const child = document.createElement("span");

      const child$ = rx(just(child)).pipe(map(toMountable));

      const subscription = just(parent, [children(child$)]).subscribe();

      assert.strictEqual(parent.contains(child), true);

      subscription.unsubscribe();
      assert.strictEqual(parent.contains(child), false);
    });
  });
});
