import { Derived } from "./Derived.js";
import { useEffect } from "./Effect.js";
import { onEachValue, subscribeTo, each } from "./util.js";
import { observable, component } from "./factories.js";
import { addDependency, onCleanup, withComputation } from "./core.js";
import { toObservable, nodeOf } from "./interop.js";

/**
 * @import { Observable } from 'rxjs';
 * @import ReactiveNode from './Node.js';
 * @import { WritableProps, EntityEffect } from './types.js';
 */

/**
 * Run `fn` against the entity, and keep re-running it whenever anything it
 * read changes.
 *
 * An `EntityEffect` *is* that already — every entry of a mounting is the body
 * of its own `Effect` — so this is the identity, kept because a call site
 * that says `effects(fn)` says what the function is for. A plain lambda in
 * the same position means exactly the same thing.
 *
 * @template T
 * @param {(value: T) => void} fn
 * @returns {EntityEffect<T>}
 */
export function effects(fn) {
  return fn;
}

/**
 * @template T
 * @returns {(source: Observable<T>) => Observable<never>}
 */
export function takeNothing() {
  return onEachValue(null);
}

/**
 * @template T, U
 * @param {(value: T) => U} fn
 * @returns {(source: Observable<T>) => Observable<U>}
 */
export function map(fn) {
  return onEachValue(subscribeTo((value) => observable(() => fn(value))));
}

/**
 * @template T, U
 * @param {(value: T) => Observable<U>} fn
 * @returns {(source: Observable<T>) => Observable<U>}
 */
export function flatMap(fn) {
  return onEachValue(subscribeTo(component(fn)));
}

/**
 * Keep whatever observable `fn` hands back subscribed for as long as the
 * entity stays mounted.
 *
 * The subscription is taken directly rather than through `use`, for the sake
 * of where its errors go. One that arrives while the subscribe is still on
 * this run's stack is *thrown* — it fails the mounting synchronously, which
 * is what lets a hydration mismatch be caught before `subscribe` returns.
 * One that arrives later goes through `context.fail`, and lands where a
 * failed mounting lands.
 *
 * @template T
 * @param {(value: T) => Observable<unknown>} fn
 * @returns {EntityEffect<T>}
 */
export function effectMap(fn) {
  return (entity, { fail }) => {
    let sync = true;
    /** @type {{ value: unknown } | null} */
    let failure = null;
    // Non-reactive, because subscribing is not reading: a foreign observable's
    // `subscribe` may read reactive things — a `component(...)` builds its
    // entities in there — and those belong to it, not to this mounting.
    // Tracking them would tear the subscription down and back up on a write
    // the mounting never looked at, which in freedom means rebuilding a
    // subtree. `toObservable` keeps the same rule around its `next`, which is
    // what made this safe while the pipeline still ran through one.
    const subscription = withComputation(null, () =>
      fn(entity).subscribe({
        error: (err) => {
          if (sync) {
            failure = failure ?? { value: err };
          } else {
            fail(err);
          }
        },
      }),
    );
    sync = false;
    onCleanup(() => subscription.unsubscribe());
    if (failure) {
      throw /** @type {{ value: unknown }} */ (failure).value;
    }
  };
}

/**
 * @template {object} TEntity
 * @template {keyof WritableProps<TEntity>} K
 * @overload
 * @param {K} key
 * @param {Observable<TEntity[K]> | (() => TEntity[K])} value
 * @returns {EntityEffect<TEntity>}
 */

/**
 * @template {object} TEntity
 * @overload
 * @param {Partial<WritableProps<TEntity>>} values
 * @returns {EntityEffect<TEntity>}
 */

/**
 * @template {object} TEntity
 * @template {keyof WritableProps<TEntity>} K
 * @param {K|Partial<WritableProps<Record<string, unknown>>>} keyOrValues
 * @param {Observable<unknown> | (() => unknown)} [value]
 * @returns {EntityEffect<Record<string, unknown>>}
 */
export function set(keyOrValues, value) {
  if (typeof keyOrValues === "object") {
    return (entity) => {
      Object.assign(entity, keyOrValues);
    };
  }
  if (!value) {
    throw new Error("Value observable is required when key is provided.");
  }
  if (typeof value === "function") {
    const valueFn = value;
    return (entity) => {
      // A `Derived` in front of the assignment for its equality cutoff, which
      // is what the observable this used to route through was providing: a
      // recomputation that lands on the value already written writes nothing.
      const source = new Derived(() => valueFn());
      useEffect(() => {
        entity[keyOrValues] = source.get();
      });
    };
  }
  const source = value;
  return effectMap((entity) =>
    each(source, (v) => {
      entity[keyOrValues] = v;
    }),
  );
}

/**
 * Mount `effects` on `value` for as long as the surrounding computation
 * stands.
 *
 * This is `just(value, effects)` minus the sharing: the computation is the
 * one holder, so there is no node, no observable, and nothing per subscriber
 * — each entry becomes an `Effect` owned by the computation, and a failure
 * edge is all that connects them back. A store built without operators pays
 * for nothing at all.
 *
 * @template T
 * @param {T} value
 * @param  {EntityEffect<T>[]} effects
 * @returns {void}
 */
export function useEffects(value, effects) {
  for (const fn of effects) {
    mountEffect(value, fn);
  }
}

/**
 * @template T
 * @param {T} value
 * @param {EntityEffect<T>} fn
 * @returns {void}
 */
function mountEffect(value, fn) {
  let standing = false;
  const effect = useEffect((context) => fn(value, context), {
    name: "useEffects",
    onError: (err) => {
      if (!standing) {
        // Still on the builder's stack — the throw fails whatever is
        // mounting, exactly where a synchronous failure belongs.
        throw err;
      }
      // Later news fails the effect, whose failure the dependency edge below
      // carries to the computation — where a pipeline error used to land.
      effect.fail(err);
    },
  });
  standing = true;
  addDependency(failuresOf(effect));
}

/**
 * A dependency that never marks the computation stale: it forwards only the
 * failure of what it watches. Liveness without listening.
 *
 * @param {{ subscribe: ReactiveNode['subscribe'] }} subscribable
 * @returns {{ subscribe: ReactiveNode['subscribe'] }}
 */
export function failuresOf(subscribable) {
  return {
    subscribe: (observer) =>
      subscribable.subscribe({
        error: (err) => observer.error?.(err),
      }),
  };
}

/**
 * Hold an observable open for as long as the surrounding computation stands,
 * for its side effects alone — whatever it emits is dropped.
 *
 * A dependency edge and nothing more: the computation attaches it on connect
 * and lets go of it when it goes dormant, which is the lifetime the caller
 * wanted. `takeNothing()` is what says the values are not the point.
 *
 * This used to take a callback too, running it as an effect and keeping
 * whatever observable it handed back subscribed until the next run. The
 * callers who had an observable to switch between runs never materialised;
 * the ones with only side effects all did, and every one of them is better
 * served by `useEffect` — the same `Effect`, disposed by the same
 * computation, without an observable in the middle for it to be subscribed
 * through, and reading a returned function as a teardown rather than as
 * something to subscribe. A function arriving here is now a mistake with a
 * name on it, rather than a `TypeError` from inside the first run that
 * happens to return one.
 *
 * @param {Observable<unknown>} observable
 */
export function use(observable) {
  if (typeof observable === "function") {
    throw new TypeError(
      "use() takes an observable. A callback that only has side effects wants " +
        "useEffect(fn): the same effect, disposed by the same computation.",
    );
  }
  const node = nodeOf(observable);
  if (node) {
    // A node-backed observable does not need its values pushed through an
    // effect just to be thrown away here. Keeping it subscribed means keeping
    // the node live and its failure heard, and a bare subscription does both.
    addDependency(failuresOf(node));
    return;
  }
  addDependency(observable.pipe(takeNothing()));
}

/**
 * @template {object} T
 * @typedef {{
 *   readonly [K in keyof T as T[K] extends (...args: any[]) => any ? never : K]-?:
 *     Observable<T[K]>
 * }} Observe
 */

/**
 * @template {object} T
 * @overload
 * @param {T} target
 * @returns {Observe<T>}
 */

/**
 * @param {Record<PropertyKey, unknown>} target
 */
export function observe(target) {
  return new Proxy(target, {
    get(_1, name) {
      return toObservable(new Derived(() => target[name]));
    },
  });
}

/**
 * @template {object} T
 * @typedef {{
 *   readonly [K in keyof T as T[K] extends (...args: any[]) => infer R
 *     ? R extends void
 *       ? never
 *       : K
 *     : never
 *   ]-?:
 *     T[K] extends (...args: infer U) => any
 *       ? (...args: U) => Observable<ReturnType<T[K]>>
 *       : never
 * }} ObserveFn
 */

/**
 * @template {object} T
 * @overload
 * @param {T} target
 * @returns {ObserveFn<T>}
 */

/**
 * @param {Record<PropertyKey, unknown>} target
 */
export function observeFn(target) {
  return new Proxy(target, {
    get(_1, name) {
      return new Proxy(new Function(), {
        apply(_2, _3, args) {
          return toObservable(
            new Derived(() => {
              if (typeof target[name] !== "function") {
                throw new Error(`Property ${String(name)} is not a function.`);
              }
              return target[name](...args);
            }),
          );
        },
      });
    },
  });
}
