/* eslint-env jest */

import { Heap } from "./Heap.js";

describe("Empty heap", function () {
  /** @type {Heap<number>} */
  let heap;

  beforeEach(function () {
    heap = new Heap((x, y) => x - y);
  });

  test("size is 0", function () {
    expect(heap.size).toEqual(0);
  });

  test("isEmpty = true", function () {
    expect(heap.isEmpty()).toEqual(true);
  });

  test("clear works", function () {
    heap.clear();
    expect(heap.size).toEqual(0);
  });

  test("throws on pop", function () {
    expect(heap.pop.bind(heap)).toThrow(/empty/);
  });

  test("throws on replace", function () {
    expect(heap.replace.bind(heap)).toThrow(/empty/);
  });
});

describe("Heap with a single element", function () {
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
    expect(heap.size).toEqual(1);
  });

  test("isEmpty = false", function () {
    expect(heap.isEmpty()).toEqual(false);
  });

  test("clear works", function () {
    heap.clear();
    expect(heap.size).toEqual(0);
  });

  test("pop returns the item", function () {
    expect(heap.pop()).toEqual(item);
  });

  test("becomes empty after pop()", function () {
    heap.pop();
    expect(heap.isEmpty()).toEqual(true);
  });
});

describe("Heap with many items", function () {
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
    expect(heap.size).toEqual(data.length);
  });

  test("returns largest item on pop()", function () {
    expect(heap.pop()).toEqual(5);
    expect(heap.pop()).toEqual(4);
    expect(heap.pop()).toEqual(3);
    expect(heap.pop()).toEqual(2);
    expect(heap.pop()).toEqual(1);
  });
});

/**
 * @typedef {Object} Item
 * @property {number} value
 */

describe("Position tracking", function () {
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
      expect(positions.get(data[i])).toEqual(i);
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
    expect(positions.get(item)).toEqual(0);
    expect(positions.get(data[0])).toEqual(1);
    expect(positions.get(data[1])).toEqual(4);
    expect(positions.get(data[2])).toEqual(2);
    expect(positions.get(data[3])).toEqual(3);
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
    expect(positions.get(item)).toEqual(0);
    expect(positions.get(data[0])).toEqual(1);
    expect(positions.get(data[1])).toEqual(3);
    expect(positions.get(data[2])).toEqual(2);
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
    expect(positions.get(item)).toEqual(3);
    expect(positions.get(data[0])).toEqual(0);
    expect(positions.get(data[2])).toEqual(2);
    expect(positions.get(data[3])).toEqual(1);
  });
});
