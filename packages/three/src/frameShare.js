/**
 * How much of each frame the panels of a scene may spend, measured from the
 * scene's own frames. The scene samples it on every frame it draws, from its
 * first, so a panel mounted late is paced by the frames before it rather
 * than by a guess (`sceneServices.js`).
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
