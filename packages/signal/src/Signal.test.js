import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { Signal, Derived, Effect, batch } from "./index.js";
import { makeNonReactive, addDependency, onCleanup, CircularDependencyError } from "./index.js";

describe("Signal", () => {
  it("only announces a write that changed something", () => {
    const signal = Signal.of(1);
    const spy = mock.fn();
    const subscription = signal.subscribe({ next: spy });
    assert.strictEqual(signal.get(), 1);
    signal.set(1);
    assert.strictEqual(spy.mock.calls.length, 0);
    signal.set(2);
    assert.strictEqual(signal.get(), 2);
    assert.strictEqual(spy.mock.calls.length, 1);
    subscription.unsubscribe();
  });

  it("notifies a direct subscriber once per write, even within a batch", () => {
    // A signal notifies as it is written rather than being queued, so
    // repeated writes inside one batch are not collapsed into a single
    // notification. Every value a subscriber is told about is a value the
    // signal really held; what a batch collapses is the *work* below it.
    const signal = Signal.of(0);
    const spy = mock.fn();
    const subscription = signal.subscribe({ next: () => spy(signal.get()) });

    batch(() => {
      signal.set(1);
      signal.set(2);
      signal.set(3);
    });

    assert.deepStrictEqual(
      spy.mock.calls.map((call) => call.arguments[0]),
      [1, 2, 3],
    );
    subscription.unsubscribe();
  });

  it("reads without depending, through peek()", () => {
    const signal = Signal.of(1);
    const derived = new Derived(() => signal.peek() * 2);
    const effect = new Effect(() => derived.get());
    const before = derived.getEvaluations();
    signal.set(5);
    assert.strictEqual(derived.getEvaluations(), before);
    effect.dispose();
  });

  it("throws until it has a value", () => {
    const signal = new Signal();
    assert.strictEqual(signal.hasValue(), false);
    assert.throws(() => signal.get(), /No value available/);
    signal.set(1);
    assert.strictEqual(signal.get(), 1);
  });
});

describe("Derived", () => {
  it("does not evaluate until somebody reads it", () => {
    // The whole point of the pull model: a write marks, it does not compute.
    const source = Signal.of(1);
    const derived = new Derived(() => source.get() * 2);
    source.set(2);
    source.set(3);
    assert.strictEqual(derived.getEvaluations(), 0);
    assert.strictEqual(derived.get(), 6);
    assert.strictEqual(derived.getEvaluations(), 1);
  });

  it("does not memoize while nothing is holding it open", () => {
    let computeCount = 0;
    const derived = new Derived(() => {
      computeCount++;
      return 42;
    });
    assert.strictEqual(derived.get(), 42);
    assert.strictEqual(computeCount, 1);
    assert.strictEqual(derived.get(), 42);
    assert.strictEqual(computeCount, 2);
  });

  it("memoizes once something is holding it open", () => {
    let computeCount = 0;
    const derived = new Derived(() => {
      computeCount++;
      return 42;
    });
    const subscription = derived.subscribe({});
    assert.strictEqual(derived.get(), 42);
    assert.strictEqual(computeCount, 1);
    assert.strictEqual(derived.get(), 42);
    assert.strictEqual(computeCount, 1);
    subscription.unsubscribe();
  });

  it("recomputes only when a dependency really moved", () => {
    const source = Signal.of(1);
    const derived = new Derived(() => source.get() + 1);
    const effect = new Effect(() => derived.get());
    assert.strictEqual(derived.get(), 2);
    assert.strictEqual(derived.getEvaluations(), 1);
    source.set(2);
    assert.strictEqual(derived.get(), 3);
    assert.strictEqual(derived.getEvaluations(), 2);
    source.set(2);
    assert.strictEqual(derived.get(), 3);
    assert.strictEqual(derived.getEvaluations(), 2);
    effect.dispose();
  });

  it("stops a change at the node that swallows it", () => {
    // The two-colour marking earning its keep: `parity` is marked and
    // recomputes, settles on the value it already had, and `label` — marked
    // CHECK — resolves back to clean without running.
    const source = Signal.of(1);
    const parity = new Derived(() => source.get() % 2);
    const label = new Derived(() => (parity.get() ? "odd" : "even"));
    const effect = new Effect(() => label.get());

    const parityBefore = parity.getEvaluations();
    const labelBefore = label.getEvaluations();
    const runsBefore = effect.getRuns();

    source.set(3);
    assert.strictEqual(parity.getEvaluations(), parityBefore + 1, "parity has to look");
    assert.strictEqual(label.getEvaluations(), labelBefore, "label does not");
    assert.strictEqual(effect.getRuns(), runsBefore, "and neither does the effect");

    source.set(4);
    assert.strictEqual(label.getEvaluations(), labelBefore + 1);
    assert.strictEqual(effect.getRuns(), runsBefore + 1);
    effect.dispose();
  });

  it("evaluates a diamond's join exactly once per write", () => {
    const source = Signal.of(1);
    const left = new Derived(() => source.get() + 1);
    const right = new Derived(() => source.get() * 2);
    const join = new Derived(() => left.get() + right.get());
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(join.get()));

    seen.length = 0;
    const before = join.getEvaluations();
    source.set(5);

    assert.strictEqual(join.getEvaluations(), before + 1);
    assert.deepStrictEqual(seen, [16]);
    effect.dispose();
  });

  it("collapses a batch into one evaluation", () => {
    const a = Signal.of(0);
    const b = Signal.of(0);
    const sum = new Derived(() => a.get() + b.get());
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(sum.get()));

    seen.length = 0;
    const before = sum.getEvaluations();
    batch(() => {
      a.set(3);
      b.set(5);
    });

    assert.strictEqual(sum.getEvaluations(), before + 1);
    assert.deepStrictEqual(seen, [8]);
    effect.dispose();
  });

  it("collapses repeated writes to one signal", () => {
    const signal = Signal.of(0);
    const derived = new Derived(() => signal.get() * 10);
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(derived.get()));

    seen.length = 0;
    const before = derived.getEvaluations();
    batch(() => {
      signal.set(1);
      signal.set(2);
      signal.set(3);
    });

    assert.strictEqual(derived.getEvaluations(), before + 1);
    assert.deepStrictEqual(seen, [30]);
    effect.dispose();
  });

  it("keeps a fan-out consistent when a signal is written outside a batch", () => {
    const signal = Signal.of(0);
    const left = new Derived(() => signal.get() + 1);
    const right = new Derived(() => signal.get() * 2);
    const join = new Derived(() => left.get() + right.get());
    /** @type {unknown[]} */
    const seen = [];
    const effect = new Effect(() => seen.push(join.get()));

    seen.length = 0;
    signal.set(5);

    assert.deepStrictEqual(seen, [16], "one update, not one per branch");
    effect.dispose();
  });

  it("does not depend on what a non-reactive block read", () => {
    const source = Signal.of(1);
    const derived = new Derived(makeNonReactive(() => source.get()));
    const effect = new Effect(() => derived.get());
    assert.strictEqual(derived.get(), 1);
    source.set(2);
    assert.strictEqual(derived.get(), 1);
    effect.dispose();
  });

  it("drops a dependency it stopped reading", () => {
    const which = Signal.of(true);
    const a = Signal.of("a");
    const b = Signal.of("b");
    const derived = new Derived(() => (which.get() ? a.get() : b.get()));
    const effect = new Effect(() => derived.get());

    assert.strictEqual(derived.get(), "a");
    which.set(false);
    assert.strictEqual(derived.get(), "b");

    const before = derived.getEvaluations();
    a.set("A");
    assert.strictEqual(derived.getEvaluations(), before, "no longer reads a");
    b.set("B");
    assert.strictEqual(derived.get(), "B");
    effect.dispose();
  });

  it("uses a custom isEqual to decide what counts as a change", () => {
    const source = Signal.of({ n: 1 });
    const derived = new Derived(() => source.get(), {
      isEqual: (x, y) => x.n === y.n,
    });
    const downstream = new Derived(() => derived.get().n * 2);
    const effect = new Effect(() => downstream.get());

    const before = downstream.getEvaluations();
    source.set({ n: 1 });
    assert.strictEqual(downstream.getEvaluations(), before, "same n, no change");
    source.set({ n: 2 });
    assert.strictEqual(downstream.get(), 4);
    effect.dispose();
  });

  describe("cleanup", () => {
    it("runs when the last reader leaves", () => {
      const cleanup = mock.fn();
      const derived = new Derived(() => {
        onCleanup(cleanup);
        return 1;
      });
      const first = derived.subscribe({});
      const second = derived.subscribe({});
      derived.get();
      first.unsubscribe();
      assert.strictEqual(cleanup.mock.calls.length, 0);
      second.unsubscribe();
      assert.strictEqual(cleanup.mock.calls.length, 1);
    });

    it("is deferred by cacheTTL", async () => {
      const cleanup = mock.fn();
      const derived = new Derived(
        () => {
          onCleanup(cleanup);
          return 1;
        },
        { cacheTTL: 0 },
      );
      const subscription = derived.subscribe({});
      derived.get();
      subscription.unsubscribe();
      assert.strictEqual(cleanup.mock.calls.length, 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.strictEqual(cleanup.mock.calls.length, 1);
    });

    it("runs before each re-evaluation", () => {
      const cleanup = mock.fn();
      const source = Signal.of(1);
      const derived = new Derived(() => {
        addDependency(source);
        onCleanup(cleanup);
        return source.get() * 2;
      });
      const effect = new Effect(() => derived.get());

      assert.strictEqual(derived.get(), 2);
      assert.strictEqual(derived.getEvaluations(), 1);
      assert.strictEqual(cleanup.mock.calls.length, 0);

      source.set(2);
      assert.strictEqual(derived.get(), 4);
      assert.strictEqual(derived.getEvaluations(), 2);
      assert.strictEqual(cleanup.mock.calls.length, 1);

      effect.dispose();
      assert.strictEqual(cleanup.mock.calls.length, 2);
    });
  });

  describe("circular dependencies", () => {
    it("are detected between two derived nodes", () => {
      /** @type {Derived<number>} */
      const a = new Derived(() => b.get() + 1);
      /** @type {Derived<number>} */
      const b = new Derived(() => a.get() + 1);
      assert.throws(() => a.get(), CircularDependencyError);
      assert.throws(() => b.get(), CircularDependencyError);
    });

    it("are detected when an effect writes what it reads", () => {
      const signal = Signal.of(0);
      assert.throws(() => {
        const effect = new Effect(() => {
          signal.set(signal.get() + 1);
        });
        effect.dispose();
      }, CircularDependencyError);
    });

    it("are allowed when the write converges", () => {
      // The write is a no-op the second time round, so nothing is ever
      // invalidated while running and there is no loop to detect.
      const signal = Signal.of(0);
      const effect = new Effect(() => {
        signal.set(Math.abs(signal.get()));
      });
      signal.set(-1);
      assert.strictEqual(signal.get(), 1);
      effect.dispose();
    });
  });
});
