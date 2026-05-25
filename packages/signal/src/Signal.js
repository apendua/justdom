import { Observable, of, share } from "rxjs";
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
import nextTick from "./nextTick.js";

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

const onNextTick = nextTick().pipe(
  share({
    resetOnRefCountZero: true,
  }),
);

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
  #priority = 0;

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
    if (this.#current) {
      addDependency(this);
      return this.#current.value;
    }
    const value = this.#recompute();
    // addDependency will need to know the priority of the current computation,
    // which will only be known after recompute() is called.
    addDependency(this);
    return value;
  }

  getEvaluations() {
    return this.#evaluations;
  }

  /**
   * @param {Dependency} dependency
   * @returns {void}
   */
  addDependency(dependency) {
    this.#priority = Math.max(this.#priority, getPriority(dependency) + 1);
    super.addDependency(dependency);
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
    return this.run(() => {
      // If we're already recomputing, it means we have a circular dependency
      // between different derived computations. We fail quickly and let the
      // user fix the problem.
      if (this.#recomputing) {
        throw new CircularDependencyError();
      }
      try {
        this.#priority = 0;
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
        setPriority(this, this.#priority);
      }
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
