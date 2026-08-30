import { Observable } from "rxjs";
import { Effect } from "./Effect.js";
import { withComputation } from "./core.js";
import { Derived } from "./Derived.js";

/**
 * @import {Subscribable, Source} from "./subscribable.js";
 * @import ReactiveNode from "./Node.js";
 */

/**
 * The node behind each observable `toObservable` has handed out.
 *
 * For consumers that hold the observable but want the node — `use` being the
 * one that matters: keeping a node-backed observable subscribed does not need
 * values pushed through an effect just to be thrown away, it needs the node
 * held live and its failure heard. A WeakMap rather than a property so the
 * observable stays exactly what it claims to be.
 *
 * @type {WeakMap<object, ReactiveNode>}
 */
const backingNodes = new WeakMap();

/**
 * The node `observable` is a view of, if `toObservable` made it.
 *
 * @param {Subscribable<unknown> | Source<unknown>} observable
 * @returns {ReactiveNode | undefined}
 */
export function nodeOf(observable) {
  return backingNodes.get(observable);
}

/**
 * A node, as an observable of its values.
 *
 * This is a **sink**: an `Effect` per subscriber, reading the node and
 * pushing what it read. Which is the only honest way to spell it — an
 * observable emits on a schedule and a `Derived` has none, so something has
 * to decide when to look, and deciding when to look is what an effect is.
 *
 * Note what is *not* here. There is no attempt to make the resulting
 * observable act as a node of the graph, or to carry the node's position in
 * the graph across the boundary, because nothing downstream needs it: an
 * observable read back into the graph is a source, and a source is ordered by
 * nothing. The previous implementation had a depth number that this wrapper
 * silently dropped, which quietly mis-scheduled every diamond that crossed
 * it. There is no number to drop any more.
 *
 * @template T
 * @param {ReactiveNode & { get: () => T }} node
 * @returns {Source<T>}
 */
export function toObservable(node) {
  const observable = new Observable((/** @type {import("rxjs").Subscriber<T>} */ subscriber) => {
    // The effect below hears the node's *values*; it cannot hear the node
    // *fail*. Failure makes a node part ways with its dependents, and what
    // the orphaned effect sees afterwards is a `NoValueError` — "not yet" —
    // so it would wait forever for news that cannot come. Failure travels
    // the observer channel, so the subscriber keeps an ear there — taken
    // *first*, so a node that fails during the very evaluation the effect
    // triggers is heard rather than reported as unhandled.
    const failures = node.subscribe({
      error: (err) => subscriber.error(err),
    });
    if (subscriber.closed) {
      // Subscribing replayed a stored failure; there is nothing to read.
      return () => {
        failures.unsubscribe();
      };
    }
    const effect = new Effect(
      () => {
        const value = node.get();
        // The subscriber's `next` may run arbitrary application code, and
        // whatever that code reads is not this effect's business.
        withComputation(null, () => {
          subscriber.next(value);
        });
      },
      {
        name: "toObservable",
        onError: (err) => subscriber.error(err),
      },
    );
    return () => {
      failures.unsubscribe();
      effect.dispose();
    };
  });
  backingNodes.set(observable, node);
  return observable;
}

/**
 * Work, as an observable that never emits.
 *
 * The shape the operator layer wants: something to `subscribe` to that runs
 * side effects for as long as it is subscribed, re-running them when what
 * they read changes, and reports a failure the one way an observable can.
 *
 * @param {import("./Effect.js").EffectRun} fn
 * @param {{ name?: string }} [options]
 * @returns {Source<never>}
 */
export function toEffect(fn, options = {}) {
  return new Observable((subscriber) => {
    const effect = new Effect(fn, {
      name: options.name ?? "toEffect",
      onError: (err) => subscriber.error(err),
    });
    return () => {
      effect.dispose();
    };
  });
}

/**
 * An observable, as a source this graph can depend on.
 *
 * The inverse of `toObservable`, and deliberately the only other thing at the
 * boundary: values come in as a source, values go out through an effect, and
 * nothing in between pretends to be a node.
 *
 * @template T
 * @param {Subscribable<T>} observable
 * @param {object} [options]
 * @param {number} [options.cacheTTL]
 * @returns {import("./Derived.js").Derived<T>}
 */
export function fromObservable(observable, options) {
  return Derived.from(observable, options);
}
