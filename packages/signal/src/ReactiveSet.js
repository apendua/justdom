import { addDependency } from "./core.js";
import { batch } from "./scheduler.js";
import { Subject } from "./subscribable.js";
import LazyIterable from "./LazyIterable.js";
import KeyRelays from "./KeyRelays.js";

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

  /**
   * What a reader of one value depends on. A reader of `size` or of
   * `values()` depends on `#events`, which hears every mutation.
   *
   * @type {KeyRelays<V>}
   */
  #valueRelays = new KeyRelays();

  get size() {
    addDependency(this.#events);
    return this.#set.size;
  }

  /**
   * @param {V} value
   * @returns {boolean}
   */
  has(value) {
    this.#valueRelays.track(value);
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
      if (event.type === "clear") {
        this.#valueRelays.invalidateAll();
      } else {
        this.#valueRelays.invalidate(event.value);
      }
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
