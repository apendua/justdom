import { addDependency } from "./core.js";
import { filter, Subject } from "rxjs";
import LazyIterable from "./LazyIterable.js";

/**
 * @import { Observable } from 'rxjs';
 */

/**
 * @template V
 * @typedef {{ type: "added"; value: V } | { type: "deleted"; value: V } | { type: "clear" }} ReactiveSetEvent
 */

/**
 * @template V
 */
export default class ReactiveSet {
  /** @type {Set<V>} */
  #set = new Set();

  /** @type {Subject<ReactiveSetEvent<V>>} */
  #events = new Subject();

  /** @type {Map<V, Observable<ReactiveSetEvent<V>>>} */
  #valueEvents = new Map();

  /**
   * @param {V} value
   * @returns {Observable<ReactiveSetEvent<V>>}
   */
  #getValueEvents(value) {
    let obs = this.#valueEvents.get(value);
    if (!obs) {
      obs = this.#events.pipe(filter((event) => event.type === "clear" || event.value === value));
      this.#valueEvents.set(value, obs);
    }
    return obs;
  }

  get size() {
    addDependency(this.#events);
    return this.#set.size;
  }

  /**
   * @param {V} value
   * @returns {boolean}
   */
  has(value) {
    addDependency(this.#getValueEvents(value));
    return this.#set.has(value);
  }

  /**
   * @param {V} value
   */
  add(value) {
    if (!this.#set.has(value)) {
      this.#set.add(value);
      this.#events.next({ type: "added", value });
    }
  }

  /**
   * @param {V} value
   */
  delete(value) {
    if (this.#set.has(value)) {
      this.#set.delete(value);
      this.#valueEvents.delete(value);
      this.#events.next({ type: "deleted", value });
    }
  }

  clear() {
    this.#set.clear();
    this.#valueEvents.clear();
    this.#events.next({ type: "clear" });
  }

  /**
   * @returns {Iterable<V>}
   */
  values() {
    addDependency(this.#events);
    return new LazyIterable(this.#set.values.bind(this.#set));
  }
}
