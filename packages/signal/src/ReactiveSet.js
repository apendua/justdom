import { addDependency } from "./core.js";
import { batch } from "./Signal.js";
import { filter, Subject } from "rxjs";
import LazyIterable from "./LazyIterable.js";
import { memoizeDependency } from "./memoize.js";

/**
 * @import { Dependency } from './core.js';
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

  /** @type {(value: V) => Dependency} */
  #getValueEvents = memoizeDependency((value) => {
    return this.#events.pipe(filter((event) => event.type === "clear" || event.value === value));
  });

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
      this.#notify({ type: "added", value });
    }
  }

  /**
   * @param {V} value
   */
  delete(value) {
    if (this.#set.has(value)) {
      this.#set.delete(value);
      this.#notify({ type: "deleted", value });
    }
  }

  clear() {
    this.#set.clear();
    this.#notify({ type: "clear" });
  }

  /**
   * One mutation is one update — see `ReactiveMap#notify` for why the batch is
   * what keeps a computation reading two values, or a value and `size`, from
   * recomputing once per branch and seeing the set mid-mutation on the first.
   *
   * @param {ReactiveSetEvent<V>} event
   */
  #notify(event) {
    batch(() => {
      this.#events.next(event);
    });
  }

  /**
   * @returns {Iterable<V>}
   */
  values() {
    addDependency(this.#events);
    return new LazyIterable(this.#set.values.bind(this.#set));
  }
}
