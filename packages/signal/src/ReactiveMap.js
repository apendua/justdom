import { addDependency } from "./core.js";
import { batch } from "./Signal.js";
import { filter, Subject } from "rxjs";
import LazyIterable from "./LazyIterable.js";
import { memoizeDependency } from "./memoize.js";

/**
 * @import { Dependency } from './core.js';
 */

/**
 * @template K
 * @typedef {{ type: "added"; key: K } | { type: "updated"; key: K } | { type: "deleted"; key: K } | { type: "clear" }} ReactiveMapEvent
 */

/**
 * @template K
 * @template V
 */
export default class ReactiveMap {
  /** @type {Map<K, V>} */
  #map = new Map();

  /** @type {Subject<ReactiveMapEvent<K>>} */
  #events = new Subject();

  // Stream that only fires when the set of keys changes (add/delete/clear).
  #structureEvents = this.#events.pipe(
    filter((event) => event.type === "added" || event.type === "deleted" || event.type === "clear"),
  );

  /** @type {(key: K) => Dependency} */
  #getKeyEvents = memoizeDependency((key) => {
    return this.#events.pipe(filter((event) => event.type === "clear" || event.key === key));
  });

  get size() {
    addDependency(this.#events);
    return this.#map.size;
  }

  /**
   * @param {K} key
   * @returns {V | undefined}
   */
  get(key) {
    addDependency(this.#getKeyEvents(key));
    return this.#map.get(key);
  }

  /**
   * @param {K} key
   * @returns {boolean}
   */
  has(key) {
    addDependency(this.#getKeyEvents(key));
    return this.#map.has(key);
  }

  /**
   * @param {K} key
   * @param {V} value
   */
  set(key, value) {
    const hasKey = this.#map.has(key);
    this.#map.set(key, value);
    this.#notify({ type: hasKey ? "updated" : "added", key });
  }

  /**
   * @param {K} key
   */
  delete(key) {
    if (this.#map.has(key)) {
      this.#map.delete(key);
      this.#notify({ type: "deleted", key });
    }
  }

  clear() {
    this.#map.clear();
    this.#notify({ type: "clear" });
  }

  /**
   * One mutation is one update.
   *
   * Announcing a change tells each dependent in turn, and telling a dependent
   * queues it — which outside a batch drains the queue then and there. So an
   * unbatched announcement lets the first dependent recompute, and everything
   * below it with it, before the second dependent has heard anything: a
   * computation reading two keys of this map, or a key and `size`, would
   * recompute once per branch and would see the map halfway through the
   * mutation on the first of them. Batching holds the drain until every
   * dependent is queued, which is what lets the queue order them by depth.
   *
   * @param {ReactiveMapEvent<K>} event
   */
  #notify(event) {
    batch(() => {
      this.#events.next(event);
    });
  }

  /**
   * @returns {Iterable<K>}
   */
  keys() {
    // We can't use this.#map.keys() directly because it returns an iterator
    // (not iterable!), which can't be cached because it's stateful.
    //
    // Likewise, we can't return a plain object with a [Symbol.iterator] method
    // because the caching strategy reconciles plain objects and symbol-keyed
    // properties are invisible to reconciliation, so it would be treated
    // as an empty object.
    addDependency(this.#structureEvents);
    return new LazyIterable(this.#map.keys.bind(this.#map));
  }

  /**
   * @returns {Iterable<V>}
   */
  values() {
    addDependency(this.#events);
    return new LazyIterable(this.#map.values.bind(this.#map));
  }

  /**
   * @returns {Iterable<[K, V]>}
   */
  entries() {
    addDependency(this.#events);
    return new LazyIterable(this.#map.entries.bind(this.#map));
  }
}
