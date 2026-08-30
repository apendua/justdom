import { Observable, from } from "rxjs";

/**
 * @import { Subscribable } from "./subscribable.js";
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
