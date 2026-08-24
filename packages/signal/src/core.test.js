import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { BehaviorSubject, Subject } from "rxjs";
import { batch, Derived, Signal } from "./index.js";
import {
  withComputation,
  makeNonReactive,
  toObservable,
  addDependency,
  onCleanup,
} from "./index.js";

const fakeComputation = {
  addDependency: () => {},
  onCleanup: () => {},
};

describe("withComputation", function () {
  it("returns callback result", function () {
    const result = withComputation(fakeComputation, () => 42);
    assert.strictEqual(result, 42);
  });

  it("rethrows callback errors", function () {
    const err = new Error("failure");
    assert.throws(() => {
      withComputation(fakeComputation, () => {
        throw err;
      });
    }, err);
  });
});

describe("makeNonReactive", function () {
  it("passes arguments through and returns function result", function () {
    const fn = mock.fn((a, b) => a + b);
    const wrapped = makeNonReactive(fn);

    assert.strictEqual(wrapped(2, 3), 5);
    assert.strictEqual(fn.mock.calls.length, 1);
    assert.deepStrictEqual(fn.mock.calls[0].arguments, [2, 3]);
  });

  it("rethrows errors from wrapped function", function () {
    const err = new Error("wrapped failure");
    const wrapped = makeNonReactive(() => {
      throw err;
    });

    assert.throws(() => {
      wrapped();
    }, err);
  });
});

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
  it("only updates final signal once (1)", function () {
    const spy = mock.fn();
    const s1 = Signal.of(0);
    const s2 = new Derived(() => s1.get() + 1);
    const s3 = new Derived(() => s1.get() + 2);
    const subscription = toObservable(
      new Derived(() => {
        spy(s2.get() + s3.get());
      }),
    ).subscribe();

    assert.strictEqual(spy.mock.calls.length, 1);
    assert.deepStrictEqual(spy.mock.calls[0].arguments, [3]);

    s1.set(1);
    assert.strictEqual(spy.mock.calls.length, 2);
    assert.deepStrictEqual(spy.mock.calls[1].arguments, [5]);

    s1.set(1);
    assert.strictEqual(spy.mock.calls.length, 2);

    s1.set(2);
    assert.strictEqual(spy.mock.calls.length, 3);
    assert.deepStrictEqual(spy.mock.calls[2].arguments, [7]);

    subscription.unsubscribe();
  });

  it("only updates final signal once (2)", function () {
    const spy = mock.fn();
    const s1 = Signal.of(0);
    const s2 = new Derived(() => s1.get() + 1);
    const s3 = new Derived(() => s1.get() + s2.get());
    const subscription = toObservable(
      new Derived(() => {
        spy(s1.get() + s2.get() + s3.get());
      }),
    ).subscribe();

    assert.strictEqual(spy.mock.calls.length, 1);
    assert.deepStrictEqual(spy.mock.calls[0].arguments, [2]);

    s1.set(1);
    assert.strictEqual(spy.mock.calls.length, 2);
    assert.deepStrictEqual(spy.mock.calls[1].arguments, [6]);

    s1.set(1);
    assert.strictEqual(spy.mock.calls.length, 2);

    s1.set(2);
    assert.strictEqual(spy.mock.calls.length, 3);
    assert.deepStrictEqual(spy.mock.calls[2].arguments, [10]);

    subscription.unsubscribe();
  });
});

describe("batching", function () {
  it("should batch updates", function () {
    const s1 = Signal.of(0);
    const s2 = Signal.of(0);
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
    const signal = Signal.of(0);
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
    const signal = Signal.of(0);
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
    const s1 = Signal.of(1);
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

  it("should use BehaviorSubject as source", function () {
    const source = new BehaviorSubject(0);
    const spy = mock.fn();
    const subscription = observable(() => {
      addDependency(source);
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

describe("effect = autorun & onCleanup", function () {
  it("should run side effects when signal changes", function () {
    const signal = Signal.of(0);
    const spy = mock.fn();
    const cleanup = mock.fn();
    const subscription = observable(() => {
      spy(signal.get());
      onCleanup(cleanup);
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

describe("observable as dependency", function () {
  it("should allow using subject as dependency", function () {
    /** @type {Subject<void>} */
    const changes = new Subject();
    let value = 0;
    const setValue = (/** @type {number} */ v) => {
      if (value !== v) {
        value = v;
        changes.next();
      }
    };
    const spy = mock.fn();
    const subscription = observable(() => {
      addDependency(changes);
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
