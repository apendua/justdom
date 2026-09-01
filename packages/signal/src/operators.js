import { Derived } from "./Derived.js";
import { useEffect, failuresOf } from "./Effect.js";
import { onEachValue, subscribeTo, subscribeAndEmit, each } from "./util.js";
import { observable, component } from "./factories.js";
import { addDependency, onCleanup, withComputation } from "./core.js";
import { toObservable, toEffect, nodeOf } from "./interop.js";

// Moved to `Effect.js`, where `useEffect` wires it; re-exported so existing
// importers keep their path.
export { failuresOf };

/**
 * @import { Subscribable, Source } from './subscribable.js';
 * @import { Operator, MonoTypeOperator } from './util.js';
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
 * An entity effect, lifted over a source of entities: mount `fn` on each value
 * the source produces, pass the value on with the mounting already standing,
 * take that mounting down when the next value arrives, and take the last one
 * down on unsubscribe.
 *
 * A mounting's array needs none of this — every entry there is the body of its
 * own `Effect` already, which is why `effects` above is the identity — but a
 * pipeline that *receives* entities rather than holding one does, and saying
 * the same thing as `flatMap` into an effect loses the value on the way
 * through.
 *
 * `rxEffects` in `@apendua/signal/rxjs` is this, carried into RxJS: same
 * mounting, an `Observable` to `.pipe()` on the way out.
 *
 * @template T
 * @param {EntityEffect<T>} fn
 * @returns {MonoTypeOperator<T>}
 */
export function mountEach(fn) {
  return onEachValue(
    subscribeAndEmit((value) => toEffect((context) => fn(value, context), { name: "mountEach" })),
  );
}

/**
 * @template T
 * @returns {Operator<T, never>}
 */
export function takeNothing() {
  return onEachValue(null);
}

/**
 * @template T, U
 * @param {(value: T) => U} fn
 * @returns {Operator<T, U>}
 */
export function map(fn) {
  return onEachValue(subscribeTo((value) => observable(() => fn(value))));
}

/**
 * @template T, U
 * @param {(value: T) => Subscribable<U>} fn
 * @returns {Operator<T, U>}
 */
export function flatMap(fn) {
  return onEachValue(subscribeTo(component(fn)));
}

/**
 * Keep whatever observable `fn` hands back subscribed for as long as the
 * entity stays mounted.
 *
 * ### What it is for, and what it is not for
 *
 * Two things, and a mounting wants this operator only when it needs both. The
 * callback *chooses* a source, reactively — it runs in a `Derived`, so a
 * choice that branches on reactive state is made again when that state moves
 * — and the chosen source is *held*, with its failure carried to the
 * mounting. Neither half is free, so:
 *
 * - A **getter** wants nothing here. `() => a.b` is a derivation, and
 *   `Derived` + `useEffect` writes what it reads with two pieces instead of
 *   five; `set` above and `write` in `@apendua/justdom`'s operators are both
 *   spelled that way. Wrapping a getter in `observable()` to feed it through
 *   here builds a node, an effect to push its values, a stream to consume
 *   them, a second node to choose that stream and a second effect to hold it,
 *   and the node at the bottom did the only work.
 * - A **source that is merely held**, with nothing chosen and nothing read
 *   back, wants `use` — one dependency edge, no `Derived`, no inner effect.
 *   That used to be unsafe during a mounting's first run, when a failure on
 *   the way in fell into a window nothing was watching; the window is closed —
 *   a failure landing mid-run is rethrown once the run unwinds, onto the
 *   builder's stack — so the only reason left to reach for this operator over
 *   `use` is one of the two above, or the ordering below.
 *
 * ### What the hand-rolled subscription still buys
 *
 * When the callback's choice changes, this operator unsubscribes the old
 * source *before* subscribing the new one: the previous run's `onCleanup`
 * fires on the way into the re-run, and the new subscribe happens inside it.
 * `use` orders it the other way — a dependency edge attaches during the run
 * and the stale one detaches in the bookkeeping afterwards — which a
 * refcounted source, or a DOM mounting that must vacate before its
 * replacement claims the same slot, would notice. `justdom`'s `children`
 * switches whole subtrees through here, so the ordering is load-bearing.
 *
 * The failure routing, by contrast, is no longer special. A failure that
 * arrives while the subscribe is still on this run's stack is *thrown*, which
 * lands in `just`'s own `try` — that is what lets a hydration mismatch be
 * caught before `subscribe` returns, quietly, with no unhandled-failure
 * report on the way. One that arrives later goes through `context.fail`, and
 * lands where a failed mounting lands. `operators.test.js` pins both — but
 * `use` in an entity effect now takes the same two paths, via the mounting
 * effect's own channels.
 *
 * @template T
 * @param {(value: T) => Subscribable<unknown>} fn
 * @returns {EntityEffect<T>}
 */
export function effectMap(fn) {
  return (entity, { fail }) => {
    // Two questions that look like one, and they get opposite answers.
    //
    // *Choosing* the observable is a read. A callback that branches on
    // reactive state — `if (dragState.get() || props.bodyType === null) return
    // NEVER` — has to run again when that state moves, and switch to whatever
    // it hands back; that is how a brick acquires its rigid body when the
    // board is made ready, and loses it while it is being carried. So the
    // callback lives in a `Derived`, which is what `component(fn)` gave it
    // when this was a stream operator.
    //
    // *Subscribing* to what it chose is not a read. Whatever the observable
    // touches on the way in belongs to it, not to this mounting, and tracking
    // it would tear the subscription down on a write the mounting never
    // looked at — which in freedom means rebuilding a subtree.
    const chosen = new Derived(() => fn(entity));
    let firstRun = true;
    useEffect(
      () => {
        const source = chosen.get();
        let sync = true;
        /** @type {{ value: unknown } | null} */
        let failure = null;
        const subscription = withComputation(null, () =>
          source.subscribe({
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
          if (firstRun) {
            // Still on the mounting's stack, so this reaches whoever is
            // subscribing — which is what lets a hydration mismatch be caught
            // before `subscribe` returns.
            throw /** @type {{ value: unknown }} */ (failure).value;
          }
          fail(/** @type {{ value: unknown }} */ (failure).value);
        }
      },
      { name: "effectMap" },
    );
    firstRun = false;
  };
}

/**
 * @template {object} TEntity
 * @template {keyof WritableProps<TEntity>} K
 * @overload
 * @param {K} key
 * @param {Subscribable<TEntity[K]> | (() => TEntity[K])} value
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
 * @param {Subscribable<unknown> | (() => unknown)} [value]
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
    return (entity, { fail }) => {
      // A `Derived` in front of the assignment for its equality cutoff, which
      // is what the observable this used to route through was providing: a
      // recomputation that lands on the value already written writes nothing.
      const source = new Derived(() => valueFn());
      // `onError` because a getter that throws on the *first* run throws into
      // the mounting, which handles it, while one that starts throwing on a
      // later run throws from the scheduler's flush, where nobody is waiting.
      // `fail` is the mounting's own channel, and it is where the observable
      // branch below has always landed.
      useEffect(
        () => {
          entity[keyOrValues] = source.get();
        },
        { name: "set", onError: fail },
      );
    };
  }
  const source = value;
  // `use` rather than `effectMap`: there is nothing to choose here — one
  // source, fixed for the life of the mounting — and nothing that has to
  // vacate before its replacement claims it, because the replacement is the
  // next value written over a property. One dependency edge does it.
  return (entity) => {
    use(
      each(source, (v) => {
        entity[keyOrValues] = v;
      }),
    );
  };
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
 * Mount one entity effect, with the mounting's failure policy.
 *
 * That policy is the whole reason this is not a bare `useEffect`: **a run
 * that fails once the mounting stands ends the mounting**, rather than
 * escaping to whoever happened to write. A mounted effect belongs to a
 * subscriber holding the entity, so a throw from one of its re-runs is news
 * for that subscriber — not for the unrelated `set()` three modules away
 * out of whose drain the throw would otherwise come. `effect.fail` is what
 * says so: it ends the effect, and `useEffect`'s failure edge carries that
 * to the computation, where a pipeline error used to land.
 *
 * The first run is exempt, and `standing` is what exempts it. Two reasons,
 * either sufficient. A first run still has the builder's stack underneath
 * it, which is a better place for a failure than any channel — it takes the
 * half-built mounting down synchronously — and that is precisely what an
 * `Effect` with no `onError` does unaided, so the `throw` below is
 * *restoring the default*, not choosing something else. It has to be
 * restored by hand because having an `onError` at all is what suppresses
 * that default, and the standing half needs one. The other reason is that
 * `effect` does not exist yet during the first run: its own initialiser is
 * what is running.
 *
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
        throw err;
      }
      effect.fail(err);
    },
  });
  standing = true;
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
 * @param {Subscribable<unknown>} observable
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
  addDependency(takeNothing()(observable));
}

/**
 * @template {object} T
 * @typedef {{
 *   readonly [K in keyof T as T[K] extends (...args: any[]) => any ? never : K]-?:
 *     Source<T[K]>
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
 *       ? (...args: U) => Source<ReturnType<T[K]>>
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
