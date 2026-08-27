/**
 * The subscription contract, spelled locally.
 *
 * The tracking layer never needed RxJS — it needed a shape: something with a
 * `subscribe` that takes a partial observer and hands back an `unsubscribe`.
 * RxJS observables have that shape, so they remain accepted everywhere a
 * `Subscribable` is, and nothing at the boundary changes. What changes is the
 * direction of the dependency: the core defines the contract and RxJS happens
 * to satisfy it, rather than the core importing the contract from RxJS.
 *
 * @template T
 * @typedef {object} Observer
 * @property {(value: T) => void} next
 * @property {(err: unknown) => void} error
 * @property {() => void} complete
 */

/**
 * @typedef {object} Unsubscribable
 * @property {() => void} unsubscribe
 */

/**
 * The `forEach` member deserves an explanation, because nothing here calls
 * it: it is how `T` survives type inference. An RxJS `Observable` declares
 * `subscribe` as an overload set, TypeScript infers from the last overload,
 * and the last one is the deprecated `(next, error, complete)` form — so a
 * call like `Derived.from(new Observable<GLTF>(...))` inferred `unknown`,
 * silently, at every call site. RxJS's own `Subscribable` fails the same
 * way, so no shape of `subscribe` fixes it. `forEach` is the member RxJS
 * observables carry whose type is plain enough to infer from, and optional
 * here so that anything with only a `subscribe` still qualifies, exactly as
 * before.
 *
 * @template T
 * @typedef {object} Subscribable
 * @property {(observer: Partial<Observer<T>>) => Unsubscribable} subscribe
 * @property {(next: (value: T) => void) => Promise<void>} [forEach]
 */

/**
 * One entry in a subject's observer list.
 *
 * `closed` is why this is an object rather than the observer itself: an
 * observer notified during a round may unsubscribe another, and the one that
 * is gone must not be called even though the round is iterating a snapshot
 * taken before it left. `ReactiveNode` keeps its external observers the same
 * way, for the same reason.
 *
 * @template T
 * @typedef {object} Entry
 * @property {Partial<Observer<T>>} observer
 * @property {boolean} closed
 */

/**
 * Multicast, and nothing else.
 *
 * What the internals were buying from an RxJS `Subject` is exactly this:
 * deliver a value to the current observers, say whether there are any, and
 * survive an observer leaving mid-round. No error or completion state, because
 * the internal subjects never terminate — a map's event stream lives as long
 * as the map.
 *
 * @template T
 */
export class Subject {
  /** @type {Set<Entry<T>>} */
  #entries = new Set();

  /** @type {Entry<T>[] | null} */
  #snapshot = null;

  /**
   * Whether anything is subscribed. The one piece of introspection the
   * internals use: an announcement that would reach no one is not worth
   * building.
   */
  get observed() {
    return this.#entries.size > 0;
  }

  /**
   * @param {T} value
   * @returns {void}
   */
  next(value) {
    if (this.#entries.size === 0) {
      return;
    }
    if (!this.#snapshot) {
      this.#snapshot = Array.from(this.#entries);
    }
    const entries = this.#snapshot;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry.closed) {
        entry.observer.next?.(value);
      }
    }
  }

  /**
   * @param {Partial<Observer<T>>} observer
   * @returns {Unsubscribable}
   */
  subscribe(observer) {
    /** @type {Entry<T>} */
    const entry = { observer, closed: false };
    this.#entries.add(entry);
    this.#snapshot = null;
    return {
      unsubscribe: () => {
        if (entry.closed) {
          return;
        }
        entry.closed = true;
        this.#entries.delete(entry);
        this.#snapshot = null;
      },
    };
  }
}

/**
 * `source`, minus whatever `predicate` rejects.
 *
 * The one operator the internals use: a reader of one key must not wake for a
 * write to another. Written as a plain object with a `subscribe`, because that
 * is all a dependency is.
 *
 * @template T
 * @param {Subscribable<T>} source
 * @param {(value: T) => boolean} predicate
 * @returns {Subscribable<T>}
 */
export function filtered(source, predicate) {
  return {
    subscribe: (observer) =>
      source.subscribe({
        next: (value) => {
          if (predicate(value)) {
            observer.next?.(value);
          }
        },
        error: (err) => observer.error?.(err),
        complete: () => observer.complete?.(),
      }),
  };
}
