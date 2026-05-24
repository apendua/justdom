import { test } from "node:test";
import assert from "node:assert/strict";
import { Signal } from "./Signal.js";
import { NoValueError } from "./core.js";
import { observable } from "./factories.js";
import selector, { arraySelector } from "./selector.js";
import { use } from "./reactive-operators.js";

test("only triggers on relevant changes", () => {
  const source = new Signal({ value: { x: 1, y: 1 } });
  const sourceS = selector(() => source.get());
  /** @type {number[]} */
  const values = [];
  observable(() => {
    use(() => {
      values.push(sourceS.x);
    });
  }).subscribe();
  source.set({ x: 1, y: 2 });
  source.set({ x: 2, y: 2 });
  source.set({ x: 2, y: 3 });
  source.set({ x: 3, y: 3 });
  assert.deepStrictEqual(values, [1, 2, 3]);
});

test("supports nested fields", () => {
  const source = new Signal({ value: { x: { a: 1 }, y: 1 } });
  const sourceS = selector(() => source.get());
  /** @type {number[]} */
  const values = [];
  observable(() => {
    use(() => {
      values.push(sourceS.x.a);
    });
  }).subscribe();
  source.set({ x: { a: 1 }, y: 2 });
  source.set({ x: { a: 2 }, y: 2 });
  source.set({ x: { a: 2 }, y: 3 });
  source.set({ x: { a: 3 }, y: 3 });
  assert.deepStrictEqual(values, [1, 2, 3]);
});

test("shallow copy of object properties", () => {
  /** @type {Signal<TestObject>} */
  const source = new Signal({ value: /** @type {TestObject} */ ({ x: 1, y: 1 }) });
  const sourceS = selector(() => source.get());

  /** @type {TestObject[]} */
  const history = [];

  observable(() => {
    use(() => {
      history.push({ ...sourceS });
    });
  }).subscribe();

  source.set({ x: 1, y: 2 });
  source.set({ x: 2, y: 2 });
  source.set({ x: 2, y: 2 });
  source.set({ x: 3 });

  assert.deepStrictEqual(history, [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3 }]);
});

/**
 * @typedef {object} TestObject
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [z]
 */

test("supports Object.entries iterator", () => {
  const value = /** @type {TestObject} */ ({});
  const source = new Signal({ value });
  const sourceS = selector(() => source.get());
  /** @type {Array<Array<[string, number]>>} */
  const entries = [];
  observable(() => {
    use(() => {
      entries.push(Array.from(Object.entries(sourceS)));
    });
  }).subscribe();
  source.set({ x: 1, y: 2, z: 3 });
  source.set({ x: 2, y: 2, z: 3 });
  source.set({ x: 2, y: 3 });
  source.set({ x: 3 });
  assert.deepStrictEqual(entries, [
    [],
    [
      ["x", 1],
      ["y", 2],
      ["z", 3],
    ],
    [
      ["x", 2],
      ["y", 2],
      ["z", 3],
    ],
    [
      ["x", 2],
      ["y", 3],
    ],
    [["x", 3]],
  ]);
});

test("enumerates object keys with for ... in", () => {
  const value = /** @type {TestObject} */ ({});
  const source = new Signal({ value });
  const sourceS = selector(() => source.get());
  /** @type {string[][]} */
  const keys = [];
  observable(() => {
    use(() => {
      const ownKeys = [];
      for (const key in sourceS) {
        ownKeys.push(key);
      }
      keys.push(ownKeys);
    });
  }).subscribe();
  source.set({ x: 1, y: 2, z: 3 });
  source.set({ x: 2, y: 2, z: 3 });
  source.set({ x: 2, y: 3 });
  source.set({ x: 3 });
  assert.deepStrictEqual(keys, [[], ["x", "y", "z"], ["x", "y"], ["x"]]);
});

test("supports Object.keys", () => {
  const value = /** @type {TestObject} */ ({});
  const source = new Signal({ value });
  const sourceS = selector(() => source.get());
  /** @type {PropertyKey[][]} */
  const keys = [];
  observable(() => {
    use(() => {
      keys.push(Object.keys(sourceS));
    });
  }).subscribe();
  source.set({ x: 1, y: 2, z: 3 });
  source.set({ x: 2, y: 2, z: 3 });
  source.set({ x: 2, y: 3 });
  source.set({ x: 3 });
  assert.deepStrictEqual(keys, [[], ["x", "y", "z"], ["x", "y"], ["x"]]);
});

test("supports array", () => {
  /** @type {number[]} */
  const value = [];
  const source = new Signal({ value });
  const sourceS = arraySelector(() => source.get());
  assert.ok(Array.isArray(sourceS));
  assert.ok(sourceS instanceof Array);
  assert.ok(sourceS.every(() => true));
  assert.equal(sourceS.length, 0);
});

test("shallow copy of array elements", () => {
  /** @type {number[]} */
  const value = [];
  const source = new Signal({ value });
  const sourceS = arraySelector(() => source.get());

  /** @type {number[][]} */
  const history = [];

  observable(() => {
    use(() => {
      history.push([...sourceS]);
    });
  }).subscribe();

  source.set([1, 2, 3]);
  source.set([1, 2, 3]);
  source.set([2, 2, 3]);
  source.set([2, 3]);
  source.set([3]);

  assert.deepStrictEqual(history, [[], [1, 2, 3], [2, 2, 3], [2, 3], [3]]);
});

test("supports array index lookup", () => {
  /** @type {number[]} */
  const value = [];
  const source = new Signal({ value });
  const sourceS = arraySelector(() => source.get());
  /** @type {number[]} */
  const values = [];
  observable(() => {
    use(() => {
      if (sourceS[0] === undefined) {
        throw new NoValueError("Array is empty");
      }
      values.push(sourceS[0]);
    });
  }).subscribe();
  source.set([1, 2, 3]);
  source.set([1, 2, 3]);
  source.set([2, 2, 3]);
  source.set([2, 3]);
  source.set([3]);
  assert.deepStrictEqual(values, [1, 2, 3]);
});

test("supports Object.keys on array", () => {
  /** @type {number[]} */
  const value = [];
  const source = new Signal({ value });
  const sourceS = arraySelector(() => source.get());
  /** @type {PropertyKey[][]} */
  const keys = [];
  observable(() => {
    use(() => {
      keys.push(Object.keys(sourceS));
    });
  }).subscribe();
  source.set([1, 2, 3]);
  source.set([1, 2, 3]);
  source.set([2, 2, 3]);
  source.set([2, 3]);
  source.set([3]);
  assert.deepStrictEqual(keys, [[], ["0", "1", "2"], ["0", "1"], ["0"]]);
});

test("supports array for ... of iteration", () => {
  /** @type {number[]} */
  const value = [];
  const source = new Signal({ value });
  const sourceS = arraySelector(() => source.get());
  /** @type {number[][]} */
  const history = [];
  observable(() => {
    use(() => {
      /** @type {number[]} */
      const numbers = [];
      for (const x of sourceS) {
        numbers.push(x);
      }
      history.push(numbers);
    });
  }).subscribe();
  source.set([1, 2, 3]);
  source.set([1, 2, 3]);
  source.set([2, 2, 3]);
  source.set([2, 3]);
  source.set([3]);
  assert.deepStrictEqual(history, [[], [1, 2, 3], [2, 2, 3], [2, 3], [3]]);
});

test("supports array for ... in iteration", () => {
  /** @type {number[]} */
  const value = [];
  const source = new Signal({ value });
  const sourceS = arraySelector(() => source.get());
  /** @type {number[][]} */
  const history = [];
  observable(() => {
    use(() => {
      /** @type {number[]} */
      const values = [];
      for (const i in sourceS) {
        values.push(sourceS[i]);
      }
      history.push(values);
    });
  }).subscribe();
  source.set([1, 2, 3]);
  source.set([1, 2, 3]);
  source.set([2, 2, 3]);
  source.set([2, 3]);
  source.set([3]);
  assert.deepStrictEqual(history, [[], [1, 2, 3], [2, 2, 3], [2, 3], [3]]);
});

test("supports Array.forEach", () => {
  /** @type {number[]} */
  const value = [];
  const source = new Signal({ value });
  const sourceS = arraySelector(() => source.get());
  /** @type {number[][]} */
  const history = [];
  observable(() => {
    use(() => {
      /** @type {number[]} */
      const numbers = [];
      sourceS.forEach((x) => {
        numbers.push(x);
      });
      history.push(numbers);
    });
  }).subscribe();
  source.set([1, 2, 3]);
  source.set([1, 2, 3]);
  source.set([2, 2, 3]);
  source.set([2, 3]);
  source.set([3]);
  assert.deepStrictEqual(history, [[], [1, 2, 3], [2, 2, 3], [2, 3], [3]]);
});

test("supports array length property", () => {
  /** @type {number[]} */
  const value = [];
  const source = new Signal({ value });
  const sourceS = arraySelector(() => source.get());
  /** @type {number[]} */
  const lengths = [];
  observable(() => {
    use(() => {
      lengths.push(sourceS.length);
    });
  }).subscribe();
  source.set([1, 2, 3]);
  source.set([1, 2, 3]);
  source.set([2, 2, 3]);
  source.set([2, 3]);
  source.set([3]);
  assert.deepStrictEqual(lengths, [0, 3, 2, 1]);
});
