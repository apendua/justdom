import { Observable } from "rxjs";
import { Derived } from "./Derived.js";
import { Effect } from "./Effect.js";
import { toEffect, toObservable } from "./interop.js";
import { onEachValue, subscribeTo } from "./util.js";

/**
 * @import { Subscriber } from 'rxjs';
 * @import { EntityEffect } from './types.js';
 */

/**
 * A pure computation, as an observable of its values.
 *
 * A `Derived` for the value and an effect per subscriber to push it — see
 * `toObservable`. `fn` must be pure: it is a derivation, and it runs whenever
 * somebody looks.
 *
 * @template T
 * @param {() => T} fn
 * @return {Observable<T>}
 */
export function observable(fn) {
  return toObservable(new Derived(() => fn()));
}

/**
 * @template {unknown[]} TArgs
 * @template TValue
 * @param {(...args: TArgs) => Observable<TValue>} fn
 * @returns {(...args: TArgs) => Observable<TValue>}
 */
export function component(fn) {
  return (...args) => {
    return observable(() => fn(...args)).pipe(onEachValue(subscribeTo((value) => value)));
  };
}

/**
 * A component that produces nothing — all of its work is what it mounts on the
 * way through.
 *
 * `component` is for the thing that has something to hand back: a mesh, a
 * panel, a scene. Plenty do not. A root reads the scene from its context and
 * decorates it; a behaviour attaches listeners and moves things about; both are
 * finished by the time they return, and had to say so by returning `Nothing()`
 * — a value invented to satisfy a caller that had no use for it.
 *
 * So this is the same shape with the value taken out: a factory, subscribed for
 * as long as its work should stand and unsubscribed to take it down. That it is
 * still a factory returning an observable is the point, and not only for the
 * caller — it is the shape `$reloadable` swaps, so a module built out of these
 * is one hot reload can replace.
 *
 * @template {unknown[]} TArgs
 * @param {(...args: TArgs) => void} fn
 * @returns {(...args: TArgs) => Observable<never>}
 */
export function effectsOnly(fn) {
  return (...args) => toEffect(() => fn(...args), { name: "effectsOnly" });
}

/**
 * An entity with `effects` mounted on it, for as long as the subscriber
 * stays.
 *
 * **Cold, deliberately.** This used to be shared — `share({ connector: () =>
 * new ReplaySubject(1), resetOnRefCountZero: true })` — which made the
 * observable idempotent to subscription count: however many times a pipeline
 * subscribed it, the entity was decorated once. That guard mattered when
 * elements were created eagerly and a stray second subscription attached
 * every event handler twice; it has been vestigial since creation moved
 * inside the subscription, and it cost the semantics everything RxJS-shaped
 * that was left — multicast, replay, refcount. Now a subscription *is* a
 * mounting: each subscriber gets the factory run and the effects mounted for
 * itself, and takes them down on unsubscribe. A caller who really wants one
 * mounting served to many subscribers wants a node, and `memoize` /
 * `memoizeDerived` are the explicit tools for that.
 *
 * The first argument is the entity, or a **factory** for one. A factory runs
 * per subscription, so the entity is created at mount time — which is what a
 * DOM tree needs: an element claimed or created when the mounting is built, a
 * fresh one for every mounting, and hydration's cursor walked in subscription
 * order. An instance is for entities whose identity precedes the mounting — a
 * `THREE.Mesh` built with its own constructor arguments. Anything callable is
 * treated as a factory.
 *
 * Each entry of `effects` is its own `Effect`, so one re-runs without the
 * others. A failure while the mounting is being built — the factory or a
 * first run throwing, a subscription erroring on the way in — reaches the
 * subscriber synchronously, with everything already mounted taken down
 * again; later news arrives on the error channel and ends the mounting. A
 * subscriber arriving after another's failure simply builds its own
 * mounting, which is the retry `share`'s reset used to provide.
 *
 * @template T
 * @overload
 * @param {() => T} factory
 * @param {EntityEffect<T>[]} [effects]
 * @returns {Observable<T>}
 */

/**
 * @template T
 * @overload
 * @param {T} value
 * @param {EntityEffect<T>[]} [effects]
 * @returns {Observable<T>}
 */

/**
 * @template T
 * @param {T | (() => T)} valueOrFactory
 * @param {EntityEffect<T>[]} [effects]
 * @returns {Observable<T>}
 */
export function just(valueOrFactory, effects = []) {
  if (effects.length === 0 && typeof valueOrFactory !== "function") {
    // Nothing to mount: a constant needs no machinery at all.
    return new Observable((/** @type {Subscriber<T>} */ subscriber) => {
      subscriber.next(/** @type {T} */ (valueOrFactory));
    });
  }
  return new Observable((/** @type {Subscriber<T>} */ subscriber) => {
    /** @type {Array<{ dispose: () => void } | { unsubscribe: () => void }>} */
    const mounted = [];
    const dispose = () => {
      for (const held of mounted) {
        if ("dispose" in held) {
          held.dispose();
        } else {
          held.unsubscribe();
        }
      }
    };
    try {
      const entity =
        typeof valueOrFactory === "function"
          ? /** @type {() => T} */ (valueOrFactory)()
          : valueOrFactory;
      for (const fn of effects) {
        let standing = false;
        /** @type {{ value: unknown } | null} */
        let pending = null;
        const effect = new Effect((context) => fn(entity, context), {
          name: "just",
          onError: (err) => {
            if (!standing) {
              // Still on this mounting's stack: the throw lands below, takes
              // down whatever was already mounted, and reaches the subscriber
              // synchronously.
              throw err;
            }
            subscriber.error(err);
          },
        });
        mounted.push(effect);
        // A dependency of the mounted effect erroring fails the effect down
        // the push path, which never consults `onError` — so the mounting
        // keeps an ear on the observer channel. A failure from the first run
        // replays synchronously on subscribe, and lands in `pending` so it is
        // handled the way a thrown one is.
        mounted.push(
          effect.subscribe({
            error: (err) => {
              if (standing) {
                subscriber.error(err);
              } else {
                pending = pending ?? { value: err };
              }
            },
          }),
        );
        standing = true;
        if (pending) {
          throw /** @type {{ value: unknown }} */ (pending).value;
        }
      }
      subscriber.next(entity);
    } catch (err) {
      dispose();
      subscriber.error(err);
    }
    return dispose;
  });
}
