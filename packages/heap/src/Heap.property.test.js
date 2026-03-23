import { test } from "node:test";
import assert from "node:assert/strict";

import * as fc from "fast-check";
import { Heap, sortBy } from "./Heap.js";

/** Simple numeric comparison function
 * @param {number} x
 * @param {number} y
 */
function cmp(x, y) {
  return x - y;
}

test("sorts a random array of numbers", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer(), {
        maxLength: 10000,
      }),
      (array) => {
        const array1 = array.slice();
        const array2 = array.slice();

        array1.sort(cmp);
        sortBy(array2, cmp);

        assert.deepStrictEqual(array1, array2);
      },
    ),
  );
});

/**
 * @template T
 * @param {(x: T, y: T) => number} cmp
 */
function createMemory(cmp) {
  /** @type {T[]} */
  const memory = [];
  /**
   * @param {T} value
   * @param {number} i
   */
  function onMove(value, i) {
    memory[i] = value;
  }
  function validate() {
    for (let i = 0; i < memory.length; i += 1) {
      const l = 2 * i + 1;
      const r = 2 * i + 1;
      if (l < memory.length) {
        assert.ok(cmp(memory[i], memory[l]) >= 0);
      }
      if (r < memory.length) {
        assert.ok(cmp(memory[i], memory[r]) >= 0);
      }
    }
  }
  return {
    onMove,
    memory,
    validate,
  };
}

test("initializes with heap property", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer(), {
        maxLength: 100,
      }),
      (array) => {
        const { onMove, validate } = createMemory(cmp);
        Heap.fromArray(array, cmp, { onMove });
        validate();
      },
    ),
  );
});

test("maintains heap property after insert()", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer(), {
        maxLength: 100,
      }),
      fc.integer(),
      (array, value) => {
        const { onMove, validate } = createMemory(cmp);
        const heap = Heap.fromArray(array, cmp, { onMove });
        heap.insert(value);
        validate();
      },
    ),
  );
});

test("maintains heap property after pop()", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer(), {
        maxLength: 100,
      }),
      (array) => {
        const { onMove, memory, validate } = createMemory(cmp);
        const heap = Heap.fromArray(array, cmp, { onMove });
        if (!heap.isEmpty()) {
          heap.pop();
          memory.pop();
        }
        validate();
      },
    ),
  );
});

test("maintains heap property after replace()", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer(), {
        maxLength: 100,
      }),
      fc.integer(),
      (array, value) => {
        const { onMove, memory, validate } = createMemory(cmp);
        const heap = Heap.fromArray(array, cmp, { onMove });
        if (!heap.isEmpty()) {
          const i = (memory.length - 1) >> 1;
          heap.replace(value, i);
        }
        validate();
      },
    ),
  );
});
