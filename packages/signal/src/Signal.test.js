/* eslint-env jest */

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
  expect(derived.get()).toBe(42);
  expect(computeCount).toBe(1);
  expect(derived.get()).toBe(42);
  expect(computeCount).toBe(2);
});

it("should memoize value when subscribed", function () {
  let computeCount = 0;
  const derived = new Derived(() => {
    computeCount++;
    return 42;
  });
  const subscription = derived.getChanges().subscribe();
  expect(derived.get()).toBe(42);
  expect(computeCount).toBe(1);
  expect(derived.get()).toBe(42);
  expect(computeCount).toBe(1);
  subscription.unsubscribe();
});

it("invokes cleanup after last subscriber unsubscribes", function () {
  const cleanup = jest.fn();
  const derived = new Derived(() => {
    onInvalidate(cleanup);
  });
  const subscription1 = derived.getChanges().subscribe();
  const subscription2 = derived.getChanges().subscribe();
  subscription1.unsubscribe();
  subscription2.unsubscribe();
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("invokes cleanup in a deferred manner", async function () {
  const cleanup = jest.fn();
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
  expect(cleanup).toHaveBeenCalledTimes(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("invokes cleanup after any relevant change in dependency", function () {
  const cleanup = jest.fn();
  const source = new Signal(1);
  const derived = new Derived(() => {
    addDependency(source);
    onInvalidate(cleanup);
    return source.get() * 2;
  });
  const subscription1 = derived.getChanges().subscribe();
  const subscription2 = derived.getChanges().subscribe();
  expect(derived.get()).toBe(2);
  expect(derived.getEvaluations()).toBe(1);
  expect(cleanup).toHaveBeenCalledTimes(0);
  subscription1.unsubscribe();
  expect(derived.getEvaluations()).toBe(1);
  expect(cleanup).toHaveBeenCalledTimes(0);
  subscription2.unsubscribe();
  expect(derived.getEvaluations()).toBe(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
  source.set(2);
  expect(derived.get()).toBe(4);
  expect(derived.getEvaluations()).toBe(2);
  expect(cleanup).toHaveBeenCalledTimes(1);
  const subscription3 = derived.getChanges().subscribe();
  expect(derived.get()).toBe(4);
  expect(derived.getEvaluations()).toBe(3);
  expect(cleanup).toHaveBeenCalledTimes(2);
  subscription3.unsubscribe();
  expect(derived.getEvaluations()).toBe(3);
  expect(cleanup).toHaveBeenCalledTimes(3);
});

it("should only emit if value changes", function () {
  const initial = new Signal(1);
  const spy = jest.fn();
  const subscription = initial.getChanges().subscribe(spy);
  expect(initial.get()).toBe(1);
  initial.set(1);
  expect(initial.get()).toBe(1);
  initial.set(2);
  expect(initial.get()).toBe(2);
  subscription.unsubscribe();
  expect(spy).toHaveBeenCalledTimes(1);
});

it("should update value when input changes", function () {
  const initial = new Signal(1);
  const derived = new Derived(() => initial.get() + 1);
  const spy = jest.fn();
  const subscription = derived.getChanges().subscribe(spy);
  expect(derived.get()).toBe(2);
  initial.set(2);
  expect(derived.get()).toBe(3);
  initial.set(3);
  expect(derived.get()).toBe(4);
  subscription.unsubscribe();
  expect(spy).toHaveBeenCalledTimes(2);
});

it("should only emit if derived value changes", function () {
  const initial = new Signal(1);
  const derived = new Derived(() => initial.get() % 2);
  const spy = jest.fn();
  const subscription = derived.getChanges().subscribe(spy);
  expect(derived.get()).toBe(1);
  initial.set(3);
  expect(derived.get()).toBe(1);
  initial.set(2);
  expect(derived.get()).toBe(0);
  initial.set(3);
  expect(derived.get()).toBe(1);
  subscription.unsubscribe();
  expect(spy).toHaveBeenCalledTimes(2);
});

it("should batch updates", function () {
  const s1 = new Signal(0);
  const s2 = new Signal(0);
  const s3 = new Derived(() => s1.get() + s2.get());

  const spy = jest.fn();
  const subscription = s3.getChanges().subscribe(() => {
    spy(s3.get());
  });

  batch(() => {
    s1.set(3);
    s2.set(5);
  });

  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenNthCalledWith(1, 8);

  subscription.unsubscribe();
});

it("should dedupe updates", function () {
  const initial = new Signal(1);
  const derived = new Derived(() => 2 * initial.get());
  const changes = merge(initial.getChanges(), derived.getChanges());
  const deduped = new Dedupe(changes);
  const spy = jest.fn();
  const subscription = deduped.getChanges().subscribe(spy);
  for (let i = 2; i <= 100; i++) {
    initial.set(i);
  }
  // NOTE: The reason it's not 99 is that the first set(2) causes
  //       both input and derived to emit because dedupe is not aware
  //       of the relationship between them. However, subsequent sets to
  //       input only cause input to emit, and dedupe only emits once
  //       for all those changes.
  expect(spy).toHaveBeenCalledTimes(100);
  subscription.unsubscribe();
});

it("should not rerun if changes happen within no-reactive block", function () {
  const initial = new Signal(1);
  const derived = new Derived(() => callNonReactive(() => initial.get()));
  const spy = jest.fn();
  const subscription = derived.getChanges().subscribe(spy);
  expect(derived.get()).toBe(1);
  initial.set(2);
  expect(derived.get()).toBe(1);
  expect(spy).toHaveBeenCalledTimes(0);
  subscription.unsubscribe();
});
