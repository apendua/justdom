import ReactiveNode from "./Node.js";
import { Signal } from "./Signal.js";
import {
  CLEAN,
  CHECK,
  DIRTY,
  CircularDependencyError,
  NoValueError,
  addDependency,
  resource,
} from "./core.js";

/**
 * @import {Observable} from "rxjs";
 */

/**
 * @template T
 * @typedef {object} EvaluationContext
 * @property {() => T} getValue the previous value, if there is one
 * @property {() => boolean} hasValue
 */

/**
 * @template T
 * @typedef {object} DerivedOptions
 * @property {(a: T, b: T) => boolean} [isEqual]
 * @property {number} [cacheTTL] how long to keep the cached value after the
 *   last reader leaves, in ms. Negative — the default — drops it there and
 *   then.
 */

/**
 * A transformation: a value computed from other values, remembered until one
 * of them moves.
 *
 * Lazy, and that is the whole design. A `Derived` does not recompute when its
 * inputs change; it is *marked*, and it recomputes the next time somebody
 * reads it — which may be never, if nothing downstream cares any more.
 *
 * Reading one resolves its dependencies first, so a read returns a value
 * computed from inputs that are themselves current. That is where the
 * ordering of this library lives: not in a schedule, but in the call stack of
 * a read. Nothing has to know how deep a node sits, or be able to see through
 * whatever an application wrapped it in, because nothing is being sorted.
 *
 * The evaluation function must be **pure**. It runs at times nobody chose,
 * possibly more than once, possibly not at all. Anything that should happen
 * on a schedule, or that touches the world, is an `Effect`.
 *
 * @template T
 */
export class Derived extends ReactiveNode {
  /** @type {{ value: T } | null} */
  #current = null;

  /**
   * The error the last evaluation threw, kept so that a repeated read is
   * answered the same way without running the function again. Cleared by the
   * next successful evaluation — unlike a node failure, which is terminal.
   *
   * @type {{ error: unknown } | null}
   */
  #error = null;

  /** @type {number} */
  #cacheTTL = -1;

  /** @type {(ctx: EvaluationContext<T>) => T} */
  #evaluate;

  /** @type {(a: T, b: T) => boolean} */
  #isEqual;

  /** @type {number} */
  #evaluations = 0;

  /** @type {boolean} */
  #evaluating = false;

  /** @type {EvaluationContext<T> | null} */
  #context = null;

  /**
   * @param {(ctx: EvaluationContext<T>) => T} evaluate
   * @param {((a: T, b: T) => boolean) | DerivedOptions<T>} [options]
   */
  constructor(evaluate, options = Object.is) {
    super({ resetDelay: () => this.#cacheTTL });
    this.#evaluate = evaluate;
    if (typeof options === "function") {
      this.#isEqual = options;
    } else {
      const { isEqual = Object.is, cacheTTL = -1 } = options;
      this.#isEqual = isEqual;
      this.#cacheTTL = cacheTTL;
    }
    // Nothing has been computed yet, so there is nothing to be clean about.
    this.state = DIRTY;
  }

  /**
   * @returns {T}
   */
  get() {
    // Registered before anything else so that a reader arriving now is on the
    // list before `isLive()` is asked — the answer decides whether this node
    // keeps what it is about to compute. Several invariants depend on the
    // order of these two steps; think before changing it.
    addDependency(this);
    const current = this.#current;
    if (current !== null && this.state === CLEAN) {
      // The hot path, and worth spelling out rather than reaching it through
      // `isLive()` and `updateIfNecessary()`: a cached value only exists on a
      // node that is being held open, and `CLEAN` only holds while it is
      // current, so these two fields answer the question between them. A
      // panel reads tens of thousands of already-computed values a frame.
      return current.value;
    }
    if (!this.isLive()) {
      // Nothing is holding this node open, so nothing is keeping a cached
      // value coherent: no subscriptions to its sources, no marking when they
      // move. Computing afresh is the only honest answer.
      return this.#evaluateUncached();
    }
    this.updateIfNecessary();
    if (this.#error) {
      throw this.#error.error;
    }
    return /** @type {{ value: T }} */ (this.#current).value;
  }

  /**
   * The cached value, without depending on this node and without computing
   * anything. Throws if there is nothing cached.
   *
   * @returns {T}
   */
  peek() {
    if (this.#error) {
      throw this.#error.error;
    }
    if (!this.#current) {
      throw new NoValueError("Derived has no cached value to peek at");
    }
    return this.#current.value;
  }

  /**
   * How many times the evaluation function has run. For tests and
   * benchmarks — it is the number this library exists to keep small.
   *
   * @returns {number}
   */
  getEvaluations() {
    return this.#evaluations;
  }

  /**
   * Bring this node up to date, resolving whatever it depends on first.
   *
   * @returns {void}
   */
  updateIfNecessary() {
    if (this.state === CLEAN) {
      return;
    }
    if (this.#evaluating) {
      throw new CircularDependencyError();
    }
    if (this.state === CHECK && !this.hasStaleDependencies()) {
      // Asked upstream rather than assuming, and every dependency came back
      // at the version last seen. Nothing really moved, so this node keeps
      // its value — which is how an `isEqual` that swallows a change stops
      // the change from travelling any further.
      this.state = CLEAN;
      return;
    }
    // Marked clean *before* running, not after. A dependency can be marked
    // while this node is evaluating — a foreign source attached on the way up
    // and firing, most plausibly — and a write of `CLEAN` after the fact
    // would swallow it, leaving a node that believes it is current and never
    // asks again.
    this.state = CLEAN;
    this.#recompute();
  }

  /**
   * @returns {void}
   */
  onDisconnect() {
    this.#current = null;
    this.#error = null;
    this.state = DIRTY;
  }

  /**
   * @returns {void}
   */
  #recompute() {
    const previous = this.#current;
    /** @type {T} */
    let value;
    this.#evaluating = true;
    this.#evaluations += 1;
    try {
      value = this.track(() => this.#evaluate(this.#getContext()));
    } catch (err) {
      this.#current = null;
      // A value turning into an error is a change like any other: whoever
      // reads this node needs to hear about it.
      if (!this.#error || previous) {
        this.version += 1;
      }
      this.#error = { error: err };
      return;
    } finally {
      this.#evaluating = false;
    }
    this.#error = null;
    if (previous && this.#isEqual(previous.value, value)) {
      // The cutoff. Nothing downstream is told, and every `CHECK` below
      // resolves back to `CLEAN` without running.
      return;
    }
    this.#current = { value };
    this.version += 1;
  }

  /**
   * @returns {T}
   */
  #evaluateUncached() {
    if (this.#evaluating) {
      throw new CircularDependencyError();
    }
    this.#evaluating = true;
    this.#evaluations += 1;
    try {
      return this.track(() => this.#evaluate(this.#getContext()));
    } finally {
      this.#evaluating = false;
    }
  }

  /**
   * @returns {EvaluationContext<T>}
   */
  #getContext() {
    if (!this.#context) {
      this.#context = {
        getValue: () => {
          if (!this.#current) {
            throw new NoValueError("Derived has not been evaluated yet");
          }
          return this.#current.value;
        },
        hasValue: () => !!this.#current,
      };
    }
    return this.#context;
  }

  /**
   * @template TValue
   * @param {(ctx: EvaluationContext<TValue>) => TValue} fn
   * @returns {Derived<TValue>}
   */
  static of(fn) {
    return new Derived(fn);
  }

  /**
   * A `Derived` fed by an observable.
   *
   * The observable is a **source**, held open for exactly as long as somebody
   * is reading the node: it writes into a signal, and the node reads the
   * signal. There is deliberately nothing clever here — the boundary between
   * this library and RxJS is a source on one side and a sink on the other,
   * and never a node in the middle whose place in the graph has to be
   * guessed at.
   *
   * @template TValue
   * @param {Observable<TValue>} observable
   * @param {object} [options]
   * @param {number} [options.cacheTTL]
   * @returns {Derived<TValue>}
   */
  static from(observable, options = {}) {
    /** @type {Signal<TValue>} */
    const signal = new Signal();
    const derived = new Derived(() => signal.get(), {
      cacheTTL: options.cacheTTL,
    });
    derived.addResource(
      resource(() => {
        const subscription = observable.subscribe({
          next: (value) => signal.set(value),
          error: (err) => derived.fail(err),
        });
        return () => subscription.unsubscribe();
      }),
    );
    return derived;
  }
}

export default Derived;
