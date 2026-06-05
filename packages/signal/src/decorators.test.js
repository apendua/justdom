import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { memo, memoFn } from "./decorators.js";
import { Derived, Signal } from "./Signal.js";

/**
 * @template {object} T
 * @template {keyof T} K
 * @param {T} target
 * @param {K} key
 * @param {Array<(target: T, key: K, descriptor: PropertyDescriptor) => void>} decorators
 */
export function decorate(target, key, ...decorators) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) {
    throw new Error(`No descriptor found for ${key.toString()}`);
  }
  for (const decorator of decorators) {
    decorator(target, key, descriptor);
  }
  Object.defineProperty(target, key, descriptor);
}

describe("memo", () => {
  it("throws when applied to a non-getter", () => {
    const obj = { value: 42 };
    assert.throws(
      () => decorate(obj, "value", memo()),
      /memo decorator can only be applied to getters/,
    );
  });

  it("memoizes getter result per instance", () => {
    // memoize (used internally) only caches within an active reactive
    // computation. Wrap access in a subscribed Derived and use a Signal
    // dependency so we can trigger a clean re-evaluation.
    const compute = mock.fn(() => ({ result: 1 }));

    class Foo {
      get bar() {
        return compute();
      }
    }

    decorate(Foo.prototype, "bar", memo());

    const foo = new Foo();
    const derived = new Derived(() => foo.bar);
    const sub = derived.subscribe({});

    // Accessing derived.get() multiple times should return the same cached
    // reference without triggering additional compute calls.
    const first = derived.get();
    const second = derived.get();

    assert.strictEqual(first, second);
    assert.strictEqual(compute.mock.calls.length, 1);

    sub.unsubscribe();
  });

  it("returns independent values for different instances", () => {
    let counter = 0;
    const trigger = Signal.of(0);

    class Foo {
      get bar() {
        trigger.get();
        return { n: ++counter };
      }
    }

    decorate(Foo.prototype, "bar", memo());

    const a = new Foo();
    const b = new Foo();

    const derivedA = new Derived(() => a.bar);
    const derivedB = new Derived(() => b.bar);
    const subA = derivedA.subscribe({});
    const subB = derivedB.subscribe({});

    trigger.set(1);

    const aResult = derivedA.get();
    const bResult = derivedB.get();

    assert.notStrictEqual(aResult, bResult);
    assert.strictEqual(derivedA.get(), aResult);
    assert.strictEqual(derivedB.get(), bResult);

    subA.unsubscribe();
    subB.unsubscribe();
  });

  it("uses custom isEqual to suppress downstream re-evaluation", () => {
    const trigger = Signal.of(0);
    const isEqual = mock.fn(() => true);
    let outerCallCount = 0;

    class Foo {
      get bar() {
        return { n: trigger.get() };
      }
    }

    decorate(Foo.prototype, "bar", memo(isEqual));

    const foo = new Foo();
    const derived = new Derived(() => {
      outerCallCount++;
      return foo.bar;
    });
    const sub = derived.subscribe({});

    // Changing the signal would normally propagate through the inner Derived.
    // But since isEqual always returns true, the outer Derived must not
    // re-evaluate.
    trigger.set(1);

    assert.strictEqual(outerCallCount, 1);
    assert.strictEqual(isEqual.mock.calls.length, 1);

    sub.unsubscribe();
  });
});

describe("memoFn", () => {
  it("throws when applied to a non-function", () => {
    class Foo {
      get bar() {
        return 1;
      }
    }
    assert.throws(
      // @ts-expect-error
      () => decorate(Foo.prototype, "bar", memoFn()),
      /memoFn decorator can only be applied to functions/,
    );
  });

  it("memoizes method results by arguments", () => {
    const compute = mock.fn((x, y) => x + y);
    const trigger = Signal.of(0);

    class Foo {
      add(/** @type {number} */ x, /** @type {number} */ y) {
        trigger.get();
        return compute(x, y);
      }
    }

    decorate(Foo.prototype, "add", memoFn());

    const foo = new Foo();
    const derived = new Derived(() => foo.add(1, 2));
    const sub = derived.subscribe({});

    trigger.set(1);

    assert.strictEqual(derived.get(), 3);
    assert.strictEqual(derived.get(), 3);
    assert.strictEqual(compute.mock.calls.length, 2);

    sub.unsubscribe();
  });

  it("caches separately for different argument combinations", () => {
    const compute = mock.fn((x, y) => x + y);
    const trigger = Signal.of(0);

    class Foo {
      add(/** @type {number} */ x, /** @type {number} */ y) {
        trigger.get();
        return compute(x, y);
      }
    }

    decorate(Foo.prototype, "add", memoFn());

    const foo = new Foo();
    const derivedA = new Derived(() => foo.add(1, 2));
    const derivedB = new Derived(() => foo.add(2, 3));
    const subA = derivedA.subscribe({});
    const subB = derivedB.subscribe({});

    trigger.set(1);

    assert.strictEqual(derivedA.get(), 3);
    assert.strictEqual(derivedB.get(), 5);
    assert.strictEqual(compute.mock.calls.length, 4);

    // Repeated reads still hit the cache
    assert.strictEqual(derivedA.get(), 3);
    assert.strictEqual(derivedB.get(), 5);
    assert.strictEqual(compute.mock.calls.length, 4);

    subA.unsubscribe();
    subB.unsubscribe();
  });

  it("provides independent caches per instance", () => {
    let callCount = 0;
    const trigger = Signal.of(0);

    class Foo {
      constructor(/** @type {number} */ base) {
        this.base = base;
      }
      add(/** @type {number} */ x) {
        trigger.get();
        callCount++;
        return this.base + x;
      }
    }

    decorate(Foo.prototype, "add", memoFn());

    const a = new Foo(10);
    const b = new Foo(20);

    const derivedA = new Derived(() => a.add(5));
    const derivedB = new Derived(() => b.add(5));
    const subA = derivedA.subscribe({});
    const subB = derivedB.subscribe({});

    trigger.set(1);

    assert.strictEqual(derivedA.get(), 15);
    assert.strictEqual(derivedB.get(), 25);
    assert.strictEqual(callCount, 4);

    subA.unsubscribe();
    subB.unsubscribe();
  });

  it("supports a custom getKey function", () => {
    const compute = mock.fn((x) => x * 2);
    const trigger = Signal.of(0);

    class Foo {
      double(/** @type {number} */ x) {
        trigger.get();
        return compute(x);
      }
    }

    // Ignore the argument, always use the same cache key
    decorate(
      Foo.prototype,
      "double",
      memoFn(() => []),
    );

    const foo = new Foo();
    const derivedA = new Derived(() => foo.double(1));
    const derivedB = new Derived(() => foo.double(99));
    const subA = derivedA.subscribe({});
    const subB = derivedB.subscribe({});

    trigger.set(1);

    // Both share the same inner Derived (same cache key []), so they hold the
    // same cached value regardless of which argument was passed.
    const first = derivedA.get();
    const second = derivedB.get();

    assert.strictEqual(first, second);
    assert.strictEqual(compute.mock.calls.length, 2);

    subA.unsubscribe();
    subB.unsubscribe();
  });
});
