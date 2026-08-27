import ReactiveNode, { runCleanups } from "./Node.js";
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
 * @import {Subscribable} from "./subscribable.js";
 */

/**
 * @template T
 * @typedef {object} EvaluationContext
 * @property {() => T} getValue the previous value, if there is one
 * @property {() => boolean} hasValue
 */

/**
 * Options a `Derived` used to take, and what to do instead.
 *
 * Both were about *scheduling*, and a `Derived` no longer has a schedule: it
 * produces a value when somebody asks and there is nothing to defer. Ignoring
 * them in silence would leave a caller with a node that computes on demand
 * where they asked for one that waits for a frame — a difference nothing
 * would report.
 *
 * @type {Record<string, string>}
 */
const REMOVED_OPTIONS = {
  channel:
    "a `Derived` has no schedule to put in a channel. Move the work that has to " +
    "wait for the channel into an `Effect`, which takes `channel`.",
  deferred:
    "a `Derived` is already deferred — it computes when it is read, and never " +
    "before. `Effect` takes `deferred` if a first run should wait for its channel.",
};

/**
 * Complained about once per option for the life of the program: the mistake
 * is made at a call site, and a call site inside a list builds thousands of
 * nodes.
 *
 * @type {Set<string>}
 */
const warnedAboutOptions = new Set();

/**
 * @param {object} options
 * @returns {void}
 */
function warnAboutRemovedOptions(options) {
  for (const name of Object.keys(REMOVED_OPTIONS)) {
    if (!(name in options) || warnedAboutOptions.has(name)) {
      continue;
    }
    warnedAboutOptions.add(name);
    console.warn(
      new Error(
        `\`new Derived(fn, { ${name} })\` no longer does anything: ${REMOVED_OPTIONS[name]}`,
      ),
    );
  }
}

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
      warnAboutRemovedOptions(options);
    }
    // Nothing has been computed yet, so there is nothing to be clean about.
    this.state = DIRTY;
  }

  /**
   * @returns {T}
   */
  get() {
    // Registered before anything else so that a reader arriving now is on the
    // list before the node is asked whether it is holding anything open — the
    // answer decides whether it keeps what it is about to compute. Several
    // invariants depend on the order of these two steps; think before
    // changing it.
    addDependency(this);
    const current = this.#current;
    if (current !== null && this.state === CLEAN) {
      // The hot path, and worth spelling out rather than reaching it through
      // `isConnected()` and `updateIfNecessary()`: a cached value only exists
      // on a node that is holding its dependencies open, and `CLEAN` only
      // holds while it is current, so these two fields answer the question
      // between them. A panel reads tens of thousands of already-computed
      // values a frame.
      return current.value;
    }
    if (!this.isConnected()) {
      // Not connected: no subscriptions to its sources, nothing marking it
      // when they move, and therefore nothing that could keep a cached value
      // coherent. Computing afresh is the only honest answer.
      //
      // Connected-but-not-live is a different state and must not come here.
      // A `cacheTTL` window is exactly that — the last reader has gone but
      // the node is still subscribed and still holding its value — so a read
      // during one takes the ordinary cached path below. Sending it here
      // instead would run the held value's teardowns on the way in and
      // refresh the edge versions on the way out, leaving a cache whose
      // resource is disposed and whose bookkeeping claims it is current.
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
    // Set aside rather than run. Which set of teardowns is owed depends on
    // which *value* ends up being the node's, and that is not known until the
    // new one has been built and compared — see below.
    const previousCleanups = this.detachCleanups();
    /** @type {{ value: T } | null} */
    let computed = null;
    /** @type {{ error: unknown } | null} */
    let failure = null;
    this.#evaluating = true;
    this.#evaluations += 1;
    try {
      computed = { value: this.track(() => this.#evaluate(this.#getContext()), true) };
    } catch (err) {
      failure = { error: err };
    } finally {
      this.#evaluating = false;
    }

    if (failure) {
      // Nothing survives: there is no new value and the old one is no longer
      // this node's. Both sets are owed — whatever the failed run managed to
      // register on its way down, and whatever the value it was replacing
      // was holding open.
      const abandoned = this.detachCleanups();
      this.#current = null;
      // A value turning into an error is a change like any other, and so is
      // one error turning into a different one: whoever reads this node needs
      // to hear about it. Only failing again with the error already held is
      // no change — and that one has to be checked rather than assumed, or a
      // node that keeps failing differently would leave its dependents
      // resolving a `CHECK` against an unmoved version and re-throwing the
      // first error for ever.
      if (!this.#error || previous || !Object.is(this.#error.error, failure.error)) {
        this.version += 1;
      }
      this.#error = failure;
      runCleanups(abandoned);
      runCleanups(previousCleanups);
      return;
    }

    this.#error = null;
    const result = /** @type {{ value: T }} */ (computed);
    if (previous && this.#isEqual(previous.value, result.value)) {
      // The cutoff. Nothing downstream is told, and every `CHECK` below
      // resolves back to `CLEAN` without running.
      //
      // The value that survives it is the one already held, not the one just
      // built: `isEqual` is the author saying the two are interchangeable,
      // and the held one is what every dependent is already holding a
      // reference to, so it is the one that has to stay valid. Which makes
      // the *new* run the one to undo.
      //
      // That is what lets a `Derived` memoize an expensive resource. A node
      // that builds a texture and disposes it through `onCleanup`, with an
      // `isEqual` that compares whatever the texture is built from, keeps the
      // texture it has and throws away the rebuild — rather than swapping a
      // live handle for a dead one behind its readers' backs.
      const rebuild = this.detachCleanups();
      this.restoreCleanups(previousCleanups);
      runCleanups(rebuild);
      return;
    }

    this.#current = result;
    this.version += 1;
    // The old value is out of the graph now, so what it was holding open can
    // go. After the new one exists rather than before: an evaluation that
    // throws then leaves the old resource intact instead of having destroyed
    // it on the way to failing.
    runCleanups(previousCleanups);
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
   * @param {Subscribable<TValue>} observable
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
