import ReactiveNode from "./Node.js";
import { DIRTY, NoValueError, addDependency, makeNonReactive } from "./core.js";
import { batch } from "./scheduler.js";

/**
 * Why a read found nothing — which is not always the same answer.
 *
 * A signal that was never written has simply not been written yet, and
 * `NoValueError` is a "not yet" the graph knows how to wait on: an effect that
 * catches one stays subscribed and runs again when the value arrives. A signal
 * that *failed* will never be written again, and saying "not yet" about it
 * would leave that effect waiting for news that cannot come. So a read of a
 * dead signal is told what killed it.
 *
 * Returned rather than thrown, and out here rather than inline, because `get`
 * is the hottest read in the library — a frame is tens of thousands of them —
 * and the engine inlines it only while it stays small. This keeps its cold
 * branch at one statement, as it was when the only answer was `NoValueError`.
 *
 * Which is all that helps. Asking the question at all costs about 1% of
 * `Signal#get`, and it is the *branch growing* that costs it, not the call:
 * a version holding the failure in a field of its own, so the branch calls
 * nothing, measures the same (Welch t=0.93 against this one over twelve
 * counterbalanced rounds). So there is no cleverer shape to find here, and
 * the duplicated state that version needed buys nothing. Measure any change
 * to this branch with the order rotated — the harness runs about 1% slower in
 * a round's later slots, which is the whole effect size.
 *
 * @param {ReactiveNode} signal
 * @returns {unknown}
 */
function noValue(signal) {
  const failure = signal.failure;
  return failure ? failure.value : new NoValueError("No value available");
}

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
      throw noValue(this);
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
      throw noValue(this);
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
   * Failing a signal takes its value with it.
   *
   * Everywhere else in the library, letting go is enough: a `Derived` drops
   * its cache when it disconnects, so a dead one has nothing left to hand
   * out. A signal *holds* its value — that is what a signal is — and going
   * dormant is not supposed to lose it. Which leaves a failed signal as the
   * one node that would still be sitting on a value it must not answer with,
   * so the value is dropped here instead, where the reason is terminal.
   *
   * It also puts the read back on the branch it belongs on: `hasValue` is
   * false, and `get` reports the failure from the same place it reports a
   * value that has not arrived yet, rather than from a check every read would
   * pay for.
   *
   * @param {unknown} err
   * @returns {void}
   */
  fail(err) {
    super.fail(err);
    this.#current = undefined;
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
