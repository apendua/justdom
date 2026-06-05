import { Observable, of, tap } from "rxjs";
import UpdateQueue from "./UpdateQueue.js";
import {
  NoValueError,
  CircularDependencyError,
  addDependency,
  setPriority,
  getPriority,
  makeNonReactive,
} from "./core.js";
import Computation from "./Computation.js";
import { onNextTick } from "./nextTick.js";

/**
 * @import {Subscribable} from "rxjs";
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
 * @template T
 * @typedef {object} DerivedOptions
 * @property {(a: T, b: T) => boolean} [isEqual]
 * @property {boolean} [deferred]
 */

/**
 * @template T
 * @implements {Dependency}
 */
export class Derived extends Computation {
  /** @type {{ value: T } | null} */
  #current = null;

  /** @type {boolean} */
  #deferred = false;

  /** @type {(ctx: EvaluationContext<T>) => T} */
  #evaluate;

  /** @type {(a: T, b: T) => boolean} */
  #isEqual;

  /** @type {number} */
  #evaluations = 0;

  /** @type {boolean} */
  #recomputing = false;

  /**
   * @param {(ctx: EvaluationContext<T>) => T} evaluate
   * @param {((a: T, b: T) => boolean) | DerivedOptions<T>} [options]
   */
  constructor(evaluate, options = Object.is) {
    super({
      resetOnRefCountZero: () => {
        return this.#deferred ? onNextTick : of(null);
      },
      onInvalidateDependency: () => {
        updateQueue.invalidate(this, getPriority(this));
      },
    });
    this.#evaluate = evaluate;
    if (typeof options === "function") {
      this.#isEqual = options;
    } else {
      const { isEqual = Object.is, deferred = false } = options;
      this.#isEqual = isEqual;
      this.#deferred = deferred;
    }
    this.addSideEffect(
      new Observable(() => {
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
      },
    });
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
   * @returns {Derived<TValue>}
   */
  static from(observable) {
    /** @type {Signal<TValue>} */
    const signal = new Signal();
    const derived = new Derived(() => {
      return signal.get();
    });
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
      updateQueue.invalidate(this);
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
