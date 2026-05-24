import { addDependency } from "./core.js";
import { filter, Subject } from "rxjs";
import LazyIterable from "./LazyIterable.js";

/**
 * @import { Observable } from 'rxjs';
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

  /** @type {Map<K, Observable<ReactiveMapEvent<K>>>} */
  #keyEvents = new Map();

  // Stream that only fires when the set of keys changes (add/delete/clear).
  #structureEvents = this.#events.pipe(
    filter((event) => event.type === "added" || event.type === "deleted" || event.type === "clear"),
  );

  /**
   * @param {K} key
   * @returns {Observable<ReactiveMapEvent<K>>}
   */
  #getKeyEvents(key) {
    let obs = this.#keyEvents.get(key);
    if (!obs) {
      obs = this.#events.pipe(filter((event) => event.type === "clear" || event.key === key));
      this.#keyEvents.set(key, obs);
    }
    return obs;
  }

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
    if (hasKey) {
      this.#events.next({ type: "updated", key });
    } else {
      this.#events.next({ type: "added", key });
    }
  }

  /**
   * @param {K} key
   */
  delete(key) {
    if (this.#map.has(key)) {
      this.#map.delete(key);
      this.#keyEvents.delete(key);
      this.#events.next({ type: "deleted", key });
    }
  }

  clear() {
    this.#map.clear();
    this.#keyEvents.clear();
    this.#events.next({ type: "clear" });
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
