import { Observable } from "rxjs";

/**
 * @import {Subscribable} from "rxjs";
 */

/** @type {ComputationLike | null} */
export let activeComputation = null;

/**
 * The update channel computations are built into while this is set.
 *
 * A channel is a property of the reader, and a reader is usually built rather
 * than configured: a region of a graph is constructed by code that knows
 * which channel the region belongs to, node by node, through helpers that do
 * not take a channel and should not have to. Threading one through every
 * operator that happens to build a `Derived` — an effect, a mapped value, a
 * memoized read — would mean every such helper growing a parameter for it,
 * and would still miss whichever one was forgotten. The forgotten ones are
 * the dangerous ones: a computation left in the default channel while the
 * values it reads are deferred applies half of an update as soon as it can
 * and the other half a frame later.
 *
 * So this works the way `activeComputation` does, and for the same reason.
 *
 * @type {UpdateChannelLike | null}
 */
export let activeChannel = null;

/**
 * What `core` needs to know about a channel, which is nothing: it only ever
 * carries one around. `UpdateChannel` is the real thing.
 *
 * @typedef {object} UpdateChannelLike
 * @property {number} order
 */

/**
 * Build everything `fn` constructs into `channel`.
 *
 * Pass `null` for a computation that must stay in the default channel even
 * though it is built inside a region — anything shared between regions, which
 * belongs to none of them.
 *
 * @template T
 * @param {UpdateChannelLike | null} channel
 * @param {() => T} fn
 * @returns {T}
 */
export function withChannel(channel, fn) {
  const previous = activeChannel;
  activeChannel = channel;
  try {
    return fn();
  } finally {
    activeChannel = previous;
  }
}

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
export function valueOf(dependency, getDefaultValue) {
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

export class CircularDependencyError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message) {
    super(message || "Circular dependency detected");
  }
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

/**
 * @param {Dependency} dependency
 * @returns {number}
 */
export function getPriority(dependency) {
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
 * Which update channel each dependency schedules in, by the channel's order.
 * Kept beside the priorities because it is the other half of the same sort
 * key — the queue drains by `(channel order, depth)` — and because a node
 * needs to ask it of its dependencies, which are `Subscribable`s and may not
 * be computations at all. Anything never registered is in the default
 * channel, which is order 0: a plain signal, a `store()` change stream, a
 * hand-rolled observable.
 *
 * @type {WeakMap<Dependency, number>}
 */
const channelOrderMap = new WeakMap();

/**
 * How many dependencies have been put in a channel other than the default.
 *
 * The check that keeps channels terminal has to walk a node's dependencies
 * asking each which channel it is in, and that walk sits inside every
 * recomputation. Almost no graph uses channels at all, and one that does not
 * cannot violate the rule, so this is what lets the walk be skipped outright
 * rather than performed and found to be fine.
 *
 * @type {number}
 */
let nonDefaultChannelCount = 0;

/**
 * Whether any dependency anywhere is outside the default channel.
 *
 * @returns {boolean}
 */
export function hasNonDefaultChannels() {
  return nonDefaultChannelCount > 0;
}

/**
 * @param {Dependency} dependency
 * @returns {number}
 */
export function getChannelOrder(dependency) {
  return channelOrderMap.get(dependency) ?? 0;
}

/**
 * @param {Dependency} dependency
 * @param {number} order
 * @returns {void}
 */
export function setChannelOrder(dependency, order) {
  if (order === 0) {
    // The default, and what `getChannelOrder` answers for anything it has
    // never been told about. Recording it would cost a write per computation
    // built and buy nothing.
    return;
  }
  if (!channelOrderMap.has(dependency)) {
    nonDefaultChannelCount += 1;
  }
  channelOrderMap.set(dependency, order);
}

/**
 * @template T
 * @param {Dependency & { get: () => T }} signal
 * @return {Observable<T>}
 */
export function toObservable(signal) {
  return new Observable((subscriber) => {
    const subscription = signal.subscribe({
      next: () => {
        try {
          withComputation(null, () => {
            subscriber.next(signal.get());
          });
        } catch (err) {
          if (err instanceof NoValueError) {
            return;
          }
          throw err;
        }
      },
      error: (err) => {
        subscriber.error(err);
      },
      complete: () => {
        subscriber.complete();
      },
    });
    try {
      if (!subscriber.closed) {
        withComputation(null, () => {
          subscriber.next(signal.get());
        });
      }
    } catch (err) {
      if (!(err instanceof NoValueError)) {
        subscription.unsubscribe();
        subscriber.error(err);
        return;
      }
    }
    return () => {
      subscription.unsubscribe();
    };
  });
  // TODO: Explain why this does not work.
  // return signal.getChanges().pipe(
  //   startWith(signal),
  //   map(() => signal.get()),
  // );
}
