/**
 * Timing, measured across frames rather than across calls.
 *
 * This is the one design decision in the suite that is not negotiable, and it
 * is worth spelling out because getting it wrong produces a large, confident,
 * completely fictional improvement.
 *
 * Today the mirror's work happens *synchronously inside the thing that
 * triggered it*. A `scroll` event is dispatched, the portal's listener
 * invalidates, the signal queue flushes before the listener returns, and by
 * the time `dispatchEvent` comes back every object has moved. So the obvious
 * benchmark — start a timer, dispatch, stop the timer — measures the whole
 * update, and it is what produced the 79 ms and 51 ms figures on this
 * codebase.
 *
 * A design that pauses invalidation and resumes it before the next render
 * frame moves that work *out* of the dispatch. The same benchmark run against
 * it would time an event dispatch that now does almost nothing, and report a
 * ninety-something-percent improvement on a change that had not yet been
 * proven to save a single microsecond. The work did not go away; it went
 * somewhere the stopwatch was not looking.
 *
 * So the stopwatch has to stop looking at calls. What a person in a headset
 * experiences is not "how long did the scroll handler take", it is "did the
 * frames keep coming" — and that question is indifferent to which side of the
 * dispatch boundary the work sits on. Drive a constant stimulus, one step per
 * real frame, and record the gaps between frames. Work moved from the
 * dispatch into the frame still lands in the gap; work genuinely removed
 * shortens it; work merely coalesced shortens it by exactly what coalescing
 * was worth.
 */

/**
 * The page-side driver: runs `step` once per animation frame for `frames`
 * frames, recording when each frame arrived.
 *
 * Installed into the page as a global by the harness rather than passed in,
 * because everything it does has to happen inside the page's own frame loop.
 *
 * @returns {void}
 */
export function installFrameDriver() {
  /**
   * @param {(index: number) => void} step
   * @param {number} count
   * @returns {Promise<number[]>} The gap before each frame, in ms.
   */
  const drive = (step, count) => {
    return new Promise((resolve) => {
      /** @type {number[]} */
      const gaps = [];
      let index = 0;
      let previous = performance.now();
      const tick = () => {
        const now = performance.now();
        gaps.push(now - previous);
        previous = now;
        if (index >= count) {
          resolve(gaps);
          return;
        }
        step(index);
        index += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  };
  Object.assign(globalThis, { __drive: drive });
}

/**
 * What a run of gaps says. Median rather than mean because one garbage
 * collection should not decide the answer, and a count of frames over budget
 * because that — not the average — is what a dropped frame is.
 *
 * @param {number[]} gaps
 * @param {number} [warmup] Frames to discard from the front.
 * @returns {{ median: number, p90: number, worst: number, over16: number, over33: number, frames: number }}
 */
export function summarize(gaps, warmup = 10) {
  const kept = gaps.slice(warmup).sort((a, b) => a - b);
  /** @param {number} value */
  const round = (value) => Math.round(value * 10) / 10;
  return {
    median: round(kept[Math.floor(kept.length / 2)] ?? 0),
    p90: round(kept[Math.floor(kept.length * 0.9)] ?? 0),
    worst: round(kept[kept.length - 1] ?? 0),
    over16: kept.filter((gap) => gap > 16.7).length,
    over33: kept.filter((gap) => gap > 33.4).length,
    frames: kept.length,
  };
}
