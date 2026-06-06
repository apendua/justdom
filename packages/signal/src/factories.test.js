import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { makeNonReactive } from "./core.js";
import { on } from "./Emitter.js";
import store, { emit } from "./store.js";
import { set, use } from "./operators.js";
import { observable, component, just } from "./factories.js";
import { Signal } from "./Signal.js";

/**
 * @import { Observable, MonoTypeOperatorFunction } from 'rxjs';
 * @import { IEmitter } from './Emitter.js';
 */

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

  /**
   * @template {object} T
   * @template {object} [TEventMap={}]
   * @typedef {MonoTypeOperatorFunction<T & IEmitter<TEventMap>>[]} Op
   */

  /**
   * @typedef {object} InputProps
   * @property {string} text
   */

  /**
   * @typedef {object} InputHandle
   * @property {(text: string) => void} reset
   */

  /**
   * @typedef {object} InputEvents
   * @property {string} changed
   * @property {InputHandle} init
   */

  /** @type {InputProps} */
  const defaults = {
    text: "",
  };

  /**
   * @type {(operators: Op<InputProps, InputEvents>) => Observable<string>} operators
   */
  const Input = component((operators) => {
    const props = store(defaults, operators);

    const reset = makeNonReactive((/** @type {string} */ text) => {
      props.text = text;
      emit(props, "changed", props.text);
    });

    emit(props, "init", {
      reset,
    });

    return observable(() => {
      return `[${props.text}]`;
    });
  });

  it("updates child component state immedately after rendering in a two-way binding scenario", () => {
    const container = component(() => {
      /** @type {Signal<InputHandle>} */
      const handle = new Signal();
      const text = Signal.of("");

      use(() => {
        handle.get().reset("Hello!");
      });

      return Input([
        set("text", () => text.get()),
        on("changed", (newText) => text.set(newText)),
        on("init", (newHandle) => {
          handle.set(newHandle);
        }),
      ]);
    });

    const next = mock.fn();
    const subscription = container().subscribe(next);

    assert.strictEqual(next.mock.calls.length, 1);
    assert.strictEqual(next.mock.calls[0].arguments[0], "[Hello!]");

    subscription.unsubscribe();
  });
});
