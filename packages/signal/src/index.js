import { Observable } from "rxjs";
import Signal from "./Signal.js";

/**
 * @template T
 * @param {() => T} fn
 */
function derived(fn) {
  const signal = new Signal(() => {
    return fn();
  });
  return {
    get: () => signal.get(),
  };
}

/**
 * @param {() => (void | (() => void))} fn
 */
function effect(fn) {
  const signal = new Signal((ctx) => {
    const cleanup = fn();
    ctx.onInvalidate(() => {
      if (typeof cleanup === "function") {
        cleanup();
      }
    });
  });
  signal.get();
  return () => {
    signal.reset();
  };
}

/**
 * @template T
 * @param {() => T} fn
 */
function observe(fn) {
  return new Observable((subscriber) => {
    const signal = new Signal((ctx) => {
      const value = fn();
      ctx.onInvalidate(() => {
        subscriber.next(ctx.getValue());
      });
      return value;
    });
    subscriber.next(signal.get());
    return () => {
      signal.reset();
    };
  });
}

let isBatching = false;

/**
 * @param {() => void} fn
 */
function batch(fn) {
  const oldIsBatching = isBatching;
  isBatching = true;
  fn();
  isBatching = oldIsBatching;
  Signal.flushQueue();
}

/**
 * @template T
 * @param {T} initialValue
 */
function input(initialValue) {
  let value = initialValue;
  const signal = new Signal(() => value);
  return {
    get() {
      return signal.get();
    },
    /**
     * @param {T} newValue
     */
    set(newValue) {
      value = newValue;
      Signal.addToQueue(signal);
      if (!isBatching) {
        Signal.flushQueue();
      }
    },
  };
}

export { batch, effect, input, derived, observe, Signal };
