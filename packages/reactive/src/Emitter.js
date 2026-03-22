import { Manual, callNonReactive } from "@apendua.dev/signal";
import { Observable } from "rxjs";
import { effectMap } from "./operators.js";

/**
 * @import { Subscriber } from 'rxjs';
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
      callNonReactive(() => {
        for (const listener of listeners) {
          listener(payload);
        }
      });
    }
  }
}

/**
 * @template {keyof TEntity["__EVENT_MAP__"]} TEvent
 * @template {IEmitter<Record<any, any>>} TEntity
 * @param {TEvent} event
 * @param {(e: TEntity["__EVENT_MAP__"][TEvent]) => void} handler
 * @returns {(source: Observable<TEntity>) => Observable<TEntity>}
 */
export function on(event, handler) {
  return effectMap((entity) => {
    return new Observable((/** @type {Subscriber<TEntity>} */ subscriber) => {
      const signal = new Manual(handler);
      entity.addEventListener(event, signal.recompute);
      subscriber.add(signal.getChanges().subscribe());
      subscriber.next(entity);
      return () => {
        entity.removeEventListener(event, signal.recompute);
      };
    });
  });
}

/**
 * @template {object} TEventMap
 * @template {keyof TEventMap} TEvent
 * @param {IEmitter<TEventMap>} emitter
 * @param {TEvent} event
 * @returns {Observable<TEventMap[TEvent]>}
 */
export function fromEvent(emitter, event) {
  return new Observable((subscriber) => {
    /** @type {Handler<TEventMap[TEvent]>} */
    const handler = (e) => subscriber.next(e);
    emitter.addEventListener(event, handler);
    return () => {
      emitter.removeEventListener(event, handler);
    };
  });
}

// /**
//  * @template {object} TEventMap
//  * @typedef {<TEvent extends keyof TEventMap, TEntity extends IEmitter<TEventMap>>(
//  *   event: TEvent,
//  *   handler: (e: TEventMap[TEvent]) => void) => (source: Observable<TEntity>
//  * ) => Observable<TEntity>} EventOperator
//  */

// /**
//  * @template {object} TEventMap
//  * @returns {EventOperator<TEventMap>}
//  */
// export function eventOperator() {
//   return /** @type {EventOperator<TEventMap>} */ (on);
// }

export default Emitter;
