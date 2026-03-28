import { Observable } from "rxjs";

/**
 * @import {Subscribable} from "rxjs";
 */

/** @type {ComputationLike | null} */
export let activeComputation = null;

/**
 * @typedef {object} ComputationLike
 * @property {(dependency: Dependency) => void} addDependency
 * @property {(fn: () => void) => void} onCleanup
 */

/**
 * @template T
 * @param {ComputationLike | null} newComputation
 * @param {() => T} fn
 * @returns {T}
 */
export function withComputation(newComputation, fn) {
  const oldComputation = activeComputation;
  activeComputation = newComputation;
  try {
    return fn();
  } finally {
    activeComputation = oldComputation;
  }
}

/**
 * @param {Dependency} dependency
 */
export function addDependency(dependency) {
  if (activeComputation) {
    activeComputation.addDependency(dependency);
  }
}

/**
 * This function can be used along with shared observables, which can replay last emitted value
 * on re-subscription, e.g. ReplaySubject, BehaviorSubject, or anything piped through shareReplay(1).
 *
 * The synchronously emitted value is captured and returned, while the observable is subscribed to for future updates.
 * If no value is emitted synchronously, an error is thrown.
 *
 * @template T
 * @param {Subscribable<T>} dependency
 * @param {() => T} [getDefaultValue]
 * @returns {T}
 */
export function getValueFromDependency(dependency, getDefaultValue) {
  /** @type {{ value: T } | undefined} */
  let observed;
  /** @type {boolean} */
  let initialized = false;
  const proxy = new Observable((subscriber) => {
    const subscription = dependency.subscribe({
      next: (value) => {
        if (!initialized) {
          observed = { value };
        }
        subscriber.next(value);
      },
      error: (err) => {
        subscriber.error(err);
      },
      complete: () => {
        subscriber.complete();
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  });
  // We are assuming that addind this observable as a depdendency will cause it to be subscribed to immediately.
  addDependency(proxy);
  initialized = true;
  if (!observed) {
    if (getDefaultValue) {
      return getDefaultValue();
    }
    throw new NoValueError();
  }
  return observed.value;
}

/**
 * @param {() => void} fn
 */
export function onCleanup(fn) {
  if (activeComputation) {
    activeComputation.onCleanup(fn);
  } else {
    console.warn(
      new Error(
        "onInvalidate called outside of a computation. " +
          "It's almost certainly not what you want. " +
          "Please examine the stack trace and make sure everything is working as expected.",
      ),
    );
    // To prevent memory leaks, invalidate immediately if we're not inside a computation.
    fn();
  }
}

/**
 * @deprecated Use onCleanup instead.
 * @param {() => void} fn
 */
export function onInvalidate(fn) {
  return onCleanup(fn);
}

/**
 * @template TResult
 * @template {unknown[]} TArgs
 * @param {(...args: TArgs) => TResult} fn
 * @returns {(...args: TArgs) => TResult}
 */
export function makeNonReactive(fn) {
  return function (...args) {
    return withComputation(null, () => fn(...args));
  };
}

/**
 * @template T
 * @param {Subscribable<T>} source
 * @returns {Observable<T>}
 */
export function skipSynchronousValues(source) {
  return new Observable((subscriber) => {
    let initialized = false;
    subscriber.add(
      source.subscribe({
        next: (value) => {
          if (initialized) {
            subscriber.next(value);
          }
        },
        error: (err) => {
          subscriber.error(err);
        },
        complete: () => {
          subscriber.complete();
        },
      }),
    );
    initialized = true;
  });
}

export class NoValueError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message) {
    super(message || "No value available");
  }
}

/**
 * @typedef {Subscribable<unknown>} Dependency
 */

/** @type {WeakMap<Dependency, number>} */
const priorityMap = new WeakMap();

/** @type {WeakMap<Dependency, () => number>} */
const priorityFnMap = new WeakMap();

/**
 * @param {Dependency} dependency
 * @returns {number}
 */
export function getPriority(dependency) {
  const fn = priorityFnMap.get(dependency);
  if (fn) {
    return fn();
  }
  return priorityMap.get(dependency) ?? 0;
}

/**
 * @param {Dependency} dependency
 * @param {number} priority
 * @returns {void}
 */
export function setPriority(dependency, priority) {
  priorityMap.set(dependency, priority);
}

/**
 * @param {Dependency} dependency
 * @param {() => number} fn
 * @returns {void}
 */
export function setPriorityFn(dependency, fn) {
  priorityFnMap.set(dependency, fn);
}
