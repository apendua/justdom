import ReactiveNode, { runCleanups } from "./Node.js";
import { Signal } from "./Signal.js";
import {
  CLEAN,
  CHECK,
  DIRTY,
  CircularDependencyError,
  NoValueError,
  addDependency,
  holdCleanups,
  resource,
} from "./core.js";

/**
 * @import {Subscribable} from "./subscribable.js";
 */

/**
 * What an evaluation is handed: the previous value, and the node's own
 * failure channel.
 *
 * `fail` is for work the evaluation *starts* rather than does — a node that
 * mounts a resource on the way through and holds it open with `onCleanup`
 * (`stylesheet.js` in `@apendua/justdom` mounts a `<style>` element exactly
 * like this). Such work can die after the evaluation returned, with no stack
 * left to throw into, and `fail` is where that news goes: the node fails,
 * terminally, the way a foreign source erroring fails it. It is passed in
 * rather than reached for so that an inline evaluation does not have to close
 * over the node it is a part of.
 *
 * Called while the evaluation is still on the stack, it does *not* fail the
 * node — failing a node mid-evaluation disconnects it under the very run
 * that is rebuilding it, running the previous run's teardowns out of turn
 * and parking the current run's on a node nothing reads again. And it does
 * not throw either, because the caller is usually a foreign source's
 * `error` observer, and a source's teardown bookkeeping does not survive an
 * observer that throws. Instead the failure is set aside, and the evaluation
 * fails with it once it unwinds — the same place a thrown one lands: the
 * pull path, non-terminal, with the reader told synchronously.
 *
 * @template T
 * @typedef {object} EvaluationContext
 * @property {() => T} getValue the previous value, if there is one
 * @property {() => boolean} hasValue
 * @property {(err: unknown) => void} fail report that something this value
 *   was computed from has died. After the evaluation has returned: the node
 *   fails, terminally. During it: the evaluation itself fails, exactly as if
 *   it had thrown.
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

  /**
   * A failure `context.fail` reported while the evaluation it was handed to
   * was still running. Picked up — and cleared — the moment that evaluation
   * unwinds, where it becomes the evaluation's own failure; see the
   * `EvaluationContext` docstring for why it is parked rather than acted on.
   *
   * @type {{ value: unknown } | null}
   */
  #pendingFailure = null;

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
      const failure = this.failure;
      if (failure) {
        throw failure.value;
      }
      return this.#evaluateUncached();
    }
    return this.#resolveConnected();
  }

  /**
   * The tail of a read that has to resolve the node first: bring it up to
   * date, and answer with whatever that produced.
   *
   * A method rather than the rest of `get` because `get` is small enough for
   * the engine to inline and this is the part with no claim on being: it
   * ends in two throws, one of which allocates. Folded back in, the memoized
   * read — the one a panel does tens of thousands of times a frame — measures
   * about 3.5% slower; split out it is within 1% of the code before any of
   * this, which is the noise floor. Twelve rounds with the order of the
   * variants rotated, trimmed means: the harness favours whichever runs
   * first in a round by about 1%, so an A-then-B comparison invents a
   * difference of roughly the size being looked for.
   *
   * @returns {T}
   */
  #resolveConnected() {
    this.updateIfNecessary();
    if (this.#error) {
      throw this.#error.error;
    }
    const computed = this.#current;
    if (computed === null) {
      // Connected, up to date as far as the state says, and holding nothing.
      // The only way to be all three is to be *inside* this node's own
      // evaluation: `updateIfNecessary` settles the state to `CLEAN` before
      // running the function, so a read that comes back round from within it
      // finds a node claiming to be current that has not produced a value
      // yet. Which is a cycle, and saying so beats the `TypeError` about a
      // property of `null` that reading the value used to raise.
      //
      // Caught here rather than by moving `updateIfNecessary`'s `#evaluating`
      // guard above its own `CLEAN` return, which would look like the fix and
      // is not: resolving a `CHECK` walks edges a *previous* evaluation left
      // behind, and two nodes that read each other only under opposite
      // conditions leave exactly such an edge pointing back. That is a cycle
      // the graph had, not one it has. Only a read happening now is one it
      // still does.
      throw new CircularDependencyError();
    }
    return computed.value;
  }

  /**
   * The cached value, without depending on this node and without computing
   * anything. Throws if there is nothing cached.
   *
   * @returns {T}
   */
  peek() {
    const failure = this.failure;
    if (failure) {
      throw failure.value;
    }
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
      const value = this.track(() => this.#evaluate(this.#getContext()), true);
      if (this.#pendingFailure) {
        // The run reported a failure through `context.fail` while it was
        // still on the stack. Thrown here, after `track` has settled its
        // bookkeeping, so it takes exactly the path a throw from the body
        // takes: the failure branch below, with both sets of cleanups owed
        // and the reader told synchronously. The value the run also produced
        // is discarded — it was computed from something already dead.
        throw this.#pendingFailure.value;
      }
      computed = { value };
    } catch (err) {
      failure = { error: err };
    } finally {
      this.#evaluating = false;
      this.#pendingFailure = null;
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
      // The old value outlives the failure exactly as it would a success, for
      // as long as a warm's effects are still holding it.
      if (!holdCleanups(previousCleanups)) {
        runCleanups(previousCleanups);
      }
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
    // it on the way to failing. Unless a warm is resolving it: the effects
    // that read it go on holding the old value until the sweep, so what it
    // holds open goes when the sweep has run — see `holdCleanups`.
    if (!holdCleanups(previousCleanups)) {
      runCleanups(previousCleanups);
    }
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
      const value = this.track(() => this.#evaluate(this.#getContext()));
      if (this.#pendingFailure) {
        // Same conversion as `#recompute`'s: a failure the run reported
        // while still on the stack is the run's own failure, thrown to the
        // reader once it has unwound.
        throw this.#pendingFailure.value;
      }
      return value;
    } finally {
      this.#evaluating = false;
      this.#pendingFailure = null;
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
        fail: (err) => {
          if (this.#evaluating) {
            this.#pendingFailure = this.#pendingFailure ?? { value: err };
            return;
          }
          this.fail(err);
        },
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
   * A `Derived` fed by work that runs for as long as the node is live.
   *
   * The escape hatch for a value that the graph cannot compute — one that
   * arrives from outside, later, possibly many times. `start` runs when the
   * first reader arrives and its teardown runs when the last one leaves, and
   * the context it is handed is the *only* way in: `setValue` lands a value,
   * `fail` ends the node.
   *
   * Nothing here bends the node's contract, because the value lands through
   * a `Signal` the node reads. A read before the first `setValue` throws
   * `NoValueError` — "not yet", which an effect answers by waiting — so a
   * read never has to block on work that has not finished. A `setValue` is
   * an ordinary write: it batches, it invalidates through the normal edge,
   * and the node's own `isEqual` still decides whether dependents hear about
   * it. Dormancy tears the work down, and the next reader starts it afresh —
   * which is why `start` is a function and not a subscription taken here and
   * now; the last value landed stays behind meanwhile, answering an early
   * reader until the restarted work brings fresh news, which is the bargain
   * `from` has always struck. And `fail` is `ReactiveNode`'s `fail`:
   * terminal, the way a source that died is terminal.
   *
   * A `start` that throws on the way in fails the node the same way — the
   * first reader is told, synchronously.
   *
   * This is `from` generalised from "an observable" to "anything that can
   * call two functions": a WebSocket handler, a `ResizeObserver`, a promise
   * chain. If what feeds the node is already an observable, `from` says so
   * more directly.
   *
   * @template TValue
   * @typedef {object} LiveContext
   * @property {(value: TValue) => void} setValue land a value: readers are
   *   invalidated through the ordinary write path, and the next read returns
   *   it.
   * @property {(err: unknown) => void} fail end the node, terminally, the
   *   way a foreign source erroring would.
   */

  /**
   * @template TValue
   * @param {(context: LiveContext<TValue>) => (void | (() => void))} start
   * @param {DerivedOptions<TValue>} [options]
   * @returns {Derived<TValue>}
   */
  static live(start, options = {}) {
    /** @type {Signal<TValue>} */
    const signal = new Signal();
    /** @type {Derived<TValue>} */
    const derived = new Derived(() => signal.get(), options);
    derived.addResource(
      resource(() =>
        start({
          setValue: (value) => signal.set(value),
          fail: (err) => derived.fail(err),
        }),
      ),
    );
    return derived;
  }

  /**
   * A `Derived` fed by an observable.
   *
   * The observable is a **source**, held open for exactly as long as somebody
   * is reading the node: it writes into a signal, and the node reads the
   * signal. There is deliberately nothing clever here — the boundary between
   * this library and RxJS is a source on one side and a sink on the other,
   * and never a node in the middle whose place in the graph has to be
   * guessed at. `live` above is this with the observable generalised away,
   * and this is `live` applied to one.
   *
   * @template TValue
   * @param {Subscribable<TValue>} observable
   * @param {object} [options]
   * @param {number} [options.cacheTTL]
   * @returns {Derived<TValue>}
   */
  static from(observable, options = {}) {
    return Derived.live(
      ({ setValue, fail }) => {
        const subscription = observable.subscribe({
          next: setValue,
          error: fail,
        });
        return () => subscription.unsubscribe();
      },
      { cacheTTL: options.cacheTTL },
    );
  }
}

export default Derived;
