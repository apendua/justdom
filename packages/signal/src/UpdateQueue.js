/**
 * @typedef {object} Task
 * @property {() => void} invalidate
 */

/**
 * The deepest level the queue will represent. A graph deep enough to reach it
 * would have to be built one dependency at a time and would blow the stack
 * long before it got here; the bound exists to keep a hand-set priority from
 * turning the drain loop into an unbounded walk.
 */
const MAX_PRIORITY = 1 << 16;

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
 * to its new bucket and the old entry goes stale, to be recognized and
 * skipped at drain time by consulting `#queued` — the single source of truth
 * for membership. Stale entries cost one map lookup each, which is less than
 * eagerly deleting from the middle of an array.
 */
export default class UpdateQueue {
  /**
   * The last priority each task was queued at, kept across flushes: it is
   * the default when `invalidate` is called without one — a plain signal
   * enqueues itself this way and stays at the priority it has always had.
   *
   * @type {WeakMap<Task, number>}
   */
  #priorities = new WeakMap();

  /**
   * Which tasks are queued, and the priority each will run at. Membership
   * and dedup both live here; the buckets are only an ordering over this.
   *
   * @type {Map<Task, number>}
   */
  #queued = new Map();

  /**
   * One FIFO per priority, grown as deeper graphs appear. `#next[p]` is the
   * read position inside `#buckets[p]`; a fully drained bucket is emptied
   * and its read position reset rather than shifted, so draining is O(1)
   * per task.
   *
   * @type {Task[][]}
   */
  #buckets = [];

  /** @type {number[]} */
  #next = [];

  /**
   * The lowest priority that may still hold work. Pushing below it moves it
   * back — a task can be re-prioritized downward mid-flush — and draining
   * moves it forward one exhausted bucket at a time.
   *
   * @type {number}
   */
  #cursor = 0;

  /**
   * Whether any bucket holds an entry for a task that has moved elsewhere.
   * Only then does a finished flush owe a sweep — the ordinary case clears
   * its buckets as it drains them and exits without touching the rest.
   *
   * @type {boolean}
   */
  #hasStale = false;

  /** @type {boolean} */
  #isBatching = false;

  /** @type {boolean} */
  #isFlushing = false;

  get size() {
    return this.#queued.size;
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
   * @returns {void}
   */
  invalidate(task, priority = this.#priorities.get(task) ?? 0) {
    this.#push(task, priority);
    if (!this.#isBatching) {
      this.flush();
    }
  }

  flush() {
    if (this.#isFlushing) {
      return;
    }
    try {
      this.#isFlushing = true;
      while (this.#queued.size > 0) {
        const bucket = this.#buckets[this.#cursor];
        if (!bucket || bucket.length === 0) {
          this.#cursor += 1;
          continue;
        }
        const next = this.#next[this.#cursor];
        const task = bucket[next];
        if (next + 1 === bucket.length) {
          // Taking the last entry empties the bucket then and there, so the
          // common flush — one task, one bucket — leaves nothing to sweep.
          bucket.length = 0;
          this.#next[this.#cursor] = 0;
        } else {
          this.#next[this.#cursor] = next + 1;
        }
        // A stale entry: the task was re-prioritized after this one was
        // written, or has already run from its newer position.
        if (this.#queued.get(task) !== this.#cursor) {
          continue;
        }
        this.#queued.delete(task);
        task.invalidate();
      }
      if (this.#hasStale) {
        // A re-prioritized task may have left an entry at a level the
        // cursor never reached, which would otherwise go on holding a
        // reference to a task that already ran.
        for (let i = 0; i < this.#buckets.length; i++) {
          const bucket = this.#buckets[i];
          if (bucket && bucket.length > 0) {
            bucket.length = 0;
            this.#next[i] = 0;
          }
        }
        this.#hasStale = false;
      }
    } catch (err) {
      // If we failed in the middle of a flush, we'd better clear the queue
      // to avoid running into troubles if someone tries to invalidate
      // something later on.
      this.#queued.clear();
      this.#buckets = [];
      this.#next = [];
      this.#cursor = 0;
      this.#hasStale = false;
      throw err;
    } finally {
      this.#isFlushing = false;
    }
  }

  /**
   * @param {Task} task
   * @param {number} priority
   * @returns {void}
   */
  #push(task, priority) {
    // Priorities are depths, so integers ≥ 0 by construction; anything else
    // is coerced onto the grid rather than trusted as an array index. The
    // ceiling matters as much as the floor: the cursor walks levels one at a
    // time, so an unbounded priority — `Infinity` from a hand-written
    // `setPriorityFn`, say — would leave it climbing forever. Depths are
    // small, so collapsing everything past the ceiling into the last bucket
    // costs nothing real: such a task still runs after every shallower one.
    if (!Number.isInteger(priority) || priority < 0 || priority > MAX_PRIORITY) {
      priority = Math.min(Math.max(0, Math.floor(priority) || 0), MAX_PRIORITY);
    }
    const current = this.#queued.get(task);
    if (current === priority) {
      return;
    }
    if (current !== undefined) {
      this.#hasStale = true;
    }
    this.#priorities.set(task, priority);
    if (this.#queued.size === 0) {
      // An empty queue's cursor can be anywhere; starting it at the first
      // task keeps a flush from scanning the empty levels below.
      this.#cursor = priority;
    } else if (priority < this.#cursor) {
      this.#cursor = priority;
    }
    let bucket = this.#buckets[priority];
    if (!bucket) {
      bucket = [];
      this.#buckets[priority] = bucket;
      this.#next[priority] = 0;
    }
    bucket.push(task);
    this.#queued.set(task, priority);
  }
}
