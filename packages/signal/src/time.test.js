import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { fromObservable, interval, timer, toObservable } from "./index.js";

/**
 * @import { Subscribable } from "./subscribable.js";
 */

/**
 * Everything a source says, and a handle to stop listening.
 *
 * @template T
 * @param {Subscribable<T>} source
 */
function collect(source) {
  /** @type {T[]} */
  const values = [];
  const seen = { completed: false };
  const subscription = source.subscribe({
    next: (value) => values.push(value),
    complete: () => {
      seen.completed = true;
    },
  });
  return { values, seen, unsubscribe: () => subscription.unsubscribe() };
}

/** @param {number} ms */
const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("timer()", () => {
  test("emits once and completes when given no period", async () => {
    const { values, seen, unsubscribe } = collect(timer(5));
    assert.deepStrictEqual(values, [], "nothing before the delay is up");

    await after(30);
    assert.deepStrictEqual(values, [0]);
    assert.strictEqual(seen.completed, true, "a one-shot timer finishes");
    unsubscribe();
  });

  test("keeps counting when given a period", async () => {
    const { values, seen, unsubscribe } = collect(timer(5, 5));
    await after(60);
    assert.ok(values.length >= 3, `expected several values, got ${values.length}`);
    assert.deepStrictEqual(
      values.slice(0, 3),
      [0, 1, 2],
      "the count starts at zero and goes up by one",
    );
    assert.strictEqual(seen.completed, false, "a repeating timer does not finish on its own");
    unsubscribe();
  });

  test("stops when the subscriber lets go, before it has fired", async () => {
    const { values, unsubscribe } = collect(timer(20));
    unsubscribe();
    await after(60);
    assert.deepStrictEqual(values, [], "a cleared timeout says nothing");
  });

  test("stops when the subscriber lets go, after it has started repeating", async () => {
    const { values, unsubscribe } = collect(timer(5, 5));
    await after(40);
    const taken = values.length;
    assert.ok(taken > 0, "expected it to have started");
    unsubscribe();
    await after(40);
    assert.strictEqual(values.length, taken, "a cleared interval adds nothing");
  });

  test("is cold: each subscriber gets a count of its own", async () => {
    const source = timer(5, 5);
    const first = collect(source);
    await after(30);
    const second = collect(source);
    await after(30);

    assert.strictEqual(second.values[0], 0, "the late subscriber starts from zero too");
    assert.ok(
      first.values.length > second.values.length,
      "the early subscriber is further along, so the two are not sharing",
    );
    first.unsubscribe();
    second.unsubscribe();
  });

  test("treats a negative delay as no delay", async () => {
    const { values, unsubscribe } = collect(timer(-100));
    await after(20);
    assert.deepStrictEqual(values, [0]);
    unsubscribe();
  });
});

describe("interval()", () => {
  test("counts from zero, a period in", async () => {
    const { values, unsubscribe } = collect(interval(5));
    assert.deepStrictEqual(values, [], "nothing at zero — the first value is a period away");
    await after(60);
    assert.deepStrictEqual(values.slice(0, 3), [0, 1, 2]);
    unsubscribe();
  });

  test("a node over one is the shared clock", async () => {
    // What `share()` was doing in knights: one timer however many read it, and
    // let go of when the last reader does. The node is the sharing; this pins
    // that two readers see the same count rather than two independent ones.
    const shared = toObservable(fromObservable(interval(5)));
    const first = collect(shared);
    await after(30);
    const second = collect(shared);
    await after(30);

    assert.ok(second.values.length > 0, "the late reader gets ticks");
    assert.deepStrictEqual(
      second.values,
      first.values.slice(first.values.length - second.values.length),
      "both readers see the same count, so there is one timer behind them",
    );
    first.unsubscribe();
    second.unsubscribe();
  });
});
