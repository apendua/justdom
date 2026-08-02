import { createProperty } from "@apendua/signal";
import { NEVER, Observable, ReplaySubject, shareReplay, switchMap, takeUntil } from "rxjs";
import { takeNothing } from "@apendua/signal";
import { withoutHydration } from "./hydrate.js";

/**
 * @import { Property } from "@apendua/signal";
 * @import { INode, Mountable } from "./types.js";
 */

/**
 * @template {INode<T>} T
 * @typedef {object} SuspendOptions
 * @property {() => Observable<Mountable<T>>} fallback
 */

/**
 * @template {INode<T>} T
 */
class Manager {
  /** @type {Set<Promise<unknown>>} */
  #promises = new Set();
  /** @type {ReplaySubject<boolean>} */
  #subject = new ReplaySubject(1);
  /** @type {SuspendOptions<T>} */
  #options;

  /**
   * @param {SuspendOptions<T>} options
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
   * @param {Observable<Mountable<T>>} content
   * @returns {Observable<Mountable<T>>}
   */
  render(content) {
    return new Observable((subscriber) => {
      const shared = content.pipe(shareReplay({ bufferSize: 1, refCount: true }));
      // Ensure that both content and fallback are always subscribed to,
      // so that their effects are applied and cleanup works correctly.
      //
      // The content is subscribed first, before anything is on screen. While
      // hydrating it must not claim anything: a synchronous server render can
      // only ever serialize the fallback, so the fallback is what the markup
      // holds, and the content has to build its own nodes and wait to be
      // swapped in.
      const keepAlive = new Observable((observer) =>
        withoutHydration(() => shared.pipe(takeNothing()).subscribe(observer)),
      );
      this.#subject
        .pipe(
          switchMap((value) => (value ? shared : this.#options.fallback())),
          takeUntil(keepAlive),
        )
        .subscribe(subscriber);
    });
  }
}

/** @type {Property<Manager<any>>} */
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
 * @template {INode<T>} T
 * @param {WeakKey} ctx
 * @param {SuspendOptions<T> | SuspendOptions<T>['fallback']} [fallbackOrOptions]
 * @returns {WeakKey}
 */
export function suspend(ctx, fallbackOrOptions) {
  /** @type {SuspendOptions<T>} */
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
 * @template {INode<T>} T
 * @param {WeakKey} ctx
 * @param {Observable<Mountable<T>>} content
 * @returns {Observable<Mountable<T>>}
 */
export function withFallback(ctx, content) {
  const manager = Context.get(ctx);
  return manager.render(content);
}
