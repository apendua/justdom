/**
 * Counting frames, and nothing else. No three.js, no DOM and no signals here,
 * so the arithmetic that decides what the panel says can be tested against a
 * made-up clock rather than against a headset.
 */

/** How often the big number is re-read, in milliseconds. */
export const READOUT_MS = 500;

/** How much time each bar of the chart stands for, in milliseconds. */
export const SAMPLE_MS = 2000;

/** How many bars there are. Thirty of two seconds is the last minute. */
export const SAMPLE_COUNT = 30;

/**
 * The rates a headset or a monitor actually runs at. The chart is drawn
 * against one of them rather than against the highest reading seen, so that a
 * bar's height means "this fraction of what the display can do" — full height
 * is the display keeping up, and a dip is a dip against a scale that does not
 * move under it.
 */
const REFRESH_RATES = [60, 72, 80, 90, 120, 144];

/**
 * Which of those a peak reading belongs to. A reading is a measured average
 * and lands a little under the true rate as often as a little over, so the
 * bracket is generous by a frame; anything past the last known rate is rounded
 * up to a round number instead of being pinned to it.
 *
 * @param {number} peak The highest frame rate seen so far.
 * @returns {number}
 */
export function chartCeiling(peak) {
  for (const rate of REFRESH_RATES) {
    if (peak <= rate + 1) {
      return rate;
    }
  }
  return Math.ceil(peak / 10) * 10;
}

/**
 * @typedef {object} FrameMeterOptions
 * @property {(fps: number) => void} [onReadout] The current frame rate, once
 *   every `readoutMs`.
 * @property {(history: readonly number[]) => void} [onSample] The chart, once
 *   every `sampleMs`: oldest reading first, at most `sampleCount` of them.
 * @property {number} [readoutMs]
 * @property {number} [sampleMs]
 * @property {number} [sampleCount]
 */

/**
 * @typedef {object} FrameMeter
 * @property {(time: number) => void} frame Call once per drawn frame, with the
 *   timestamp the frame callback was given.
 */

/**
 * A frame counter with two speeds: a reading often enough to be worth looking
 * at, and a coarser one for the chart.
 *
 * Both are counted between the timestamps the frame callbacks carry rather
 * than against a timer of their own, so a session that stops being drawn — the
 * headset taken off, the tab hidden — reports the frames it actually got
 * rather than the ones a wall clock says it should have had.
 *
 * @param {FrameMeterOptions} [options]
 * @returns {FrameMeter}
 */
export function createFrameMeter({
  onReadout,
  onSample,
  readoutMs = READOUT_MS,
  sampleMs = SAMPLE_MS,
  sampleCount = SAMPLE_COUNT,
} = {}) {
  /** @type {number | null} */
  let readoutSince = null;
  /** @type {number | null} */
  let sampleSince = null;
  let readoutFrames = 0;
  let sampleFrames = 0;
  /** @type {readonly number[]} */
  let history = [];

  return {
    frame(time) {
      // The first frame is a starting line, not a frame: there is no interval
      // behind it yet, and counting it would make the first reading an
      // infinity.
      if (readoutSince === null || sampleSince === null) {
        readoutSince = time;
        sampleSince = time;
        return;
      }
      readoutFrames += 1;
      sampleFrames += 1;

      const readoutElapsed = time - readoutSince;
      if (readoutElapsed >= readoutMs) {
        onReadout?.((1000 * readoutFrames) / readoutElapsed);
        readoutFrames = 0;
        readoutSince = time;
      }

      const sampleElapsed = time - sampleSince;
      if (sampleElapsed >= sampleMs) {
        history = [...history, (1000 * sampleFrames) / sampleElapsed].slice(-sampleCount);
        onSample?.(history);
        sampleFrames = 0;
        sampleSince = time;
      }
    },
  };
}
