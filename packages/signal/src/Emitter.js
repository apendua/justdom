import Computation from "./Computation.js";
import { withComputation, addDependency, onCleanup } from "./core.js";
import { Stream } from "./Stream.js";
import { failuresOf } from "./operators.js";

/**
 * @import { Source } from './subscribable.js';
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
 * The listener runs the handler inside a `Computation`, exactly as before,
 * and the computation's failure — a handler throwing — fails the mounting the
 * way a pipeline error used to.
 *
 * @template {keyof TEntity["__EVENT_MAP__"]} TEvent
 * @template {IEmitter<Record<any, any>>} TEntity
 * @param {TEvent} event
 * @param {(e: TEntity["__EVENT_MAP__"][TEvent]) => void} handler
 * @returns {EntityEffect<TEntity>}
 */
export function on(event, handler) {
  return (entity) => {
    const computation = new Computation();
    const listener = computation.bind(handler);
    entity.addEventListener(event, listener);
    addDependency(failuresOf(computation));
    onCleanup(() => {
      entity.removeEventListener(event, listener);
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
