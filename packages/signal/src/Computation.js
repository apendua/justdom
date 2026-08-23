import ReactiveNode from "./Node.js";
import { CLEAN, DIRTY } from "./core.js";

/**
 * A bare tracking scope: something that remembers what a function read and
 * passes on the news when any of it changes.
 *
 * Neither an input, a transformation nor an output — it has no value at all —
 * so it sits outside the three-way split the rest of this library is built
 * on. Two things want it anyway.
 *
 * A **relay**: a node standing in for a foreign source so that the source can
 * be shared, filtered or cached before the graph depends on it. That is what
 * `memoizeDependency` builds, and what a `ReactiveMap`'s per-key streams are
 * made of. A relay has no value, so it announces every invalidation and bumps
 * its version each time — a dependent resolving a `CHECK` against it must
 * conclude "changed", because there is nothing to compare.
 *
 * A **listener wrapper**: an event handler whose reactive reads should be
 * tracked and released with the listener, rather than leaking into whatever
 * happened to be evaluating when the event arrived.
 */
export class Computation extends ReactiveNode {
  /**
   * Run `fn` as this scope's evaluation, and consider the scope settled
   * afterwards so that the next invalidation is announced afresh.
   *
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  track(fn) {
    try {
      return super.track(fn);
    } finally {
      this.state = CLEAN;
    }
  }

  /**
   * @param {number} _state
   * @returns {void}
   */
  markStale(_state) {
    // Every time, not just on the way out of `CLEAN`. A node with a value can
    // let a second invalidation pass in silence, because the value is what
    // dependents will compare; this has nothing for them to compare, so
    // silence would read as "nothing changed".
    this.version += 1;
    this.state = DIRTY;
    this.invalidateDependents(DIRTY);
  }

  /**
   * Announce an invalidation nobody upstream asked for.
   *
   * @returns {void}
   */
  invalidate() {
    this.markStale(DIRTY);
  }
}

export default Computation;
