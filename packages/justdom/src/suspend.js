import {
  createProperty,
  flatMap,
  fromObservable,
  observable,
  Signal,
  Stream,
  toObservable,
} from "@apendua/signal";
import { withoutHydration } from "./hydrate.js";

/**
 * @import { Property, Source, Subscribable } from "@apendua/signal";
 * @import { Mountable } from "./types.js";
 */

/**
 * Render nothing. What `NEVER` was for: a source that never says anything, so
 * nothing is put on screen and nothing is taken down again.
 *
 * @returns {Source<Mountable>}
 */
function nothing() {
  return new Stream(() => {});
}

/**
 * @typedef {object} SuspendOptions
 * @property {() => Subscribable<Mountable>} fallback
 */

/** Tracks what a subtree is still waiting for, and what to show meanwhile. */
class Manager {
  /** @type {Set<Promise<unknown>>} */
  #promises = new Set();
  /**
   * Whether everything this subtree was waiting for has arrived.
   *
   * A `Signal` rather than the `ReplaySubject(1)` this was: what a replay of
   * one buys is a reader arriving late still being told the current answer,
   * which is what a node holding a value *is*. The constructor settles it
   * before anybody can read it, so there is no "not yet" to represent.
   *
   * @type {Signal<boolean>}
   */
  #ready = new Signal();
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
      this.#ready.set(false);
    }
    this.#promises.add(promise);
    promise.finally(() => {
      this.#promises.delete(promise);
      if (this.#promises.size === 0) {
        this.#ready.set(true);
      }
    });
  }

  /**
   * @param {Subscribable<Mountable>} content
   * @returns {Source<Mountable>}
   */
  render(content) {
    return new Stream((subscriber) => {
      // `shareReplay({ bufferSize: 1, refCount: true })`, said as a node —
      // which is where this package keeps sharing, and the only site in it
      // that ever wanted a multicast operator. A node fed by one subscription
      // to `content` is the sharing; a node holding the value it was last
      // given is the replay; a node letting go when nothing reads it is the
      // refcount. Built per subscription, as the shared observable was, so a
      // second mounting of the same tree gets a content of its own.
      const node = fromObservable(content);
      const shared = toObservable(node);
      // The content is always subscribed, so that its effects are applied
      // once and its cleanup runs when the boundary goes, whichever branch is
      // showing. `takeUntil(keepAlive)` used to say this: a notifier that
      // never emits, held open for the life of the subscription. Holding the
      // node open says it directly. The fallback is not held: it is the
      // `flatMap` branch below while `ready` is false, and is unsubscribed
      // when the content is swapped in.
      //
      // The content is subscribed first, before anything is on screen. While
      // hydrating it must not claim anything: a synchronous server render can
      // only ever serialize the fallback, so the fallback is what the markup
      // holds, and the content has to build its own nodes and wait to be
      // swapped in.
      subscriber.add(
        withoutHydration(() =>
          node.subscribe({
            error: (err) => subscriber.error(err),
          }),
        ),
      );
      subscriber.add(
        flatMap((/** @type {boolean} */ isReady) => (isReady ? shared : this.#options.fallback()))(
          observable(() => this.#ready.get()),
        ).subscribe({
          next: (mountable) => subscriber.next(mountable),
          error: (err) => subscriber.error(err),
        }),
      );
    });
  }
}

/** @type {Property<Manager>} */
const Context = createProperty(() => {
  return new Manager({
    // This effectively renders nothing while suspended.
    fallback: nothing,
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
  // Same default the Context manager uses: render nothing while suspended.
  // Calling suspend() without a fallback previously left this empty, so
  // render() called this.#options.fallback() on undefined.
  const options = { fallback: nothing };
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
 * @param {Subscribable<Mountable>} content
 * @returns {Source<Mountable>}
 */
export function withFallback(ctx, content) {
  const manager = Context.get(ctx);
  return manager.render(content);
}
