import UpdateChannel from "./UpdateChannel.js";

/**
 * @typedef {object} Task
 * @property {() => void} invalidate
 */

/**
 * What the queue remembers about a task. One of these is made the first time
 * a task is ever queued and then reused for the life of the task, so a hot
 * graph queues and drains without allocating. The bucket grids hold these
 * rather than the tasks themselves, which is what lets a drain recognise an
 * entry left behind by re-prioritisation without a second lookup.
 *
 * @typedef {object} Entry
 * @property {Task} task
 * @property {Lane} lane
 * @property {number} priority
 * @property {boolean} queued whether this task is waiting to run. Membership
 *   lives here rather than in a map keyed by task: the entry is reached from
 *   the bucket grid already, so asking a field is what a drain would
 *   otherwise pay a hash lookup for, once per task and again per stale entry
 *   it skips.
 */

/**
 * How many levels get a bucket of their own. A graph deep enough to reach
 * this would have to be built one dependency at a time and would blow the
 * stack long before it got here, so in practice every real priority is a
 * dense one. Anything above the limit — including `Infinity` — is still
 * ordered correctly, just by the slower path below.
 */
const DENSE_LIMIT = 1 << 12;

/**
 * One channel's worth of queue: the bucket grid described on `UpdateQueue`,
 * plus where the drain has got to in it. Every channel gets its own, and they
 * are drained in channel order — so the drain is really two cursors, one over
 * channels and one over depths, and only the inner one is on the hot path.
 */
class Lane {
  /** @type {UpdateChannel} */
  channel;

  /**
   * One FIFO per priority, grown as deeper graphs appear. `next[p]` is the
   * read position inside `buckets[p]`; a fully drained bucket is emptied and
   * its read position reset rather than shifted, so draining is O(1) per
   * task.
   *
   * @type {Entry[][]}
   */
  buckets = [];

  /** @type {number[]} */
  next = [];

  /**
   * Entries whose priority is too large to index a bucket with, `Infinity`
   * included. They are held unsorted and drained after every dense level,
   * lowest priority first, by scanning — the set is empty in every graph
   * built out of real dependencies, and a handful of entries at worst.
   *
   * @type {Entry[]}
   */
  far = [];

  /**
   * The deepest dense level currently holding work, or -1 when none does.
   *
   * @type {number}
   */
  maxDense = -1;

  /**
   * The lowest priority that may still hold work. Pushing below it moves it
   * back — a task can be re-prioritised downward mid-flush — and draining
   * moves it forward one exhausted bucket at a time. It survives between
   * passes, which is what lets a pass cut short by a budget resume where it
   * stopped rather than starting over.
   *
   * @type {number}
   */
  cursor = 0;

  /**
   * Whether any bucket holds an entry for a task that has moved elsewhere.
   *
   * @type {boolean}
   */
  hasStale = false;

  /**
   * How many tasks are queued in this lane. Kept rather than derived so that
   * finding the next lane to drain, which happens once per task, costs a
   * property read.
   *
   * @type {number}
   */
  size = 0;

  /**
   * Consecutive passes the budget has cut short. Reset by a pass that runs
   * this lane dry; once it reaches the channel's `maxStalePasses` the next
   * pass ignores the budget, so a channel whose input outruns its budget
   * falls behind by a bounded amount rather than indefinitely.
   *
   * @type {number}
   */
  stalePasses = 0;

  /**
   * Where this lane sits in the drain order, and whether it waits to be asked.
   * Both are the channel's to say, but the drain reads them once per task, so
   * they are copied here rather than fetched through a getter every time.
   *
   * @type {number}
   */
  index = 0;

  /** @type {boolean} */
  onDemand = false;

  /**
   * @param {UpdateChannel} channel
   */
  constructor(channel) {
    this.channel = channel;
    this.onDemand = channel.drainsOnDemand;
  }
}

/**
 * A priority queue of pending invalidations, drained in ascending priority
 * order so that dependencies always run before their dependents.
 *
 * Priorities here are not arbitrary numbers: a computation's priority is the
 * maximum of its dependencies' priorities plus one — its depth in the graph —
 * so they are small consecutive integers. That makes a binary heap the wrong
 * tool: every sift pays comparator calls and index bookkeeping to maintain a
 * total order the priorities do not have. An array of buckets indexed by
 * priority gives O(1) push and pop with no comparisons at all, and drains
 * each level in insertion order, which a heap did not even promise.
 *
 * Wide fan-out is the case this serves: one hot signal invalidating
 * thousands of computations per frame (see fanout.bench.js, distilled from
 * a scrolling list mirrored by @apendua/freedom). There the queue's cost is
 * paid per task, and per-task cost is what this representation minimizes.
 *
 * A task whose priority changes while queued is not moved: it is appended
 * to its new bucket and the old slot goes stale, to be recognized and
 * skipped at drain time by asking the entry whether it is still queued and
 * whether the level being drained is the one it now belongs to. Stale slots
 * cost two field reads each, which is less than eagerly deleting from the
 * middle of an array.
 *
 * Priorities too large to index a bucket with — `Infinity`, most usefully,
 * which a hand-written priority function may pass to mean "after everything"
 * — are held separately and drained last, in priority order. Nothing built
 * out of real dependencies lands there, so that path never costs the common
 * case anything; it exists so that the grid's width is an implementation
 * detail rather than a limit on what callers may ask for.
 *
 * All of that is per **channel**. A channel is a scheduling class: the drain
 * order is `(channel order, depth)` with the channel as the major key, and a
 * channel can be told to wait for a trigger and to spend no more than a fixed
 * number of milliseconds when it does. See `UpdateChannel`.
 */
export default class UpdateQueue {
  /**
   * What the queue remembers about every task it has ever seen, including the
   * priority to re-queue it at when `invalidate` is called without one.
   *
   * @type {WeakMap<Task, Entry>}
   */
  #entries = new WeakMap();

  /**
   * The last task looked up, and what was found. A one-slot cache in front of
   * `#entries`, which is the only lookup left on the push path.
   *
   * Sound without invalidation because an entry is made once per task and
   * then reused forever: what the map holds for a task cannot change, so a
   * remembered answer cannot go out of date. A task that has never been
   * pushed is simply not the one remembered, and takes the map.
   *
   * @type {Task | null}
   */
  #lastTask = null;

  /** @type {Entry | undefined} */
  #lastEntry = undefined;

  /**
   * How many tasks are queued across every lane. Membership itself is the
   * `queued` flag on each entry; this is only the count, kept so that the
   * commonest question a drain asks — is there anything to do at all — is a
   * field read.
   *
   * @type {number}
   */
  #size = 0;

  /**
   * Every channel's lane, for looking one up when something is queued.
   *
   * @type {Map<UpdateChannel, Lane>}
   */
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
   * during another channel's pass. Satisfied when it is safe to, which is the
   * whole reason the request is recorded rather than acted on.
   *
   * @type {Map<UpdateChannel, number>}
   */
  #requested = new Map();

  /** @type {UpdateChannel} */
  #defaultChannel = new UpdateChannel({ name: "default", order: 0 });

  /**
   * Whether any lane holds an entry left behind by re-prioritisation. Lets a
   * pass that had none — almost all of them — skip the sweep without looking.
   *
   * @type {boolean}
   */
  #anyStale = false;

  /**
   * The lane the drain is working through, or null when it is not draining.
   * `#push` compares against it to notice work arriving in a channel that has
   * already had its turn this pass.
   *
   * The lane itself rather than its index: a lane inserted mid-pass renumbers
   * the ones after it, so an index captured when the pass started can quietly
   * come to mean a different lane. Which is not hypothetical — the first lane
   * a queue ever makes is whichever channel is used first, and a panel's is
   * used before anything lands in the default one, so the very first push to
   * the default channel renumbers the lane being drained.
   *
   * @type {Lane | null}
   */
  #currentLane = null;

  /** @type {boolean} */
  #restart = false;

  /** @type {boolean} */
  #isBatching = false;

  /** @type {boolean} */
  #isFlushing = false;

  get size() {
    return this.#size;
  }

  /**
   * The channel everything lands in unless told otherwise: no trigger, no
   * budget, drains at the end of a batch exactly as this queue always has.
   */
  get defaultChannel() {
    return this.#defaultChannel;
  }

  /**
   * @param {() => void} fn
   */
  batch(fn) {
    if (this.#isBatching) {
      fn();
      return;
    }
    this.#isBatching = true;
    try {
      fn();
    } finally {
      // A batch body that throws must not leave the flag set: nothing would
      // ever drain the queue again, and every later invalidation would be
      // silently swallowed. Draining is still right — the writes the body
      // managed to make before it failed are real, and their dependents are
      // stale until they run.
      this.#isBatching = false;
      this.flush();
    }
  }

  /**
   * @param {Task} task
   * @param {number} [priority]
   * @param {UpdateChannel} [channel]
   * @returns {void}
   */
  invalidate(task, priority, channel) {
    if (priority === undefined || channel === undefined) {
      const entry = this.#entries.get(task);
      priority ??= entry?.priority ?? 0;
      channel ??= entry?.lane.channel ?? this.#defaultChannel;
    }
    this.#push(task, priority, channel);
    if (!this.#isBatching) {
      this.flush();
    }
  }

  /**
   * Drain every channel that drains of its own accord — which is every
   * channel without a trigger.
   */
  flush() {
    this.#drain(null, Infinity);
  }

  /**
   * Drain one triggered channel, plus the channels that drain of their own
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
   * How deep a channel's queue is. `UpdateChannel` reports this reactively;
   * this is where the number comes from.
   *
   * @param {UpdateChannel} channel
   * @returns {number}
   */
  pendingCountOf(channel) {
    return this.#lanes.get(channel)?.size ?? 0;
  }

  /**
   * @param {UpdateChannel | null} target
   * @param {number} budget
   * @returns {void}
   */
  #drain(target, budget) {
    if (this.#size === 0 && this.#requested.size === 0) {
      // By far the commonest call: a write whose dependents have all already
      // run, or none. Nothing below this has anything to do, and this path is
      // hot enough that finding that out twice is worth avoiding.
      return;
    }
    if (this.#isBatching || this.#isFlushing) {
      // Draining now would recompute against a half-written model, or
      // interleave two passes. Both are exactly what the caller does not
      // want; record the request and satisfy it when the queue is free.
      if (target) {
        this.#request(target, budget);
      }
      return;
    }
    try {
      this.#isFlushing = true;
      this.#pass(target, budget);
      // A pass can ask for another channel — `channel.flush()` called from
      // inside a computation, most plausibly. Satisfy each at most once, so
      // that two channels flushing each other cannot spin.
      if (this.#requested.size > 0) {
        const satisfied = new Set(target ? [target] : []);
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
    } catch (err) {
      // If we failed in the middle of a flush, we'd better clear the queue
      // to avoid running into troubles if someone tries to invalidate
      // something later on. A half-drained multi-channel state is harder to
      // reason about than a clean slate, so this clears every channel and not
      // only the one that threw.
      this.#reset();
      throw err;
    } finally {
      this.#isFlushing = false;
    }
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
    const targetLane = target ? this.#laneOf(target) : null;
    if (target && targetLane && targetLane.stalePasses >= target.maxStalePasses) {
      // The budget has cut this lane short too many times running. Input is
      // outpacing it, and depth ordering means the shallow work keeps
      // preempting the deep, so without this the deepest nodes would stay
      // wrong indefinitely. One unbounded pass is a hitch; the alternative is
      // a permanently stale subtree.
      budget = Infinity;
    }
    const timed = Number.isFinite(budget);
    // Only a budgeted pass reads the clock. The default channel's drain is
    // the hot path and must not pay for a feature it does not use.
    const now = timed ? (target?.now ?? (() => performance.now())) : null;
    const startedAt = now ? now() : 0;
    let ranOut = false;

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
        // Staying on one lane is the whole point: a graph with a single
        // channel — which is most of them — then drains through one tight
        // loop, with no per-task decision about where to look next.
        //
        // The grid is read through locals rather than through the lane on
        // every turn. Safe because `#push` grows these arrays in place and
        // never replaces them — only `#reset` does, and that unwinds out of
        // this frame — and worth doing because a drain touches them three
        // times per task.
        const buckets = lane.buckets;
        const next = lane.next;
        while (lane.size > 0 && !this.#restart) {
          const cursor = lane.cursor;
          if (cursor > lane.maxDense) {
            // Every dense level is spent, so anything still queued is far. A
            // far task may yet push shallow work, which moves the cursor back
            // and returns the next turn of this loop to the branch below.
            const index = this.#takeFar(lane);
            if (index < 0) {
              break;
            }
            const entry = lane.far[index];
            lane.far.splice(index, 1);
            entry.queued = false;
            this.#size -= 1;
            lane.size -= 1;
            if (lane.size === 0) {
              lane.channel.reportPending(this, 0);
            }
            entry.task.invalidate();
            if (now && now() - startedAt >= budget) {
              ranOut = true;
              break outer;
            }
            continue;
          }
          const bucket = buckets[cursor];
          if (bucket === undefined || bucket.length === 0) {
            lane.cursor = cursor + 1;
            continue;
          }
          const at = next[cursor];
          const entry = bucket[at];
          if (at + 1 === bucket.length) {
            // Taking the last entry empties the bucket then and there, so the
            // common flush — one task, one bucket — leaves nothing to sweep.
            bucket.length = 0;
            next[cursor] = 0;
          } else {
            next[cursor] = at + 1;
          }
          // A stale slot: the task was re-prioritised after this one was
          // written, or has already run from its newer position. Neither
          // costs the caller any of its budget.
          if (!entry.queued || entry.priority !== cursor) {
            continue;
          }
          entry.queued = false;
          this.#size -= 1;
          lane.size -= 1;
          if (lane.size === 0) {
            lane.channel.reportPending(this, 0);
          }
          entry.task.invalidate();
          if (now && now() - startedAt >= budget) {
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
    this.#sweep(target);
  }

  /**
   * The lowest-ordered lane that has work and may run in this pass, or null.
   *
   * Scanning from the start every time is deliberate: a task that has just
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
   * Clear bucket entries left behind by re-prioritisation, for every lane a
   * pass ran dry.
   *
   * Only a lane that drained completely may be swept: the sweep cannot tell
   * an abandoned entry from a live one — membership is what does that, and it
   * is only unambiguous once the lane is empty. Clearing the buckets with
   * work still queued would strand it, since the tasks would keep their
   * entries flagged as queued with no bucket slot left to reach them by, and
   * `#push` refuses to re-enqueue a task already queued at the same priority.
   * That is what lets a pass stop early on a budget without wedging the lane.
   *
   * @param {UpdateChannel | null} target
   * @returns {void}
   */
  #sweep(target) {
    if (!this.#anyStale) {
      return;
    }
    let remaining = false;
    for (const lane of this.#ordered) {
      if (!lane.hasStale || lane.size > 0) {
        continue;
      }
      if (lane.onDemand && lane.channel !== target) {
        remaining = true;
        continue;
      }
      for (let i = 0; i < lane.buckets.length; i++) {
        const bucket = lane.buckets[i];
        if (bucket && bucket.length > 0) {
          bucket.length = 0;
          lane.next[i] = 0;
        }
      }
      lane.far.length = 0;
      lane.hasStale = false;
    }
    for (const lane of this.#ordered) {
      if (lane.hasStale) {
        remaining = true;
      }
    }
    this.#anyStale = remaining;
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
    // Kept sorted on insert rather than at drain time: channels are created
    // once and drained from constantly, and there are only ever a handful.
    let at = this.#ordered.length;
    while (at > 0 && this.#ordered[at - 1].channel.order > channel.order) {
      at -= 1;
    }
    this.#ordered.splice(at, 0, lane);
    for (let i = at; i < this.#ordered.length; i++) {
      this.#ordered[i].index = i;
    }
    return lane;
  }

  /**
   * @param {Task} task
   * @param {number} priority
   * @param {UpdateChannel} channel
   * @returns {void}
   */
  #push(task, priority, channel) {
    // Priorities are depths, so integers ≥ 0 by construction. `Infinity` is
    // the one out-of-range value with an obvious meaning — after everything
    // — and it keeps that meaning here; the rest are nonsense as depths and
    // collapse to the shallowest level rather than being trusted as indices.
    if (!Number.isFinite(priority)) {
      priority = priority === Infinity ? Infinity : 0;
    } else if (!Number.isInteger(priority) || priority < 0) {
      priority = Math.max(0, Math.floor(priority));
    }
    // One task pushed again and again is the shape of a fan-in: a node
    // reading a dozen signals is told about each of them, and every push
    // after the first is a duplicate. An entry is made once and kept for the
    // life of the task, so remembering the last one turns those into an
    // identity comparison instead of a hash lookup apiece.
    let entry;
    if (task === this.#lastTask) {
      entry = this.#lastEntry;
    } else {
      entry = this.#entries.get(task);
      if (entry !== undefined) {
        this.#lastTask = task;
        this.#lastEntry = entry;
      }
    }
    // Checked before anything else is worked out, because it is the answer
    // most of the time and everything below it is wasted on that case.
    if (
      entry !== undefined &&
      entry.queued &&
      entry.priority === priority &&
      entry.lane.channel === channel
    ) {
      return;
    }
    const lane = entry && entry.lane.channel === channel ? entry.lane : this.#laneOf(channel);
    if (entry === undefined) {
      entry = { task, lane, priority, queued: false };
      this.#entries.set(task, entry);
      this.#lastTask = task;
      this.#lastEntry = entry;
    }
    const queued = entry.queued;
    if (queued) {
      entry.lane.hasStale = true;
      this.#anyStale = true;
      if (entry.lane !== lane) {
        // Moving channels while queued would leave an entry behind in a lane
        // that no longer owns the task, and the lane's size would never come
        // back down. Membership is meant to be fixed when a node is built.
        entry.lane.size -= 1;
        lane.size += 1;
      }
    } else {
      const wasEmpty = lane.size === 0;
      entry.queued = true;
      this.#size += 1;
      lane.size += 1;
      if (wasEmpty) {
        // An empty lane's cursor can be anywhere; starting it at the first
        // task keeps a pass from scanning the empty levels below.
        lane.cursor = priority >= DENSE_LIMIT ? 0 : priority;
        lane.maxDense = -1;
      }
    }
    entry.lane = lane;
    entry.priority = priority;
    if (priority >= DENSE_LIMIT) {
      // Too large to index a bucket with. It sorts after every dense level
      // by construction, so the cursor needs no adjusting for it.
      lane.far.push(entry);
    } else {
      if (priority < lane.cursor) {
        lane.cursor = priority;
      }
      if (priority > lane.maxDense) {
        lane.maxDense = priority;
      }
      let bucket = lane.buckets[priority];
      if (!bucket) {
        bucket = [];
        lane.buckets[priority] = bucket;
        lane.next[priority] = 0;
      }
      bucket.push(entry);
    }
    if (this.#currentLane !== null && lane.index < this.#currentLane.index) {
      // An earlier channel has work again, and channel order is the major key
      // it all sorts by, so the pass has to go back for it.
      this.#restart = true;
    }
    // Announced last, and only once the lane is consistent. Announcing is a
    // change like any other, so it goes through `batch()` — which, outside a
    // batch, drains. A lane counted as holding work it has not yet been given
    // a bucket entry for would send that drain hunting for a task it cannot
    // reach, forever.
    if (lane.size === 1 && !queued) {
      lane.channel.reportPending(this, 1);
    }
  }

  /**
   * The index in a lane's `far` list of the lowest-priority entry that is
   * still live, or -1 if there is none. Compacts away the entries left behind
   * by re-prioritization on the way through, so one pass does both jobs.
   *
   * @param {Lane} lane
   * @returns {number}
   */
  #takeFar(lane) {
    let best = -1;
    let write = 0;
    for (let read = 0; read < lane.far.length; read++) {
      const entry = lane.far[read];
      if (!entry.queued || entry.priority < DENSE_LIMIT) {
        continue;
      }
      lane.far[write] = entry;
      if (best < 0 || entry.priority < lane.far[best].priority) {
        best = write;
      }
      write++;
    }
    lane.far.length = write;
    return best;
  }

  #reset() {
    this.#requested.clear();
    this.#size = 0;
    for (const lane of this.#ordered) {
      // Membership is a flag on the entry, and the entries are reached only
      // through the grids being thrown away here — so they have to be told
      // before the grids go, or a task dropped by this reset would refuse to
      // be queued again for the rest of its life. A slot left behind by
      // re-prioritisation names an entry that is queued elsewhere, and
      // clearing its flag too is right: everything is being dropped.
      for (const bucket of lane.buckets) {
        if (bucket) {
          for (const entry of bucket) {
            entry.queued = false;
          }
        }
      }
      for (const entry of lane.far) {
        entry.queued = false;
      }
      lane.buckets = [];
      lane.next = [];
      lane.far = [];
      lane.cursor = 0;
      lane.maxDense = -1;
      lane.hasStale = false;
      lane.stalePasses = 0;
      this.#anyStale = false;
      const wasPending = lane.size > 0;
      lane.size = 0;
      if (wasPending) {
        lane.channel.reportPending(this, 0);
      }
    }
  }
}
