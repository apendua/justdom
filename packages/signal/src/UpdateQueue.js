import { CircularDependencyError, withHeldCleanups } from "./core.js";
import { runCleanups } from "./Node.js";

/**
 * @import UpdateChannel from "./UpdateChannel.js";
 */

/**
 * Something the queue can run. `Effect` is the only implementation.
 *
 * `passId` and `runsInPass` belong to the queue rather than to the task; they
 * live on the task because that is the only place a per-task, per-pass count
 * can be kept without a map keyed by every effect in the program.
 *
 * @typedef {object} Task
 * @property {boolean} queued
 * @property {boolean} warmed
 * @property {UpdateChannel} channel
 * @property {number} passId
 * @property {number} runsInPass
 * @property {string} name
 * @property {() => void} runFromQueue
 * @property {() => void} warm
 */

/**
 * One channel's pending work.
 *
 * A plain FIFO, which is the entire data structure — and the clearest sign
 * that the pull model paid for itself. What used to live here was a grid of
 * buckets indexed by a node's depth in the graph, because a push system has
 * to recompute dependencies before dependents and the only way it can know
 * the order is to have measured it. Pulling measures nothing: an effect
 * resolves its own dependencies on the way to running, so by the time it runs
 * everything it reads is current, whatever order the effects themselves are
 * taken in.
 *
 * What is left is dedup — the same effect invalidated ten times in a batch
 * runs once — and that is a flag on the task.
 */
class Lane {
  /** @type {UpdateChannel} */
  channel;

  /** Whether this channel waits to be asked rather than draining on its own. */
  onDemand = false;

  /**
   * The ring, as an array with a read cursor. Entries before `head` have run;
   * the array is reset rather than shifted whenever it empties, so a lane
   * that drains completely — almost every lane, almost every pass — leaves no
   * garbage behind.
   *
   * @type {Task[]}
   */
  queue = [];

  /** @type {number} */
  head = 0;

  /** How many entries are still to run. */
  size = 0;

  /** Position in the queue's ordered lane list. */
  index = 0;

  /**
   * How many passes in a row the budget has cut this lane short while it
   * still had work.
   *
   * @type {number}
   */
  stalePasses = 0;

  /**
   * The teardowns of values a warm of this lane replaced while its effects
   * were still holding them, run once the lane has nothing left to run — see
   * `holdCleanups` in `core.js`.
   *
   * @type {Array<Array<() => void>>}
   */
  held = [];

  /**
   * How many of this lane's effects are running right now, on the stack.
   * Nothing a warm set aside may go while one is: an effect taken out of the
   * lane to run has not been handed the new value until its body has read
   * it, and a teardown it sets off on the way in — a nested effect it built
   * last time, disposed — can empty the lane before it gets there.
   */
  running = 0;

  /**
   * @param {UpdateChannel} channel
   */
  constructor(channel) {
    this.channel = channel;
    this.onDemand = channel.drainsOnDemand;
  }
}

/**
 * How many order corrections one pass may make before giving up and letting
 * the offending work wait for the next pass instead. A graph with mutually
 * triggering channels would otherwise raise each above the other forever.
 */
const MAX_CORRECTIONS_PER_PASS = 32;

/**
 * How many times one effect may run in a single pass before the pass is
 * called a loop.
 *
 * Two effects that write what the other reads keep each other queued forever,
 * and no ordering of their channels can fix it — reordering only decides
 * which of them goes round first. Nothing else runs an effect anywhere near
 * this often in one pass: a batch of a thousand writes still runs each effect
 * once, because that is what the queue's dedup is for.
 */
const MAX_RUNS_PER_PASS = 200;

/**
 * The pending effects, by channel.
 *
 * A channel is a scheduling class: channels drain in `order`, and within one
 * channel effects run in the order they were invalidated. `UpdateChannel`
 * carries the rest — a trigger to wait for, a millisecond budget to spend.
 *
 * ### Channels are terminal, and this enforces it
 *
 * An effect may invalidate an effect in a **later** channel — application
 * state settling before presentation reads it is the case the whole
 * arrangement exists for. The other direction is a mistake: work arriving in
 * a channel this pass has already finished with would either be run out of
 * order, or wait a whole pass and lag its input forever.
 *
 * Rather than warn and carry on, the queue fixes it: the channel that was
 * written into is moved above the one that wrote, and re-sorted into place.
 * The pass then reaches it again on its way down, so the correction takes
 * effect immediately as well as permanently. Two channels that trigger each
 * other cannot be fixed this way — each correction provokes the next — so
 * corrections are capped per pass, and past the cap the work simply waits.
 */
export default class UpdateQueue {
  /**
   * How many tasks are queued across every lane, so that the commonest
   * question a drain asks — is there anything to do at all — is a field read.
   *
   * @type {number}
   */
  #size = 0;

  /** @type {Map<UpdateChannel, Lane>} */
  #lanes = new Map();

  /**
   * The same lanes in the order they drain: by their channel's `order`, ties
   * broken by which channel was used first. Two channels may share an order —
   * they are then simply not ordered relative to each other, which is the
   * honest answer for two independent regions that have no reason to be.
   *
   * @type {Lane[]}
   */
  #ordered = [];

  /**
   * Channels asked to drain while the queue was busy — during a `batch()`, or
   * during another channel's pass. Satisfied when it is safe to.
   *
   * @type {Map<UpdateChannel, number>}
   */
  #requested = new Map();

  /** @type {UpdateChannel} */
  #defaultChannel;

  /**
   * The lane the drain is working through, or null when it is not draining.
   *
   * The lane itself rather than its index: a lane inserted mid-pass renumbers
   * the ones after it, so an index captured when the pass started can quietly
   * come to mean a different lane.
   *
   * @type {Lane | null}
   */
  #currentLane = null;

  /**
   * How deep we are inside the queue's own bookkeeping announcements.
   *
   * A channel reports its depth reactively — `hasPendingUpdates` — and a
   * channel emptying therefore wakes whatever was watching it, which is
   * usually an effect in the default channel. That is the library telling the
   * application about itself, not the application's own dataflow flowing
   * backwards, so it must not be mistaken for a channel-order violation.
   *
   * @type {number}
   */
  #announcing = 0;

  /**
   * Set when work lands in a lane the current pass has already gone past, so
   * that the pass restarts its scan from the top instead of walking off the
   * end with work still queued behind it.
   *
   * @type {boolean}
   */
  #restart = false;

  /** @type {number} */
  #corrections = 0;

  /**
   * Which pass is running, so that a task can tell whether the run count it
   * is carrying belongs to this one.
   *
   * @type {number}
   */
  #passId = 0;

  /** @type {boolean} */
  #warnedAboutCorrectionLimit = false;

  /**
   * How many tasks have ever been queued. A warm compares it before and
   * after to learn whether anything was queued in the meantime, which the
   * size cannot say — see `warmChannel`.
   *
   * @type {number}
   */
  #enqueued = 0;

  /** @type {boolean} */
  #isBatching = false;

  /** @type {boolean} */
  #isFlushing = false;

  /**
   * @param {UpdateChannel} defaultChannel
   */
  constructor(defaultChannel) {
    this.#defaultChannel = defaultChannel;
  }

  get size() {
    return this.#size;
  }

  /**
   * The channel everything lands in unless told otherwise: no trigger, no
   * budget, drains at the end of a batch.
   */
  get defaultChannel() {
    return this.#defaultChannel;
  }

  /**
   * Hold the drain until `fn` returns.
   *
   * This is what makes a multi-part write land as one update. Writing a
   * signal marks its dependents and, outside a batch, drains the queue then
   * and there — so two writes that belong together would run every effect
   * twice, once against a half-written model.
   *
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  batch(fn) {
    if (this.#isBatching) {
      return fn();
    }
    this.#isBatching = true;
    try {
      return fn();
    } finally {
      // A batch body that throws must not leave the flag set: nothing would
      // ever drain the queue again, and every later invalidation would be
      // silently swallowed. Draining is still right — the writes the body
      // managed to make before it failed are real, and the effects that read
      // them are stale until they run.
      this.#isBatching = false;
      this.flush();
    }
  }

  get isBatching() {
    return this.#isBatching;
  }

  get isFlushing() {
    return this.#isFlushing;
  }

  /**
   * @param {Task} task
   * @returns {void}
   */
  enqueue(task) {
    if (task.queued) {
      return;
    }
    const channel = task.channel;
    const lane = this.#laneOf(channel);
    if (this.#isFlushing && this.#currentLane && this.#currentLane !== lane) {
      this.#checkOrder(lane);
    }
    task.queued = true;
    lane.queue.push(task);
    lane.size += 1;
    this.#size += 1;
    this.#enqueued += 1;
    if (lane.size === 1) {
      this.#reportPending(lane);
    }
    if (this.#currentLane && lane.index <= this.#currentLane.index && lane !== this.#currentLane) {
      // A lane this pass has already gone past. It has to be revisited, or
      // the work sits there until something else happens to drain it.
      this.#restart = true;
    }
    if (!this.#isBatching && !this.#isFlushing && !lane.onDemand) {
      this.flush();
    }
  }

  /**
   * Take a task back out — it was disposed before it got to run.
   *
   * The slot is left where it is and recognized as spent at drain time, which
   * costs a field read rather than a splice out of the middle of an array.
   *
   * Unless it was the last one, in which case the array goes too — see
   * `#emptied`.
   *
   * @param {Task} task
   * @returns {void}
   */
  dequeue(task) {
    if (!task.queued) {
      return;
    }
    task.queued = false;
    const lane = this.#lanes.get(task.channel);
    if (!lane) {
      return;
    }
    lane.size -= 1;
    this.#size -= 1;
    if (lane.size === 0) {
      this.#emptied(lane);
      // The last effect a warm resolved for is gone rather than run, so
      // nothing is left holding what the warm replaced — unless one of the
      // lane's effects is mid-run, and emptied it by disposing something on
      // its way in: that one still holds the old value, and the release is
      // owed once its run is over (`#runTask`).
      if (lane.running === 0) {
        this.#release(lane);
      }
    }
  }

  /**
   * Run one queued task out of turn: what `Effect.flush()` asks for. Taken
   * out of its lane and run as a pass would run it, so that what a warm set
   * aside for the lane waits for this run to read the new value rather than
   * going when the dequeue empties the lane.
   *
   * @param {Task} task
   * @returns {void}
   */
  flushTask(task) {
    const lane = this.#lanes.get(task.channel);
    if (lane) {
      lane.running += 1;
    }
    try {
      this.dequeue(task);
    } finally {
      if (lane) {
        lane.running -= 1;
      }
    }
    this.#runTask(lane ?? null, task);
  }

  /**
   * Run a task already out of its lane, and afterwards release what the
   * lane's warms set aside if nothing in it is left to run or running.
   *
   * @param {Lane | null} lane
   * @param {Task} task
   * @returns {void}
   */
  #runTask(lane, task) {
    if (!lane) {
      task.runFromQueue();
      return;
    }
    lane.running += 1;
    let threw = true;
    try {
      task.runFromQueue();
      threw = false;
    } finally {
      lane.running -= 1;
      // Released after the run whether or not it threw: a run that failed
      // outside any drain — `Effect.flush()` — has no reset coming to release
      // for it, and a lane nothing uses again would keep what it holds for
      // ever. The one exception is a throw inside a drain, which goes on to
      // `#reset`: that releases once the queue's counters are back to zero,
      // and releasing here first would let a teardown enqueue into a lane
      // the reset is about to wipe.
      if (lane.size === 0 && lane.running === 0 && (!threw || !this.#isFlushing)) {
        this.#release(lane);
      }
    }
  }

  /**
   * The lane has nothing left to run: let go of the array.
   *
   * Spent slots are skipped at drain time rather than spliced out, and the
   * array is reset rather than shifted, so it is only ever let go of when a
   * drain reaches its end — which a drain does only if the *last* slot held
   * something live. A spent slot at the tail, and every slot before it, run
   * or skipped, stays exactly where it is, holding its task and everything
   * the task closes over; the next drain skips them and stops at its own
   * dead tail, and the array only ever grows. A scene torn down inside a
   * batch leaves precisely that tail: the write that takes it down queues
   * its effects, the teardown disposes them before the batch ends. Every
   * exit from a level editor was leaving its whole scene hanging from a
   * lane this way. So: the moment nothing in the lane is left to run,
   * whether the last task ran or was taken back, the array is dropped.
   *
   * Safe mid-pass: the pass takes its next task only while the lane's size
   * is above zero, and the task it is about to run is already out of the
   * array's hands; anything that task queues starts a fresh array.
   *
   * @param {Lane} lane
   * @returns {void}
   */
  #emptied(lane) {
    lane.queue.length = 0;
    lane.head = 0;
    this.#reportPending(lane);
  }

  /**
   * Run what the lane's warms set aside. Called once nothing in the lane is
   * left to run, after the last of it has: every effect a warm resolved for has since either run —
   * and been handed the new value — or been disposed, so nothing is holding
   * the old values any more.
   *
   * A teardown that throws is reported from a fresh task rather than thrown
   * here, as a Stream reports an unhandled error: this runs on the way out of
   * a sweep or of an effect's `dispose`, and neither caller has any business
   * receiving somebody else's failure on its own stack.
   *
   * @param {Lane} lane
   * @returns {void}
   */
  #release(lane) {
    const held = lane.held;
    if (held.length === 0) {
      return;
    }
    // Drained in place rather than swapped for a fresh array: a warm still on
    // the stack is setting aside into this one (`withHeldCleanups`), and
    // whatever it holds after this has to land where the next release finds
    // it.
    for (const cleanups of held.splice(0)) {
      try {
        runCleanups(cleanups);
      } catch (err) {
        setTimeout(() => {
          throw err;
        });
      }
    }
  }

  /**
   * Tell a channel how deep its queue is, without that announcement counting
   * as application dataflow — see `#announcing`.
   *
   * @param {Lane} lane
   * @returns {void}
   */
  #reportPending(lane) {
    this.#announcing += 1;
    try {
      lane.channel.reportPending(this, lane.size);
    } finally {
      this.#announcing -= 1;
    }
  }

  /**
   * Drain every channel that drains of its own accord — which is every
   * channel without a trigger.
   *
   * @returns {void}
   */
  flush() {
    this.#drain(null, Infinity);
  }

  /**
   * Drain one on-demand channel, plus the channels that drain of their own
   * accord, for at most `budget` milliseconds.
   *
   * @param {UpdateChannel} channel
   * @param {number} budget
   * @returns {void}
   */
  flushChannel(channel, budget) {
    this.#drain(channel, budget);
  }

  /**
   * Bring what one channel's queued effects read up to date, for at most
   * `budget` milliseconds, running none of them. The first half of an atomic
   * pass, offered on its own; see `UpdateChannel.warm`.
   *
   * Declined outright inside a batch or a flush — there is no request to
   * record, because a caller asking whether the channel is warm wants an
   * answer now, and "not yet" is the true one.
   *
   * @param {UpdateChannel} channel
   * @param {number} budget
   * @returns {boolean} whether everything queued in the channel is now warm
   */
  warmChannel(channel, budget) {
    if (this.#isBatching || this.#isFlushing) {
      return false;
    }
    const lane = this.#lanes.get(channel);
    if (!lane || lane.size === 0) {
      return true;
    }
    if (lane.stalePasses >= channel.maxStalePasses) {
      // Counted here as in `#pass`, so that a channel driven by `warm()`
      // while its owner has other work pending is bounded the same way: one
      // unbudgeted warm, and the next flush finds nothing left to read.
      budget = Infinity;
    }
    const timed = Number.isFinite(budget);
    const now = timed ? channel.now : null;
    try {
      this.#isFlushing = true;
      const before = this.#enqueued;
      const warm = this.#warmLane(lane, now, now ? now() : 0, budget);
      lane.stalePasses = warm ? 0 : lane.stalePasses + 1;
      if (this.#enqueued !== before) {
        // Resolving a node can mark an effect — a `Derived` that attaches a
        // foreign source on the way up, and the source fires — and one in a
        // channel that drains of its own accord would have drained then and
        // there, had the flushing flag not been up. A pass over those
        // channels alone is what it was owed; the atomic lane is not a
        // target here and is left as it stands. Decided on what was queued,
        // not on the queue's size: a resource torn down in the same
        // evaluation can dispose a queued effect and leave the count where
        // it was.
        this.#pass(null, Infinity);
      }
      // And whatever those effects asked for — a `flush()` of some other
      // channel lands in `#requested` while the flag is up, and a caller
      // that only ever warms would otherwise leave it there for as long as
      // it has other work to finish. The channel being warmed is not among
      // them: a request to flush it is a request to commit, which is the
      // one thing this call was made to put off.
      this.#satisfyRequests(channel);
      return warm;
    } catch (err) {
      this.#reset();
      throw err;
    } finally {
      this.#isFlushing = false;
    }
  }

  /**
   * @param {UpdateChannel} channel
   * @returns {number}
   */
  pendingCountOf(channel) {
    return this.#lanes.get(channel)?.size ?? 0;
  }

  /**
   * How many slots the channel's lane holds, spent ones included: what the
   * lane is keeping alive between drains, which is what `pendingCountOf`
   * does not say. For tests and diagnostics; it is zero once a lane has
   * drained or emptied.
   *
   * @param {UpdateChannel} channel
   * @returns {number}
   */
  retainedCountOf(channel) {
    return this.#lanes.get(channel)?.queue.length ?? 0;
  }

  /**
   * @param {UpdateChannel | null} target
   * @param {number} budget
   * @returns {void}
   */
  #drain(target, budget) {
    if (this.#size === 0 && this.#requested.size === 0) {
      // By far the commonest call: a write whose effects have all already
      // run, or none.
      return;
    }
    if (this.#isBatching || this.#isFlushing) {
      // Draining now would run effects against a half-written model, or
      // interleave two passes. Both are exactly what the caller does not
      // want; record the request and satisfy it when the queue is free.
      if (target) {
        this.#request(target, budget);
      }
      return;
    }
    try {
      this.#isFlushing = true;
      this.#corrections = 0;
      this.#pass(target, budget);
      this.#satisfyRequests(target);
    } catch (err) {
      // If we failed in the middle of a flush, we'd better clear the queue to
      // avoid running into trouble if someone invalidates something later. A
      // half-drained multi-channel state is harder to reason about than a
      // clean slate, so this clears every channel and not only the one that
      // threw.
      this.#reset();
      throw err;
    } finally {
      this.#isFlushing = false;
    }
  }

  /**
   * A pass can ask for another channel — `channel.flush()` called from
   * inside an effect, most plausibly. Satisfy each at most once, so that two
   * channels flushing each other cannot spin; `except` is the channel whose
   * pass just ran, and a request for it is spent by that pass.
   *
   * @param {UpdateChannel | null} except
   * @returns {void}
   */
  #satisfyRequests(except) {
    if (this.#requested.size === 0) {
      return;
    }
    const satisfied = new Set(except ? [except] : []);
    for (;;) {
      /** @type {UpdateChannel | undefined} */
      let next;
      for (const channel of this.#requested.keys()) {
        if (!satisfied.has(channel)) {
          next = channel;
          break;
        }
      }
      if (!next) {
        break;
      }
      const requestedBudget = this.#requested.get(next) ?? next.budget;
      this.#requested.delete(next);
      satisfied.add(next);
      this.#pass(next, requestedBudget);
    }
    this.#requested.clear();
  }

  /**
   * One drain pass: `target` (if any) plus every channel that drains of its
   * own accord, in channel order, for at most `budget` milliseconds.
   *
   * @param {UpdateChannel | null} target
   * @param {number} budget
   * @returns {void}
   */
  #pass(target, budget) {
    this.#passId += 1;
    const targetLane = target ? this.#laneOf(target) : null;
    if (targetLane && target && targetLane.stalePasses >= target.maxStalePasses) {
      // The budget has cut this lane short too many times running. Input is
      // outpacing it, and without this the tail of the queue would stay
      // unrun indefinitely. One unbounded pass is a hitch; the alternative is
      // a permanently stale output.
      budget = Infinity;
    }
    const timed = Number.isFinite(budget);
    // Only a budgeted pass reads the clock. The default channel's drain is
    // the hot path and must not pay for a feature it does not use.
    const now = timed ? (target?.now ?? (() => performance.now())) : null;
    const startedAt = now ? now() : 0;
    let ranOut = false;

    /**
     * The one lane the clock does not apply to: an atomic target whose
     * reading is done. Its sweep runs whole — a sweep cut short would be the
     * half-applied update the channel exists to rule out — but the channels
     * that drain of their own accord and come along with the pass stay
     * under the budget, as they were for any budgeted pass before there
     * were atomic ones; the default lane can hold any amount of unrelated
     * work, and the slice this pass was given was not given for that.
     *
     * @type {Lane | null}
     */
    let unbudgeted = null;

    if (targetLane && target && target.isAtomic) {
      // The budget goes on the reading, not the running. Every queued effect
      // has what it read last time resolved, as many as fit; and only when
      // all of them are resolved does the sweep below run them. A pass that
      // could not finish the reading runs nothing of the target's, and only
      // takes the channels that drain of their own accord with it.
      if (this.#warmLane(targetLane, now, startedAt, budget)) {
        unbudgeted = targetLane;
      } else {
        ranOut = true;
        target = null;
      }
    }

    const previousLane = this.#currentLane;
    try {
      let from = 0;
      outer: for (;;) {
        const lane = this.#nextLane(target, from);
        if (!lane) {
          break;
        }
        this.#currentLane = lane;
        this.#restart = false;
        while (lane.size > 0 && !this.#restart) {
          const queue = lane.queue;
          if (lane.head >= queue.length) {
            break;
          }
          const task = queue[lane.head];
          lane.head += 1;
          if (lane.head >= queue.length) {
            // Drained to the end: reset rather than shift, so the array is
            // reused and nothing is copied.
            queue.length = 0;
            lane.head = 0;
          }
          if (!task.queued) {
            // Disposed after it was queued. Costs a field read, and none of
            // the caller's budget.
            continue;
          }
          task.queued = false;
          lane.size -= 1;
          this.#size -= 1;
          if (lane.size === 0) {
            this.#emptied(lane);
          }
          // Counted only once the task is fully out of the lane. The count can
          // throw, and a throw that left `queued` set while the lane had
          // already forgotten the task would take the queue's size negative on
          // the next `dequeue` — after which a lane could hold work while the
          // queue believed it held none.
          this.#countRun(task);
          // Released after the run, not at `#emptied` above: the task that
          // emptied the lane is the last one still holding what a warm
          // replaced, until it has run and been handed the new value.
          this.#runTask(lane, task);
          if (now && lane !== unbudgeted && now() - startedAt >= budget) {
            ranOut = true;
            break outer;
          }
        }
        if (this.#restart) {
          // Something landed in an earlier channel, which now owes its turn.
          this.#restart = false;
          from = 0;
          continue;
        }
        from = lane.index + 1;
      }
    } finally {
      this.#currentLane = previousLane;
      this.#restart = false;
    }

    if (targetLane) {
      targetLane.stalePasses = ranOut && targetLane.size > 0 ? targetLane.stalePasses + 1 : 0;
    }
  }

  /**
   * Warm every queued task in the lane that is not warm already, until the
   * clock says stop.
   *
   * A scan from the lane's head rather than a cursor of its own, because a
   * task can go cold again behind the cursor — something it read was written
   * while the scan was elsewhere — and the scan has to find it. Skipping a
   * task that is already warm costs a field read, and the lane holds at most
   * what one update queued.
   *
   * The answer is a second scan of the whole lane, whichever way the first
   * one ended. Warming a task can cool one *before* it — the node it
   * resolves attaches a source, the source fires, and what an earlier task
   * read is marked — so a flag read on the way past is no longer the flag's
   * value by the end. Trusting it would send that task into the sweep cold,
   * with its measurement paid there, off the budget.
   *
   * @param {Lane} lane
   * @param {(() => number) | null} now
   * @param {number} startedAt
   * @param {number} budget
   * @returns {boolean} whether every queued task in the lane is warm
   */
  #warmLane(lane, now, startedAt, budget) {
    const queue = lane.queue;
    // What a warm replaces, its effects are still holding: set aside, for
    // `#release` once the lane is through.
    withHeldCleanups(lane.held, () => {
      for (let index = lane.head; index < queue.length; index += 1) {
        const task = queue[index];
        if (!task.queued || task.warmed) {
          continue;
        }
        task.warm();
        if (now && now() - startedAt >= budget) {
          break;
        }
      }
    });
    // The warm may have disposed every effect it was resolving for — the lane
    // released at that dequeue, and whatever the warm set aside after it is
    // still here. No sweep is coming for an empty lane, and a lane nothing
    // uses again would keep it for ever, so it goes now.
    if (lane.size === 0 && lane.running === 0) {
      this.#release(lane);
    }
    for (let index = lane.head; index < queue.length; index += 1) {
      if (queue[index].queued && !queue[index].warmed) {
        return false;
      }
    }
    return true;
  }

  /**
   * Charge a run to this pass, and refuse to keep going round.
   *
   * @param {Task} task
   * @returns {void}
   */
  #countRun(task) {
    if (task.passId !== this.#passId) {
      task.passId = this.#passId;
      task.runsInPass = 0;
    }
    task.runsInPass += 1;
    if (task.runsInPass > MAX_RUNS_PER_PASS) {
      throw new CircularDependencyError(
        `Effect "${task.name}" in update channel "${task.channel.name}" has run ` +
          `${MAX_RUNS_PER_PASS} times in one pass without the queue settling. Something it ` +
          `writes is read by something that writes what it reads; no channel order can ` +
          `resolve that, so the cycle itself has to be broken.`,
      );
    }
  }

  /**
   * Work has arrived in `lane` while another lane is draining. If that lane
   * comes at or before the one running, the channels are the wrong way round.
   *
   * @param {Lane} lane
   * @returns {void}
   */
  #checkOrder(lane) {
    const current = this.#currentLane;
    if (!current || this.#announcing > 0) {
      return;
    }
    if (lane.channel.order > current.channel.order) {
      // The allowed direction: an earlier channel feeding a later one.
      return;
    }
    if (lane.channel.hasFixedOrder) {
      lane.channel.warnAboutOrder(current.channel);
      return;
    }
    if (this.#corrections >= MAX_CORRECTIONS_PER_PASS) {
      if (!this.#warnedAboutCorrectionLimit) {
        this.#warnedAboutCorrectionLimit = true;
        console.warn(
          new Error(
            `Update channels "${current.channel.name}" and "${lane.channel.name}" keep ` +
              `invalidating each other, so no ordering of them can be correct. Their work ` +
              `will be spread over several passes instead. Effects that feed each other ` +
              `belong in one channel, or the cycle between them needs breaking.`,
          ),
        );
      }
      return;
    }
    this.#corrections += 1;
    lane.channel.warnAboutOrder(current.channel);
    this.#raiseOrder(lane, current.channel.order + 1);
  }

  /**
   * Move a channel above the one that wrote into it, and put its lane back in
   * the right place. The pass rescans from the top, so this takes effect
   * immediately as well as for every pass after it.
   *
   * @param {Lane} lane
   * @param {number} order
   * @returns {void}
   */
  #raiseOrder(lane, order) {
    lane.channel.setOrder(order);
    const at = this.#ordered.indexOf(lane);
    if (at >= 0) {
      this.#ordered.splice(at, 1);
    }
    this.#insertOrdered(lane);
  }

  /**
   * The lowest-ordered lane that has work and may run in this pass, or null.
   *
   * Scanning from the start every time is deliberate: an effect that has just
   * run may have queued work in a lower channel, and channels number in the
   * handful, so a scan is cheaper than the bookkeeping that would avoid it.
   *
   * @param {UpdateChannel | null} target
   * @param {number} from
   * @returns {Lane | null}
   */
  #nextLane(target, from) {
    for (let i = from; i < this.#ordered.length; i++) {
      const lane = this.#ordered[i];
      if (lane.size === 0) {
        continue;
      }
      // A channel that drains on demand never drains because something was
      // queued in it — only because it, specifically, was asked to.
      if (lane.onDemand && lane.channel !== target) {
        continue;
      }
      return lane;
    }
    return null;
  }

  /**
   * @param {UpdateChannel} channel
   * @param {number} budget
   * @returns {void}
   */
  #request(channel, budget) {
    const existing = this.#requested.get(channel);
    // Two requests for one channel are one pass, at the more generous budget:
    // a caller asking to settle the channel completely must not be denied by
    // an ordinary trigger that happened to ask first.
    this.#requested.set(channel, existing === undefined ? budget : Math.max(existing, budget));
  }

  /**
   * @param {UpdateChannel} channel
   * @returns {Lane}
   */
  #laneOf(channel) {
    const existing = this.#lanes.get(channel);
    if (existing) {
      return existing;
    }
    const lane = new Lane(channel);
    this.#lanes.set(channel, lane);
    this.#insertOrdered(lane);
    return lane;
  }

  /**
   * @param {Lane} lane
   * @returns {void}
   */
  #insertOrdered(lane) {
    // Kept sorted on insert rather than at drain time: channels are created
    // once and drained from constantly, and there are only ever a handful.
    let at = this.#ordered.length;
    while (at > 0 && this.#ordered[at - 1].channel.order > lane.channel.order) {
      at -= 1;
    }
    this.#ordered.splice(at, 0, lane);
    // Every index, not just the ones from the insertion point on. A lane
    // being *re*-inserted after an order correction was spliced out of an
    // earlier position, which shifted everything between the two points down
    // by one — and those lanes sit before the insertion point, so renumbering
    // from there leaves them each claiming the index of their neighbour.
    //
    // A pass resumes scanning at `lane.index + 1`, so one stale index is one
    // channel silently skipped, and the staleness outlives the pass: its
    // effects sit queued through every later write until some unrelated lane
    // happens to be created and renumbers the tail. There are only ever a
    // handful of lanes, so there is nothing to save by being clever here.
    for (let i = 0; i < this.#ordered.length; i++) {
      this.#ordered[i].index = i;
    }
  }

  /**
   * @returns {void}
   */
  #reset() {
    for (const lane of this.#ordered) {
      // From the start, not from the cursor: an entry the pass had taken but
      // not finished with is still flagged, and leaving it flagged would
      // strand it — nothing would ever queue that task again.
      for (let i = 0; i < lane.queue.length; i++) {
        lane.queue[i].queued = false;
      }
      lane.queue.length = 0;
      lane.head = 0;
      const had = lane.size;
      lane.size = 0;
      lane.stalePasses = 0;
      // `running` is left alone: every run on the stack puts its own count
      // back in a `finally`, including one outside this drain — a run
      // `flushTask` started, whose body began the drain that failed. Zeroing
      // it here would take that one below zero when it unwinds, and the lane
      // would never release again.
      if (had > 0) {
        this.#reportPending(lane);
      }
      // What the old values held open is released below, once the queue's
      // own counters are back to zero: a teardown may write a signal, and the
      // enqueue that follows has to land in a lane the queue believes it has,
      // not in one it is about to forget.
    }
    this.#size = 0;
    this.#requested.clear();
    this.#currentLane = null;
    this.#restart = false;
    this.#corrections = 0;
    this.#announcing = 0;
    // Nothing queued is going to run now, so nothing will be handed a new
    // value: what the old ones held open goes here or not at all.
    for (const lane of this.#ordered) {
      // A lane with a run still on the stack — one `flushTask` started, whose
      // body began the drain that failed — is that run's to release, from
      // `#runTask`, once it has read the new value; `size` is zero by then.
      if (lane.running === 0) {
        this.#release(lane);
      }
    }
  }
}
