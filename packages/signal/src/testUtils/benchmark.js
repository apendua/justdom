/**
 * The benchmark helper shared by `*.bench.js`.
 *
 * Written to be believable rather than quick. The naive shape — warm up a
 * little, run for a fixed window, print one number — reads noise as signal,
 * and did: a change that turned out to be a ~3% improvement showed up as a
 * 2x regression on the deep-chain benchmark because a single cold 500 ms
 * window happened to land badly. Four things make the difference.
 *
 * **Warm up to steady state.** V8's optimising compiler needs on the order of
 * ten thousand calls before it settles. Measuring after two hundred measures
 * the interpreter and whatever the optimiser was doing at the time.
 *
 * **Amortise the clock.** `performance.now()` costs tens of nanoseconds, and
 * the operations here are measured in tens of nanoseconds too — reading the
 * clock once per iteration would put the instrument and the subject in the
 * same weight class. So iterations run in chunks sized to take at least a
 * millisecond, and the clock is read once per chunk.
 *
 * **Sample repeatedly and report the spread.** One window cannot tell a
 * regression from a GC pause or a noisy neighbour. Several windows can, and
 * printing the spread means a reader can see when a number is not to be
 * trusted rather than having to guess.
 *
 * **Keep the work alive.** A benchmark whose result is discarded may be
 * partly optimised away. Returning a value from the body folds it into a sink
 * the engine cannot prove is dead.
 *
 * Two things to know when reading the output. The harness floor is around a
 * nanosecond per iteration — an empty body measures ~1.3 billion ops/sec — so
 * anything reported much above a few hundred million is measuring this file
 * rather than the library. And numbers here are not comparable with those the
 * previous harness printed: reading the clock every iteration cost roughly as
 * much as the cheapest operations being timed, so it understated them by an
 * order of magnitude.
 */

import { it } from "node:test";

/**
 * Accumulates benchmark results so the engine cannot discard the work that
 * produced them. Never read; that is the point.
 *
 * @type {number}
 */
export let sink = 0;

/**
 * @param {unknown} value
 * @returns {number}
 */
function consume(value) {
  if (typeof value === "number") {
    return value;
  }
  return value === undefined || value === null ? 0 : 1;
}

/**
 * @param {number[]} sorted
 * @returns {number}
 */
function median(sorted) {
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The measured loop — the only one there is.
 *
 * Warming up, calibrating and sampling all go through here, which matters
 * more than it looks: the optimiser works per call site, so a warm-up written
 * as its own loop leaves the loop that actually gets timed cold, and the
 * early samples then measure the optimiser catching up rather than the code.
 * That showed up as a 99% spread on the cheapest benchmarks.
 *
 * @param {() => unknown} fn
 * @param {number} count
 * @returns {number}
 */
function runChunk(fn, count) {
  let accumulated = 0;
  for (let i = 0; i < count; i++) {
    accumulated += consume(fn());
  }
  return accumulated;
}

/**
 * How many iterations to run between clock reads, so that the clock costs a
 * negligible share of each sample. Doubles until a chunk takes at least a
 * millisecond, and stops early for bodies already slower than that.
 *
 * @param {() => unknown} fn
 * @returns {number}
 */
function calibrate(fn) {
  const LIMIT = 1 << 24;
  let chunk = 1;
  while (chunk < LIMIT) {
    const start = performance.now();
    sink += runChunk(fn, chunk);
    if (performance.now() - start >= 1) {
      break;
    }
    chunk *= 2;
  }
  return chunk;
}

/**
 * Measure `fn` and report ops/sec.
 *
 * Return a value from `fn` if the body would otherwise compute something it
 * never uses — it is folded into a sink so the work cannot be optimised away.
 *
 * @param {string} name
 * @param {() => unknown} fn
 * @param {object} [options]
 * @param {number} [options.samples] how many timed windows to take
 * @param {number} [options.sampleMs] target duration of one window
 * @param {number} [options.warmupMs] time spent reaching steady state
 * @param {number} [options.warmupIterations] minimum warm-up calls
 */
export function bench(
  name,
  fn,
  { samples = 5, sampleMs = 150, warmupMs = 150, warmupIterations = 10_000 } = {},
) {
  it(name, () => {
    const warmupStart = performance.now();
    let warmed = 0;
    while (warmed < warmupIterations || performance.now() - warmupStart < warmupMs) {
      sink += runChunk(fn, 64);
      warmed += 64;
      // A body slow enough to have spent ten times the warm-up budget is
      // already warm; insisting on the iteration count could take minutes.
      if (performance.now() - warmupStart > warmupMs * 10) {
        break;
      }
    }

    const chunk = calibrate(fn);

    // The first window is discarded. Warming up and calibrating leave the
    // engine in a state it is still settling out of, and that shows up as a
    // slow first sample that drags the spread — and only the spread, since
    // the median would have shrugged it off — into looking alarming.
    /** @type {number[]} */
    const rates = [];
    for (let s = 0; s <= samples; s++) {
      const start = performance.now();
      let iterations = 0;
      do {
        sink += runChunk(fn, chunk);
        iterations += chunk;
      } while (performance.now() - start < sampleMs);
      if (s > 0) {
        rates.push((iterations / (performance.now() - start)) * 1000);
      }
    }

    rates.sort((a, b) => a - b);
    const mid = median(rates);
    const spread = ((rates[rates.length - 1] - rates[0]) / mid) * 100;
    // A spread this wide means the machine, not the code, is what varied —
    // and that a difference smaller than the spread is not worth reading.
    const warning = spread > 20 ? "  [noisy]" : "";
    // eslint-disable-next-line no-console
    console.log(
      `    ${name}: ${Math.round(mid).toLocaleString()} ops/sec` +
        `  (median of ${samples}, spread ${spread.toFixed(0)}%)${warning}`,
    );
  });
}
