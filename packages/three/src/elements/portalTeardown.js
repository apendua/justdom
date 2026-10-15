import { batch, withChannel } from "@apendua/signal";

/**
 * @import {PortalPump, PortalScheduler} from './portalScheduler.js';
 */

/**
 * Taking a closed panel's objects down a budget at a time, the way they were
 * built.
 *
 * What a panel costs to close is the reactive graph its objects hold: every
 * element keeps a subscription, and unsubscribing it disposes the effects
 * under it and disconnects every derived read they kept alive, each of which
 * lets go of its own dependencies. That is about a hundred reactive nodes per
 * element. A list of a hundred rows took 46 ms to close in Chromium on a
 * desktop CPU, all in the task that closed it, where the same panel's mount
 * never cost a frame more than the scheduler's budget. Nothing in the graph
 * is quadratic, it is the size of the graph, so the cost moves to frames
 * rather than going away.
 *
 * The rules, in order of time.
 *
 * 1. **Closing hides everything at once.** `disconnect` takes the panel out
 *    of the scene, makes its container invisible, which takes every object
 *    under it out of the raycast (`#castsOwnWalk` in `interactions.js`),
 *    takes the portal's marks and flags off the page, lets go of every node
 *    in the mirror and stops everything that could change the panel: the
 *    observer, the listeners, the clock and the pump. What is left is each
 *    object's subscription, and that is what is queued here.
 * 2. **Hidden until taken down.** An object waiting for its teardown is
 *    still registered as a ray target, and the manager casts none that has
 *    a hidden object above it. Nothing takes an element's object out of
 *    its parent's content group but the portal, which has stopped, so every
 *    waiting object stays under the hidden container whatever order the
 *    teardowns run in. An object built for a commit that never came hangs
 *    under nothing, and `disconnect` hides it as well.
 * 3. **Only under the scene's scheduler.** The queue outlives the panel, so
 *    it needs frames that outlive the panel, and only the scheduler
 *    `render()` installs has them. A portal pacing itself, on a plain page
 *    or under a test runner, tears down in the task that closes it.
 * 4. **The frame's leftovers.** The queue is a pump of the lowest priority
 *    (`TEARDOWN_PRIORITY`). It is offered a frame only while time is left
 *    after every panel mounting or updating, and keeps to the deadline. The
 *    first pump offered a frame always tears down one object, so a queue
 *    alone in the scheduler finishes even on a zero budget.
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
 *    claimed for the next session, or nodes moved into another panel. Its
 *    old teardown writes to what the new build owns, such as the
 *    `data-xr-checked` it puts back on a checkbox or the reveal handle it
 *    joins, so a portal building a node, or claiming a root, first runs
 *    every teardown still queued for it, whole and at once
 *    (`finishTeardownOf`).
 * 7. **The end.** A queue ends when it is empty, by any of the three paths,
 *    and then leaves the scheduler, stops watching frames and clears its
 *    timer. Nothing else ends it.
 *
 * Each slice of teardowns runs as one `batch()` in the default channel: the
 * panel's own channel has no pump to drain it any more.
 */

/** Below any priority a panel can be given; see rule 4. */
export const TEARDOWN_PRIORITY = -Infinity;

/** How long, in ms, a queue waits for a frame before using timers; rule 5. */
export const FRAMELESS_WAIT = 250;

/** How long, in ms, one timer task tears down for; rule 5. */
export const FRAMELESS_SLICE = 4;

/**
 * What finishes the queue covering a node, for as long as one does.
 *
 * @type {WeakMap<Node, () => void>}
 */
const covering = new WeakMap();

/**
 * Run whatever teardown is still queued for a node, whole, before a portal
 * builds the node again or claims it as a root (rule 6). Nothing for a node
 * no queue covers.
 *
 * @param {Node} node
 * @returns {void}
 */
export function finishTeardownOf(node) {
  covering.get(node)?.();
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
 * @property {() => number} [now] The clock, injectable for tests.
 * @property {(fn: () => void, ms: number) => () => void} [setTimer] A timer
 *   and the way to clear it, injectable for tests.
 */

/** What an entry is left as once it has run, so the queue holds nothing. */
const ran = () => {};

/**
 * Queue a closed panel's teardowns on the scene's scheduler. See the rules
 * above.
 *
 * @param {TeardownOptions} options
 * @returns {void}
 */
export function scheduleTeardown({
  scheduler,
  requestFrames,
  teardowns,
  nodes,
  now = () => performance.now(),
  setTimer = (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
}) {
  /** The next entry to run. A cursor rather than `shift`, which is linear. */
  let next = 0;
  /** When the scene last drew a frame, or when the queue was made. */
  let lastFrame = now();
  /** @type {(() => void) | null} */
  let clearTimer = null;

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
        while (next < teardowns.length && (!progressed || now() < deadline)) {
          const teardown = teardowns[next];
          teardowns[next] = ran;
          next += 1;
          progressed = true;
          teardown();
        }
      });
    });
    return next >= teardowns.length;
  };

  const finish = () => {
    stopWatching();
    clearTimer?.();
    clearTimer = null;
    for (const node of nodes) {
      if (covering.get(node) === finishNow) {
        covering.delete(node);
      }
    }
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

  /** Rule 6, and the end of a queue run off the scheduler's frames. */
  function finishNow() {
    if (next < teardowns.length) {
      runUntil(Infinity);
    }
    scheduler.remove(pump);
    finish();
  }

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
      if (next < teardowns.length) {
        clearTimer = setTimer(check, 0);
      }
    }
  };

  if (teardowns.length === 0) {
    return;
  }
  for (const node of nodes) {
    covering.set(node, finishNow);
  }
  const stopWatching = requestFrames(() => {
    lastFrame = now();
  });
  clearTimer = setTimer(check, FRAMELESS_WAIT);
  scheduler.schedule(pump);
}
