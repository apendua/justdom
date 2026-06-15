import { it, mock } from "node:test";
import assert from "node:assert/strict";

import { Signal, Derived, batch } from "./Signal.js";
import { makeNonReactive, addDependency, onCleanup, CircularDependencyError } from "./core.js";

it("should not memoize value if not subscribed", function () {
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

it("should memoize value when subscribed", function () {
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

it("invokes cleanup after last subscriber unsubscribes", function () {
  const cleanup = mock.fn();
  const derived = new Derived(() => {
    onCleanup(cleanup);
  });
  const subscription1 = derived.subscribe({});
  const subscription2 = derived.subscribe({});
  subscription1.unsubscribe();
  subscription2.unsubscribe();
  assert.strictEqual(cleanup.mock.calls.length, 1);
});

it("invokes cleanup in a deferred manner", async function () {
  const cleanup = mock.fn();
  const derived = new Derived(
    () => {
      onCleanup(cleanup);
    },
    {
      cacheTTL: 0,
    },
  );
  const subscription1 = derived.subscribe({});
  const subscription2 = derived.subscribe({});
  subscription1.unsubscribe();
  subscription2.unsubscribe();
  assert.strictEqual(cleanup.mock.calls.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(cleanup.mock.calls.length, 1);
});

it("invokes cleanup after any relevant change in dependency", function () {
  const cleanup = mock.fn();
  const source = Signal.of(1);
  const derived = new Derived(() => {
    addDependency(source);
    onCleanup(cleanup);
    return source.get() * 2;
  });
  const subscription1 = derived.subscribe({});
  const subscription2 = derived.subscribe({});
  assert.strictEqual(derived.get(), 2);
  assert.strictEqual(derived.getEvaluations(), 1);
  assert.strictEqual(cleanup.mock.calls.length, 0);
  subscription1.unsubscribe();
  assert.strictEqual(derived.getEvaluations(), 1);
  assert.strictEqual(cleanup.mock.calls.length, 0);
  subscription2.unsubscribe();
  assert.strictEqual(derived.getEvaluations(), 1);
  assert.strictEqual(cleanup.mock.calls.length, 1);
  source.set(2);
  assert.strictEqual(derived.get(), 4);
  assert.strictEqual(derived.getEvaluations(), 2);
  assert.strictEqual(cleanup.mock.calls.length, 1);
  const subscription3 = derived.subscribe({});
  assert.strictEqual(derived.get(), 4);
  assert.strictEqual(derived.getEvaluations(), 3);
  assert.strictEqual(cleanup.mock.calls.length, 2);
  subscription3.unsubscribe();
  assert.strictEqual(derived.getEvaluations(), 3);
  assert.strictEqual(cleanup.mock.calls.length, 3);
});

it("should only emit if value changes", function () {
  const initial = Signal.of(1);
  const spy = mock.fn();
  const subscription = initial.subscribe({ next: spy });
  assert.strictEqual(initial.get(), 1);
  initial.set(1);
  assert.strictEqual(initial.get(), 1);
  initial.set(2);
  assert.strictEqual(initial.get(), 2);
  subscription.unsubscribe();
  assert.strictEqual(spy.mock.calls.length, 1);
});

it("should update value when input changes", function () {
  const initial = Signal.of(1);
  const derived = new Derived(() => initial.get() + 1);
  const spy = mock.fn();
  const subscription = derived.subscribe({ next: spy });
  assert.strictEqual(derived.get(), 2);
  initial.set(2);
  assert.strictEqual(derived.get(), 3);
  initial.set(3);
  assert.strictEqual(derived.get(), 4);
  subscription.unsubscribe();
  assert.strictEqual(spy.mock.calls.length, 2);
});

it("should only emit if derived value changes", function () {
  const initial = Signal.of(1);
  const derived = new Derived(() => initial.get() % 2);
  const spy = mock.fn();
  const subscription = derived.subscribe({ next: spy });
  assert.strictEqual(derived.get(), 1);
  initial.set(3);
  assert.strictEqual(derived.get(), 1);
  initial.set(2);
  assert.strictEqual(derived.get(), 0);
  initial.set(3);
  assert.strictEqual(derived.get(), 1);
  subscription.unsubscribe();
  assert.strictEqual(spy.mock.calls.length, 2);
});

it("should batch updates", function () {
  const s1 = Signal.of(0);
  const s2 = Signal.of(0);
  const s3 = new Derived(() => s1.get() + s2.get());

  const spy = mock.fn();
  const subscription = s3.subscribe({
    next: () => {
      spy(s3.get());
    },
  });

  batch(() => {
    s1.set(3);
    s2.set(5);
  });

  assert.strictEqual(spy.mock.calls.length, 1);
  assert.deepStrictEqual(spy.mock.calls[1 - 1].arguments, [8]);

  subscription.unsubscribe();
});

it("should not rerun if changes happen within no-reactive block", function () {
  const initial = Signal.of(1);
  const derived = new Derived(makeNonReactive(() => initial.get()));
  const spy = mock.fn();
  const subscription = derived.subscribe({ next: spy });
  assert.strictEqual(derived.get(), 1);
  initial.set(2);
  assert.strictEqual(derived.get(), 1);
  assert.strictEqual(spy.mock.calls.length, 0);
  subscription.unsubscribe();
});

it("should detect circular dependencies on initial subscribe", function () {
  const onError = mock.fn();
  const s1 = Signal.of(0);
  const s2 = new Derived(() => {
    s1.set(s1.get() + 1);
  });
  s2.subscribe({
    error: onError,
  });
  assert.equal(onError.mock.calls.length, 1);
  assert.equal(onError.mock.calls[0].arguments[0] instanceof CircularDependencyError, true);
});

it("should gracefully handle circular dependencies which converge to a stable state", function () {
  const onError = mock.fn();
  const s1 = Signal.of(0);
  const s2 = new Derived(() => {
    // This looks like a circular dependency, but upon the second iteration the set
    // operation becomes a no-op, so it is actually safe to allow this.
    // This may be useful in certain scenarios.
    s1.set(Math.abs(s1.get()));
  });
  s2.subscribe({
    error: onError,
  });
  s1.set(-1);
  assert.equal(s1.get(), 1);
  assert.equal(onError.mock.calls.length, 0);
});

it("should detect circular dependencies in derived computations", function () {
  /** @type {Derived<number>} */
  const a = new Derived(() => b.get() + 1);
  /** @type {Derived<number>} */
  const b = new Derived(() => a.get() + 1);
  assert.throws(() => a.get(), CircularDependencyError);
  assert.throws(() => b.get(), CircularDependencyError);
});
