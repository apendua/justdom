import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { BehaviorSubject, Subject } from "rxjs";
import { addDependency, batch, Changes, Derived, Signal, onInvalidate, Source } from "./Signal.js";
import { toObservable } from "./operators.js";

/**
 * @import {Observable} from "rxjs";
 */

/**
 * @template T
 * @param {() => T} fn
 * @return {Observable<T>}
 */
function observable(fn) {
  return toObservable(new Derived(fn));
}

describe("diamond dependency", function () {
  it("should update all dependants when a signal changes", function () {
    const s1 = new Signal(0);
    const s2 = new Derived(() => s1.get() + 1);
    const s3 = new Derived(() => s1.get() + s2.get());
    const s4 = new Derived(() => s1.get() + s2.get() + s3.get());

    const spy = mock.fn();
    const subscription = observable(() => {
      spy(s4.get());
    }).subscribe();

    s1.set(1);
    s1.set(1); // same value, should be no-op
    s1.set(2);
    s1.set(3);

    assert.strictEqual(spy.mock.calls.length, 4);
    assert.deepStrictEqual(spy.mock.calls[1 - 1].arguments, [2]);
    assert.deepStrictEqual(spy.mock.calls[2 - 1].arguments, [6]);
    assert.deepStrictEqual(spy.mock.calls[3 - 1].arguments, [10]);
    assert.deepStrictEqual(spy.mock.calls[4 - 1].arguments, [14]);

    subscription.unsubscribe();
  });
});

describe("batching", function () {
  it("should batch updates", function () {
    const s1 = new Signal(0);
    const s2 = new Signal(0);
    const s3 = new Derived(() => s1.get() + s2.get());

    const spy = mock.fn();
    const subscription = observable(() => {
      spy(s3.get());
    }).subscribe();

    batch(() => {
      s1.set(3);
      s2.set(5);
    });

    assert.strictEqual(spy.mock.calls.length, 2);
    assert.deepStrictEqual(spy.mock.calls[1 - 1].arguments, [0]);
    assert.deepStrictEqual(spy.mock.calls[2 - 1].arguments, [8]);

    subscription.unsubscribe();
  });
});

describe("autorun", function () {
  it("should re-run whenever input changes", function () {
    const signal = new Signal(0);
    const spy = mock.fn();
    const subscription = observable(() => {
      spy(signal.get());
    }).subscribe();

    signal.set(1);
    signal.set(1); // same value, should be no-op
    signal.set(2);
    signal.set(3);
    subscription.unsubscribe();

    assert.strictEqual(spy.mock.calls.length, 4);
    assert.deepStrictEqual(spy.mock.calls[1 - 1].arguments, [0]);
    assert.deepStrictEqual(spy.mock.calls[2 - 1].arguments, [1]);
    assert.deepStrictEqual(spy.mock.calls[3 - 1].arguments, [2]);
    assert.deepStrictEqual(spy.mock.calls[4 - 1].arguments, [3]);
  });
});

describe("observe", function () {
  it("should observe values when signal changes", function () {
    const signal = new Signal(0);
    const spy = mock.fn();
    const subscription = observable(() => {
      return signal.get();
    }).subscribe({
      next(value) {
        spy(value);
      },
    });

    signal.set(1);
    signal.set(1); // same value, should be no-op
    signal.set(2);
    subscription.unsubscribe();

    assert.strictEqual(spy.mock.calls.length, 3);
    assert.deepStrictEqual(spy.mock.calls[1 - 1].arguments, [0]);
    assert.deepStrictEqual(spy.mock.calls[2 - 1].arguments, [1]);
    assert.deepStrictEqual(spy.mock.calls[3 - 1].arguments, [2]);
  });

  it("should observe value when derived signal changes", function () {
    const s1 = new Signal(1);
    const s2 = new Derived(() => s1.get() % 2);
    const spy = mock.fn();
    const subscription = observable(() => {
      return s2.get();
    }).subscribe({
      next(value) {
        spy(value);
      },
    });

    s1.set(3);
    s1.set(2);
    s1.set(3);
    subscription.unsubscribe();

    assert.strictEqual(spy.mock.calls.length, 3);
    assert.deepStrictEqual(spy.mock.calls[1 - 1].arguments, [1]);
    assert.deepStrictEqual(spy.mock.calls[2 - 1].arguments, [0]);
    assert.deepStrictEqual(spy.mock.calls[3 - 1].arguments, [1]);
  });

  it("should return the same values as source observable", function () {
    const source = new BehaviorSubject(0);
    const signal = new Source(source);
    const observe = toObservable(signal);
    const spy = mock.fn();
    const subscription = observe.subscribe(spy);

    source.next(1);
    source.next(1); // source is not deduped by default
    source.next(2);

    assert.strictEqual(spy.mock.calls.length, 4);
    assert.deepStrictEqual(spy.mock.calls[1 - 1].arguments, [0]);
    assert.deepStrictEqual(spy.mock.calls[2 - 1].arguments, [1]);
    assert.deepStrictEqual(spy.mock.calls[3 - 1].arguments, [1]);
    assert.deepStrictEqual(spy.mock.calls[4 - 1].arguments, [2]);

    subscription.unsubscribe();
  });

  it("should use BehaviorSubject as source", function () {
    const source = new BehaviorSubject(0);
    const signal = new Source(source);
    const spy = mock.fn();
    const subscription = observable(() => {
      addDependency(signal);
      return source.getValue();
    }).subscribe(spy);

    source.next(1);
    source.next(1); // same value, should be no-op
    source.next(2);

    assert.strictEqual(spy.mock.calls.length, 3);
    assert.deepStrictEqual(spy.mock.calls[1 - 1].arguments, [0]);
    assert.deepStrictEqual(spy.mock.calls[2 - 1].arguments, [1]);
    assert.deepStrictEqual(spy.mock.calls[3 - 1].arguments, [2]);

    subscription.unsubscribe();
  });
});

describe("effect = autorun & onInvalidate", function () {
  it("should run side effects when signal changes", function () {
    const signal = new Signal(0);
    const spy = mock.fn();
    const cleanup = mock.fn();
    const subscription = observable(() => {
      spy(signal.get());
      onInvalidate(cleanup);
    }).subscribe();

    signal.set(1);
    signal.set(1); // same value, should be no-op
    signal.set(2);
    subscription.unsubscribe();

    assert.strictEqual(spy.mock.calls.length, 3);
    assert.deepStrictEqual(spy.mock.calls[1 - 1].arguments, [0]);
    assert.deepStrictEqual(spy.mock.calls[2 - 1].arguments, [1]);
    assert.deepStrictEqual(spy.mock.calls[3 - 1].arguments, [2]);

    assert.strictEqual(cleanup.mock.calls.length, 3);
  });
});

describe("toChanges", function () {
  it("should convert an observable to a signal", function () {
    /** @type {Subject<void>} */
    const changes = new Subject();
    let value = 0;
    const dependency = new Changes(changes);
    const setValue = (/** @type {number} */ v) => {
      if (value !== v) {
        value = v;
        changes.next();
      }
    };
    const spy = mock.fn();
    const subscription = observable(() => {
      addDependency(dependency);
      spy(value);
    }).subscribe();

    setValue(1);
    setValue(1); // same value, should be no-op
    setValue(2);
    subscription.unsubscribe();

    assert.strictEqual(spy.mock.calls.length, 3);
    assert.deepStrictEqual(spy.mock.calls[1 - 1].arguments, [0]);
    assert.deepStrictEqual(spy.mock.calls[2 - 1].arguments, [1]);
    assert.deepStrictEqual(spy.mock.calls[3 - 1].arguments, [2]);
  });
});
