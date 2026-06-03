import { Observable, share, Subject } from "rxjs";
import { withComputation, makeNonReactive, skipSynchronousValues } from "./core.js";

/**
 * @import {Observer, Subscriber, Unsubscribable, ObservableInput} from "rxjs";
 */

/**
 * Need to re-declare it due to https://github.com/microsoft/TypeScript/issues/60591.
 * @template T
 * @typedef {object} Subscribable
 * @property {(observer: Partial<Observer<T>>) => Unsubscribable} subscribe
 */

/**
 * @typedef {object} ComputationOptions
 * @property {boolean | (() => ObservableInput<unknown>)} [resetOnRefCountZero]
 * @property {(this: Computation, observable: Subscribable<unknown>) => void} [onInvalidateDependency]
 */

/**
 * @implements {Subscribable<void>}
 */
class Computation {
  /** @type {Map<Subscribable<unknown>, Unsubscribable>} */
  #subscriptions = new Map();

  /** @type {Set<Subscribable<unknown>>} */
  #dependencies = new Set();

  /** @type {Set<Subscribable<unknown>>} */
  #sideEffects = new Set();

  /** @type {Subject<void>} */
  #notifier = new Subject();

  /** @type {Observable<void>} */
  #changes;

  /** @type {ComputationOptions} */
  #options;

  /** @type {Array<() => void>} */
  #cleanupListeners = [];

  /**
   * @param {ComputationOptions} [options]
   */
  constructor(options) {
    this.#options = { ...options };
    this.#changes = new Observable((/** @type {Subscriber<void>} */ subscriber) => {
      this.#notifier.subscribe(subscriber);
      for (const observable of this.#dependencies.keys()) {
        this.#subscribeTo(observable);
      }
      return () => {
        for (const subscription of this.#subscriptions.values()) {
          subscription.unsubscribe();
        }
        this.#subscriptions.clear();
        this.cleanup();
      };
    }).pipe(
      share({
        connector: () => new Subject(),
        resetOnRefCountZero: this.#options.resetOnRefCountZero ?? true,
      }),
    );
  }

  isActive() {
    return this.#notifier.observed;
  }

  /**
   * @param {unknown} err
   * @returns {void}
   */
  error(err) {
    if (!this.isActive()) {
      throw err;
    }
    this.#notifier.error(err);
  }

  /**
   * @param {Subscribable<unknown>} observable
   */
  addDependency(observable) {
    this.#dependencies.add(observable);
    if (this.#notifier.observed) {
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
   */
  subscribe(observer) {
    return this.#changes.subscribe(observer);
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
          /** @type {Subscribable<unknown>[]} */
          const dependencies = [];
          for (const observable of this.#dependencies) {
            if (!this.#sideEffects.has(observable)) {
              dependencies.push(observable);
            }
          }
          options.onAfterRun.call(this, dependencies);
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
    this.#notifier.next(undefined);
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
   * @param {Subscribable<unknown>} observable
   */
  #subscribeTo(observable) {
    if (!this.#subscriptions.has(observable)) {
      // We use non-reactive, because there can potentially be some reactive dependencies in observable
      // subscribe() call, and we don't want to accidentally create a dependency on those.
      withComputation(null, () => {
        this.#subscriptions.set(
          observable,
          skipSynchronousValues(observable).subscribe({
            next: () => {
              this.#options.onInvalidateDependency?.call(this, observable);
            },
            error: (err) => {
              this.#notifier.error(err);
            },
          }),
        );
      });
    }
  }
}

export default Computation;
