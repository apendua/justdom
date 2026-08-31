import { Observable, from } from "rxjs";
import { mountEach } from "./operators.js";

/**
 * @import { MonoTypeOperatorFunction } from "rxjs";
 * @import { Subscribable } from "./subscribable.js";
 * @import { EntityEffect } from "./types.js";
 */

/**
 * Carries a `Source` into RxJS, so an operator can be applied to it.
 *
 * The core's own types never name RxJS: a factory answers with a `Source`,
 * and a `Source` says nothing about `pipe`, because an RxJS operator needs an
 * RxJS `Observable` to lift. This is the crossing, and it is deliberately a
 * function rather than a cast at every call site — a pipeline that starts
 * with `rx(...)` is a pipeline that has said, visibly, that it is leaving the
 * graph's vocabulary.
 *
 * Today it is the identity: every `Source` the package builds still is a
 * genuine `Observable` at runtime. The day that stops being true, the `from`
 * branch takes over — a `Source` that answers `Symbol.observable` lifts
 * through it — and no call site moves.
 *
 * Lives on its own subpath (`@apendua/signal/rxjs`) so that the package root
 * stays free of RxJS types, and so that this module can one day keep `rxjs`
 * as its own optional dependency after the core has dropped it.
 *
 * @template T
 * @param {Subscribable<T>} source
 * @returns {Observable<T>}
 */
export function rx(source) {
  if (source instanceof Observable) {
    return source;
  }
  return /** @type {Observable<T>} */ (from(/** @type {any} */ (source)));
}

/**
 * `mountEach` from the core, carried into RxJS: an entity effect lifted over
 * a stream of entities, answering with something an RxJS pipeline can go on
 * piping.
 *
 * It lives here rather than in the core because what it produces is an RxJS
 * operator: `MonoTypeOperatorFunction` is an RxJS type, and a call site that
 * pipes with it is an RxJS pipeline. The core's `effects` names no RxJS type,
 * and the two are named apart so that a mounting entry and a pipeline stage
 * cannot be mistaken for one another.
 *
 * @template T
 * @param {EntityEffect<T>} fn
 * @returns {MonoTypeOperatorFunction<T>}
 */
export function rxEffects(fn) {
  const operator = mountEach(fn);
  // Through `rx()`, not a cast. What the core's operators build is a `Stream`,
  // and the next operator in an RxJS `.pipe()` will try to *lift* whatever
  // this hands back — `takeUntil(rxEffects(…)(source))` is a real call site —
  // which only an RxJS `Observable` survives. A cast here would compile and
  // then throw "Unable to lift unknown Observable type" at runtime, which is
  // exactly what it did.
  return (source) => rx(operator(source));
}
