import { createProperty } from "justdom-signal";

/**
 * One portal's claim on frame time, as the scheduler sees it.
 *
 * `tick` is called with the shared deadline and must make at least one unit
 * of progress — one node built or one update run — however far past the
 * deadline the clock already is. That guarantee belongs to the *first* pump
 * the scheduler offers a frame to; every later pump is offered the frame
 * only while time remains. Between the two rules a zero budget still moves
 * exactly one unit of work per frame, and the rotation below decides whose.
 *
 * It returns whether the pump is finished — no queued nodes, no pending
 * updates — at which point the scheduler forgets it until it is scheduled
 * again.
 *
 * A pump marked `idle` is the exception: it does work that may wait, such as
 * rasterizing a step the panel may never cross into, so it is offered the
 * frame after every other pump, and only while time remains. It is never the
 * first pump of a frame, and it never moves the rotation.
 *
 * @typedef {object} PortalPump
 * @property {number} priority
 * @property {boolean} [idle] Run only in the time the other pumps leave.
 * @property {(deadline: number) => boolean} tick
 */

/**
 * @typedef {object} PortalScheduler
 * @property {(pump: PortalPump) => void} schedule The pump has work; see that
 *   it gets frame time. Idempotent while the pump is already waiting.
 * @property {(pump: PortalPump) => void} remove Forget the pump entirely — a
 *   portal on its way out.
 */

/**
 * @typedef {object} PortalSchedulerOptions
 * @property {number | (() => number)} [budget] Milliseconds of each frame the
 *   scheduler's portals may spend between them. A getter is read at the top
 *   of every frame, so the trade between mount time and frame rate stays a
 *   live one. A share of the measured frame by default, which is what
 *   `createFrameShareBudget` is for; a number here is milliseconds, whatever
 *   the frame turns out to be.
 * @property {() => number} [now] The clock, injectable so tests are
 *   deterministic.
 * @property {(tick: () => void) => () => void} requestFrames How the
 *   scheduler gets a frame loop, and how it lets go of it: called when work
 *   arrives, and the returned stop is called the moment no pump has any, so
 *   an idle scene runs no frame callbacks at all.
 */

/** The frame a scene is assumed to be drawing at before it has drawn any. */
const ASSUMED_FRAME_MS = 1000 / 60;

/**
 * How much of a frame the panels may have. 0.3 of a 60 Hz frame is 5 ms,
 * which is the number this scheduler carried when it was written down as one.
 */
const DEFAULT_SHARE = 0.3;

/** How many frames back the estimate looks. */
const DEFAULT_WINDOW = 60;

/**
 * The floor and ceiling on the answer. The floor is a promise that a panel
 * still mounts, slowly, through a stretch of terrible frames; the ceiling
 * keeps a scene that has genuinely dropped to 20 Hz from handing the panels
 * a sixth of a second.
 */
const MINIMUM_MS = 1.5;
const MAXIMUM_MS = 8;

/**
 * A budget that is a share of the frame rather than a number of milliseconds.
 *
 * Five milliseconds is a third of a 60 Hz frame and three fifths of a 120 Hz
 * one. The number was chosen against the frame rate headsets used to run at,
 * and it stopped meaning what it meant the moment the sessions started asking
 * for their fastest rate: the frame halved and the panels' share of it did
 * not. So the number is not the setting — the share is, and the frame is
 * measured.
 *
 * Measured as the *shortest* recent frame, which is the one thing here worth
 * explaining. The obvious estimate is the average, and the average is a trap:
 * a frame stretched by the portals' own work would read as a longer frame,
 * which would buy them a bigger slice, which would stretch the next one. The
 * shortest frame in the recent past is the one nothing was blocking, so it is
 * the display's cadence rather than a report on our own spending, and it
 * cannot be talked upwards by it.
 *
 * @param {{ share?: number; window?: number; minimum?: number; maximum?: number }} [options]
 * @returns {{ sample: (frameMs: number) => void; budget: () => number }}
 */
export function createFrameShareBudget({
  share = DEFAULT_SHARE,
  window = DEFAULT_WINDOW,
  minimum = MINIMUM_MS,
  maximum = MAXIMUM_MS,
} = {}) {
  /** @type {number[]} */
  const recent = [];
  let next = 0;
  return {
    sample(frameMs) {
      // A frame that took no time did not happen, and a frame that took a
      // second was a tab coming back from the background. Neither is the
      // cadence, and the minimum would believe the first of them forever.
      if (!(frameMs > 1) || frameMs > 200) {
        return;
      }
      recent[next] = frameMs;
      next = (next + 1) % window;
    },
    budget() {
      const frame = recent.length ? Math.min(...recent) : ASSUMED_FRAME_MS;
      return Math.min(maximum, Math.max(minimum, share * frame));
    },
  };
}

/**
 * One budget for every panel under a renderer.
 *
 * The budget guards the frame, and the frame is shared: three panels each
 * honouring a private five milliseconds cost the frame fifteen, and several
 * panels mounting at once is not an edge case — it is scene startup, the
 * heaviest moment an XR app has. So the pumps do not pace themselves;
 * whoever holds the scheduler paces all of them, dividing one budget per
 * frame — which is the very caller `UpdateChannel`'s manual mode was
 * written for.
 *
 * Division is by priority first and rotation second. Buckets of higher
 * priority are offered the frame before lower ones — a panel the player is
 * waiting on can be told to finish first, and starving the others is then
 * the point, not a bug. Within a bucket the offer rotates, so when the
 * budget is too small for everyone, the guaranteed first slice goes to a
 * different pump each frame and nobody waits forever on a peer.
 *
 * @param {PortalSchedulerOptions} options
 * @returns {PortalScheduler}
 */
export function createPortalScheduler({
  budget = createFrameShareBudget().budget,
  now = () => performance.now(),
  requestFrames,
}) {
  const budgetOf = typeof budget === "function" ? budget : () => budget;

  /** @type {Set<PortalPump>} */
  const waiting = new Set();

  /** @type {(() => void) | null} */
  let stopFrames = null;

  /** Advances every frame; what makes the within-bucket offer rotate. */
  let rotation = 0;

  /**
   * The idle pumps waiting this frame, refilled at the top of every tick
   * rather than made anew.
   *
   * @type {PortalPump[]}
   */
  const idle = [];

  /** Let go of the frame loop the moment no pump has work. */
  const stopIfIdle = () => {
    if (waiting.size === 0 && stopFrames) {
      const stop = stopFrames;
      stopFrames = null;
      stop();
    }
  };

  const tick = () => {
    const deadline = now() + budgetOf();
    // Buckets by priority, highest first, in one pass; insertion order
    // within a bucket is stable, and the rotation below is what varies it.
    /** @type {Map<number, PortalPump[]>} */
    const buckets = new Map();
    idle.length = 0;
    for (const pump of waiting) {
      if (pump.idle) {
        idle.push(pump);
        continue;
      }
      const bucket = buckets.get(pump.priority);
      if (bucket) {
        bucket.push(pump);
      } else {
        buckets.set(pump.priority, [pump]);
      }
    }
    const priorities = [...buckets.keys()].sort((a, b) => b - a);
    let first = true;
    for (const priority of priorities) {
      const bucket = /** @type {PortalPump[]} */ (buckets.get(priority));
      const start = rotation % bucket.length;
      for (let index = 0; index < bucket.length; index += 1) {
        const pump = bucket[(start + index) % bucket.length];
        if (!first && now() >= deadline) {
          // Out of time. The pumps not reached keep their place in
          // `waiting`, and the rotation means the head of the queue is a
          // different one next frame.
          rotation += 1;
          return;
        }
        first = false;
        if (pump.tick(deadline)) {
          waiting.delete(pump);
        }
      }
    }
    rotation += 1;
    // What the frame has left, if anything. Each idle pump keeps to the
    // deadline itself; this only stops offering once the time is gone.
    for (const pump of idle) {
      if (now() >= deadline) {
        break;
      }
      if (pump.tick(deadline)) {
        waiting.delete(pump);
      }
    }
    stopIfIdle();
  };

  return {
    schedule(pump) {
      waiting.add(pump);
      if (!stopFrames) {
        stopFrames = requestFrames(tick);
      }
    },
    remove(pump) {
      waiting.delete(pump);
      stopIfIdle();
    },
  };
}

/**
 * The scheduler the portals under a renderer share. `render()` installs one
 * per rendering context, which is what makes the budget global: every panel
 * in the scene draws frame time from the same pool, however many are
 * mounting at once. Null by default — a portal built outside a rendering
 * context, as under a test runner or on a plain page, paces itself with a
 * private scheduler instead, and its own `budget` option governs it.
 */
export const PortalSchedulerContext = createProperty(
  /** @returns {PortalScheduler | null} */ () => null,
);
