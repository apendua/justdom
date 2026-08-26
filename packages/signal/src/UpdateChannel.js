import { addDependency, withComputation } from "./core.js";
import { Subject } from "./subscribable.js";

/**
 * @import { Unsubscribable, Subscribable } from "./subscribable.js";
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
 * @property {boolean} [fixedOrder] refuse automatic order correction. The
 *   channel then warns about a violation instead of fixing it, which is what
 *   you want when the order is a decision rather than a guess.
 * @property {() => number} [now] the clock, injectable so tests are deterministic
 * @property {number} [maxStalePasses] passes the budget may cut short in a row
 */

/**
 * A scheduling class for effects.
 *
 * The default channel runs the way this library always has: work queued in it
 * drains at the end of `batch()`, or immediately if there is no batch. A
 * channel built with a `trigger` does not — its work sits until the trigger
 * fires, and then drains for at most `budget` milliseconds, with whatever
 * does not fit waiting for the trigger after that. That is the point of the
 * thing: a panel mirrored into the DOM can be told to apply its updates at a
 * frame boundary and within a frame's worth of time, rather than the instant
 * its inputs move.
 *
 * Only effects belong to channels. A `Derived` has no channel because it has
 * no schedule: it produces a value when somebody asks, and deferring it would
 * mean handing that somebody a stale one.
 *
 * ### Order
 *
 * Channels drain in `order`, and an effect may only invalidate an effect in a
 * **later** channel — application state settling before presentation reads it
 * is the arrangement this exists for. Violating that is not a warning to be
 * lived with: the queue moves the channel that was written into above the one
 * that wrote, so a mis-declared order fixes itself on the first pass that
 * exposes it. `order` is therefore a starting guess and not a guarantee, and
 * reading it back after a violation will show the corrected value. Pass
 * `fixedOrder` to keep the declared value and get a warning instead.
 */
export default class UpdateChannel {
  /** @type {string} */
  #name;

  /** @type {number} */
  #order;

  /** @type {boolean} */
  #fixedOrder;

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
   * Channels already complained about, so that an edge created once does not
   * produce a warning per pass for the life of the program.
   *
   * @type {Set<UpdateChannel>}
   */
  #warnedAbout = new Set();

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
   * hundreds of effects in one pass, and waking every observer of the channel
   * once per effect would cost more than the work being scheduled.
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
      fixedOrder = false,
      now = () => performance.now(),
      maxStalePasses = 3,
    } = options;
    if (!Number.isInteger(order) || order < 0) {
      throw new RangeError("An update channel's order must be a non-negative integer");
    }
    this.#name = name;
    this.#order = order;
    this.#fixedOrder = fixedOrder;
    this.#trigger = trigger;
    this.#manual = manual;
    this.#budget = budget;
    this.#now = now;
    this.#maxStalePasses = maxStalePasses;
  }

  get name() {
    return this.#name;
  }

  /**
   * Where this channel sits in the drain order. Not necessarily what was
   * asked for at construction — see the note on order correction above.
   */
  get order() {
    return this.#order;
  }

  get hasFixedOrder() {
    return this.#fixedOrder;
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
   * Whether this channel is holding effects that have not run yet.
   *
   * Reactive: a computation that reads this re-runs when the answer changes.
   * It means "something is queued", not "something will actually change" — an
   * effect may resolve its dependencies and find nothing moved, and finding
   * that out in advance would mean doing the very work the channel exists to
   * defer.
   */
  get hasPendingUpdates() {
    addDependency(this.#toggles);
    return this.#isPending;
  }

  /**
   * How many effects are queued in this channel.
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
   * through a batch would run effects against a half-written model, which is
   * the one thing `batch()` exists to prevent.
   *
   * @param {{ budget?: number }} [options]
   * @returns {void}
   */
  flush(options = {}) {
    this.#queue?.flushChannel(this, options.budget ?? this.#budget);
  }

  /**
   * @internal Called by `UpdateQueue` when correcting a violation.
   * @param {number} order
   * @returns {void}
   */
  setOrder(order) {
    this.#order = order;
  }

  /**
   * @internal Called by `UpdateQueue` when this channel is invalidated by one
   * that should have come after it. Once per offending channel: the edge is
   * created once, but the effect that creates it may run thousands of times.
   * @param {UpdateChannel} from
   * @returns {void}
   */
  warnAboutOrder(from) {
    if (this.#warnedAbout.has(from)) {
      return;
    }
    this.#warnedAbout.add(from);
    const remedy = this.#fixedOrder
      ? `"${this.#name}" has a fixed order, so this will not be corrected: its work waits ` +
        `for the next pass and lags "${from.name}" by one every time.`
      : `"${this.#name}" has been moved after "${from.name}" so that this pass, and every ` +
        `pass after it, runs them the right way round.`;
    console.warn(
      new Error(
        `An effect in update channel "${from.name}" (order ${from.order}) invalidated an ` +
          `effect in "${this.#name}" (order ${this.#order}). Channels drain in order, so ` +
          `work may only flow from an earlier channel to a later one. ${remedy}`,
      ),
    );
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
