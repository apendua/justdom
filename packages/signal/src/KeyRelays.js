import Computation from "./Computation.js";
import { activeComputation } from "./core.js";

/**
 * The per-key dependencies of a keyed collection: what a reader of one key
 * of a `ReactiveMap`, or one value of a `ReactiveSet`, depends on, so that
 * a write to another key does not wake it.
 *
 * Each key has a relay, a node with no value that passes an invalidation
 * on. The rules:
 *
 * - `track(key)` makes the computation that is evaluating depend on the
 *   key's relay. It uses the relay that is registered for the key, and
 *   makes one when there is none. With no computation evaluating it does
 *   nothing, so an untracked read costs no relay.
 * - A relay is registered while it is connected, which is while something
 *   depends on it: it enters the registry when its first dependent arrives
 *   and leaves when its last one goes. So the registry holds what is being
 *   read and nothing else, and a key nobody reads any more costs nothing.
 * - `invalidate(key)` wakes the relays registered for the key, and
 *   `invalidateAll()` every registered relay. The collection calls them
 *   inside the `batch` of the mutation, so that a reader of two keys, or
 *   of a key and the collection's size, runs once. It calls them after it
 *   has told its own stream of events, so a write wakes the readers of the
 *   whole collection, of `size` and of the iterators, and then the readers
 *   of its key.
 * - A relay that is not connected hears nothing, and nothing waits on it:
 *   a reader that holds its dependencies open has connected the relay, and
 *   one that does not reads the collection again when it is asked.
 *
 * Two relays can stand for one key, when two readers each made one before
 * either had connected. Both are registered then, chained through `next`,
 * and both are woken. Readers that arrive later share the first in the
 * chain.
 *
 * A collection used to give each key a `filtered` view of its one stream
 * of events, held by a memoized `Computation`. Every write then ran one
 * predicate per key being read, and every key cost the view, its
 * subscription, the computation and its two resources. A relay is the
 * computation alone, and a write goes to its key by one lookup.
 *
 * @template K
 */
export default class KeyRelays {
  /**
   * The first relay registered for each key.
   *
   * @type {Map<K, KeyRelay<K>>}
   */
  #registered = new Map();

  /**
   * Make the computation that is evaluating, if there is one, depend on
   * `key`.
   *
   * @param {K} key
   * @returns {void}
   */
  track(key) {
    if (activeComputation) {
      activeComputation.addDependency(
        this.#registered.get(key) ?? new KeyRelay(this.#registered, key),
      );
    }
  }

  /**
   * Wake what reads `key`.
   *
   * @param {K} key
   * @returns {void}
   */
  invalidate(key) {
    const first = this.#registered.get(key);
    if (!first) {
      return;
    }
    if (!first.next) {
      first.invalidate();
      return;
    }
    // Collected before any is woken: waking a relay can lose it, or the
    // ones behind it, the last dependent, which takes them out of the
    // chain.
    const chain = [];
    for (let relay = /** @type {KeyRelay<K> | null} */ (first); relay; relay = relay.next) {
      chain.push(relay);
    }
    for (const relay of chain) {
      relay.invalidate();
    }
  }

  /**
   * Wake what reads any key.
   *
   * @returns {void}
   */
  invalidateAll() {
    for (const key of Array.from(this.#registered.keys())) {
      this.invalidate(key);
    }
  }
}

/**
 * The relay of one key. It registers itself while it is connected.
 *
 * @template K
 */
class KeyRelay extends Computation {
  /** @type {Map<K, KeyRelay<K>>} */
  #registered;

  /** @type {K} */
  #key;

  /**
   * The next relay registered for the same key, if there is one.
   *
   * @type {KeyRelay<K> | null}
   */
  next = null;

  /**
   * @param {Map<K, KeyRelay<K>>} registered
   * @param {K} key
   */
  constructor(registered, key) {
    super();
    this.#registered = registered;
    this.#key = key;
  }

  onConnect() {
    this.next = this.#registered.get(this.#key) ?? null;
    this.#registered.set(this.#key, this);
  }

  onDisconnect() {
    const first = this.#registered.get(this.#key);
    if (first === this) {
      if (this.next) {
        this.#registered.set(this.#key, this.next);
      } else {
        this.#registered.delete(this.#key);
      }
    } else {
      /** @type {KeyRelay<K> | null | undefined} */
      let previous = first;
      while (previous && previous.next !== this) {
        previous = previous.next;
      }
      if (previous) {
        previous.next = this.next;
      }
    }
    this.next = null;
  }
}
