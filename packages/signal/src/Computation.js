import { withComputation, makeNonReactive, skipSynchronousValues } from "./core.js";

/**
 * @import {Observer, Unsubscribable, ObservableInput} from "rxjs";
 */

/**
 * Need to re-declare it due to https://github.com/microsoft/TypeScript/issues/60591.
 * @template T
 * @typedef {object} Subscribable
 * @property {(observer: Partial<Observer<T>>) => Unsubscribable} subscribe
 */

/**
 * @typedef {object} ComputationOptions
 * @property {() => number} [resetDelay] How long to keep the connection open
 *   after the last observer leaves, in ms. Negative — the default — drops it
 *   there and then. A function rather than a number because the answer is a
 *   subclass's field, and a subclass assigns its fields after `super()`.
 * @property {(this: Computation, observable: Subscribable<unknown>) => void} [onInvalidateDependency]
 */

/**
 * One entry in a computation's observer list.
 *
 * `closed` is why this is an object rather than the observer itself. An
 * observer notified during a round may unsubscribe another, and the one that
 * is gone must not be called even though the round is iterating a snapshot
 * taken before it left.
 *
 * @typedef {object} Entry
 * @property {Partial<Observer<void>>} observer
 * @property {boolean} closed
 */

/** @type {Unsubscribable} */
const CLOSED = { unsubscribe: () => {} };

/**
 * A unit of reactive work: the thing that remembers what it read, hears when
 * any of it changes, and tells whoever is listening.
 *
 * This used to be an RxJS `Subject` behind `share()`, which is a fair
 * description of what it does and an expensive way to say it. A panel mirrors
 * a few hundred DOM nodes and builds some sixty of these per node, so the
 * question is not what one costs but what a hundred and fifty thousand cost
 * at once — and profiling a list arriving in a single frame put more time in
 * `Observable.subscribe` and the garbage it makes than in every DOM read the
 * mirror performed. What `share()` was buying is three things, each a few
 * lines when written out: multicast to the current observers, connect on the
 * first of them and disconnect after the last, and — with `cacheTTL` — wait a
 * while before that disconnect in case another arrives.
 *
 * RxJS stays where it earns its place: a *dependency* may be any
 * `Subscribable` at all — a DOM event stream, a `ReplaySubject`, anything an
 * application hands to `addDependency` — and those are still subscribed to
 * through `skipSynchronousValues`. What went away is the wrapper around the
 * overwhelmingly common case, a computation depending on another computation,
 * where the source is known to emit nothing during subscribe and needs no
 * machinery to say so.
 *
 * @implements {Subscribable<void>}
 */
class Computation {
  /** @type {Map<Subscribable<unknown>, Unsubscribable>} */
  #subscriptions = new Map();

  /** @type {Set<Subscribable<unknown>>} */
  #dependencies = new Set();

  /** @type {Set<Subscribable<unknown>>} */
  #sideEffects = new Set();

  /** @type {Set<Entry>} */
  #observers = new Set();

  /**
   * The observer list as an array, rebuilt only when the list changes, so a
   * notification iterates without allocating. The same trick RxJS's `Subject`
   * plays, and for the same reason: notifying is the hot direction.
   *
   * @type {Entry[] | null}
   */
  #snapshot = null;

  /** Whether the dependencies are currently subscribed to. */
  #connected = false;

  /**
   * The error this computation died of, if it did. Terminal, as it was when
   * a `Subject` carried it: everything downstream has been told, and anyone
   * arriving later is told immediately rather than waiting for news that
   * cannot come.
   *
   * @type {{ value: unknown } | null}
   */
  #failure = null;

  /** @type {ReturnType<typeof setTimeout> | null} */
  #resetTimer = null;

  /** @type {ComputationOptions} */
  #options;

  /** @type {Array<() => void>} */
  #cleanupListeners = [];

  /**
   * @param {ComputationOptions} [options]
   */
  constructor(options) {
    this.#options = options ?? {};
  }

  isActive() {
    return this.#observers.size > 0;
  }

  /**
   * @param {unknown} err
   * @returns {void}
   */
  error(err) {
    if (!this.isActive()) {
      throw err;
    }
    this.#fail(err);
  }

  /**
   * @param {Subscribable<unknown>} observable
   */
  addDependency(observable) {
    this.#dependencies.add(observable);
    if (this.isActive()) {
      this.#subscribeTo(observable);
    }
  }

  /**
   * @param {Subscribable<unknown>} observable
   */
  addSideEffect(observable) {
    this.#sideEffects.add(observable);
    this.addDependency(observable);
  }

  /**
   * @param {Subscribable<unknown>} observable
   */
  removeSideEffect(observable) {
    if (!this.#sideEffects.has(observable)) {
      return;
    }
    this.#dependencies.delete(observable);
    this.#sideEffects.delete(observable);
    const subscription = this.#subscriptions.get(observable);
    if (subscription) {
      subscription.unsubscribe();
      this.#subscriptions.delete(observable);
    }
  }

  /**
   * @param {Partial<Observer<void>>} observer
   * @returns {Unsubscribable}
   */
  subscribe(observer) {
    if (this.#failure) {
      observer.error?.(this.#failure.value);
      return CLOSED;
    }
    /** @type {Entry} */
    const entry = { observer, closed: false };
    this.#observers.add(entry);
    this.#snapshot = null;
    // An arrival cancels a departure that had not taken effect yet, which is
    // the whole of what `cacheTTL` promises: a value that survives the gap
    // between one reader letting go and the next taking hold.
    if (this.#resetTimer !== null) {
      clearTimeout(this.#resetTimer);
      this.#resetTimer = null;
    }
    // Deliberately after the observer is on the list: connecting runs the side
    // effects, a `Derived`'s among them, and that one asks `isActive()` to
    // decide whether its value is worth keeping.
    if (!this.#connected) {
      this.#connect();
    }
    return {
      unsubscribe: () => {
        if (entry.closed) {
          return;
        }
        entry.closed = true;
        this.#observers.delete(entry);
        this.#snapshot = null;
        if (this.#observers.size === 0) {
          this.#scheduleReset();
        }
      },
    };
  }

  /**
   * @template T
   * @param {() => T} fn
   * @param {object} [options]
   * @param {(dependencies: Subscribable<unknown>[]) => void} [options.onAfterRun]
   * @returns {T}
   */
  run(fn, options = {}) {
    this.cleanup();
    return withComputation(this, () => {
      try {
        this.#dependencies = new Set(this.#sideEffects);
        const result = fn();
        if (options.onAfterRun) {
          options.onAfterRun.call(this, Array.from(this.#dependencies));
        }
        return result;
      } finally {
        for (const [observable, subscription] of this.#subscriptions.entries()) {
          if (!this.#dependencies.has(observable)) {
            subscription.unsubscribe();
            this.#subscriptions.delete(observable);
          }
        }
      }
    });
  }

  /**
   * @template {unknown[]} TArgs
   * @template TReturn
   * @param {(...args: TArgs) => TReturn} fn
   * @returns {(...args: TArgs) => TReturn}
   */
  bind(fn) {
    return (...args) => this.run(() => fn(...args));
  }

  invalidate() {
    const observers = this.#peek();
    for (let index = 0; index < observers.length; index += 1) {
      const entry = observers[index];
      if (!entry.closed) {
        entry.observer.next?.(undefined);
      }
    }
  }

  /**
   * @param {() => void} fn
   * @returns {void}
   */
  onCleanup(fn) {
    fn = makeNonReactive(fn);
    this.#cleanupListeners.push(fn);
  }

  cleanup() {
    const cleanupListeners = this.#cleanupListeners;
    cleanupListeners.forEach((fn) => fn());
    this.#cleanupListeners = [];
  }

  /**
   * The observer list, as something safe to walk. A notification may add or
   * drop observers, and the array handed back is not the list itself.
   *
   * @returns {Entry[]}
   */
  #peek() {
    if (!this.#snapshot) {
      this.#snapshot = Array.from(this.#observers);
    }
    return this.#snapshot;
  }

  /**
   * Tell everyone, then die. Nothing is left subscribed and nothing more will
   * be said; a subscriber arriving afterwards is handed the same error.
   *
   * @param {unknown} err
   * @returns {void}
   */
  #fail(err) {
    if (this.#failure) {
      return;
    }
    this.#failure = { value: err };
    const observers = this.#peek();
    this.#observers.clear();
    this.#snapshot = null;
    this.#disconnect();
    for (let index = 0; index < observers.length; index += 1) {
      const entry = observers[index];
      if (!entry.closed) {
        entry.closed = true;
        entry.observer.error?.(err);
      }
    }
  }

  /**
   * @returns {void}
   */
  #connect() {
    this.#connected = true;
    // The set is read once: subscribing can run a side effect, which can
    // `run()` and replace the set wholesale. What that leaves behind is
    // settled by `run`'s own bookkeeping, and anything it added subscribes on
    // the spot through `addDependency`, this computation being active by now.
    for (const dependency of this.#dependencies) {
      this.#subscribeTo(dependency);
    }
  }

  /**
   * @returns {void}
   */
  #disconnect() {
    if (this.#resetTimer !== null) {
      clearTimeout(this.#resetTimer);
      this.#resetTimer = null;
    }
    if (!this.#connected) {
      return;
    }
    this.#connected = false;
    for (const subscription of this.#subscriptions.values()) {
      subscription.unsubscribe();
    }
    this.#subscriptions.clear();
    this.cleanup();
  }

  /**
   * @returns {void}
   */
  #scheduleReset() {
    const delay = this.#options.resetDelay?.() ?? -1;
    if (!(delay >= 0)) {
      this.#disconnect();
      return;
    }
    this.#resetTimer = setTimeout(() => {
      this.#resetTimer = null;
      if (this.#observers.size === 0) {
        this.#disconnect();
      }
    }, delay);
  }

  /**
   * @param {Subscribable<unknown>} observable
   */
  #subscribeTo(observable) {
    if (this.#subscriptions.has(observable)) {
      return;
    }
    // Non-reactive, because there can be reactive reads inside a dependency's
    // own `subscribe`, and they are not this computation's.
    withComputation(null, () => {
      /** @type {Partial<Observer<unknown>>} */
      const observer = {
        next: () => {
          this.#options.onInvalidateDependency?.call(this, observable);
        },
        error: (err) => {
          this.#fail(err);
        },
      };
      // One computation depending on another is nearly all of them, and such
      // a source says nothing during `subscribe` — it speaks only when
      // invalidated — so there is nothing for `skipSynchronousValues` to skip
      // and no reason to build an Observable and a Subscriber to find that
      // out. An error is the one thing it can deliver on the way in, and
      // `subscribe` hands that straight to the observer either way.
      const subscription =
        observable instanceof Computation
          ? observable.subscribe(observer)
          : skipSynchronousValues(observable).subscribe(observer);
      this.#subscriptions.set(observable, subscription);
    });
  }
}

export default Computation;
