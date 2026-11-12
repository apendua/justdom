import Computation from "./Computation.js";
import { withComputation, onCleanup } from "./core.js";
import { Stream } from "./Stream.js";

/**
 * @import { Source, Unsubscribable } from './subscribable.js';
 * @import { EntityEffect } from './types.js';
 */

/**
 * @template T
 * @typedef {(payload: T) => void} Handler
 */

/**
 * @template {object} TEventMap
 * @typedef {{
 *   __EVENT_MAP__: TEventMap;
 *   addEventListener: <K extends keyof TEventMap>(type: K, listener: Handler<TEventMap[K]>) => void;
 *   removeEventListener: <K extends keyof TEventMap>(type: K, listener: Handler<TEventMap[K]>) => void;
 * }} IEmitter
 */

/**
 * The event map of a store, or of its operators, that is given none: any
 * event, with any payload. `emit` and `on` then work on a store made without
 * one, as every store in plain JavaScript is; passing a map has both checked.
 *
 * @typedef {Record<string, any>} AnyEventMap
 */

/**
 * @template {object} TEventMap
 */
class Emitter {
  /** @type {Map<PropertyKey, Set<(payload: never) => void>>} */
  #listeners = new Map();

  /**
   * @readonly @type {TEventMap}
   */
  __EVENT_MAP__ = /** @type {TEventMap} */ ({});

  /**
   * @template {keyof TEventMap} TEvent
   * @param {TEvent} event
   * @param {Handler<TEventMap[TEvent]>} callback
   */
  addEventListener(event, callback) {
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(callback);
  }

  /**
   * @template {keyof TEventMap} TEvent
   * @param {TEvent} event
   * @param {Handler<TEventMap[TEvent]>} callback
   */
  removeEventListener(event, callback) {
    const listeners = this.#listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
      if (listeners.size === 0) {
        this.#listeners.delete(event);
      }
    }
  }

  /**
   * @template {keyof TEventMap} TEvent
   * @param {TEvent} event
   * @param {TEventMap[TEvent]} payload
   */
  emit(event, payload) {
    const listeners = /** @type {Set<Handler<TEventMap[TEvent]>>} */ (this.#listeners.get(event));
    if (listeners) {
      withComputation(null, () => {
        for (const listener of listeners) {
          listener(payload);
        }
      });
    }
  }
}

/**
 * Listen to `event` on the entity for as long as it stays mounted.
 *
 * The listener runs the handler inside a `Computation`, so that what the
 * handler reads is tracked and released with the listener. The computation
 * is subscribed for as long as the listener stands, which does two things.
 * It keeps what the handler read alive between events: a `Derived` it read
 * holds its value until the next event, and is not computed again for it.
 * And it hears the computation fail, a dependency of the handler dying,
 * which fails the mounting.
 *
 * The computation is built by the first event. Most listeners in a tree are
 * never called, a button in each row of a table say, and until one is there
 * is nothing for a computation to hold. So mounting a listener costs the
 * listener and its teardown, and reads nothing, which leaves the entry
 * without an `Effect` of its own in a `just`.
 *
 * @template {keyof TEntity["__EVENT_MAP__"]} TEvent
 * @template {IEmitter<Record<any, any>>} TEntity
 * @param {TEvent} event
 * @param {(e: TEntity["__EVENT_MAP__"][TEvent]) => void} handler
 * @returns {EntityEffect<TEntity>}
 */
export function on(event, handler) {
  return (entity, { fail }) => {
    /** @type {Computation | null} */
    let computation = null;
    /** @type {Unsubscribable | null} */
    let held = null;
    /** @param {TEntity["__EVENT_MAP__"][TEvent]} e */
    const listener = (e) => {
      if (!computation) {
        const built = new Computation();
        computation = built;
        // Non-reactive, as attaching any dependency is: whichever
        // computation dispatched the event has read nothing here.
        held = withComputation(null, () => built.subscribe({ error: fail }));
      }
      return computation.track(() => handler(e));
    };
    entity.addEventListener(event, listener);
    onCleanup(() => {
      entity.removeEventListener(event, listener);
      held?.unsubscribe();
    });
  };
}

/**
 * @template {object} TEventMap
 * @template {keyof TEventMap} TEvent
 * @param {IEmitter<TEventMap>} emitter
 * @param {TEvent} event
 * @returns {Source<TEventMap[TEvent]>}
 */
export function fromEvent(emitter, event) {
  return new Stream((subscriber) => {
    /** @type {Handler<TEventMap[TEvent]>} */
    const handler = (e) => subscriber.next(e);
    emitter.addEventListener(event, handler);
    return () => {
      emitter.removeEventListener(event, handler);
    };
  });
}

export default Emitter;
