import { batch, withChannel } from "justdom-signal";

/**
 * @import {PortalPump, PortalScheduler} from './portalScheduler.js';
 */

/**
 * Taking a closed panel's objects down a budget at a time, the way they were
 * built, and the objects of the rows that leave a panel still open.
 *
 * What a panel costs to close is the reactive graph its objects hold: every
 * element keeps a subscription, and unsubscribing it disposes the effects
 * under it and disconnects every derived read they kept alive, each of which
 * lets go of its own dependencies. That is about a hundred reactive nodes per
 * element. A list of a hundred rows took 46 ms to close in Chromium on a
 * desktop CPU, all in the task that closed it, where the same panel's mount
 * never cost a frame more than the scheduler's budget. Nothing in the graph
 * is quadratic, it is the size of the graph, so the cost moves to frames
 * rather than going away. A row that leaves an open panel holds the same
 * graph, and was taken down in the frame its commit landed in.
 *
 * The rules, in order of time.
 *
 * 1. **Closing hides everything at once.** `disconnect` takes the panel out
 *    of the scene, makes its container invisible, which takes every object
 *    under it out of the raycast (`#castsOwnWalk` in `interactions.js`),
 *    takes the portal's marks and flags off the page, lets go of every node
 *    in the mirror and stops everything that could change the panel: the
 *    observer, the listeners, the clock and the pump. What is left is each
 *    object's subscription, and that is what is queued here. A commit does
 *    the same for the rows that left an open panel: their objects leave the
 *    scene in the frame the rows around them close the gap, and only their
 *    teardowns wait.
 * 2. **Hidden until taken down.** An object waiting for its teardown is
 *    still registered as a ray target, and the manager casts none that has
 *    a hidden object above it. Nothing takes an element's object out of
 *    its parent's content group but the portal, which has stopped, so every
 *    waiting object stays under the hidden container whatever order the
 *    teardowns run in. An object built for a commit that never came hangs
 *    under nothing, and `disconnect` hides it as well. The rows that left
 *    an open panel wait under a hidden group of their own rather than each
 *    hidden in its own right: that panel's channel still runs, and a row's
 *    own effect writes `visible` from its style whenever it runs.
 *    Nor has that portal stopped, but nothing it does reaches a held
 *    object: `unlink` took the row and everything under it out of the
 *    portal's maps, so no commit can place one of them anywhere, and a
 *    child still in the tree was passed over by the walk and is its
 *    commit's to place. The group lets go of them as their last teardown. The
 *    mirror let go of such a row when it left (`DomMirror.release`), so nothing
 *    the page does reaches it. The panel's text step (`textScale.js`) still
 *    does: a step crossed while the row waits draws its text again at the new
 *    step, for nothing, as it did while the row waited for its commit.
 * 3. **Only under the scene's scheduler.** The queue outlives the panel, so
 *    it needs frames that outlive the panel, and only the scheduler
 *    `render()` installs has them. A portal pacing itself, on a plain page
 *    or under a test runner, tears down in the task that closes it.
 * 4. **The frame's leftovers.** The queue is a pump of the lowest priority
 *    (`TEARDOWN_PRIORITY`). It is offered a frame only while time is left
 *    after every panel mounting or updating, and keeps to the deadline. The
 *    first pump offered a frame always tears down one object, so a queue
 *    alone in the scheduler finishes even on a zero budget. That is why it
 *    is not an `idle` pump, which is never the first pump of a frame: on a
 *    zero budget it would never run while frames keep coming, and rule 5
 *    would not take over either. So a queue comes before the idle work, a
 *    panel preparing the text step it may cross into, for the frames it
 *    lasts: what the queue frees is held by a panel nobody sees.
 * 5. **Frames stopping.** A scene can stop drawing with a teardown queued: a
 *    `presentingOnly` scene at the end of its session, which is exactly
 *    when a page's mirrored panel closes, or a `render()` taken down. Each
 *    queue watches the scene's frames. The wait starts when the queue is
 *    made and every frame starts it again. Once `FRAMELESS_WAIT` passes
 *    with no frame, a timer tears down for `FRAMELESS_SLICE` and looks
 *    again in the next task, until the queue is empty or a frame arrives,
 *    which starts the wait again. A queue that frames are reaching but the
 *    other pumps leave no time for is not frameless and waits for them.
 * 6. **Building a node finishes its teardown.** A node the queue covers can
 *    be built again before the queue reaches it: the same page element
 *    claimed for the next session, nodes moved into another panel, or a row
 *    put back in the panel it left, as a keyed list does when a filter is
 *    cleared. Its old teardown writes to what the new build owns, such as
 *    the `data-xr-checked` it takes off a checkbox or the reveal handle it
 *    leaves, so a portal building a node, or claiming a root, first runs
 *    the teardowns still queued for that node and for everything that was
 *    under it, at once (`finishTeardownOf`). The rest of the queue keeps to
 *    its frames: a row put back costs its own teardown in the frame that
 *    builds it, not those of every row that left with it. The walk collects
 *    a node's teardowns and those of everything under it next to each other,
 *    so the queue knows each covered node by where its run of entries
 *    starts and ends. A node is covered by one queue at a time: a newer
 *    queue covering a node an older one still covers, which the page moved
 *    from one panel to another, first finishes the older one's entries for
 *    it.
 * 7. **The end.** A queue ends when every entry has run, whichever path ran
 *    the last of them, and then leaves the scheduler, stops watching frames
 *    and clears its timer. Nothing else ends it.
 *
 * Each slice of teardowns runs as one `batch()`, so that what a slice writes
 * settles once. It runs in the default channel, for a closed panel and an
 * open one alike. A channel decides where what is built gets built, and a
 * teardown builds nothing: what its writes invalidate is queued in the
 * channel it was built in, an open panel's own included, whose pump drains
 * it with any other change. The default channel only keeps a slice run from
 * inside another panel's build (rule 6) from lending it that channel.
 */

/** Below any priority a panel can be given; see rule 4. */
export const TEARDOWN_PRIORITY = -Infinity;

/** How long, in ms, a queue waits for a frame before using timers; rule 5. */
export const FRAMELESS_WAIT = 250;

/** How long, in ms, one timer task tears down for; rule 5. */
export const FRAMELESS_SLICE = 4;

/**
 * Where a node's teardowns wait: the queue's run of entries for the node and
 * everything that was under it, and the way to finish them (rule 6).
 *
 * @typedef {object} Cover
 * @property {object} queue Which queue, so that a queue knows its own.
 * @property {number} start
 * @property {number} end
 * @property {(start: number, end: number) => void} finish
 */

/**
 * The run of teardowns still queued for a node, for as long as one is.
 *
 * @type {WeakMap<Node, Cover>}
 */
const covering = new WeakMap();

/**
 * Run whatever teardowns are still queued for a node and for everything
 * that was under it, before a portal builds the node again or claims it as
 * a root (rule 6). Nothing for a node no queue covers.
 *
 * @param {Node} node
 * @returns {void}
 */
export function finishTeardownOf(node) {
  const cover = covering.get(node);
  if (cover) {
    covering.delete(node);
    cover.finish(cover.start, cover.end);
  }
}

/**
 * @typedef {object} TeardownOptions
 * @property {PortalScheduler} scheduler The scene's, which outlives the
 *   panel (rule 3).
 * @property {(tick: () => void) => () => void} requestFrames The scene's
 *   frames, watched to tell a scene that stopped drawing from one that is
 *   busy (rule 5).
 * @property {Array<() => void>} teardowns Each object's teardown, in the
 *   order to run them. Taken over: the queue lets go of each entry as it
 *   runs it.
 * @property {readonly Node[]} nodes Every node the teardowns were built for
 *   (rule 6).
 * @property {readonly number[]} starts Where the run of entries for each of
 *   `nodes` and everything under it starts in `teardowns`.
 * @property {readonly number[]} ends And where it ends, past its last entry.
 *   A node passed twice has an empty run the second time.
 * @property {() => number} [now] The clock, injectable for tests.
 * @property {(fn: () => void, ms: number) => () => void} [setTimer] A timer
 *   and the way to clear it, injectable for tests.
 */

/** What an entry is left as once it has run, so the queue holds nothing. */
const ran = () => {};

/**
 * Queue the teardowns of a closed panel, or of the rows that left an open
 * one, on the scene's scheduler. See the rules above.
 *
 * @param {TeardownOptions} options
 * @returns {void}
 */
export function scheduleTeardown({
  scheduler,
  requestFrames,
  teardowns,
  nodes,
  starts,
  ends,
  now = () => performance.now(),
  setTimer = (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
}) {
  if (teardowns.length === 0) {
    return;
  }
  /**
   * The first entry that may not have run. A cursor rather than `shift`,
   * which is linear; entries past it that rule 6 ran are skipped.
   */
  let next = 0;
  /** How many entries have not run, by whichever path. */
  let left = teardowns.length;
  /** When the scene last drew a frame, or when the queue was made. */
  let lastFrame = now();
  /** @type {(() => void) | null} */
  let clearTimer = null;

  /**
   * Run one entry, if it has not run.
   *
   * @param {number} index
   * @returns {boolean} whether it ran now
   */
  const runEntry = (index) => {
    const teardown = teardowns[index];
    if (teardown === ran) {
      return false;
    }
    teardowns[index] = ran;
    left -= 1;
    teardown();
    return true;
  };

  /**
   * Tear down until the deadline, at least one object whatever the clock.
   *
   * @param {number} deadline
   * @returns {boolean} whether the queue is empty
   */
  const runUntil = (deadline) => {
    withChannel(null, () => {
      batch(() => {
        let progressed = false;
        while (left > 0 && (!progressed || now() < deadline)) {
          const index = next;
          next += 1;
          if (runEntry(index)) {
            progressed = true;
          }
        }
      });
    });
    return left === 0;
  };

  /** @type {PortalPump} */
  const pump = {
    priority: TEARDOWN_PRIORITY,
    tick: (deadline) => {
      const done = runUntil(deadline);
      if (done) {
        finish();
      }
      return done;
    },
  };

  const finish = () => {
    stopWatching();
    clearTimer?.();
    clearTimer = null;
    for (const node of nodes) {
      if (covering.get(node)?.queue === pump) {
        covering.delete(node);
      }
    }
  };

  /**
   * Rule 6: run what is left of a node's entries now.
   *
   * @param {number} start
   * @param {number} end
   */
  const finishRun = (start, end) => {
    withChannel(null, () => {
      batch(() => {
        for (let index = start; index < end; index++) {
          runEntry(index);
        }
      });
    });
    if (left === 0) {
      scheduler.remove(pump);
      finish();
    }
  };

  /** Rule 5: tear down on a timer while the scene draws no frames. */
  const check = () => {
    clearTimer = null;
    const waited = now() - lastFrame;
    if (waited < FRAMELESS_WAIT) {
      clearTimer = setTimer(check, FRAMELESS_WAIT - waited);
      return;
    }
    try {
      if (runUntil(now() + FRAMELESS_SLICE)) {
        scheduler.remove(pump);
        finish();
      }
    } finally {
      if (left > 0) {
        clearTimer = setTimer(check, 0);
      }
    }
  };

  for (let index = 0; index < nodes.length; index++) {
    const start = starts[index];
    const end = ends[index];
    if (start === end) {
      // Nothing queued for it here: a node with no object and nothing under
      // it, or one the walk passed a second time.
      continue;
    }
    const node = nodes[index];
    if (covering.get(node)?.queue !== pump) {
      finishTeardownOf(node);
      covering.set(node, { queue: pump, start, end, finish: finishRun });
    }
  }
  const stopWatching = requestFrames(() => {
    lastFrame = now();
  });
  clearTimer = setTimer(check, FRAMELESS_WAIT);
  scheduler.schedule(pump);
}
