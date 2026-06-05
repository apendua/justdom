import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { memoizeImpl, memoize, memoize3 } from "./memoize.js";
import { Derived } from "./Signal.js";
import { waitForNextTick } from "./nextTick.js";
import { Subject, tap } from "rxjs";
import { addDependency } from "./core.js";
import Computation from "./Computation.js";

/**
 * @param {() => void} fn
 */
function inComputation(fn) {
  const computation = new Computation();
  const sub = computation.subscribe({});
  computation.run(() => {
    fn();
  });
  sub.unsubscribe();
}

describe("memoizeImpl()", () => {
  it("memoize signal inside a reactive computation", async () => {
    const compute = mock.fn((/** @type {number} */ x) => ({ value: x }));
    /** @type {Map<number, Derived<{ value: number }>>} */
    const cache = new Map();
    const memoized = memoizeImpl(
      (/** @type {number} */ x) => {
        return new Derived(() => {
          return compute(x);
        });
      },
      {
        cache,
      },
    );
    inComputation(() => {
      const a = memoized(1);
      a.get();
      const b = memoized(1);
      b.get();
      const c = memoized(2);
      c.get();
      assert.strictEqual(cache.size, 2);
      assert.strictEqual(a, b);
      assert.strictEqual(a.get(), b.get());
      assert.notStrictEqual(a, c);
    });
    await waitForNextTick();
    assert.equal(cache.size, 0);
    assert.equal(compute.mock.calls.length, 2);
  });
});

describe("memoize()", () => {
  it("memoize signal inside a reactive computation", async () => {
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
    await waitForNextTick();
    assert.equal(cache.size, 0);
    assert.equal(compute.mock.calls.length, 2);
  });
});

describe("memoize3()", () => {
  it("memoize signal inside a reactive computation", async () => {
    const spy = mock.fn((/** @type {number} */ x) => ({ value: x }));
    /** @type {Map<number, Computation>} */
    const cache = new Map();
    /** @type {Subject<void>} */
    const subject = new Subject();
    const memoized = memoize3(
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
    await waitForNextTick();
    assert.equal(cache.size, 0);
    assert.equal(spy.mock.calls.length, 2);
  });
});
