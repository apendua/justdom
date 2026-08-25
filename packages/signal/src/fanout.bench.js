/**
 * Benchmark & efficiency-validation suite for wide, shallow fan-out — the
 * update-queue's hot path.
 *
 * The shape is a case study taken from justdom-three: a portal mirroring a
 * scrolling list re-derives, on every frame of a drag, one small chain per
 * element — a rect from the scroller's offset, a clip box from the rect, a
 * visibility flag from the clip box — with an effect subscribed to each.
 * One signal is hot; thousands of cheap computations re-run; almost all of
 * the frame is spent in the scheduler rather than in the chains' own
 * arithmetic. Profiling that case put ~60% of a frame inside the signal
 * core, a fifth of which was the update queue's heap maintaining a
 * task-index map on every sift.
 *
 * The graph below reproduces that shape without the DOM: rows of three
 * "elements" each, every element with a rect that changes on every update
 * (fresh identity, like a measured DOMRect), a value-gated clip derived from
 * it, and a value-gated boolean that flips only when a row crosses the
 * window's edge. What ops/sec means here is scroll frames per second.
 *
 * Run with:
 *   node --test src/fanout.bench.js
 */

import { it } from "node:test";
import assert from "node:assert/strict";
import { Signal, Derived, Effect } from "./index.js";
import { bench } from "./testUtils/benchmark.js";

const ROW_HEIGHT = 40;
const WINDOW_HEIGHT = 600;
const ELEMENTS_PER_ROW = 3;

/**
 * One scrolling list, in the abstract: a delta signal and `rows` chains of
 * the shape described above.
 *
 * @param {number} rows
 */
function buildList(rows) {
  const delta = Signal.of(0);
  /** @type {import('./Effect.js').Effect[]} */
  const subscriptions = [];
  /** @type {Derived<{ top: number, bottom: number }>[]} */
  const rects = [];
  /** @type {Derived<{ top: number, bottom: number }>[]} */
  const clips = [];
  /** @type {Derived<boolean>[]} */
  const showns = [];

  for (let i = 0; i < rows; i++) {
    const top = i * ROW_HEIGHT;
    for (let j = 0; j < ELEMENTS_PER_ROW; j++) {
      // A fresh object per evaluation, the way a measured rect is a fresh
      // DOMRect: identity equality never stops the propagation here.
      const rect = new Derived(() => ({
        top: top - delta.get(),
        bottom: top + ROW_HEIGHT - delta.get(),
      }));
      // The clip window in the element's own coordinates: moves on every
      // frame, so the value gate compares and passes.
      const clip = new Derived(
        () => {
          const r = rect.get();
          return { top: 0 - r.top, bottom: WINDOW_HEIGHT - r.top };
        },
        { isEqual: (a, b) => a.top === b.top && a.bottom === b.bottom },
      );
      // Whether anything of the element survives the window: flips only when
      // the row crosses an edge, so the value gate almost always stops here.
      const shown = new Derived(() => {
        const r = rect.get();
        return r.bottom > 0 && r.top < WINDOW_HEIGHT;
      });
      // Effects rather than bare subscriptions: what a mirror actually holds
      // is an output, and only an output pulls. A subscription on its own
      // hears that the value may have moved and never asks what it is, so a
      // list built out of those would measure the marking and nothing else.
      subscriptions.push(new Effect(() => clip.get()));
      subscriptions.push(new Effect(() => shown.get()));
      rects.push(rect);
      clips.push(clip);
      showns.push(shown);
    }
  }

  return {
    delta,
    rects,
    clips,
    showns,
    dispose: () => subscriptions.forEach((effect) => effect.dispose()),
  };
}

// ─── Efficiency / correctness assertions ─────────────────────────────────────

it("one update evaluates each chain exactly once", () => {
  const list = buildList(10);
  try {
    const before = list.rects.map((rect) => rect.getEvaluations());
    list.delta.set(4);
    list.rects.forEach((rect, i) => {
      assert.strictEqual(
        rect.getEvaluations(),
        before[i] + 1,
        `rect[${i}] must evaluate exactly once per update`,
      );
    });
  } finally {
    list.dispose();
  }
});

it("the boolean gate stops propagation for rows that did not cross an edge", () => {
  const list = buildList(50);
  try {
    /** @type {number[]} */
    const flips = list.showns.map(() => 0);
    const subscriptions = list.showns.map(
      (shown, i) =>
        new Effect(() => {
          shown.get();
          flips[i] += 1;
        }),
    );
    flips.fill(0);
    // Four px is less than a row, so at most one row enters and one leaves.
    list.delta.set(4);
    const flipped = flips.filter((count) => count > 0).length;
    assert.ok(
      flipped <= 2 * ELEMENTS_PER_ROW,
      `a small scroll must not notify rows that stayed where they were (notified ${flipped})`,
    );
    subscriptions.forEach((effect) => effect.dispose());
  } finally {
    list.dispose();
  }
});

// ─── Performance benchmarks ───────────────────────────────────────────────────

for (const rows of [100, 300]) {
  const list = buildList(rows);
  let frame = 0;
  bench(
    `scroll frame — ${rows} rows × ${ELEMENTS_PER_ROW} elements (rect → clip → shown, subscribed)`,
    () => {
      frame += 4;
      list.delta.set(frame);
    },
    // A frame here is milliseconds of work, so the warm-up is bounded by time
    // rather than by the default iteration count, and the windows are long
    // enough to hold a useful number of frames.
    { sampleMs: 500, warmupMs: 300, warmupIterations: 50 },
  );
}
