/**
 * Benchmark & efficiency-validation suite for `store`.
 *
 * A store is the ordinary way to hold state in this library, and the shape
 * that matters is not one big store but very many small ones: a mirrored
 * element owns a store of its visual properties (see `VisualProperties` in
 * @apendua/freedom), a panel owns a few hundred elements, and mounting the
 * panel builds all of them in a frame. So what is measured here is the cost
 * of *building* one, not of reading it.
 *
 * The distinction the benchmarks draw is between a store built with operators
 * and one built without. Applying operators means `useEffects`, which is
 * `use(just(entity, operators))` — an `Observable`, a `ReplaySubject`, a
 * `share`, a subscription and a dependency edge. That is the price of the
 * feature and worth paying when there are operators to apply. With an empty
 * list it bought a pipeline that emits once into a `takeNothing` and can
 * never fire again, per store, held for as long as the store lived.
 *
 * Run with:
 *   node --test src/store.bench.js
 */

import { it } from "node:test";
import assert from "node:assert/strict";
import { Derived, effects } from "./index.js";
import store from "./store.js";
import { bench } from "./testUtils/benchmark.js";

/**
 * A store built the way an application builds one: inside a live computation,
 * so that whatever `store` registers as a dependency actually lands and is
 * held. Built outside one, `addDependency` has nobody to tell and the cost of
 * the pipeline disappears into garbage rather than into the heap — which is
 * the measurement that hides the thing worth measuring.
 *
 * @template T
 * @param {() => T} build
 * @returns {{ value: T, dispose: () => void }}
 */
function inComputation(build) {
  const derived = new Derived(build);
  const subscription = derived.subscribe({});
  return {
    value: derived.get(),
    dispose: () => subscription.unsubscribe(),
  };
}

// ─── Efficiency assertions ───────────────────────────────────────────────────

it("a store with no operators registers no dependency of its own", () => {
  let ran = false;
  const derived = new Derived(() => {
    const value = store({ x: 0 });
    ran = true;
    return value;
  });
  const subscription = derived.subscribe({});
  derived.get();
  assert.ok(ran, "the computation should have run");
  // Reading no keys and applying no operators leaves nothing to depend on.
  assert.equal([...derived.dependencies()].length, 0);
  subscription.unsubscribe();
});

it("a store with operators still applies them", () => {
  /** @type {number[]} */
  const seen = [];
  const { value, dispose } = inComputation(() =>
    store({ x: 1 }, [effects((entity) => seen.push(entity.x))]),
  );
  assert.equal(value.x, 1);
  assert.deepEqual(seen, [1], "the operator should have run against the entity");
  dispose();
});

// ─── Benchmarks ──────────────────────────────────────────────────────────────

const options = { sampleMs: 250, warmupMs: 200, warmupIterations: 200 };

bench(
  "store({ ... }) — no operators",
  () => {
    const { value, dispose } = inComputation(() => store({ x: 0, y: 0, z: 0 }));
    dispose();
    return value.x;
  },
  options,
);

bench(
  "store({ ... }, [effects(...)]) — one operator",
  () => {
    const { value, dispose } = inComputation(() =>
      store({ x: 0, y: 0, z: 0 }, [effects(() => {})]),
    );
    dispose();
    return value.x;
  },
  options,
);
