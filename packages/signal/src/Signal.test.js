import { it, mock } from "node:test";
import assert from "node:assert/strict";

import { merge } from "rxjs";
import {
  Signal,
  Derived,
  Dedupe,
  batch,
  callNonReactive,
  onInvalidate,
  addDependency,
} from "./Signal.js";

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
  const subscription = derived.getChanges().subscribe();
  assert.strictEqual(derived.get(), 42);
  assert.strictEqual(computeCount, 1);
  assert.strictEqual(derived.get(), 42);
  assert.strictEqual(computeCount, 1);
  subscription.unsubscribe();
});

it("invokes cleanup after last subscriber unsubscribes", function () {
  const cleanup = mock.fn();
  const derived = new Derived(() => {
    onInvalidate(cleanup);
  });
  const subscription1 = derived.getChanges().subscribe();
  const subscription2 = derived.getChanges().subscribe();
  subscription1.unsubscribe();
  subscription2.unsubscribe();
  assert.strictEqual(cleanup.mock.calls.length, 1);
});

it("invokes cleanup in a deferred manner", async function () {
  const cleanup = mock.fn();
  const derived = new Derived(
    () => {
      onInvalidate(cleanup);
    },
    {
      deferred: true,
    },
  );
  const subscription1 = derived.getChanges().subscribe();
  const subscription2 = derived.getChanges().subscribe();
  subscription1.unsubscribe();
  subscription2.unsubscribe();
  assert.strictEqual(cleanup.mock.calls.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(cleanup.mock.calls.length, 1);
});

it("invokes cleanup after any relevant change in dependency", function () {
  const cleanup = mock.fn();
  const source = new Signal(1);
  const derived = new Derived(() => {
    addDependency(source);
    onInvalidate(cleanup);
    return source.get() * 2;
  });
  const subscription1 = derived.getChanges().subscribe();
  const subscription2 = derived.getChanges().subscribe();
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
  const subscription3 = derived.getChanges().subscribe();
  assert.strictEqual(derived.get(), 4);
  assert.strictEqual(derived.getEvaluations(), 3);
  assert.strictEqual(cleanup.mock.calls.length, 2);
  subscription3.unsubscribe();
  assert.strictEqual(derived.getEvaluations(), 3);
  assert.strictEqual(cleanup.mock.calls.length, 3);
});

it("should only emit if value changes", function () {
  const initial = new Signal(1);
  const spy = mock.fn();
  const subscription = initial.getChanges().subscribe(spy);
  assert.strictEqual(initial.get(), 1);
  initial.set(1);
  assert.strictEqual(initial.get(), 1);
  initial.set(2);
  assert.strictEqual(initial.get(), 2);
  subscription.unsubscribe();
  assert.strictEqual(spy.mock.calls.length, 1);
});

it("should update value when input changes", function () {
  const initial = new Signal(1);
  const derived = new Derived(() => initial.get() + 1);
  const spy = mock.fn();
  const subscription = derived.getChanges().subscribe(spy);
  assert.strictEqual(derived.get(), 2);
  initial.set(2);
  assert.strictEqual(derived.get(), 3);
  initial.set(3);
  assert.strictEqual(derived.get(), 4);
  subscription.unsubscribe();
  assert.strictEqual(spy.mock.calls.length, 2);
});

it("should only emit if derived value changes", function () {
  const initial = new Signal(1);
  const derived = new Derived(() => initial.get() % 2);
  const spy = mock.fn();
  const subscription = derived.getChanges().subscribe(spy);
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
  const s1 = new Signal(0);
  const s2 = new Signal(0);
  const s3 = new Derived(() => s1.get() + s2.get());

  const spy = mock.fn();
  const subscription = s3.getChanges().subscribe(() => {
    spy(s3.get());
  });

  batch(() => {
    s1.set(3);
    s2.set(5);
  });

  assert.strictEqual(spy.mock.calls.length, 1);
  assert.deepStrictEqual(spy.mock.calls[1 - 1].arguments, [8]);

  subscription.unsubscribe();
});

it("should dedupe updates", function () {
  const initial = new Signal(1);
  const derived = new Derived(() => 2 * initial.get());
  const changes = merge(initial.getChanges(), derived.getChanges());
  const deduped = new Dedupe(changes);
  const spy = mock.fn();
  const subscription = deduped.getChanges().subscribe(spy);
  for (let i = 2; i <= 100; i++) {
    initial.set(i);
  }
  // NOTE: The reason it's not 99 is that the first set(2) causes
  //       both input and derived to emit because dedupe is not aware
  //       of the relationship between them. However, subsequent sets to
  //       input only cause input to emit, and dedupe only emits once
  //       for all those changes.
  assert.strictEqual(spy.mock.calls.length, 100);
  subscription.unsubscribe();
});

it("should not rerun if changes happen within no-reactive block", function () {
  const initial = new Signal(1);
  const derived = new Derived(() => callNonReactive(() => initial.get()));
  const spy = mock.fn();
  const subscription = derived.getChanges().subscribe(spy);
  assert.strictEqual(derived.get(), 1);
  initial.set(2);
  assert.strictEqual(derived.get(), 1);
  assert.strictEqual(spy.mock.calls.length, 0);
  subscription.unsubscribe();
});
