/* eslint-env jest */

import { merge } from "rxjs";
import { Initial, Derived, Dedupe, batch, nonReactive } from "./Signal.js";

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

it("should only emit if value changes", function () {
  const initial = new Initial(1);
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
  const initial = new Initial(1);
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
  const initial = new Initial(1);
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
  const s1 = new Initial(0);
  const s2 = new Initial(0);
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
  const initial = new Initial(1);
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
  const initial = new Initial(1);
  const derived = new Derived(() => nonReactive(() => initial.get()));
  const spy = jest.fn();
  const subscription = derived.getChanges().subscribe(spy);
  expect(derived.get()).toBe(1);
  initial.set(2);
  expect(derived.get()).toBe(1);
  expect(spy).toHaveBeenCalledTimes(0);
  subscription.unsubscribe();
});
