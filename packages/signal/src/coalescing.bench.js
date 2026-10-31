/**
 * What deferring invalidation to a frame boundary can and cannot buy.
 *
 * `fanout.bench.js` next door models a portal mirroring a scrolling list, and
 * it moves *one* signal per iteration — which is faithful to a drag and, for
 * that reason, is the one case where batching has nothing to offer. Anything
 * invalidated once between two flushes is recomputed once either way.
 *
 * A design that pauses invalidation and resumes it before each render frame
 * is betting that real frames are not like that: that a frame carries a
 * scroll *and* a hover *and* two animation samples, each of which today walks
 * the same graph separately. This file is that bet, isolated — the same
 * fan-out shape, driven with a varying number of writes per flush, measured
 * both as throughput and as a count of how many times the graph actually
 * recomputed.
 *
 * The count is the part to trust. It is identical on every run, so it says
 * exactly how much redundant work a batch removed, with none of the noise a
 * wall clock brings; the ops/sec beside it says whether removing that work
 * was worth what the batching machinery cost.
 *
 * Read it as a ceiling. With W writes per frame, perfect coalescing recomputes
 * the graph once instead of W times, so `recomputes` should fall towards 1/W
 * of the eager figure and no further. If a real change lands well short of
 * that on the browser-level suite, the difference is somewhere other than the
 * scheduler.
 *
 * Run with:
 *   node --test src/coalescing.bench.js
 */

import { it } from "node:test";
import assert from "node:assert/strict";
import { Signal, Derived, Effect, batch } from "./index.js";
import { bench } from "./testUtils/benchmark.js";

const ROWS = 200;

/**
 * How far the offset travels before wrapping. A frame's worth of scrolling
 * should keep the panel in the regime a real one is in — some rows in the
 * window, most out — rather than letting the offset run away until every row
 * is off-screen and the `shown` gate has nothing left to do.
 */
const SCROLL_RANGE = ROWS * 40;

/**
 * A panel's worth of chains hanging off one hot signal: per row a rect that
 * takes a fresh identity every time (as a measured DOMRect does), a clip
 * gated on a rounded value, and a flag that flips rarely. The counter is what
 * this file is for — every recompute of every chain passes through it.
 *
 * @param {{ count: number }} tally
 */
function panel(tally) {
  const offset = Signal.of(0);
  /** @type {(() => void)[]} */
  const unsubscribes = [];
  for (let row = 0; row < ROWS; row++) {
    const top = row * 40;
    const rect = new Derived(() => {
      tally.count += 1;
      return { top: top - offset.get(), height: 40 };
    });
    const clip = new Derived(
      () => {
        tally.count += 1;
        return Math.round(rect.get().top / 8) * 8;
      },
      { isEqual: (a, b) => a === b },
    );
    const shown = new Derived(
      () => {
        tally.count += 1;
        const y = clip.get();
        return y > -40 && y < 600;
      },
      { isEqual: (a, b) => a === b },
    );
    // An effect, because only an output pulls: a bare subscription hears
    // that the chain may have moved and never asks what it is, so the tally
    // below would count nothing.
    const effect = new Effect(() => shown.get());
    unsubscribes.push(() => effect.dispose());
  }
  return { offset, dispose: () => unsubscribes.forEach((fn) => fn()) };
}

/**
 * How many recomputes `writes` separate writes cost, against how many the
 * same writes cost inside one batch. The ratio between them is the whole
 * thesis of a frame-boundary scheduler, stated as a number that does not
 * move between runs.
 *
 * @param {number} writes
 */
function recomputes(writes) {
  /** @type {[number, number]} */
  const answer = [0, 0];
  for (const [index, wrap] of /** @type {const} */ ([
    [0, (/** @type {() => void} */ fn) => fn()],
    [1, (/** @type {() => void} */ fn) => batch(fn)],
  ])) {
    const tally = { count: 0 };
    const { offset, dispose } = panel(tally);
    // The graph is built lazily and settles on the first subscribe; measure
    // only the steady state that follows.
    tally.count = 0;
    for (let frame = 0; frame < 20; frame++) {
      wrap(() => {
        for (let w = 0; w < writes; w++) {
          offset.set(offset.get() + 1);
        }
      });
    }
    answer[index] = tally.count / 20;
    dispose();
  }
  return { eager: answer[0], batched: answer[1] };
}

for (const writes of [1, 2, 4, 8]) {
  it(`${writes} write${writes > 1 ? "s" : ""} a frame: recomputes`, () => {
    const { eager, batched } = recomputes(writes);
    const saved = eager === 0 ? 0 : Math.round((1 - batched / eager) * 100);
    console.log(
      `    ${writes} write(s)/frame: eager ${eager} recomputes, batched ${batched} — ${saved}% removed`,
    );
    // One write cannot be coalesced with anything, so batching must not cost
    // extra recomputes; more than one must cost strictly fewer. Both are
    // exact, so they are assertions rather than observations.
    if (writes === 1) {
      assert.equal(batched, eager, "batching one write should change nothing");
    } else {
      assert.ok(batched < eager, `batching ${writes} writes should remove recomputes`);
    }
  });
}

// The panel is built once and scrolled, rather than built and thrown away
// inside each timed iteration. Building 200 rows costs about 2.5 ms, which was
// 37% of the "8 writes, eager" figure and 62% of the batched one — and because
// it fell on the batched side hardest, it flattened the very ratio this file
// exists to report, showing 1.68x where the writes alone are worth 2.80x. A
// frame in a running app does not rebuild its panel, and neither does the
// fan-out benchmark next door.
for (const writes of [1, 8]) {
  const label = `${writes} write(s)/frame`;
  /** @type {{ count: number }} */
  const tally = { count: 0 };
  const { offset } = panel(tally);
  let frame = 0;
  // Each write has to land on a new value: writing the same one back
  // short-circuits on isEqual, and the benchmark would time the early return.
  const scroll = () => offset.set(frame++ % SCROLL_RANGE);
  const options = { sampleMs: 400, warmupMs: 300, warmupIterations: 50 };

  bench(
    `${label}, eager`,
    () => {
      for (let w = 0; w < writes; w++) scroll();
      return tally.count;
    },
    options,
  );

  bench(
    `${label}, batched`,
    () => {
      batch(() => {
        for (let w = 0; w < writes; w++) scroll();
      });
      return tally.count;
    },
    options,
  );
}
