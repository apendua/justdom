import { Subject } from "rxjs";
import { addDependency, withComputation } from "./core.js";

/**
 * @import { Unsubscribable } from "rxjs";
 * @import { Subscribable } from "./Computation.js";
 * @import UpdateQueue from "./UpdateQueue.js";
 */

/**
 * @typedef {object} UpdateChannelOptions
 * @property {string} [name] shown in diagnostics
 * @property {number} [order] major sort key; the default channel is 0
 * @property {Subscribable<unknown>} [trigger] when to attempt a drain pass
 * @property {boolean} [manual] drain only when `flush()` is called, with no
 *   trigger of its own — for a caller that drives several channels itself and
 *   wants to divide one budget between them
 * @property {number} [budget] milliseconds of wall clock one pass may spend
 * @property {() => number} [now] the clock, injectable so tests are deterministic
 * @property {number} [maxStalePasses] passes the budget may cut short in a row
 */

/**
 * A scheduling class for invalidations.
 *
 * The default channel runs the way this library always has: work queued in it
 * drains at the end of `batch()`, or immediately if there is no batch. A
 * channel built with a `trigger` does not — its work sits until the trigger
 * fires, and then drains for at most `budget` milliseconds, with whatever
 * does not fit waiting for the trigger after that. That is the point of the
 * thing: a panel mirrored into the DOM can be told to re-derive at a frame
 * boundary and within a frame's worth of time, rather than the instant its
 * inputs move.
 *
 * Channels are ordered, and the order is the major key the queue drains by —
 * every task in channel 0 before any task in channel 1, depth deciding within
 * a channel. That only makes sense while channels are **terminal**: a node
 * must not read a dependency from a later channel than its own, or it would
 * be scheduled before the value it reads, every pass. `Derived` warns about
 * such an edge when it first sees one.
 */
export default class UpdateChannel {
  /** @type {string} */
  #name;

  /** @type {number} */
  #order;

  /** @type {Subscribable<unknown> | undefined} */
  #trigger;

  /** @type {number} */
  #budget;

  /** @type {() => number} */
  #now;

  /** @type {boolean} */
  #manual;

  /** @type {number} */
  #maxStalePasses;

  /**
   * The queue this channel schedules in. A channel is bound to one the first
   * time anything is queued in it, and to nothing before that.
   *
   * @type {UpdateQueue | null}
   */
  #queue = null;

  /**
   * Whether the queue last told us this channel holds work. Only the boolean
   * is kept: the count is asked of the queue when wanted, so that this cannot
   * drift from it.
   *
   * @type {boolean}
   */
  #isPending = false;

  /** @type {boolean} */
  #isPaused = false;

  /**
   * Fires when this channel goes from holding no work to holding some, or
   * back. Only the transition is announced, never the count: a fan-out queues
   * hundreds of tasks in one pass, and waking every observer of the channel
   * once per task would cost more than the work being scheduled.
   *
   * @type {Subject<boolean>}
   */
  #toggles = new Subject();

  /**
   * The live subscription to `trigger`, held only while there is work for a
   * pass to do. An idle channel with a `requestAnimationFrame` trigger would
   * otherwise keep a frame loop running for as long as the app is open.
   *
   * @type {Unsubscribable | null}
   */
  #subscription = null;

  /**
   * @param {UpdateChannelOptions} [options]
   */
  constructor(options = {}) {
    const {
      name = "channel",
      order = 0,
      trigger,
      manual = false,
      budget = Infinity,
      now = () => performance.now(),
      maxStalePasses = 3,
    } = options;
    if (!Number.isInteger(order) || order < 0) {
      throw new RangeError("An update channel's order must be a non-negative integer");
    }
    this.#name = name;
    this.#order = order;
    this.#trigger = trigger;
    this.#manual = manual;
    this.#budget = budget;
    this.#now = now;
    this.#maxStalePasses = maxStalePasses;
  }

  get name() {
    return this.#name;
  }

  get order() {
    return this.#order;
  }

  get budget() {
    return this.#budget;
  }

  get now() {
    return this.#now;
  }

  get maxStalePasses() {
    return this.#maxStalePasses;
  }

  /** Whether this channel drives itself off a trigger. */
  get isTriggered() {
    return this.#trigger !== undefined;
  }

  /**
   * Whether this channel waits to be told to drain, rather than draining
   * because something was queued in it. A trigger is one way to be told; a
   * `manual` channel is told by whoever holds it, which is what lets several
   * channels share one budget instead of each spending its own.
   *
   * This is also why a source writing into such a channel needs no batch of
   * its own: between two drains it is already, in effect, permanently
   * batched.
   */
  get drainsOnDemand() {
    return this.#trigger !== undefined || this.#manual;
  }

  get isPaused() {
    return this.#isPaused;
  }

  /**
   * Whether this channel is holding invalidations that have not run yet.
   *
   * Reactive: a computation that reads this re-runs when the answer changes.
   * It means "something is queued", not "something will actually change" — a
   * `Derived` may recompute to an equal value and notify nobody, and finding
   * that out in advance would mean doing the very work the channel exists to
   * defer.
   */
  get hasPendingUpdates() {
    addDependency(this.#toggles);
    return this.#isPending;
  }

  /**
   * How many invalidations are queued in this channel.
   *
   * Deliberately **not** reactive — see `#toggles`. It is for diagnostics and
   * for tests; `hasPendingUpdates` is the one to build on.
   */
  get pendingCount() {
    return this.#queue?.pendingCountOf(this) ?? 0;
  }

  /**
   * Let triggers fire and do nothing. Work goes on accumulating; `resume()`
   * arms the channel again but does not itself drain it, since the next
   * trigger is about to.
   */
  pause() {
    this.#isPaused = true;
  }

  resume() {
    if (!this.#isPaused) {
      return;
    }
    this.#isPaused = false;
    if (this.#isPending) {
      this.#arm();
    }
  }

  /**
   * Drain this channel now: one pass, bounded by `budget` unless another is
   * given here. `flush({ budget: Infinity })` empties it, which is what a test
   * — or anything that wants to measure a settled graph — should ask for.
   *
   * Called during a `batch()`, this defers to the end of it. Draining halfway
   * through a batch would recompute against a half-written model, which is
   * the one thing `batch()` exists to prevent.
   *
   * @param {{ budget?: number }} [options]
   * @returns {void}
   */
  flush(options = {}) {
    this.#queue?.flushChannel(this, options.budget ?? this.#budget);
  }

  /**
   * @internal Called by `UpdateQueue` when this channel's queue depth changes.
   * @param {UpdateQueue} queue
   * @param {number} count
   * @returns {void}
   */
  reportPending(queue, count) {
    this.#queue = queue;
    const was = this.#isPending;
    const is = count > 0;
    if (was === is) {
      return;
    }
    this.#isPending = is;
    if (this.#trigger) {
      if (is) {
        this.#arm();
      } else {
        this.#disarm();
      }
    }
    if (!this.#toggles.observed) {
      // Nobody is watching this channel's depth. The default channel crosses
      // zero on essentially every flush, so the announcement below — a
      // closure, a batch and a drain — is worth not making when it would
      // reach no one.
      return;
    }
    // One change, one update: hold the drain until every dependent has been
    // told, exactly as a signal write does.
    queue.batch(() => {
      this.#toggles.next(is);
    });
  }

  #arm() {
    if (this.#subscription || !this.#trigger || this.#isPaused) {
      return;
    }
    // Subscribing may run arbitrary code — a frame loop starting up, say —
    // and this happens while a computation is on the stack, so anything that
    // subscription reads must not be mistaken for a dependency of it.
    withComputation(null, () => {
      this.#subscription =
        this.#trigger?.subscribe({
          next: () => {
            this.flush();
          },
        }) ?? null;
    });
  }

  #disarm() {
    const subscription = this.#subscription;
    this.#subscription = null;
    subscription?.unsubscribe();
  }
}
