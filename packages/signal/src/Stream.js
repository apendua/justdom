/**
 * @import { Observer, Unsubscribable, Source } from "./subscribable.js";
 */

/**
 * The key an RxJS `from()` looks for when it is handed something that is not
 * one of its own. Computed the way RxJS computes it — `Symbol.observable`
 * where the runtime has it, the string otherwise — so that a `Stream` lifts
 * through `from()` without this module importing RxJS to find out.
 *
 * @type {symbol | string}
 */
export const interopSymbol =
  (typeof Symbol === "function" && /** @type {any} */ (Symbol).observable) || "@@observable";

/**
 * What a `Stream`'s subscribe function is given: somewhere to put values, and
 * a way to ask whether anyone is still listening.
 *
 * `closed` is not decoration. A source that replays a stored failure the
 * moment it is subscribed leaves nothing to set up, and the only way to know
 * that is to ask — `toObservable` does exactly this before it builds an
 * effect that would have nothing to read.
 *
 * `add` is the other thing a source reaches for: a subscribe function that
 * acquires several things wants to hand back several teardowns, and saying so
 * as it goes is clearer than accumulating a list to return at the end. What
 * is added after the subscription has closed is undone at once, because the
 * alternative is a leak.
 *
 * @template T
 * @typedef {object} Subscriber
 * @property {(value: T) => void} next
 * @property {(err: unknown) => void} error
 * @property {() => void} complete
 * @property {(teardown: Teardown) => void} add
 * @property {boolean} closed
 */

/**
 * What a subscribe function may hand back to be undone later: a function, an
 * object with `unsubscribe`, or nothing at all.
 *
 * @typedef {(() => void) | Unsubscribable | void} Teardown
 */

/**
 * An error nobody was listening for.
 *
 * Thrown from a fresh task rather than swallowed, and rather than thrown
 * here: the caller of `next` — application code, a scheduler, a DOM event
 * handler — has no business receiving somebody else's failure on its own
 * stack. This is what RxJS does with an unhandled `error`, and losing that
 * behaviour would turn a loud bug into a silent one.
 *
 * @param {unknown} err
 * @returns {void}
 */
function reportUnhandledError(err) {
  setTimeout(() => {
    throw err;
  });
}

/**
 * One subscription to a `Stream`: the subscriber the source writes into, and
 * the handle the subscriber holds, which are deliberately the same object.
 *
 * @template T
 * @implements {Subscriber<T>}
 */
class StreamSubscription {
  /** @type {Partial<Observer<T>>} */
  #observer;

  /**
   * Everything owed, in the order it was taken on. The teardown the subscribe
   * function returns goes on the end, which is where RxJS puts it too: what a
   * source acquired first is undone first.
   *
   * @type {Teardown[]}
   */
  #teardowns = [];

  #closed = false;

  /**
   * @param {Partial<Observer<T>>} observer
   */
  constructor(observer) {
    this.#observer = observer;
  }

  get closed() {
    return this.#closed;
  }

  /**
   * @param {T} value
   * @returns {void}
   */
  next(value) {
    if (this.#closed) {
      return;
    }
    this.#observer.next?.(value);
  }

  /**
   * @param {unknown} err
   * @returns {void}
   */
  error(err) {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#observer.error) {
      this.#observer.error(err);
    } else {
      reportUnhandledError(err);
    }
    this.#undo();
  }

  /**
   * @returns {void}
   */
  complete() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#observer.complete?.();
    this.#undo();
  }

  /**
   * @returns {void}
   */
  unsubscribe() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#undo();
  }

  /**
   * @param {Teardown} teardown
   * @returns {void}
   */
  add(teardown) {
    if (!teardown) {
      return;
    }
    if (this.#closed) {
      undo(teardown);
      return;
    }
    this.#teardowns.push(teardown);
  }

  /**
   * Run the source, and hold on to whatever it wants undone.
   *
   * A source may terminate before it returns — a node replaying a stored
   * failure does, and so does anything that throws on the way in — and the
   * teardown it hands back is *still* owed, because the resources it names
   * were acquired before the failure. So the closed case is checked after
   * the call, not only before it, and a throw is routed the way a source's
   * own `error` would have been.
   *
   * @param {(subscriber: Subscriber<T>) => Teardown} onSubscribe
   * @returns {void}
   */
  run(onSubscribe) {
    /** @type {Teardown} */
    let teardown;
    try {
      teardown = onSubscribe(this);
    } catch (err) {
      this.error(err);
      return;
    }
    this.add(teardown);
    if (this.#closed) {
      this.#undo();
    }
  }

  /**
   * Exactly once each, and taken off the list before they run, so that a
   * teardown which unsubscribes something that unsubscribes this cannot come
   * back round.
   *
   * One that throws does not strand the rest: they all run, and the first
   * failure is raised once they have.
   *
   * @returns {void}
   */
  #undo() {
    const teardowns = this.#teardowns;
    this.#teardowns = [];
    /** @type {{ value: unknown } | null} */
    let failure = null;
    for (const teardown of teardowns) {
      try {
        undo(teardown);
      } catch (err) {
        failure = failure ?? { value: err };
      }
    }
    if (failure) {
      throw failure.value;
    }
  }
}

/**
 * @param {Teardown} teardown
 * @returns {void}
 */
function undo(teardown) {
  if (!teardown) {
    return;
  }
  if (typeof teardown === "function") {
    teardown();
  } else {
    teardown.unsubscribe();
  }
}

/**
 * A cold source: a subscribe function, run once per subscriber, that pushes
 * values and says how to undo itself.
 *
 * This is what the package used `new Observable(...)` for, and all it used it
 * for. Everything the core builds is cold — a subscription *is* a mounting,
 * as `just` puts it — so there is no multicast here, no replay, no refcount;
 * `Subject` is next door for the push side, and sharing is a node's job
 * (`memoize`, `memoizeDerived`), which is where this package decided it
 * belongs.
 *
 * The semantics are RxJS's, because that is what every call site was written
 * against: values stop at the first `error` or `complete`, the teardown runs
 * exactly once and runs even when the source failed on the way in, a throw
 * from the subscribe function reaches the observer's `error`, and an error
 * nobody handles is reported rather than swallowed.
 *
 * It carries the interop key, so `rx()` — and any other RxJS `from()` — lifts
 * one into an `Observable` when a call site genuinely wants RxJS operators.
 *
 * @template T
 * @implements {Source<T>}
 */
export class Stream {
  /** @type {(subscriber: Subscriber<T>) => Teardown} */
  #onSubscribe;

  /**
   * @param {(subscriber: Subscriber<T>) => Teardown} onSubscribe
   */
  constructor(onSubscribe) {
    this.#onSubscribe = onSubscribe;
  }

  /**
   * @param {Partial<Observer<T>> | ((value: T) => void)} [observerOrNext]
   * @returns {Unsubscribable}
   */
  subscribe(observerOrNext) {
    const observer =
      typeof observerOrNext === "function" ? { next: observerOrNext } : (observerOrNext ?? {});
    const subscription = new StreamSubscription(observer);
    subscription.run(this.#onSubscribe);
    return subscription;
  }

  /**
   * @returns {Stream<T>}
   */
  [interopSymbol]() {
    return this;
  }
}
