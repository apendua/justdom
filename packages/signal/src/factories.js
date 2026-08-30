import { Observable } from "rxjs";
import { Derived } from "./Derived.js";
import { useEffect } from "./Effect.js";
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
 * An entity with `effects` mounted on it, shared among its subscribers for as
 * long as any of them stays.
 *
 * This used to be spelled with RxJS — a cold source piped through operators
 * into `share({ connector: () => new ReplaySubject(1), resetOnRefCountZero:
 * true })`. Every piece of that machinery is a description of a node's
 * lifetime: connect lazily when the first reader arrives, multicast, replay
 * the value to a late one, tear down and start afresh when the last one
 * leaves. So the sharing is a `Derived` now, and the effects mount *inside its
 * evaluation*: the node's cleanups take them down on disconnect, and — by the
 * node's own equality cutoff — a re-evaluation that lands on the same entity
 * keeps the standing mounting rather than rebuilding it.
 *
 * The first argument is the entity, or a **factory** for one. A factory runs
 * inside the evaluation, so the entity is created per mounting cycle rather
 * than when `just` is called — which is what a DOM tree needs: an element
 * claimed or created at mount time, a fresh one for the next mounting, and
 * hydration's cursor walked in subscription order. An instance is for entities
 * whose identity precedes the mounting — a `THREE.Mesh` built with its own
 * constructor arguments. Anything callable is treated as a factory.
 *
 * A mounted effect that fails on the way in fails the evaluation — the pull
 * path, retryable, handed to whoever is reading. One that fails *later* fails
 * the node — the push path, terminal for the node — and the next subscriber
 * is handed a fresh mounting rather than a replay of the failure, which is
 * what `share`'s reset used to do.
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
    // Nothing to mount and nothing to share: a constant needs no node.
    return new Observable((/** @type {Subscriber<T>} */ subscriber) => {
      subscriber.next(/** @type {T} */ (valueOrFactory));
    });
  }
  /** @type {Derived<T> | null} */
  let node = null;
  return new Observable((/** @type {Subscriber<T>} */ subscriber) => {
    if (!node || node.failure) {
      // A node's failure is terminal — a reader arriving afterwards is handed
      // the same error — where `share` reset and let the next subscriber try
      // again. The node is the sharing here, so matching that means a new
      // node; everything it mounts is built afresh by its first evaluation.
      node = justNode(valueOrFactory, effects);
    }
    return toObservable(node).subscribe(subscriber);
  });
}

/**
 * The node behind `just`: entity and mounting in one evaluation.
 *
 * @template T
 * @param {T | (() => T)} valueOrFactory
 * @param {EntityEffect<T>[]} effects
 * @returns {Derived<T>}
 */
function justNode(valueOrFactory, effects) {
  /** @type {Derived<T>} */
  const node = new Derived(() => {
    const entity =
      typeof valueOrFactory === "function"
        ? /** @type {() => T} */ (valueOrFactory)()
        : valueOrFactory;
    for (const fn of effects) {
      // Each entry is its own `Effect`, so one re-runs without the others.
      // `useEffect` ties its disposal to this evaluation's cleanups, which is
      // the mounting's lifetime: run again on reconnect, undone on disconnect.
      let standing = false;
      useEffect(() => fn(entity), {
        name: "just",
        onError: (err) => {
          if (!standing) {
            // Still on this evaluation's stack: the throw fails the
            // evaluation, which is retryable and lands on whoever is reading.
            throw err;
          }
          // News from a mounting that was already up — a re-run throwing, or
          // a failure reported after the fact. There is no read on the stack
          // to hand it to; it travels the push path and takes the node with
          // it.
          node.fail(err);
        },
      });
      standing = true;
    }
    return entity;
  });
  return node;
}
