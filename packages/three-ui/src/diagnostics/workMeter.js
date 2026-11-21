/**
 * The longest piece of work in the last minute, from an account that keeps
 * the longest since it was last cleared. No three.js, no DOM and no signals
 * here, as in `frameMeter.js`, so it is tested against a made-up account.
 */
import { SAMPLE_COUNT, SAMPLE_MS } from "./frameMeter.js";

/**
 * The account the meter reads and clears: `textWork(ctx)` of
 * `justdom-three`.
 *
 * @typedef {object} WorkAccount
 * @property {number} longestDrawMs
 * @property {number} longestUploadMs
 */

/**
 * @typedef {object} WorkReading
 * @property {number} drawMs The longest one run took to draw, in
 *   milliseconds.
 * @property {number} uploadMs The longest one upload took.
 */

/**
 * @typedef {object} WorkMeterOptions
 * @property {(reading: WorkReading) => void} [onSample] The longest of the
 *   last `sampleCount` windows, once every `sampleMs`.
 * @property {number} [sampleMs]
 * @property {number} [sampleCount]
 */

/**
 * @typedef {object} WorkMeter
 * @property {(time: number, account: WorkAccount) => void} frame Call once
 *   per drawn frame, with the frame's timestamp and the account.
 */

/**
 * Every `sampleMs` the meter takes the account's two maxima as that
 * window's and sets them back to zero, and it reports the largest across
 * the last `sampleCount` windows, which with the defaults is the minute the
 * frame rate chart covers. A long piece of work stays on the panel for that
 * minute, long enough to be read after the movement that caused it.
 *
 * The meter is the account's one reader, since it clears what it reads.
 *
 * @param {WorkMeterOptions} [options]
 * @returns {WorkMeter}
 */
export function createWorkMeter({
  onSample,
  sampleMs = SAMPLE_MS,
  sampleCount = SAMPLE_COUNT,
} = {}) {
  /** @type {number | null} */
  let since = null;
  // Rings, written in place: a frame allocates nothing, and neither does a
  // window but for the reading it hands out.
  const draws = new Float64Array(sampleCount);
  const uploads = new Float64Array(sampleCount);
  let next = 0;

  return {
    frame(time, account) {
      if (since === null) {
        // The first frame is a starting line: what the account holds was
        // done before the meter, over however long.
        since = time;
      } else if (time - since >= sampleMs) {
        draws[next] = account.longestDrawMs;
        uploads[next] = account.longestUploadMs;
        next = (next + 1) % sampleCount;
        since = time;
        onSample?.({ drawMs: Math.max(...draws), uploadMs: Math.max(...uploads) });
      } else {
        return;
      }
      account.longestDrawMs = 0;
      account.longestUploadMs = 0;
    },
  };
}
