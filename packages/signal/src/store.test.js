import { test } from "node:test";
import assert from "node:assert/strict";
import { observable } from "./factories.js";
import store, { replace } from "./store.js";
import { use } from "./reactive-operators.js";

test("observes value", () => {
  const state = store({ value: 1 });
  /** @type {number[]} */
  const values = [];
  observable(() => {
    use(() => {
      values.push(state.value);
    });
  }).subscribe();
  state.value = 2;
  state.value = 2;
  state.value = 3;
  assert.deepStrictEqual(values, [1, 2, 3]);
});

test("observes derived value", () => {
  const state = store({ value: 1 });
  const derived = {
    get double() {
      return state.value * 2;
    },
  };
  /** @type {number[]} */
  const values = [];
  observable(() => {
    use(() => {
      values.push(derived.double);
    });
  }).subscribe();
  state.value = 2;
  state.value = 2;
  state.value = 3;
  assert.deepStrictEqual(values, [2, 4, 6]);
});

test("nested store", () => {
  /** @type {{ nested: { x1?: number, x2?: number }}} */
  const state = store({
    nested: {
      x1: 1,
      x2: 1,
    },
  });
  /** @type {(number | undefined)[]} */
  const values = [];
  observable(() => {
    use(() => {
      values.push((state.nested.x1 ?? 0) + (state.nested.x2 ?? 0));
    });
  }).subscribe();
  state.nested.x1 = 2;
  state.nested.x1 = 2;
  state.nested.x1 = 3;
  state.nested = { x1: 3, x2: 4 };
  state.nested = { x1: 7 };
  state.nested = { x1: 4 };
  state.nested = {};
  assert.deepStrictEqual(values, [2, 3, 4, 7, 7, 4, 0]);
});

test("nested store replacement", () => {
  const state = store({
    nested: {
      value: 1,
    },
  });
  /** @type {number[]} */
  const values = [];
  observable(() => {
    use(() => {
      values.push(state.nested.value);
    });
  }).subscribe();
  state.nested = { value: 2 };
  state.nested = { value: 2 };
  state.nested = { value: 3 };
  assert.deepStrictEqual(values, [1, 2, 3]);
});

test("deleting property", () => {
  /** @type {{ value?: number}} */
  const state = store({
    value: 1,
  });
  /** @type {Array<number | undefined>} */
  const values = [];
  observable(() => {
    use(() => {
      values.push(state.value);
    });
  }).subscribe();
  delete state.value;
  state.value = 2;
  assert.deepStrictEqual(values, [1, undefined, 2]);
});

test("has property", () => {
  /** @type {{ value?: number}} */
  const state = store({
    value: 1,
  });
  /** @type {boolean[]} */
  const values = [];
  observable(() => {
    use(() => {
      values.push("value" in state);
    });
  }).subscribe();
  delete state.value;
  state.value = 2;
  assert.deepStrictEqual(values, [true, false, true]);
});

test("ownKeys", () => {
  /** @type {{ a?: number; b?: number; c?: number }} */
  const state = store({
    a: 1,
    b: 2,
  });
  /** @type {Array<Array<string | symbol>>} */
  const values = [];
  observable(() => {
    use(() => {
      values.push(Reflect.ownKeys(state));
    });
  }).subscribe();
  state.c = 3;
  delete state.a;
  replace(state, { a: 1 });
  assert.deepStrictEqual(values, [["a", "b"], ["a", "b", "c"], ["b", "c"], ["a"]]);
});

test("custom getters", () => {
  const state = store({
    value: 1,
    get absValue() {
      return Math.abs(this.value);
    },
  });
  /** @type {number[]} */
  const values = [];
  observable(() => {
    use(() => {
      values.push(state.absValue);
    });
  }).subscribe();
  state.value = -1;
  state.value = 2;
  state.value = -2;
  state.value = 3;
  state.value = -3;
  assert.deepStrictEqual(values, [1, 2, 3]);
});

test("custom setters", () => {
  const state = store({
    value: 1,
    get doubleValue() {
      return this.value * 2;
    },
    set doubleValue(newValue) {
      this.value = newValue / 2;
    },
  });
  /** @type {number[]} */
  const values = [];
  observable(() => {
    use(() => {
      values.push(state.value);
    });
  }).subscribe();
  state.doubleValue = 4;
  state.doubleValue = 4;
  state.doubleValue = 6;
  assert.deepStrictEqual(values, [1, 2, 3]);
});

test("non-plain object", () => {
  assert.throws(() => {
    store(new Date());
  }, /can only be created from a plain object/);
});
