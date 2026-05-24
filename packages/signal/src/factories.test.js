import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { observable, component, just } from "./factories.js";
import { Signal } from "./Signal.js";

/**
 * @param {it.Mock<(...args: unknown[]) => unknown>} fn
 * @param {number} callIndex
 * @param {number} argumentIndex
 * @param {unknown} expected
 */
function assertNthCallArgumentEqual(fn, callIndex, argumentIndex, expected) {
  assert.ok(fn.mock.calls.length > callIndex);
  assert.deepStrictEqual(fn.mock.calls[callIndex].arguments[argumentIndex], expected);
}

describe("observable()", () => {
  it("creates an observable that emits values from a signal", () => {
    const signal = Signal.of(0);
    const next = mock.fn();
    const complete = mock.fn();

    const subscription = observable(() => {
      return 2 * signal.get();
    }).subscribe({
      next,
      complete,
    });

    assertNthCallArgumentEqual(next, 0, 0, 0);

    signal.set(1);
    assertNthCallArgumentEqual(next, 1, 0, 2);

    signal.set(2);
    assertNthCallArgumentEqual(next, 2, 0, 4);

    subscription.unsubscribe();
  });
});

describe("component()", () => {
  it("creates an observable that emits values from a signal", () => {
    const signal = Signal.of(0);
    const next = mock.fn();
    const complete = mock.fn();

    const subscription = component(() => {
      return just(2 * signal.get());
    })().subscribe({
      next,
      complete,
    });

    assertNthCallArgumentEqual(next, 0, 0, 0);

    signal.set(1);
    assertNthCallArgumentEqual(next, 1, 0, 2);

    signal.set(2);
    assertNthCallArgumentEqual(next, 2, 0, 4);

    subscription.unsubscribe();
  });
});
