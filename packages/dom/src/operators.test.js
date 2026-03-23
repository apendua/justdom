import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import userEvent from "@testing-library/user-event";
import { just } from "@apendua.dev/reactive";
import { map, Observable, Subject } from "rxjs";
import { on, set, attr, data, style } from "./operators.js";
import { children, toMountable } from "./dom.js";

describe("DOM Operators", () => {
  describe("operator: on()", () => {
    it("should handle click events", async () => {
      const handleClick = mock.fn();
      const button = document.createElement("button");
      const source$ = just(button);

      const subscription = source$.pipe(on("click", handleClick)).subscribe();

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
      const source$ = just(input);

      const subscription = source$.pipe(set("value", value$)).subscribe();

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
      const source$ = just(div);

      const subscription = source$.pipe(attr("data-test", value$)).subscribe();

      value$.next("test value");
      assert.strictEqual(div.getAttribute("data-test"), "test value");

      subscription.unsubscribe();
    });

    it("should remove attribute", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const source$ = just(div);

      const subscription = source$.pipe(attr("data-test", value$)).subscribe();

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
      const source$ = just(div);

      const subscription = source$.pipe(attr("data-test", value$)).subscribe();

      value$.next("test value");
      assert.strictEqual(div.getAttribute("data-test"), "test value");

      subscription.unsubscribe();
      assert.strictEqual(div.getAttribute("data-test"), "test value");
    });

    it("should update dataset when data-* attribute is set", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const source$ = just(div);

      const subscription = source$.pipe(attr("data-test-key", value$)).subscribe();

      value$.next("test value");
      assert.strictEqual(div.dataset.testKey, "test value");

      subscription.unsubscribe();
    });

    it("should remove dataset when data-* attribute is removed", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const source$ = just(div);

      const subscription = source$.pipe(attr("data-test-key", value$)).subscribe();

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
      const source$ = just(div);

      const subscription = source$.pipe(data("testKey", value$)).subscribe();

      value$.next("test value");
      assert.strictEqual(div.dataset.testKey, "test value");

      subscription.unsubscribe();
    });

    it("should remove dataset value", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const source$ = just(div);

      const subscription = source$.pipe(data("testKey", value$)).subscribe();

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
      const source$ = new Observable((subscriber) => subscriber.next(div));

      const subscription = source$.pipe(data("testKey", value$)).subscribe();

      value$.next("test value");
      assert.strictEqual(div.getAttribute("data-test-key"), "test value");

      subscription.unsubscribe();
      assert.strictEqual(div.getAttribute("data-test-key"), "test value");
    });

    it("should remove data-* attribute when dataset value is undefined", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const source$ = new Observable((subscriber) => subscriber.next(div));

      const subscription = source$.pipe(data("testKey", value$)).subscribe();

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
      const source$ = new Observable((subscriber) => subscriber.next(div));

      const subscription = source$.pipe(style("backgroundColor", value$)).subscribe();

      value$.next("red");
      assert.strictEqual(div.style.backgroundColor, "red");

      subscription.unsubscribe();
      assert.strictEqual(div.style.backgroundColor, "red");
    });
  });

  describe("operator: append()", () => {
    it("should append and remove child elements", () => {
      const parent = document.createElement("div");
      const child = document.createElement("span");

      const source$ = just(parent);
      const child$ = just(child).pipe(map(toMountable));

      const subscription = source$.pipe(children(child$)).subscribe();

      assert.strictEqual(parent.contains(child), true);

      subscription.unsubscribe();
      assert.strictEqual(parent.contains(child), false);
    });
  });
});
