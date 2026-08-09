/**
 * @typedef {object} Task
 * @property {() => void} invalidate
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
 *
 * Priorities too large to index a bucket with — `Infinity`, most usefully,
 * which a hand-written priority function may pass to mean "after everything"
 * — are held separately and drained last, in priority order. Nothing built
 * out of real dependencies lands there, so that path never costs the common
 * case anything; it exists so that the grid's width is an implementation
 * detail rather than a limit on what callers may ask for.
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
   * Tasks whose priority is too large to index a bucket with, `Infinity`
   * included. They are held unsorted and drained after every dense level,
   * lowest priority first, by scanning — the set is empty in every graph
   * built out of real dependencies, and a handful of entries at worst.
   *
   * @type {{ task: Task, priority: number }[]}
   */
  #far = [];

  /**
   * The deepest dense level currently holding work, or -1 when none does.
   * Once the cursor passes it, whatever is left must be in `#far`, so the
   * drain switches over instead of walking to the end of the grid.
   *
   * @type {number}
   */
  #maxDense = -1;

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
        if (this.#cursor > this.#maxDense) {
          // Every dense level is spent, so anything still queued is far. A
          // far task may yet push shallow work, which moves the cursor back
          // and returns the next turn of this loop to the branch below.
          const index = this.#takeFar();
          if (index < 0) {
            break;
          }
          const { task } = this.#far[index];
          this.#far.splice(index, 1);
          this.#queued.delete(task);
          task.invalidate();
          continue;
        }
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
        this.#far.length = 0;
        this.#hasStale = false;
      }
    } catch (err) {
      // If we failed in the middle of a flush, we'd better clear the queue
      // to avoid running into troubles if someone tries to invalidate
      // something later on.
      this.#queued.clear();
      this.#buckets = [];
      this.#next = [];
      this.#far = [];
      this.#cursor = 0;
      this.#maxDense = -1;
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
    // Priorities are depths, so integers ≥ 0 by construction. `Infinity` is
    // the one out-of-range value with an obvious meaning — after everything
    // — and it keeps that meaning here; the rest are nonsense as depths and
    // collapse to the shallowest level rather than being trusted as indices.
    if (!Number.isFinite(priority)) {
      priority = priority === Infinity ? Infinity : 0;
    } else if (!Number.isInteger(priority) || priority < 0) {
      priority = Math.max(0, Math.floor(priority));
    }
    const current = this.#queued.get(task);
    if (current === priority) {
      return;
    }
    if (current !== undefined) {
      this.#hasStale = true;
    }
    this.#priorities.set(task, priority);
    const wasEmpty = this.#queued.size === 0;
    if (wasEmpty) {
      // An empty queue's cursor can be anywhere; starting it at the first
      // task keeps a flush from scanning the empty levels below.
      this.#cursor = 0;
      this.#maxDense = -1;
    }
    this.#queued.set(task, priority);
    if (priority >= DENSE_LIMIT) {
      // Too large to index a bucket with. It sorts after every dense level
      // by construction, so the cursor needs no adjusting for it.
      this.#far.push({ task, priority });
      return;
    }
    if (wasEmpty || priority < this.#cursor) {
      this.#cursor = priority;
    }
    if (priority > this.#maxDense) {
      this.#maxDense = priority;
    }
    let bucket = this.#buckets[priority];
    if (!bucket) {
      bucket = [];
      this.#buckets[priority] = bucket;
      this.#next[priority] = 0;
    }
    bucket.push(task);
  }

  /**
   * The index in `#far` of the lowest-priority entry that is still live,
   * or -1 if there is none. Compacts away the entries left behind by
   * re-prioritization on the way through, so one pass does both jobs.
   *
   * @returns {number}
   */
  #takeFar() {
    let best = -1;
    let write = 0;
    for (let read = 0; read < this.#far.length; read++) {
      const entry = this.#far[read];
      if (this.#queued.get(entry.task) !== entry.priority) {
        continue;
      }
      this.#far[write] = entry;
      if (best < 0 || entry.priority < this.#far[best].priority) {
        best = write;
      }
      write++;
    }
    this.#far.length = write;
    return best;
  }
}
