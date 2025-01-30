import userEvent from "@testing-library/user-event";
import { Observable, Subject } from "rxjs";
import { on, set, setAttribute, data, style, append } from "./operators.js";
import { just } from "./core.js";

describe("DOM Operators", () => {
  describe("operator: on()", () => {
    it("should handle click events", async () => {
      const handleClick = jest.fn();
      const button = document.createElement("button");
      const source$ = just(button);

      const subscription = source$.pipe(on("click", handleClick)).subscribe();

      await userEvent.click(button);
      expect(handleClick).toHaveBeenCalledTimes(1);

      subscription.unsubscribe();
      await userEvent.click(button);
      expect(handleClick).toHaveBeenCalledTimes(1);
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
      expect(input.value).toBe("test value");

      subscription.unsubscribe();
      expect(input.value).toBe("test value");
    });
  });

  describe("operator: setAttribute()", () => {
    it("should set attribute", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const source$ = just(div);

      const subscription = source$
        .pipe(setAttribute("data-test", value$))
        .subscribe();

      value$.next("test value");
      expect(div.getAttribute("data-test")).toBe("test value");

      subscription.unsubscribe();
    });

    it("should remove attribute", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const source$ = just(div);

      const subscription = source$
        .pipe(setAttribute("data-test", value$))
        .subscribe();

      value$.next("test value");
      expect(div.getAttribute("data-test")).toBe("test value");

      value$.next(undefined);
      expect(div.getAttribute("data-test")).toBeNull();

      subscription.unsubscribe();
    });

    it("should persist last value after unsubscribing", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const source$ = just(div);

      const subscription = source$
        .pipe(setAttribute("data-test", value$))
        .subscribe();

      value$.next("test value");
      expect(div.getAttribute("data-test")).toBe("test value");

      subscription.unsubscribe();
      expect(div.getAttribute("data-test")).toBe("test value");
    });

    it("should update dataset when data-* attribute is set", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const source$ = just(div);

      const subscription = source$
        .pipe(setAttribute("data-test-key", value$))
        .subscribe();

      value$.next("test value");
      expect(div.dataset.testKey).toBe("test value");

      subscription.unsubscribe();
    });

    it("should remove dataset when data-* attribute is removed", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const source$ = just(div);

      const subscription = source$
        .pipe(setAttribute("data-test-key", value$))
        .subscribe();

      value$.next("test value");
      expect(div.dataset.testKey).toBe("test value");

      value$.next(undefined);
      expect(div.dataset.testKey).toBeUndefined();

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
      expect(div.dataset.testKey).toBe("test value");

      subscription.unsubscribe();
    });

    it("should remove dataset value", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const source$ = just(div);

      const subscription = source$.pipe(data("testKey", value$)).subscribe();

      value$.next("test value");
      expect(div.dataset.testKey).toBe("test value");

      value$.next(undefined);
      expect(div.dataset.testKey).toBeUndefined();

      subscription.unsubscribe();
    });

    it("should update data-* attribute when dataset value is updated", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const source$ = new Observable((subscriber) => subscriber.next(div));

      const subscription = source$.pipe(data("testKey", value$)).subscribe();

      value$.next("test value");
      expect(div.getAttribute("data-test-key")).toBe("test value");

      subscription.unsubscribe();
      expect(div.getAttribute("data-test-key")).toBe("test value");
    });

    it("should remove data-* attribute when dataset value is undefined", () => {
      const div = document.createElement("div");
      /** @type {Subject<string | undefined>} */
      const value$ = new Subject();
      const source$ = new Observable((subscriber) => subscriber.next(div));

      const subscription = source$.pipe(data("testKey", value$)).subscribe();

      value$.next("test value");
      expect(div.getAttribute("data-test-key")).toBe("test value");

      value$.next(undefined);
      expect(div.getAttribute("data-test-key")).toBeNull();

      subscription.unsubscribe();
    });
  });

  describe("operator: style()", () => {
    it("should set and remove style properties", () => {
      const div = document.createElement("div");
      /** @type {Subject<string>} */
      const value$ = new Subject();
      const source$ = new Observable((subscriber) => subscriber.next(div));

      const subscription = source$
        .pipe(style("backgroundColor", value$))
        .subscribe();

      value$.next("red");
      expect(div.style.backgroundColor).toBe("red");

      subscription.unsubscribe();
      expect(div.style.backgroundColor).toBe("red");
    });
  });

  describe("operator: append()", () => {
    it("should append and remove child elements", () => {
      const parent = document.createElement("div");
      const child = document.createElement("span");

      const source$ = just(parent);
      const child$ = just(child);

      const subscription = source$.pipe(append(child$)).subscribe();

      expect(parent.contains(child)).toBe(true);

      subscription.unsubscribe();
      expect(parent.contains(child)).toBe(false);
    });
  });
});
