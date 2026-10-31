import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { memoize, memoizeDependency, memoizeWithTTL } from "./memoize.js";
import { Subject, tap } from "rxjs";
import { addDependency, onCleanup } from "./index.js";
import { Computation } from "./index.js";

/**
 * @import {Derived} from './Derived.js';
 */

/**
 * @param {() => void} fn
 */
function inComputation(fn) {
  const computation = new Computation();
  const sub = computation.subscribe({});
  computation.track(() => {
    fn();
  });
  sub.unsubscribe();
}

describe("memoize()", () => {
  it("memoize signal inside a reactive computation", () => {
    const compute = mock.fn((/** @type {number} */ x) => ({ value: x }));
    /** @type {Map<number, Derived<{ value: number }>>} */
    const cache = new Map();
    const memoized = memoize(compute, {
      cache,
      getKey: (x) => x,
    });
    inComputation(() => {
      const a = memoized(1);
      const b = memoized(1);
      const c = memoized(2);
      assert.strictEqual(cache.size, 2);
      assert.strictEqual(a, b);
      assert.notStrictEqual(a, c);
    });
    assert.equal(cache.size, 0);
    assert.equal(compute.mock.calls.length, 2);
  });

  it("holds an entry open past its last reader, with cacheTTL", async () => {
    const cleanup = mock.fn();
    const compute = mock.fn((/** @type {number} */ x) => {
      onCleanup(cleanup);
      return { value: x };
    });
    /** @type {Map<number, Derived<{ value: number }>>} */
    const cache = new Map();
    const memoized = memoize(compute, { cache, getKey: (x) => x, cacheTTL: 0 });

    inComputation(() => {
      memoized(1);
    });
    // The reader has gone, but the entry is still there and still holding
    // what it built — which is what lets a factory whose key follows
    // interaction state survive the state flipping back.
    assert.equal(cache.size, 1);
    assert.equal(cleanup.mock.calls.length, 0);
    inComputation(() => {
      memoized(1);
    });
    assert.equal(compute.mock.calls.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cache.size, 0);
    assert.equal(cleanup.mock.calls.length, 1);
  });
});

describe("memoizeWithTTL()", () => {
  it("is memoize with the window in front", async () => {
    const cleanup = mock.fn();
    const compute = mock.fn((/** @type {number} */ x) => {
      onCleanup(cleanup);
      return { value: x };
    });
    /** @type {Map<number, Derived<{ value: number }>>} */
    const cache = new Map();
    const memoized = memoizeWithTTL(0, compute, { cache, getKey: (x) => x });

    inComputation(() => {
      memoized(1);
    });
    assert.equal(cache.size, 1);
    assert.equal(cleanup.mock.calls.length, 0);
    inComputation(() => {
      memoized(1);
    });
    assert.equal(compute.mock.calls.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cache.size, 0);
    assert.equal(cleanup.mock.calls.length, 1);
  });

  it("evicts on the spot when the window is negative, as memoize does", () => {
    const cleanup = mock.fn();
    const compute = mock.fn((/** @type {number} */ x) => {
      onCleanup(cleanup);
      return { value: x };
    });
    /** @type {Map<number, Derived<{ value: number }>>} */
    const cache = new Map();
    const memoized = memoizeWithTTL(-1, compute, { cache, getKey: (x) => x });

    inComputation(() => {
      memoized(1);
    });
    assert.equal(cache.size, 0);
    assert.equal(cleanup.mock.calls.length, 1);
  });
});

describe("memoizeDependency()", () => {
  it("memoize signal inside a reactive computation", () => {
    const spy = mock.fn((/** @type {number} */ x) => ({ value: x }));
    /** @type {Map<number, Computation>} */
    const cache = new Map();
    /** @type {Subject<void>} */
    const subject = new Subject();
    const memoized = memoizeDependency(
      (/** @type {number} */ x) =>
        subject.pipe(
          tap(() => {
            spy(x);
          }),
        ),
      {
        cache,
        getKey: (x) => x,
      },
    );
    inComputation(() => {
      const a = memoized(1);
      addDependency(a);
      const b = memoized(1);
      addDependency(b);
      const c = memoized(2);
      addDependency(c);
      assert.strictEqual(cache.size, 2);
      assert.strictEqual(a, b);
      assert.notStrictEqual(a, c);
      subject.next();
    });
    assert.equal(cache.size, 0);
    assert.equal(spy.mock.calls.length, 2);
  });
});
