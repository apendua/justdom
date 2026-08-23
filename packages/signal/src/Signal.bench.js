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
import { bench } from "./testUtils/benchmark.js";

import { Signal, Derived, batch } from "./index.js";

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

it("without batch(), unread writes still cost only one evaluation", () => {
  // What laziness gives away for nothing. Two unbatched writes used to mean
  // two recomputations, because each one pushed the work through
  // immediately; now they mean two markings, and the single read that
  // follows pays for one evaluation. `batch()` is still worth reaching for —
  // it is what keeps an *effect* from running twice — but it is no longer
  // what keeps a derived value from being computed twice.
  const s1 = Signal.of(0);
  const s2 = Signal.of(0);
  const sum = new Derived(() => s1.get() + s2.get());
  const sub = sum.subscribe({});
  sum.get(); // initial evaluation

  const before = sum.getEvaluations();
  s1.set(1);
  s2.set(2);
  sum.get();
  assert.strictEqual(
    sum.getEvaluations(),
    before + 1,
    "one read, one evaluation, however many writes preceded it",
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
  bench("Signal#get", () => s.get());
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
  bench("Derived#get (unsubscribed — re-evaluates)", () => d.get());
}

// 5. Reading a subscribed Derived (memoized, no re-evaluation)
{
  const s = Signal.of(1);
  const d = new Derived(() => s.get() * 2);
  d.subscribe({});
  bench("Derived#get (subscribed — memoized)", () => d.get());
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
    return leaf.get();
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
    let total = 0;
    for (const leaf of leaves) total += leaf.get();
    return total;
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
    return c.get();
  });
}

// 9. batch() over 100 simultaneous signal writes
{
  const signals = Array.from({ length: 100 }, (_, i) => Signal.of(i));
  const sum = new Derived(() => signals.reduce((acc, sig) => acc + sig.get(), 0));
  sum.subscribe({});
  let i = 0;
  bench("batch() — 100 signal writes", () => {
    i++;
    batch(() => {
      for (let j = 0; j < signals.length; j++) {
        // The value has to move on every iteration: writing the same value
        // back short-circuits on isEqual, and the benchmark would measure a
        // hundred early returns instead of a hundred writes.
        signals[j].set(j + i);
      }
    });
    return sum.get();
  });
}
