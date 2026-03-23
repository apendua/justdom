import { createProperty } from "@apendua.dev/signal";
import { NEVER, Observable, ReplaySubject, shareReplay, switchMap, takeUntil } from "rxjs";
import { takeNothing } from "./operators.js";

/**
 * @import { Mountable } from "./types.js";
 */

/**
 * @typedef {object} SuspendOptions
 * @property {() => Observable<Mountable<Node>>} fallback
 */

class Manager {
  /** @type {Set<Promise<unknown>>} */
  #promises = new Set();
  /** @type {ReplaySubject<boolean>} */
  #subject = new ReplaySubject(1);
  /** @type {SuspendOptions} */
  #options;

  /**
   * @param {SuspendOptions} options
   */
  constructor(options) {
    this.#options = { ...options };
    this.add(Promise.resolve());
  }

  /**
   * @param {Promise<unknown>} promise
   */
  add(promise) {
    if (this.#promises.has(promise)) {
      return;
    }
    if (this.#promises.size === 0) {
      this.#subject.next(false);
    }
    this.#promises.add(promise);
    promise.finally(() => {
      this.#promises.delete(promise);
      if (this.#promises.size === 0) {
        this.#subject.next(true);
      }
    });
  }

  /**
   * @param {Observable<Mountable<Node>>} content
   * @returns {Observable<Mountable<Node>>}
   */
  render(content) {
    return new Observable((subscriber) => {
      const shared = shareReplay({ bufferSize: 1, refCount: true })(content);
      this.#subject
        .pipe(
          switchMap((value) => (value ? shared : this.#options.fallback())),
          // Ensure that both content and fallback are always subscribed to,
          // so that their effects are applied and cleanup works correctly.
          takeUntil(shared.pipe(takeNothing())),
        )
        .subscribe(subscriber);
    });
  }
}

const Context = createProperty(() => {
  return new Manager({
    // This effectively renders nothing while suspended.
    fallback: () => NEVER,
  });
});

/**
 * @param {WeakKey} ctx
 * @param {Promise<unknown>} promise
 * @returns {void}
 */
export function waitFor(ctx, promise) {
  const manager = Context.get(ctx);
  manager.add(promise);
}

/**
 * @param {WeakKey} ctx
 * @param {SuspendOptions | SuspendOptions['fallback']} [fallbackOrOptions]
 * @returns {WeakKey}
 */
export function suspend(ctx, fallbackOrOptions) {
  /** @type {SuspendOptions} */
  const options = {};
  if (typeof fallbackOrOptions === "function") {
    options.fallback = fallbackOrOptions;
  } else if (fallbackOrOptions) {
    Object.assign(options, fallbackOrOptions);
  }
  const manager = new Manager(options);
  ctx = Context.set(ctx, manager);
  return ctx;
}

/**
 * @param {WeakKey} ctx
 * @param {Observable<Mountable<Node>>} content
 * @returns {Observable<Mountable<Node>>}
 */
export function withFallback(ctx, content) {
  const manager = Context.get(ctx);
  return manager.render(content);
}
