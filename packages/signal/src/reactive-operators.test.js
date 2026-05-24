import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";
import { effects, map, takeNothing } from "./reactive-operators.js";
import { Signal } from "./Signal.js";

describe("effects()", () => {
  it("applies effects until the source completes", () => {
    /** @type {Subject<{ value: number }>} */
    const source = new Subject();
    const signal = Signal.of(0);
    const complete = mock.fn();
    const entity = { value: 0 };
    const entity2 = { value: 0 };

    const subscription = source
      .pipe(
        effects((obj) => {
          obj.value = signal.get();
        }),
      )
      .subscribe({
        complete,
      });

    assert.strictEqual(entity.value, 0);

    signal.set(1);
    source.next(entity);
    assert.strictEqual(entity.value, 1);

    signal.set(2);
    assert.strictEqual(entity.value, 2);

    source.next(entity2);
    assert.strictEqual(entity2.value, 2);

    signal.set(3);
    assert.strictEqual(entity.value, 2);
    assert.strictEqual(entity2.value, 3);

    source.complete();
    assert.ok(complete.mock.calls.length > 0);

    subscription.unsubscribe();
  });

  it("applies effects in order", () => {
    /** @type {Subject<number[]>} */
    const source = new Subject();
    const signal = Signal.of(0);
    /** @type {number[]} */
    const result = [];

    const subscription = source
      .pipe(
        effects((arr) => {
          arr.push(1 * signal.get());
        }),
        effects((arr) => {
          arr.push(2 * signal.get());
        }),
      )
      .subscribe();

    signal.set(1);
    source.next(result);
    assert.deepStrictEqual(result, [1, 2]);

    signal.set(3);
    assert.deepStrictEqual(result, [1, 2, 3, 6]);

    source.complete();
    subscription.unsubscribe();
  });
});

describe("takeNothing()", () => {
  it("emits no values and completes with the source", () => {
    /** @type {Subject<number>} */
    const source = new Subject();
    const complete = mock.fn();

    const subscription = source.pipe(takeNothing()).subscribe({
      complete,
    });

    source.next(1);
    assert.strictEqual(complete.mock.calls.length, 0);

    source.next(2);
    assert.strictEqual(complete.mock.calls.length, 0);

    source.complete();
    assert.ok(complete.mock.calls.length > 0);

    subscription.unsubscribe();
  });
});

describe("map()", () => {
  it("maps values until the source completes", () => {
    /** @type {Subject<number> } */
    const source = new Subject();
    const signal = Signal.of(0);
    const next = mock.fn();
    const complete = mock.fn();

    const subscription = source
      .pipe(
        map((x) => {
          return x + signal.get();
        }),
      )
      .subscribe({
        next,
        complete,
      });

    assert.strictEqual(next.mock.calls.length, 0);

    signal.set(1);
    source.next(1);
    assert.ok(
      next.mock.calls.some((call) => {
        try {
          assert.deepStrictEqual(call.arguments, [2]);
          return true;
        } catch {
          return false;
        }
      }),
    );

    signal.set(2);
    assert.ok(
      next.mock.calls.some((call) => {
        try {
          assert.deepStrictEqual(call.arguments, [3]);
          return true;
        } catch {
          return false;
        }
      }),
    );

    source.next(3);
    assert.ok(
      next.mock.calls.some((call) => {
        try {
          assert.deepStrictEqual(call.arguments, [5]);
          return true;
        } catch {
          return false;
        }
      }),
    );

    source.complete();
    assert.ok(complete.mock.calls.length > 0);

    subscription.unsubscribe();
  });
});
