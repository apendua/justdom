import { test } from "node:test";
import assert from "node:assert/strict";
import { observable } from "./factories.js";
import store from "./store.js";

test("observes value", () => {
  const state = store({ value: 1 });
  /** @type {number[]} */
  const values = [];
  observable(() => state.value).subscribe((value) => {
    values.push(value);
  });
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
  observable(() => derived.double).subscribe((value) => {
    values.push(value);
  });
  state.value = 2;
  state.value = 2;
  state.value = 3;
  assert.deepStrictEqual(values, [2, 4, 6]);
});

test("nested store", () => {
  const state = store({
    nested: {
      value: 1,
    },
  });
  /** @type {number[]} */
  const values = [];
  observable(() => state.nested.value).subscribe((value) => {
    values.push(value);
  });
  state.nested.value = 2;
  state.nested.value = 2;
  state.nested.value = 3;
  assert.deepStrictEqual(values, [1, 2, 3]);
});

test("nested store replacement", () => {
  const state = store({
    nested: {
      value: 1,
    },
  });
  /** @type {number[]} */
  const values = [];
  observable(() => state.nested.value).subscribe((value) => {
    values.push(value);
  });
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
  observable(() => state.value).subscribe((value) => {
    values.push(value);
  });
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
  observable(() => "value" in state).subscribe((hasValue) => {
    values.push(hasValue);
  });
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
  observable(() => Reflect.ownKeys(state)).subscribe((keys) => {
    values.push(keys);
  });
  state.c = 3;
  delete state.a;
  assert.deepStrictEqual(values, [
    ["a", "b"],
    ["a", "b", "c"],
    ["b", "c"],
  ]);
});
