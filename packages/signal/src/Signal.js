import { tap } from "rxjs";
import UpdateQueue from "./UpdateQueue.js";
import {
  NoValueError,
  CircularDependencyError,
  addDependency,
  setPriority,
  getPriority,
  setChannelOrder,
  getChannelOrder,
  hasNonDefaultChannels,
  activeChannel,
  makeNonReactive,
  effect,
} from "./core.js";
import Computation from "./Computation.js";

/**
 * @import UpdateChannel from "./UpdateChannel.js";
 */

/**
 * @import {Observable, Subscribable} from "rxjs";
 */

/**
 * @typedef {Subscribable<unknown>} Dependency
 */

/**
 * @template T
 * @typedef {object} EvaluationContext
 * @property {() => T} getValue
 * @property {() => boolean} hasValue
 */

/** @type {UpdateQueue} */
const updateQueue = new UpdateQueue();

/**
 * @param {() => void} fn
 */
export function batch(fn) {
  return updateQueue.batch(fn);
}

/**
 * The channel everything schedules in unless a `Derived` says otherwise.
 */
export const defaultChannel = updateQueue.defaultChannel;

/**
 * @template T
 * @typedef {object} DerivedOptions
 * @property {(a: T, b: T) => boolean} [isEqual]
 * @property {boolean} [deferred]
 * @property {number} [cacheTTL]
 * @property {UpdateChannel} [channel] which channel to schedule this node's
 *   recomputation in. Fixed for the life of the node.
 */

/**
 * @template T
 * @implements {Dependency}
 */
export class Derived extends Computation {
  /** @type {{ value: T } | null} */
  #current = null;

  /** @type {number} */
  #cacheTTL = -1;

  /** @type {(ctx: EvaluationContext<T>) => T} */
  #evaluate;

  /** @type {(a: T, b: T) => boolean} */
  #isEqual;

  /** @type {number} */
  #evaluations = 0;

  /** @type {boolean} */
  #recomputing = false;

  /** @type {UpdateChannel} */
  #channel;

  /** @type {boolean} */
  #warnedAboutChannelOrder = false;

  /**
   * The update queue's slot on this node, written on the first enqueue and
   * reused for life. Declared here so every node carries the field from
   * birth rather than growing it mid-flight.
   *
   * @type {import("./UpdateQueue.js").Entry | undefined}
   */
  queueEntry = undefined;

  /**
   * @param {(ctx: EvaluationContext<T>) => T} evaluate
   * @param {((a: T, b: T) => boolean) | DerivedOptions<T>} [options]
   */
  constructor(evaluate, options = Object.is) {
    super({
      resetDelay: () => this.#cacheTTL,
      onInvalidateDependency: () => {
        updateQueue.invalidate(this, getPriority(this), this.#channel);
      },
    });
    this.#evaluate = evaluate;
    // An explicit channel wins; failing that, whichever region this is being
    // built inside; failing that, the default. Which is what lets a region be
    // built by helpers that know nothing about channels.
    const ambient = /** @type {UpdateChannel | null} */ (activeChannel);
    if (typeof options === "function") {
      this.#isEqual = options;
      this.#channel = ambient ?? updateQueue.defaultChannel;
    } else {
      const { isEqual = Object.is, cacheTTL = -1, channel } = options;
      this.#isEqual = isEqual;
      this.#cacheTTL = cacheTTL;
      this.#channel = channel ?? ambient ?? updateQueue.defaultChannel;
    }
    setChannelOrder(this, this.#channel.order);
    this.addSideEffect(
      effect(() => {
        try {
          this.#recompute();
        } catch (err) {
          if (!(err instanceof NoValueError)) {
            throw err;
          }
        }
        return () => {
          this.#current = null;
        };
      }),
    );
  }

  get() {
    // We want to register this as dependency before recompute, to make sure that subscription to own changes
    // is created early, so that the recomute properly recognizes isActive() stauts. In order for this to work
    // the priority calculation needs to be decoupled from addDependency (old implementation), and instead it's
    // now performed in the onAfterRun callback of the run() method.
    //
    // Please think carefully before changing the order of these operations, as multiple invariants may break
    // if the order is messed up.
    addDependency(this);
    if (this.#current) {
      return this.#current.value;
    }
    return this.#recompute();
  }

  getEvaluations() {
    return this.#evaluations;
  }

  invalidate() {
    // If invalidate was called while recomputing, it means we have a circular dependency,
    // i.e. we depenend on a signal that was updated during the current recomputation.
    if (this.#recomputing) {
      throw new CircularDependencyError();
    }
    if (!this.#current) {
      // If we have no current value, there's no way we can figure out if
      // something changed or not, so we just notify all potential dependents,
      // in case they would like to recompute.
      super.invalidate();
      return;
    }
    const oldValue = this.#current.value;
    /** @type {T} */
    let newValue;
    try {
      newValue = this.#recompute();
    } catch (err) {
      if (err instanceof NoValueError) {
        return;
      }
      this.error(err);
      return;
    }
    if (!this.#isEqual(oldValue, newValue)) {
      super.invalidate();
    }
  }

  #recompute() {
    const recompute = () => {
      // If we're already recomputing, it means we have a circular dependency
      // between different derived computations. We fail quickly and let the
      // user fix the problem.
      if (this.#recomputing) {
        throw new CircularDependencyError();
      }
      try {
        this.#evaluations += 1;
        this.#recomputing = true;
        const newValue = this.#evaluate(this.#getContext());
        if (!this.isActive()) {
          return newValue;
        }
        if (!this.#current) {
          this.#current = { value: newValue };
        } else {
          this.#current.value = newValue;
        }
        return this.#current.value;
      } finally {
        this.#recomputing = false;
      }
    };
    return this.run(recompute, {
      onAfterRun: (dependencies) => {
        let maxPriority = 0;
        for (const dependency of dependencies) {
          maxPriority = Math.max(maxPriority, getPriority(dependency) + 1);
        }
        setPriority(this, maxPriority);
        // Skipped entirely by a graph that uses no channels, which cannot
        // break the rule and should not pay to be asked about it.
        if (hasNonDefaultChannels() && !this.#warnedAboutChannelOrder) {
          this.#checkChannelOrder(dependencies);
        }
      },
    });
  }

  /**
   * Channels are drained in order, so a node must not read a dependency from
   * a later channel than its own: it would be scheduled before the value it
   * reads, on every pass, and would never catch up by more than one pass at a
   * time. Channels are meant to be terminal — a presentation channel reads
   * application state, never the other way round — and this is where a
   * violation becomes visible, since the dependencies are already being
   * walked here for the depth.
   *
   * Warned about once per node: the edge is created once, but the node may
   * recompute thousands of times a second.
   *
   * @param {Iterable<Dependency>} dependencies
   * @returns {void}
   */
  #checkChannelOrder(dependencies) {
    let order = 0;
    for (const dependency of dependencies) {
      const dependencyOrder = getChannelOrder(dependency);
      if (dependencyOrder > order) {
        order = dependencyOrder;
      }
    }
    if (order <= this.#channel.order) {
      return;
    }
    this.#warnedAboutChannelOrder = true;
    console.warn(
      new Error(
        `A computation in update channel "${this.#channel.name}" (order ` +
          `${this.#channel.order}) reads a dependency from a channel of order ${order}. ` +
          `Channels drain in order, so this node will be recomputed before the value it ` +
          `reads and will always lag it by a pass. Channels are meant to be terminal: ` +
          `move this node into the later channel, or move its dependency into an earlier one.`,
      ),
    );
  }

  /**
   * @returns {EvaluationContext<T>}
   */
  #getContext() {
    return {
      getValue: () => {
        if (!this.#current) {
          throw new NoValueError("Signal has not been initialized yet");
        }
        return this.#current.value;
      },
      hasValue: () => {
        return !!this.#current;
      },
    };
  }

  /**
   * @template TValue
   * @param {(ctx: EvaluationContext<TValue>) => TValue} fn
   */
  static of(fn) {
    return new Derived(fn);
  }

  /**
   * @template TValue
   * @param {Observable<TValue>} observable
   * @param {object} [options]
   * @param {number} [options.cacheTTL]
   * @returns {Derived<TValue>}
   */
  static from(observable, options = {}) {
    /** @type {Signal<TValue>} */
    const signal = new Signal();
    const derived = new Derived(
      () => {
        return signal.get();
      },
      {
        cacheTTL: options.cacheTTL,
      },
    );
    derived.addSideEffect(observable.pipe(tap((value) => signal.set(value))));
    return derived;
  }
}

/**
 * @template T
 * @implements {Dependency}
 */
export class Signal extends Computation {
  /** @type {(a: T, b: T) => boolean} */
  #isEqual;

  /** @type {{ value: T } | undefined} */
  #current;

  /**
   * @param {{ value: T }} [current]
   * @param {(a: T, b: T) => boolean} [isEqual]
   */
  constructor(current, isEqual = Object.is) {
    super();
    this.#isEqual = makeNonReactive(isEqual);
    this.#current = current;
  }

  get() {
    addDependency(this);
    if (!this.#current) {
      throw new NoValueError("No value available");
    }
    return this.#current.value;
  }

  /**
   * @param {T} value
   */
  set(value) {
    if (!this.#current || !this.#isEqual(this.#current.value, value)) {
      this.#current = Object.freeze({ value });
      // Notify directly rather than through the queue. A signal is a source:
      // it has no dependencies to be ordered after, so the only thing a trip
      // through the queue bought was collapsing repeated writes to the same
      // signal within one batch into a single notification. What that saves
      // is a notification, never a recomputation — every dependent is a
      // computation, and the queue still dedups those by membership at the
      // level below. It also puts signals on the same footing as the other
      // sources in this library: `store()`'s per-key streams and
      // `ReactiveMap`/`ReactiveSet` have always notified synchronously.
      //
      // The batch is what keeps this glitch-free. Notifying a dependent
      // enqueues it, and an enqueue outside a batch drains the queue then and
      // there — so an unbatched notification would let the first dependent
      // recompute, and everything below it with it, before the second
      // dependent had even been told. A diamond would see one update per
      // branch instead of one in total. Batching holds the drain until every
      // direct dependent is queued, which is precisely what the queue needs
      // to order them by depth. Inside an outer `batch()` this nests away to
      // nothing, and inside a flush the drain is already guarded.
      updateQueue.batch(() => {
        this.invalidate();
      });
    }
  }

  /**
   * @param {(value: T) => T} fn
   * @param {() => T} [onNoValue]
   */
  setFn(fn, onNoValue) {
    if (!this.#current) {
      if (!onNoValue) {
        throw new NoValueError();
      }
      this.set(makeNonReactive(onNoValue)());
    } else {
      this.set(makeNonReactive(fn)(this.#current.value));
    }
  }

  /**
   * @template TValue
   * @param {TValue} value
   * @returns {Signal<TValue>}
   */
  static of(value) {
    return new Signal({ value });
  }
}
