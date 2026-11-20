/**
 * The worst a frame cost, from totals that only grow. No three.js, no DOM
 * and no signals here, as in `frameMeter.js`, so it is tested against
 * made-up totals.
 */
import { SAMPLE_COUNT, SAMPLE_MS } from "./frameMeter.js";

/**
 * @typedef {object} WorkReading
 * @property {number} drawMs The most one frame spent drawing, in
 *   milliseconds.
 * @property {number} uploadMs The most one frame spent uploading. Not
 *   always the same frame as `drawMs`.
 */

/**
 * @typedef {object} WorkMeterOptions
 * @property {(reading: WorkReading) => void} [onSample] The worst frame of
 *   the last `sampleCount` windows, once every `sampleMs`.
 * @property {number} [sampleMs]
 * @property {number} [sampleCount]
 */

/**
 * @typedef {object} WorkMeter
 * @property {(time: number, drawMs: number, uploadMs: number) => void} frame
 *   Call once per drawn frame, with the frame's timestamp and the two totals
 *   as they stand (`textWork` in `justdom-three`).
 */

/**
 * What a frame spent is the totals now less the totals at the frame before.
 * The meter keeps the largest of those in each window of `sampleMs`, and
 * reports the largest across the last `sampleCount` windows, which with the
 * defaults is the minute the frame rate chart covers. A hitch is one long
 * frame, so the worst frame is the reading, and an average would hide it.
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
  let lastDraw = 0;
  let lastUpload = 0;
  let worstDraw = 0;
  let worstUpload = 0;
  // Rings, written in place: a frame allocates nothing, and neither does a
  // window but for the reading it hands out.
  const draws = new Float64Array(sampleCount);
  const uploads = new Float64Array(sampleCount);
  let next = 0;

  return {
    frame(time, drawMs, uploadMs) {
      // The first frame is a starting line: the totals before it were spent
      // over however many frames came before the meter.
      if (since !== null) {
        worstDraw = Math.max(worstDraw, drawMs - lastDraw);
        worstUpload = Math.max(worstUpload, uploadMs - lastUpload);
      }
      lastDraw = drawMs;
      lastUpload = uploadMs;
      if (since === null) {
        since = time;
        return;
      }
      if (time - since < sampleMs) {
        return;
      }
      draws[next] = worstDraw;
      uploads[next] = worstUpload;
      next = (next + 1) % sampleCount;
      worstDraw = 0;
      worstUpload = 0;
      since = time;
      onSample?.({ drawMs: Math.max(...draws), uploadMs: Math.max(...uploads) });
    },
  };
}
