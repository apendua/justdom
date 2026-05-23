/**
 * Benchmark & efficiency-validation suite for Signal.js.
 *
 * Efficiency assertions (using `it`) verify that the implementation avoids
 * unnecessary re-evaluations.  Performance benchmarks (using `bench`) measure
 * raw throughput so regressions can be spotted over time.
 *
 * Run with:
 *   node --test src/Signal.bench.js
 */

import { it } from "node:test";
import assert from "node:assert/strict";

/**
 * Minimal benchmark helper built on top of `node:test`'s `it`.
 * Runs the function for `duration` ms (after `warmup` warm-up iterations)
 * and reports ops/sec to stdout.
 *
 * @param {string} name
 * @param {() => void} fn
 * @param {{ duration?: number, warmup?: number }} [options]
 */
function bench(name, fn, { duration = 500, warmup = 200 } = {}) {
  it(name, () => {
    for (let i = 0; i < warmup; i++) fn();

    const start = performance.now();
    let iterations = 0;
    while (performance.now() - start < duration) {
      fn();
      iterations++;
    }
    const elapsed = performance.now() - start;
    const opsPerSec = Math.round((iterations / elapsed) * 1000);
    // eslint-disable-next-line no-console
    console.log(
      `    ${name}: ${opsPerSec.toLocaleString()} ops/sec  (${iterations.toLocaleString()} iterations / ${elapsed.toFixed(0)} ms)`,
    );
  });
}

import { Signal, Derived, batch } from "./Signal.js";

// ─── Efficiency / correctness assertions ─────────────────────────────────────

it("subscribed Derived does not re-evaluate on repeated get()", () => {
  const s = Signal.of(1);
  const d = new Derived(() => s.get() * 2);
  const sub = d.subscribe({});
  d.get(); // initial evaluation

  const before = d.getEvaluations();
  d.get();
  d.get();
  d.get();
  assert.strictEqual(
    d.getEvaluations(),
    before,
    "subscribed Derived must not re-evaluate when the source has not changed",
  );
  sub.unsubscribe();
});

it("unsubscribed Derived re-evaluates on every get()", () => {
  const s = Signal.of(1);
  const d = new Derived(() => s.get() * 2);
  d.get(); // first evaluation

  const before = d.getEvaluations();
  d.get();
  d.get();
  assert.strictEqual(
    d.getEvaluations(),
    before + 2,
    "unsubscribed Derived must re-evaluate on every get() call",
  );
});

it("diamond graph: terminal node evaluates exactly once per source update", () => {
  //   s
  //  / \
  // a   b
  //  \ /
  //   c   ← should recompute exactly once when s changes, not once per parent
  const s = Signal.of(0);
  const a = new Derived(() => s.get() + 1);
  const b = new Derived(() => s.get() * 2);
  const c = new Derived(() => a.get() + b.get());
  const sub = c.subscribe({});
  c.get(); // initial evaluation

  const before = c.getEvaluations();
  s.set(1);
  c.get();
  assert.strictEqual(
    c.getEvaluations(),
    before + 1,
    "terminal node in a diamond must recompute exactly once per upstream change",
  );
  sub.unsubscribe();
});

it("batch() reduces Derived evaluations to one when multiple signals change", () => {
  const s1 = Signal.of(0);
  const s2 = Signal.of(0);
  const sum = new Derived(() => s1.get() + s2.get());
  const sub = sum.subscribe({});
  sum.get(); // initial evaluation

  const before = sum.getEvaluations();
  batch(() => {
    s1.set(1);
    s2.set(2);
  });
  sum.get();
  assert.strictEqual(
    sum.getEvaluations(),
    before + 1,
    "batched updates must trigger exactly one re-evaluation",
  );
  sub.unsubscribe();
});

it("without batch(), Derived evaluates once per individual signal change", () => {
  const s1 = Signal.of(0);
  const s2 = Signal.of(0);
  const sum = new Derived(() => s1.get() + s2.get());
  const sub = sum.subscribe({});
  sum.get(); // initial evaluation

  const before = sum.getEvaluations();
  s1.set(1); // triggers one recompute
  s2.set(2); // triggers a second recompute
  sum.get();
  assert.strictEqual(
    sum.getEvaluations(),
    before + 2,
    "unbatched updates must each trigger their own re-evaluation",
  );
  sub.unsubscribe();
});

it("deep chain: leaf evaluates exactly once per root update", () => {
  const DEPTH = 10;
  const root = Signal.of(0);
  let node = new Derived(() => root.get());
  for (let i = 0; i < DEPTH; i++) {
    const prev = node;
    node = new Derived(() => prev.get() + 1);
    node.subscribe({});
  }
  /** @type {Derived<number>} */
  const leaf = /** @type {any} */ (node);
  leaf.get(); // initial evaluation

  const before = leaf.getEvaluations();
  root.set(1);
  leaf.get();
  assert.strictEqual(
    leaf.getEvaluations(),
    before + 1,
    `leaf at depth ${DEPTH} must recompute exactly once per root change`,
  );
});

it("fan-out: each derived evaluates at most once per source update", () => {
  const WIDTH = 20;
  const root = Signal.of(0);
  const leaves = Array.from({ length: WIDTH }, (_, i) => {
    const d = new Derived(() => root.get() + i);
    d.subscribe({});
    return d;
  });
  leaves.forEach((d) => d.get()); // initial evaluations

  const before = leaves.map((d) => d.getEvaluations());
  root.set(1);
  leaves.forEach((d, i) => {
    d.get();
    assert.strictEqual(
      d.getEvaluations(),
      before[i] + 1,
      `fan-out leaf[${i}] must recompute exactly once`,
    );
  });
});

// ─── Performance benchmarks ───────────────────────────────────────────────────

// 1. Baseline: reading a plain signal
{
  const s = Signal.of(42);
  bench("Signal#get", () => {
    s.get();
  });
}

// 2. Writing a signal with no subscribers
{
  const s = Signal.of(0);
  let i = 0;
  bench("Signal#set  (no subscriber)", () => {
    s.set(i++);
  });
}

// 3. Writing a signal that has one active subscriber
{
  const s = Signal.of(0);
  s.subscribe({});
  let i = 0;
  bench("Signal#set  (1 subscriber)", () => {
    s.set(i++);
  });
}

// 4. Reading an unsubscribed Derived (re-evaluates on every get)
{
  const s = Signal.of(1);
  const d = new Derived(() => s.get() * 2);
  bench("Derived#get (unsubscribed — re-evaluates)", () => {
    d.get();
  });
}

// 5. Reading a subscribed Derived (memoized, no re-evaluation)
{
  const s = Signal.of(1);
  const d = new Derived(() => s.get() * 2);
  d.subscribe({});
  bench("Derived#get (subscribed — memoized)", () => {
    d.get();
  });
}

// 6. Propagation through a 10-level deep chain
{
  const root = Signal.of(0);
  let node = new Derived(() => root.get());
  for (let i = 0; i < 10; i++) {
    const prev = node;
    node = new Derived(() => prev.get() + 1);
    node.subscribe({});
  }
  const leaf = node;
  let i = 0;
  bench("Signal update → 10-level deep chain", () => {
    root.set(i++);
    leaf.get();
  });
}

// 7. 100-way fan-out: one signal feeds 100 subscribed derived nodes
{
  const root = Signal.of(0);
  const leaves = Array.from({ length: 100 }, (_, i) => {
    const d = new Derived(() => root.get() + i);
    d.subscribe({});
    return d;
  });
  let i = 0;
  bench("Signal update → 100-way fan-out", () => {
    root.set(i++);
    for (const leaf of leaves) leaf.get();
  });
}

// 8. Diamond dependency graph
{
  const s = Signal.of(0);
  const a = new Derived(() => s.get() + 1);
  const b = new Derived(() => s.get() * 2);
  const c = new Derived(() => a.get() + b.get());
  c.subscribe({});
  let i = 0;
  bench("Diamond dependency update", () => {
    s.set(i++);
    c.get();
  });
}

// 9. batch() over 100 simultaneous signal writes
{
  const signals = Array.from({ length: 100 }, (_, i) => Signal.of(i));
  const sum = new Derived(() => signals.reduce((acc, sig) => acc + sig.get(), 0));
  sum.subscribe({});
  bench("batch() — 100 signal writes", () => {
    batch(() => {
      for (let j = 0; j < signals.length; j++) {
        signals[j].set(j);
      }
    });
    sum.get();
  });
}
