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
import { Signal, Derived, batch } from "./Signal.js";

/**
 * @param {string} name
 * @param {() => void} fn
 * @param {{ duration?: number, warmup?: number, note?: string }} [options]
 */
function bench(name, fn, { duration = 400, warmup = 100, note = "" } = {}) {
  it(name, () => {
    for (let i = 0; i < warmup; i++) fn();
    const start = performance.now();
    let iterations = 0;
    while (performance.now() - start < duration) {
      fn();
      iterations++;
    }
    const elapsed = performance.now() - start;
    console.log(
      `    ${name}: ${Math.round((iterations / elapsed) * 1000).toLocaleString()} ops/sec${note}`,
    );
  });
}

const ROWS = 200;

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
    const subscription = shown.subscribe({ next: () => shown.get() });
    unsubscribes.push(() => subscription.unsubscribe());
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

for (const writes of [1, 8]) {
  const label = `${writes} write(s)/frame`;
  bench(`${label}, eager`, () => {
    const tally = { count: 0 };
    const { offset, dispose } = panel(tally);
    for (let w = 0; w < writes; w++) offset.set(offset.get() + 1);
    dispose();
  });
  bench(`${label}, batched`, () => {
    const tally = { count: 0 };
    const { offset, dispose } = panel(tally);
    batch(() => {
      for (let w = 0; w < writes; w++) offset.set(offset.get() + 1);
    });
    dispose();
  });
}
