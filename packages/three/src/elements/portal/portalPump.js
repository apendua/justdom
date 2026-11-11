import { batch, Effect, withChannel } from "justdom-signal";

/**
 * @import {UpdateChannel} from "justdom-signal";
 * @import {PortalScheduler} from './portalScheduler.js';
 */

/**
 * @typedef {object} PortalPumpOptions
 * @property {UpdateChannel} channel The panel's own update channel. The pump
 *   drains it a budget's worth at a time, and watches it so that work landing
 *   while no pump is running — a scroll, an attribute flip, anything after
 *   the initial mount — starts one.
 * @property {PortalScheduler} scheduler Who hands out frame time. The pump
 *   asks for it when there is work and leaves the queue by finishing, not by
 *   being stopped.
 * @property {number} priority This pump's say in the scheduler's pool.
 * @property {() => void} [beforeTick] Told at the top of every tick, before
 *   anything is read: the portal's cue to take whatever its observer holds
 *   and has not yet delivered. A ray's press runs the page's handlers inside
 *   the frame, and a handler that changes the DOM leaves its records waiting
 *   for a microtask that does not come before this tick.
 * @property {(node: Node) => boolean} buildNode Build the object for one
 *   queued node and attach it, returning whether anything was genuinely
 *   built. A stale entry — a node that left the tree, a comment with nothing
 *   to draw — reports false, and the pump does not count it against the
 *   at-least-one-per-frame guarantee, or a queue headed by such entries
 *   would spend whole frames building nothing.
 * @property {() => boolean} onCommit Told when a tick has brought the scene
 *   up to date as a whole — the node queue empty and the channel's effects
 *   swept — and before `afterTick`: the portal's cue to put into the scene
 *   whatever it has been holding back for exactly that moment, the objects
 *   it built and the ones whose nodes left. Answers whether it did. A portal
 *   may decline — it is holding a finished mount for its loading frame's
 *   minimum time — and a tick whose commit was declined has not settled:
 *   the pump stays scheduled and asks again next frame, so the portal
 *   needs no way of its own to bring the pump back.
 * @property {() => boolean} [commitsEarly] Whether the portal takes its
 *   commit as soon as no node is waiting to be built, however much the
 *   channel still holds. False by default, and for an atomic portal always:
 *   there the commit is the frame the update lands whole in. A portal that
 *   is not atomic has no such frame to wait for — its effects already land
 *   by instalments — and holding its new rows back for a channel that an
 *   animation keeps busy would stall exactly what the option exists to keep
 *   moving. A row is placed as it is built, since an effect runs when it is
 *   made, so it is fit to go in at once. Asked every tick, so the portal
 *   can keep its initial mount whole and commit early only after.
 * @property {() => boolean} [commitDue] Whether the portal would take a
 *   commit now. Asked on every tick a commit has waited on, so it should be
 *   cheap, and the time bounds force a long frame only while it answers
 *   true: the reading a forced frame does is for the commit, and one the
 *   portal would decline is undone by the next invalidation, so until it is
 *   due the pump keeps to its budget. True by default; false while a
 *   finished mount is held for its loading frame's minimum time.
 * @property {() => boolean} [hasPendingCommit] Whether the portal is holding
 *   anything for `onCommit`. Asked when deciding whether a frame is worth
 *   asking for: a removal that happens to queue nothing in the channel
 *   still has an object to take out of the scene, and a pump that only
 *   counted queued nodes and queued effects would never come round for it.
 * @property {() => void} [onForced] Told when a tick spends past its budget
 *   because a bound ran out, `MAX_COMMIT_WAIT` or `MAX_BUILD_WAIT`: the
 *   portal's cue to show, in outlines mode, a panel that never settles on
 *   its own.
 * @property {() => void} onSettled Told whenever a tick ends with the queue
 *   and the channel both empty — the portal's cue to declare its initial
 *   mount done.
 * @property {(queued: boolean) => void} [onQueued] Told when the pump joins
 *   the scheduler's queue, having work, and when it leaves it, having none:
 *   the portal's cue to say on the page whether the panel has an update it
 *   has yet to draw.
 * @property {(settled: boolean) => void} afterTick Told at the end of every
 *   tick, drained or not — the portal's cue that content appeared or moved
 *   under whatever rays are resting on the panel — with whether the tick
 *   found nothing left to build or sweep: a tick that did not is a mount
 *   that needs another frame, which is the portal's cue to show something
 *   in the meantime.
 */

/**
 * How long, in milliseconds, a pump waits on a channel that will not empty
 * before it empties it in one go. The count is wall-clock time, the frames
 * between ticks included: it runs from the end of the first tick that finds no
 * node left to build and the channel still holding work the commit waits for,
 * to the start of the next tick that ends with nodes still queued, a build
 * spanning frames, which pauses it. A tick that starts with the count running
 * is counted whole, any build it finishes included; the first tick after a
 * pause, like the first of all, is counted from its end. The build's reading
 * gets what is left of the bound afterwards; a pause does not start the count
 * again, or rows that keep arriving would hold the panel for as long as they
 * came. The count ends only when a commit is taken, or the portal commits
 * without the channel (`commitsEarly`). A commit the portal would decline,
 * holding a finished mount for its loading frame's minimum time, leaves it
 * running, and past the bound the pump keeps to its budget until the portal
 * says the commit is due (`commitDue`): a long frame spent reading the panel
 * for a commit that is refused is undone by the next invalidation. Then, or
 * otherwise on the first tick past the bound, the pump sweeps the channel
 * unbudgeted, and the panel takes one long frame and lands.
 *
 * An atomic channel holds every effect until the pass that finds nothing
 * left to read. Anything that invalidates the panel every frame, such as an
 * endless animation, a timer faster than a slow frame or a drag, undoes each
 * frame's reading before the next, so that pass never comes. The channel's
 * own bound on that, `maxStalePasses`, counts passes and is off here, since
 * a large mount overruns the budget for many frames and a forced drain there
 * is the stall the budget exists to avoid. A time bound tells the two
 * apart: a mount still building has nodes queued and is not swept by this
 * one, and one with only reading left has a second of budgeted frames
 * before the long one. A build that never finishes has a bound of its own,
 * `MAX_BUILD_WAIT`.
 */
export const MAX_COMMIT_WAIT = 1000;

/**
 * How long, in milliseconds, a commit waits on a build the page keeps adding to
 * before the pump builds whatever is queued and sweeps the channel in one go.
 * `MAX_COMMIT_WAIT` pauses on every tick that ends with nodes queued, so it
 * never runs for a queue that arrivals keep fed faster than a frame's slice
 * builds it: the desk's charts, whose timers replace text and add log rows, on
 * a runner drawing a few frames a second. The wait counts from the start of
 * the first tick that ends without the commit taken, and ends only when one is
 * taken, or the portal commits without the channel. While the portal would
 * decline the commit, the bound waits for it to be due (`commitDue`), keeping
 * to the budget until then, as `MAX_COMMIT_WAIT` does. The pump lands the
 * build once a node new to the queue arrives from the page, not from a build,
 * this long into the wait; a queued node the page moves, or takes out and
 * puts back, is not new, and the portal does not queue a node the page has
 * already taken out again by the time it reads the change.
 * One node is enough: the rule does not ask whether the build is keeping up,
 * since a breadth-first walk's queue grows while it is making headway and no
 * count of the queue tells a slow mount from a flooded one. So a slow mount
 * that the page adds a single row to five seconds in builds the rest in one
 * frame. A build fed only by its own content, a large mount on a slow device,
 * is left to its budget however long it takes, since building the rest of it in
 * one frame is the stall the budget exists to avoid.
 */
export const MAX_BUILD_WAIT = 5000;

/**
 * The machinery that spreads a portal's work across frames: a queue of DOM
 * nodes waiting to be built, a tick that spends each frame's slice on them
 * and on the channel, and a watcher that asks for frames whenever work lands.
 *
 * Extracted from the portal so that the portal reads as what is projected
 * and this as when. The portal decides what building a node means and what
 * an empty queue means; everything about pacing — the deadline, the
 * guarantee, the scheduling — lives here.
 *
 * @param {PortalPumpOptions} options
 */
export function createPortalPump({
  channel,
  scheduler,
  priority,
  beforeTick = () => {},
  buildNode,
  onCommit,
  commitsEarly = () => false,
  commitDue = () => true,
  hasPendingCommit = () => false,
  onForced = () => {},
  onSettled,
  onQueued = () => {},
  afterTick,
}) {
  /**
   * DOM roots waiting to be built, in arrival order. Roots rather than
   * nodes: the observer reports what was inserted, and one insertion may
   * carry a whole subtree, which queues its children as it is built. The set
   * is the same membership, kept so a node cannot be queued twice.
   *
   * **The queue discipline is the traversal order.** Drained from the front
   * and grown at the back, which makes it FIFO; the portal puts a node's
   * children on the tail as it builds it. Together those two facts are what
   * make a mount breadth-first — every sibling before any of their children,
   * level by level — and neither of them looks like a decision at the point
   * it is made. It is pinned by a test, because the obvious optimization
   * here undoes it silently: `shift` on a queue of thousands is linear, and
   * swapping it for `pop` to fix that turns the mount depth-first without a
   * word.
   *
   * @type {Node[]}
   */
  const pendingNodes = [];

  /**
   * What `pendingNodes` holds, so that a node is queued once. A node the page
   * takes out of the tree keeps its entry: `buildNode` reports what left the
   * tree as no work done, and one the page puts back before its turn is
   * built then, rather than queued again as an arrival.
   *
   * @type {Set<Node>}
   */
  const pendingSet = new Set();

  /** Whether the pump is in the scheduler's queue, as last told. */
  let queued = false;

  /** @param {boolean} value */
  const setQueued = (value) => {
    if (queued !== value) {
      queued = value;
      onQueued(value);
    }
  };

  /**
   * How long, by the channel's clock, this pump has waited on a channel that
   * has not emptied, over the stretches of ticks with nothing left to build
   * before the current one, the frames between them included; and when the
   * current stretch began, or null while a build is under way or nothing is
   * waited for. See `MAX_COMMIT_WAIT`.
   */
  let waited = 0;
  /** @type {number | null} */
  let waitingSince = null;
  /**
   * The start of the first tick that ended without the commit taken,
   * building included, by the channel's clock, or null while it is not
   * waiting. See `MAX_BUILD_WAIT`.
   *
   * @type {number | null}
   */
  let commitWaitingSince = null;
  /**
   * When a node last arrived from the page rather than from a build: the
   * start of the tick that first saw it, by the channel's clock. See
   * `MAX_BUILD_WAIT`.
   *
   * @type {number | null}
   */
  let arrivedAt = null;
  /**
   * Whether a node has arrived from the page since the last tick began. Set
   * per node, and stamped into `arrivedAt` once a tick, so that a thousand
   * rows appended at once cost one clock read.
   */
  let arrived = false;
  /** Whether the tick is building, so that what it queues is not an arrival. */
  let building = false;

  /**
   * This portal's slice of a frame: build queued nodes until the deadline,
   * hand what is left to the channel, and when both are empty, say so. At
   * least one node and at least one update per call regardless of the clock
   * — the scheduler's contract asks it of whichever pump it offers a frame
   * to first, and giving the guarantee always is what keeps a zero budget
   * moving instead of stalling.
   *
   * The scene changes once per update, not once per frame. The channel is
   * atomic, so what a frame's slice buys is *reading* — measurements
   * resolved, text rasterized — and the effects that write the scene run
   * together, in the frame that finds nothing left to read. (A portal built
   * with `atomic: false` has a channel that runs its effects under the
   * budget instead, and then the scene changes by instalments — and its
   * built rows go in without waiting for the channel; see `commitsEarly`.)
   * And while nodes
   * are still queued the channel is only warmed, never flushed: a row still
   * to be built changes the layout of the rows around it, and applying
   * those moves before the row exists would be the same half-update from the
   * other side. So the sweep waits for the queue, and the queue's objects
   * wait for the sweep — `onCommit` is where the portal puts them in. A
   * sweep that something keeps from ever coming, by invalidating the panel
   * every frame, is forced once the wait passes `MAX_COMMIT_WAIT`.
   *
   * Returns whether the pump is finished, which is how it leaves the
   * scheduler's queue: not by being stopped, but by having nothing left —
   * checked *after* `onSettled`, because the loading flip is itself a
   * change the graph answers, the gated ray targets re-evaluating their
   * conditions right back into this channel, and a notification collapsed
   * by the queue's own bookkeeping must not strand that work.
   *
   * @type {import('./portalScheduler.js').PortalPump}
   */
  const pump = {
    priority,
    tick: (deadline) => {
      const now = channel.now;
      const tickStart = now();
      beforeTick();
      if (arrived) {
        arrivedAt = tickStart;
        arrived = false;
      }
      // Either bound forces a long frame only for a commit the portal would
      // take; until then the tick keeps to its budget.
      const due = commitWaitingSince !== null && commitDue();
      // Past the bound on the whole wait, everything queued is built and the
      // channel swept in this tick, whatever the deadline.
      const overdue =
        due &&
        commitWaitingSince !== null &&
        arrivedAt !== null &&
        arrivedAt - commitWaitingSince >= MAX_BUILD_WAIT;
      if (overdue) {
        onForced();
      }
      if (pendingNodes.length > 0) {
        batch(() => {
          withChannel(channel, () => {
            // Until the deadline — but at least one node genuinely *built*,
            // not merely one entry shifted: entries for nodes that left the
            // tree are skipped for free, or a queue headed by them would
            // spend whole frames building nothing.
            let progressed = false;
            building = true;
            try {
              while (pendingNodes.length > 0 && (!progressed || overdue || now() < deadline)) {
                const node = /** @type {Node} */ (pendingNodes.shift());
                pendingSet.delete(node);
                if (buildNode(node)) {
                  progressed = true;
                }
              }
            } finally {
              // A build that throws must not leave the page's next node
              // taken for the build's own.
              building = false;
            }
          });
        });
      }
      // In the channel, because draining can build: a node re-deriving its
      // layout constructs computations of its own, and those belong to the
      // panel's region like everything else here.
      withChannel(channel, () => {
        const budget = Math.max(deadline - now(), 0);
        if (pendingNodes.length > 0) {
          channel.warm({ budget });
        } else if (overdue) {
          channel.flush({ budget: Infinity });
        } else if (
          due &&
          waited + (waitingSince === null ? 0 : now() - waitingSince) >= MAX_COMMIT_WAIT
        ) {
          onForced();
          channel.flush({ budget: Infinity });
        } else {
          channel.flush({ budget });
        }
      });
      // Settled only if the portal took the commit: one it declined leaves
      // the scene behind the graph, and the tick has to come round again.
      const built = pendingNodes.length === 0;
      const drained = built && channel.pendingCount === 0;
      const early = commitsEarly();
      let settled = drained && onCommit();
      if (!drained && built && hasPendingCommit() && early) {
        // Committed, but not settled: the channel still has work, and the
        // tick comes round for it.
        onCommit();
        settled = false;
      }
      if (settled || (built && early)) {
        // Nothing is waiting on the channel any more: the commit was
        // taken, or the portal takes it without the channel.
        waited = 0;
        waitingSince = null;
        commitWaitingSince = null;
        return finish(settled);
      }
      commitWaitingSince ??= tickStart;
      if (!built) {
        // Still building. The frames a build spans do not count towards
        // the bound, so its reading gets what is left of it afterwards.
        if (waitingSince !== null) {
          waited += tickStart - waitingSince;
          waitingSince = null;
        }
      } else if (!drained) {
        waitingSince ??= now();
      }
      return finish(settled);
    },
  };

  /**
   * The end of every tick, settled or not; see `tick` for why the queue and
   * the channel are checked again after `onSettled`.
   *
   * @param {boolean} settled
   * @returns {boolean} whether the pump is finished
   */
  function finish(settled) {
    afterTick(settled);
    if (!settled) {
      return false;
    }
    onSettled();
    const finished = pendingNodes.length === 0 && channel.pendingCount === 0;
    if (finished) {
      setQueued(false);
    }
    return finished;
  }

  const schedule = () => {
    if (pendingNodes.length > 0 || channel.pendingCount > 0 || hasPendingCommit()) {
      scheduler.schedule(pump);
      setQueued(true);
    }
  };

  // Work landing in the channel while no pump is running — a scroll, an
  // attribute flip, anything after the initial mount — must start one. The
  // watcher lives in the *default* channel, necessarily: work inside the
  // channel saying "the channel has work" would itself be the work, waiting
  // for the pump it exists to start.
  //
  // An `Effect`, which is what this always was: it reads a flag and does
  // something about it, and nobody wants its value. Three things it used to
  // need go with the change — the never-equal gate (an effect re-runs on the
  // announcement, not on the value, so there is nothing for an equality gate
  // to swallow), the manual subscription, and the priming read. An effect
  // runs once when it is built, which is the priming, and it tracks its own
  // reads, so `createPortal`'s surrounding computation never sees this one.
  const pendingWatch = withChannel(
    null,
    () =>
      new Effect(
        () => {
          if (channel.hasPendingUpdates) {
            schedule();
          }
        },
        { name: "portal-pending-watch" },
      ),
  );

  return {
    /**
     * Queue a node to be built on some frame's slice. Idempotent while the
     * node is already waiting, and a no-op for one the portal has built —
     * the caller checks that, since the object map is the caller's.
     *
     * @param {Node} node
     */
    enqueue(node) {
      if (!pendingSet.has(node)) {
        // Only what joins the queue arrives: a node the page moves while it
        // is still queued is reported added again and changes nothing.
        if (!building) {
          arrived = true;
        }
        pendingSet.add(node);
        pendingNodes.push(node);
      }
    },

    /** Ask the scheduler for frame time, if there is any work to spend it on. */
    schedule,

    /** A closed panel must not go on being offered frames. */
    dispose() {
      scheduler.remove(pump);
      pendingWatch.dispose();
      pendingNodes.length = 0;
      pendingSet.clear();
    },
  };
}
