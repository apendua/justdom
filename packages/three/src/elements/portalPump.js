import { batch, Derived, makeNonReactive, withChannel } from "@apendua/signal";

/**
 * @import {Unsubscribable} from 'rxjs';
 * @import {UpdateChannel} from "@apendua/signal";
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
 * @property {(node: Node) => boolean} buildNode Build the object for one
 *   queued node and attach it, returning whether anything was genuinely
 *   built. A stale entry — a node that left the tree, a comment with nothing
 *   to draw — reports false, and the pump does not count it against the
 *   at-least-one-per-frame guarantee, or a queue headed by such entries
 *   would spend whole frames building nothing.
 * @property {() => void} onSettled Told whenever a tick ends with the queue
 *   and the channel both empty — the portal's cue to declare its initial
 *   mount done.
 * @property {() => void} afterTick Told at the end of every tick, drained or
 *   not — the portal's cue that content appeared or moved under whatever
 *   rays are resting on the panel.
 */

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
  buildNode,
  onSettled,
  afterTick,
}) {
  /**
   * DOM roots waiting to be built, in arrival order. Roots rather than
   * nodes: the observer reports what was inserted, and one insertion may
   * carry a whole subtree, which queues its children as it is built. The set
   * is the same membership, kept so a node cannot be queued twice.
   *
   * @type {Node[]}
   */
  const pendingNodes = [];

  /** @type {Set<Node>} */
  const pendingSet = new Set();

  /**
   * This portal's slice of a frame: build queued nodes until the deadline,
   * hand what is left to the channel, and when both are empty, say so. At
   * least one node and at least one update per call regardless of the clock
   * — the scheduler's contract asks it of whichever pump it offers a frame
   * to first, and giving the guarantee always is what keeps a zero budget
   * moving instead of stalling.
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
      if (pendingNodes.length > 0) {
        batch(() => {
          withChannel(channel, () => {
            // Until the deadline — but at least one node genuinely *built*,
            // not merely one entry shifted: entries for nodes that left the
            // tree are skipped for free, or a queue headed by them would
            // spend whole frames building nothing.
            let progressed = false;
            while (pendingNodes.length > 0 && (!progressed || now() < deadline)) {
              const node = /** @type {Node} */ (pendingNodes.shift());
              pendingSet.delete(node);
              if (buildNode(node)) {
                progressed = true;
              }
            }
          });
        });
      }
      // In the channel, because draining can build: a node re-deriving its
      // layout constructs computations of its own, and those belong to the
      // panel's region like everything else here.
      withChannel(channel, () => {
        channel.flush({ budget: Math.max(deadline - now(), 0) });
      });
      afterTick();
      if (pendingNodes.length > 0 || channel.pendingCount > 0) {
        return false;
      }
      onSettled();
      return pendingNodes.length === 0 && channel.pendingCount === 0;
    },
  };

  const schedule = () => {
    if (pendingNodes.length > 0 || channel.pendingCount > 0) {
      scheduler.schedule(pump);
    }
  };

  // Work landing in the channel while no pump is running — a scroll, an
  // attribute flip, anything after the initial mount — must start one. The
  // watcher lives in the *default* channel, necessarily: a computation
  // inside the channel saying "the channel has work" would itself be the
  // work, waiting for the pump it exists to start.
  //
  // Never-equal, deliberately. The flag can go true and back mid-flush,
  // and the two announcements can collapse into one evaluation that finds
  // the cached value again; an equality gate would swallow exactly the
  // notification that carries "there is work now".
  const pendingWatch = withChannel(
    null,
    () =>
      new Derived(() => channel.hasPendingUpdates, {
        isEqual: () => false,
      }),
  );

  /** @type {Unsubscribable} */
  const pendingWatchSubscription = pendingWatch.subscribe({
    next: () => {
      if (pendingWatch.get()) {
        schedule();
      }
    },
  });

  // Prime it: a Derived computes on first read, and the watcher must be
  // watching before the first mutation arrives. Non-reactively, and that
  // is load-bearing: `createPortal` is itself called inside a computation
  // — `dom()` builds the portal in an effect — and a bare read here would
  // make that computation depend on the never-equal watcher, tearing the
  // portal down and rebuilding it on every toggle of its own channel.
  makeNonReactive(() => pendingWatch.get())();

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
        pendingSet.add(node);
        pendingNodes.push(node);
      }
    },

    /**
     * Un-queue a node rather than build a ghost. The array keeps its entry —
     * `buildNode` reports what left the tree as no work done — but the
     * membership must go, or a node removed and re-added would be refused
     * the queue the second time.
     *
     * @param {Node} node
     */
    discard(node) {
      pendingSet.delete(node);
    },

    /** Ask the scheduler for frame time, if there is any work to spend it on. */
    schedule,

    /** A closed panel must not go on being offered frames. */
    dispose() {
      scheduler.remove(pump);
      pendingWatchSubscription.unsubscribe();
      pendingNodes.length = 0;
      pendingSet.clear();
    },
  };
}
