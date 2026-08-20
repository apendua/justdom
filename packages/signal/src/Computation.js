import { Effect, withComputation, makeNonReactive, skipSynchronousValues } from "./core.js";

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
 * One entry in a computation's external observer list.
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
 * The observer list is further split in two. A **dependent** — another
 * computation that read this one — is registered directly and told about an
 * invalidation through a plain method call, with no observer object, no
 * subscriber and no RxJS between two computations. **External observers** —
 * application code, `toObservable`, effects — keep the ordinary
 * `Subscribable` interface. The two receive exactly the same notifications
 * in exactly the same order as when they shared one list; only the per-edge
 * machinery is gone.
 *
 * RxJS stays where it earns its place: a *dependency* may be any
 * `Subscribable` at all — a DOM event stream, a `ReplaySubject`, anything an
 * application hands to `addDependency` — and those are still subscribed to
 * through `skipSynchronousValues`.
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

  /**
   * Computations that depend on this one, told about invalidations through
   * direct method calls.
   *
   * @type {Set<Computation>}
   */
  #dependents = new Set();

  /** @type {Computation[] | null} */
  #dependentsSnapshot = null;

  /** @type {Set<Entry>} */
  #observers = new Set();

  /**
   * The external observer list as an array, rebuilt only when the list
   * changes, so a notification iterates without allocating. The same trick
   * RxJS's `Subject` plays, and for the same reason: notifying is the hot
   * direction.
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
   * This computation's depth in the graph — see `getPriority` in `core.js`.
   * A data property declared up front rather than a `WeakMap` entry, because
   * every recomputation of every dependent reads it.
   *
   * @type {number}
   */
  priority = 0;

  /**
   * @param {ComputationOptions} [options]
   */
  constructor(options) {
    this.#options = options ?? {};
  }

  isActive() {
    return this.#observers.size > 0 || this.#dependents.size > 0;
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
    this.#cancelReset();
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
        if (!this.isActive()) {
          this.#scheduleReset();
        }
      },
    };
  }

  /**
   * Register a dependent computation: the internal counterpart of
   * `subscribe`. The dependent hears about invalidations through
   * `dependencyInvalidated` and about death through `dependencyFailed`,
   * without an observer object in between.
   *
   * @param {Computation} dependent
   * @returns {Unsubscribable}
   */
  subscribeAsDependent(dependent) {
    if (this.#failure) {
      dependent.dependencyFailed(this.#failure.value);
      return CLOSED;
    }
    this.#dependents.add(dependent);
    this.#dependentsSnapshot = null;
    this.#cancelReset();
    if (!this.#connected) {
      this.#connect();
    }
    let closed = false;
    return {
      unsubscribe: () => {
        if (closed) {
          return;
        }
        closed = true;
        this.#dependents.delete(dependent);
        this.#dependentsSnapshot = null;
        if (!this.isActive()) {
          this.#scheduleReset();
        }
      },
    };
  }

  /**
   * A dependency announced a change. The historical contract, minus the
   * observer object: hand the event to `onInvalidateDependency`, which for a
   * `Derived` schedules a recomputation.
   *
   * @param {Subscribable<unknown>} dependency
   * @returns {void}
   */
  dependencyInvalidated(dependency) {
    this.#options.onInvalidateDependency?.call(this, dependency);
  }

  /**
   * A dependency died. Terminal for this computation too.
   *
   * @param {unknown} err
   * @returns {void}
   */
  dependencyFailed(err) {
    this.#fail(err);
  }

  /**
   * @template T
   * @param {() => T} fn
   * @param {object} [options]
   * @param {(dependencies: Iterable<Subscribable<unknown>>) => void} [options.onAfterRun]
   * @returns {T}
   */
  run(fn, options = {}) {
    this.cleanup();
    return withComputation(this, () => {
      try {
        this.#dependencies = new Set(this.#sideEffects);
        const result = fn();
        if (options.onAfterRun) {
          // The set itself rather than a copy: the walk happens on every
          // recomputation, and the callback only reads.
          options.onAfterRun.call(this, this.#dependencies);
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
    // Dependents first, in registration order, then external observers — the
    // same overall order the single shared list produced. Both walks iterate
    // a snapshot with a liveness check, because a notified party may
    // unsubscribe another mid-round.
    if (this.#dependents.size > 0) {
      const dependents = this.#peekDependents();
      for (let index = 0; index < dependents.length; index += 1) {
        const dependent = dependents[index];
        if (this.#dependents.has(dependent)) {
          dependent.dependencyInvalidated(this);
        }
      }
    }
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
   * @returns {Computation[]}
   */
  #peekDependents() {
    if (!this.#dependentsSnapshot) {
      this.#dependentsSnapshot = Array.from(this.#dependents);
    }
    return this.#dependentsSnapshot;
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
    const dependents = this.#peekDependents();
    const observers = this.#peek();
    this.#dependents.clear();
    this.#dependentsSnapshot = null;
    this.#observers.clear();
    this.#snapshot = null;
    this.#disconnect();
    for (let index = 0; index < dependents.length; index += 1) {
      dependents[index].dependencyFailed(err);
    }
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
    this.#cancelReset();
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

  #cancelReset() {
    if (this.#resetTimer !== null) {
      clearTimeout(this.#resetTimer);
      this.#resetTimer = null;
    }
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
      if (!this.isActive()) {
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
      /** @type {Unsubscribable} */
      let subscription;
      if (observable instanceof Computation) {
        // The overwhelmingly common case: computation depending on
        // computation, wired up as a direct dependent with nothing between.
        subscription = observable.subscribeAsDependent(this);
      } else if (observable instanceof Effect) {
        // An `Effect` never emits; an error on the way in is the one thing it
        // can deliver.
        subscription = observable.subscribe({
          error: (err) => {
            this.#fail(err);
          },
        });
      } else {
        subscription = skipSynchronousValues(observable).subscribe({
          next: () => {
            this.dependencyInvalidated(observable);
          },
          error: (err) => {
            this.#fail(err);
          },
        });
      }
      this.#subscriptions.set(observable, subscription);
    });
  }
}

export default Computation;
