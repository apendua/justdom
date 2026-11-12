import { Stream } from "./Stream.js";
import { Derived } from "./Derived.js";
import { Mounting } from "./Mounting.js";
import { withComputation } from "./core.js";
import { toEffect, toObservable } from "./interop.js";
import { onEachValue, subscribeTo } from "./util.js";

/**
 * @import { Subscribable, Source, Unsubscribable } from './subscribable.js';
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
 * @return {Source<T>}
 */
export function observable(fn) {
  return toObservable(new Derived(() => fn()));
}

/**
 * `TArgs` is bounded by `any[]`, not `unknown[]`, for a callback whose
 * parameters say no type, which is every one in plain JavaScript. TypeScript
 * gives such a parameter the bound's element type, and with `unknown` a
 * `ctx.get(...)` in the body would be an error. With `any` the body reads as
 * it would outside the call; a callback that annotates its parameters still
 * gets exactly those types.
 *
 * @template {any[]} TArgs
 * @template TValue
 * @param {(...args: TArgs) => Subscribable<TValue>} fn
 * @returns {(...args: TArgs) => Source<TValue>}
 */
export function component(fn) {
  return (...args) => {
    return onEachValue(subscribeTo((/** @type {Subscribable<TValue>} */ value) => value))(
      observable(() => fn(...args)),
    );
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
 * `TArgs` is bounded by `any[]` for the reason given at `component`.
 *
 * @template {any[]} TArgs
 * @param {(...args: TArgs) => void} fn
 * @returns {(...args: TArgs) => Source<never>}
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
 * Each entry of `effects` behaves as the body of its own `Effect`, so one
 * re-runs without the others. An entry is only given an `Effect` once it
 * reads something that can change; one that reads nothing runs once, and a
 * teardown it leaves is kept by the mounting (see `Mounting`). A failure
 * while the mounting is being built — the factory or a first run throwing,
 * a subscription erroring on the way in — reaches the subscriber
 * synchronously, with everything already mounted taken down again; later
 * news arrives on the error channel and ends the mounting. A subscriber
 * arriving after another's failure simply builds its own mounting, which is
 * the retry `share`'s reset used to provide.
 *
 * @template T
 * @overload
 * @param {() => T} factory
 * @param {EntityEffect<T>[]} [effects]
 * @returns {Source<T>}
 */

/**
 * @template T
 * @overload
 * @param {T} value
 * @param {EntityEffect<T>[]} [effects]
 * @returns {Source<T>}
 */

/**
 * @template T
 * @param {T | (() => T)} valueOrFactory
 * @param {EntityEffect<T>[]} [effects]
 * @returns {Source<T>}
 */
export function just(valueOrFactory, effects = []) {
  if (effects.length === 0 && typeof valueOrFactory !== "function") {
    // Nothing to mount: a constant needs no machinery at all.
    return new Stream((/** @type {import("./Stream.js").Subscriber<T>} */ subscriber) => {
      subscriber.next(/** @type {T} */ (valueOrFactory));
    });
  }
  return new Stream((/** @type {import("./Stream.js").Subscriber<T>} */ subscriber) => {
    /** @type {Unsubscribable | undefined} */
    let mounting;
    try {
      const entity =
        typeof valueOrFactory === "function"
          ? // Non-reactive, for the same reason attaching a foreign source is:
            // subscribing is not reading. A factory may read reactive state to
            // build its entity, and whichever computation happened to be
            // evaluating when somebody subscribed has no business depending on
            // what it read — it would be marked stale by a write it never
            // looked at, and in justdom-three that means rebuilding a subtree.
            withComputation(null, /** @type {() => T} */ (valueOrFactory))
          : valueOrFactory;
      // A failure while the mounting is being built is thrown by `mount`,
      // so it lands in the `catch` below and reaches the subscriber
      // synchronously, with everything already mounted taken down again.
      // Later news goes to the error channel and ends the mounting.
      mounting = mount(entity, effects, (err) => subscriber.error(err));
      subscriber.next(entity);
    } catch (err) {
      mounting?.unsubscribe();
      subscriber.error(err);
    }
    return mounting;
  });
}

/** What `mount` hands back when there was nothing to mount. */
const NOTHING_MOUNTED = { unsubscribe() {} };

/**
 * Mount `effects` on `entity`, and hand back the mounting, to be
 * unsubscribed when the effects should come down.
 *
 * This is the inside of `just`, for a holder that has the entity already
 * and has no use for an observable of it: a parent mounting the element
 * that is its child, say, which would otherwise subscribe to a `just` only
 * to be handed the node it could have made itself. The entries run as they
 * do in a `just`, each as the body of its own `Effect` (see `Mounting`).
 *
 * A failure while the effects are being mounted is thrown, with what was
 * mounted taken down again. One that arrives later goes to `onError`, and
 * the mounting stays up until the holder unsubscribes it.
 *
 * @template T
 * @param {T} entity
 * @param {EntityEffect<T>[]} effects
 * @param {(err: unknown) => void} onError
 * @returns {Unsubscribable}
 */
export function mount(entity, effects, onError) {
  if (effects.length === 0) {
    return NOTHING_MOUNTED;
  }
  /** @type {Mounting<T>} */
  const mounting = new Mounting(onError);
  try {
    for (const fn of effects) {
      mounting.mount(fn, entity);
    }
  } catch (err) {
    mounting.unsubscribe();
    throw err;
  }
  return mounting;
}
