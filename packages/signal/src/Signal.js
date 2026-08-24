import ReactiveNode from "./Node.js";
import { DIRTY, NoValueError, addDependency, makeNonReactive } from "./core.js";
import { batch } from "./scheduler.js";

/**
 * An input: a value somebody writes, and the place a change enters the graph.
 *
 * A write does not compute anything. It records the new value, bumps this
 * node's version, and marks its direct dependents `DIRTY` and everything
 * below them `CHECK` — a walk that touches each node once and evaluates
 * nothing. What the change *means* is worked out later, by whoever asks.
 *
 * @template T
 */
export class Signal extends ReactiveNode {
  /** @type {(a: T, b: T) => boolean} */
  #isEqual;

  /** @type {{ value: T } | undefined} */
  #current;

  /**
   * Bound once rather than allocated per write. A hot signal is written
   * thousands of times a frame, and a closure per write is a closure per
   * write.
   *
   * @type {() => void}
   */
  #notify = () => {
    this.invalidateDependents(DIRTY);
  };

  /**
   * @param {{ value: T }} [current]
   * @param {(a: T, b: T) => boolean} [isEqual]
   */
  constructor(current, isEqual = Object.is) {
    super();
    this.#isEqual = makeNonReactive(isEqual);
    this.#current = current;
  }

  /**
   * @returns {T}
   */
  get() {
    addDependency(this);
    if (!this.#current) {
      throw new NoValueError("No value available");
    }
    return this.#current.value;
  }

  /**
   * The value, without depending on it.
   *
   * @returns {T}
   */
  peek() {
    if (!this.#current) {
      throw new NoValueError("No value available");
    }
    return this.#current.value;
  }

  /**
   * @returns {boolean}
   */
  hasValue() {
    return !!this.#current;
  }

  /**
   * @param {T} value
   * @returns {void}
   */
  set(value) {
    if (this.#current && this.#isEqual(this.#current.value, value)) {
      return;
    }
    this.#current = Object.freeze({ value });
    this.version += 1;
    // The batch is what makes one write one update. Marking a dependent can
    // queue an effect, and a queued effect outside a batch drains then and
    // there — so an unbatched write would let the first effect run before the
    // second dependent had even been told. Inside an outer `batch()` this
    // nests away to nothing, and inside a flush the drain is already guarded.
    batch(this.#notify);
  }

  /**
   * @param {(value: T) => T} fn
   * @param {() => T} [onNoValue]
   * @returns {void}
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

export default Signal;
