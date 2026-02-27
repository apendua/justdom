import { Lazy, makeNonReactive, Signal } from "@apendua.dev/signal";
import { component, observable } from "./factories.js";
import { on } from "./Emitter.js";
import store, { emit } from "./store.js";
import { set, use } from "./operators.js";

/**
 * @import { Observable, MonoTypeOperatorFunction } from 'rxjs';
 * @import { IEmitter } from './Emitter.js';
 */

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
    /** @type {Lazy<InputHandle>} */
    const handle = new Lazy();
    const text = new Signal("");

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

  const next = jest.fn();
  const subscription = container().subscribe(next);

  expect(next).toHaveBeenCalledTimes(1);
  expect(next.mock.calls[0][0]).toBe("[Hello!]");

  subscription.unsubscribe();
});
