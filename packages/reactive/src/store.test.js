/* eslint-env jest */
import { $autorun } from "@apendua.dev/signal";
import store from "./store.js";

test("observes value", () => {
  const state = store({ value: 1 });
  /** @type {number[]} */
  const values = [];
  $autorun(() => state.value).subscribe((value) => {
    values.push(value);
  });
  state.value = 2;
  state.value = 2;
  state.value = 3;
  expect(values).toEqual([1, 2, 3]);
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
  $autorun(() => derived.double).subscribe((value) => {
    values.push(value);
  });
  state.value = 2;
  state.value = 2;
  state.value = 3;
  expect(values).toEqual([2, 4, 6]);
});

test("nested store", () => {
  const state = store({
    nested: {
      value: 1,
    },
  });
  /** @type {number[]} */
  const values = [];
  $autorun(() => state.nested.value).subscribe((value) => {
    values.push(value);
  });
  state.nested.value = 2;
  state.nested.value = 2;
  state.nested.value = 3;
  expect(values).toEqual([1, 2, 3]);
});

test("nested store replacement", () => {
  const state = store({
    nested: {
      value: 1,
    },
  });
  /** @type {number[]} */
  const values = [];
  $autorun(() => state.nested.value).subscribe((value) => {
    values.push(value);
  });
  state.nested = { value: 2 };
  state.nested = { value: 2 };
  state.nested = { value: 3 };
  expect(values).toEqual([1, 2, 3]);
});

test("deleting property", () => {
  /** @type {{ value?: number}} */
  const state = store({
    value: 1,
  });
  /** @type {Array<number | undefined>} */
  const values = [];
  $autorun(() => state.value).subscribe((value) => {
    values.push(value);
  });
  delete state.value;
  state.value = 2;
  expect(values).toEqual([1, undefined, 2]);
});

test("has property", () => {
  /** @type {{ value?: number}} */
  const state = store({
    value: 1,
  });
  /** @type {boolean[]} */
  const values = [];
  $autorun(() => "value" in state).subscribe((hasValue) => {
    values.push(hasValue);
  });
  delete state.value;
  state.value = 2;
  expect(values).toEqual([true, false, true]);
});

test("ownKeys", () => {
  /** @type {{ a?: number; b?: number; c?: number }} */
  const state = store({
    a: 1,
    b: 2,
  });
  /** @type {Array<Array<string | symbol>>} */
  const values = [];
  $autorun(() => Reflect.ownKeys(state)).subscribe((keys) => {
    values.push(keys);
  });
  state.c = 3;
  delete state.a;
  expect(values).toEqual([
    ["a", "b"],
    ["a", "b", "c"],
    ["b", "c"],
  ]);
});
