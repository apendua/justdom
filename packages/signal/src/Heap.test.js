import { suite, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { Heap } from "./Heap.js";

suite("Empty heap", function () {
  /** @type {Heap<number>} */
  let heap;

  beforeEach(function () {
    heap = new Heap((x, y) => x - y);
  });

  test("size is 0", function () {
    assert.deepStrictEqual(heap.size, 0);
  });

  test("isEmpty = true", function () {
    assert.deepStrictEqual(heap.isEmpty(), true);
  });

  test("clear works", function () {
    heap.clear();
    assert.deepStrictEqual(heap.size, 0);
  });

  test("throws on pop", function () {
    assert.throws(heap.pop.bind(heap), /empty/);
  });

  test("throws on replace", function () {
    assert.throws(() => heap.replace(0), /empty/);
  });
});

suite("Heap with a single element", function () {
  /** @type {Heap<number>} */
  let heap;
  /** @type {number} */
  let item;

  beforeEach(function () {
    heap = new Heap((x, y) => x - y);
    item = Math.random();
    heap.insert(item);
  });

  test("size = 1", function () {
    assert.deepStrictEqual(heap.size, 1);
  });

  test("isEmpty = false", function () {
    assert.deepStrictEqual(heap.isEmpty(), false);
  });

  test("clear works", function () {
    heap.clear();
    assert.deepStrictEqual(heap.size, 0);
  });

  test("pop returns the item", function () {
    assert.deepStrictEqual(heap.pop(), item);
  });

  test("becomes empty after pop()", function () {
    heap.pop();
    assert.deepStrictEqual(heap.isEmpty(), true);
  });
});

suite("Heap with many items", function () {
  /** @type {number[]} */
  let data;
  /** @type {Heap<number>} */
  let heap;

  beforeEach(function () {
    data = [2, 4, 1, 5, 3];
    heap = new Heap((x, y) => x - y);
    heap.initialize(data);
  });

  test("returns correct size", function () {
    assert.deepStrictEqual(heap.size, data.length);
  });

  test("returns largest item on pop()", function () {
    assert.deepStrictEqual(heap.pop(), 5);
    assert.deepStrictEqual(heap.pop(), 4);
    assert.deepStrictEqual(heap.pop(), 3);
    assert.deepStrictEqual(heap.pop(), 2);
    assert.deepStrictEqual(heap.pop(), 1);
  });
});

/**
 * @typedef {Object} Item
 * @property {number} value
 */

suite("Position tracking", function () {
  /** @type {Item[]} */
  let data;
  /** @type {Heap<Item>} */
  let heap;

  /** @type {WeakMap<Item, number>} */
  const positions = new WeakMap();

  /**
   * @param {Item} a
   * @param {Item} b
   */
  function cmp(a, b) {
    return a.value - b.value;
  }

  /**
   * @param {Item} item
   * @param {number} i
   */
  function onMove(item, i) {
    positions.set(item, i);
  }

  beforeEach(function () {
    data = [
      {
        value: 4,
      },
      {
        value: 3,
      },
      {
        value: 2,
      },
      {
        value: 1,
      },
    ];
    heap = new Heap(cmp, { onMove });
    heap.initialize(data);
  });

  test("records current position of each element", function () {
    // NOTE: data is already has the heap property, so in fact
    //       the positions are initially unchanged
    for (let i = 0; i < data.length; i += 1) {
      assert.deepStrictEqual(positions.get(data[i]), i);
    }
  });

  test("maintains up-to-date position on insert", function () {
    const item = {
      value: 5,
    };
    heap.insert(item);
    //     4
    //    / \
    //   3   2
    //  / \
    // 1   5
    // ~~~~~~~~~
    //     5
    //    / \
    //   4   2
    //  / \
    // 1   3
    assert.deepStrictEqual(positions.get(item), 0);
    assert.deepStrictEqual(positions.get(data[0]), 1);
    assert.deepStrictEqual(positions.get(data[1]), 4);
    assert.deepStrictEqual(positions.get(data[2]), 2);
    assert.deepStrictEqual(positions.get(data[3]), 3);
  });

  test("replaces element at given position with element of larger value", function () {
    const item = {
      value: 5,
    };
    heap.replace(item, positions.get(data[3]));
    //     4
    //    / \
    //   3   2
    //  /
    // 5
    // ~~~~~~~~~
    //     5
    //    / \
    //   4   2
    //  /
    // 3
    assert.deepStrictEqual(positions.get(item), 0);
    assert.deepStrictEqual(positions.get(data[0]), 1);
    assert.deepStrictEqual(positions.get(data[1]), 3);
    assert.deepStrictEqual(positions.get(data[2]), 2);
  });

  test("replaces element at given position with element of lower value", function () {
    const item = {
      value: 0,
    };
    heap.replace(item, positions.get(data[1]));
    //     4
    //    / \
    //   0   2
    //  /
    // 1
    // ~~~~~~~~~
    //     4
    //    / \
    //   1   2
    //  /
    // 0
    assert.deepStrictEqual(positions.get(item), 3);
    assert.deepStrictEqual(positions.get(data[0]), 0);
    assert.deepStrictEqual(positions.get(data[2]), 2);
    assert.deepStrictEqual(positions.get(data[3]), 1);
  });
});
