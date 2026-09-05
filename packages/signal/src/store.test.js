import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "./index.js";
import store, { isStore, isVolatile, replace, volatileStore } from "./store.js";

test("observes value", () => {
  const state = store({ value: 1 });
  /** @type {number[]} */
  const values = [];
  new Effect(() => {
    values.push(state.value);
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
  new Effect(() => {
    values.push(derived.double);
  });
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
  new Effect(() => {
    values.push((state.nested.x1 ?? 0) + (state.nested.x2 ?? 0));
  });
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
  new Effect(() => {
    values.push(state.nested.value);
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
  new Effect(() => {
    values.push(state.value);
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
  new Effect(() => {
    values.push("value" in state);
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
  new Effect(() => {
    values.push(Reflect.ownKeys(state));
  });
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
  new Effect(() => {
    values.push(state.absValue);
  });
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
  new Effect(() => {
    values.push(state.value);
  });
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

test("reports one write as one update, not one per dependent", () => {
  // Writing a key announces the key and the key set separately. Announcing a
  // change queues each dependent, and outside a batch a queued dependent
  // drains immediately — so without batching the pair, a computation reading
  // both would recompute twice and would see the store halfway through the
  // write on the first of them.
  /** @type {{ a?: number; b?: number }} */
  const state = store({ a: 1, b: 2 });
  /** @type {string[]} */
  const values = [];
  new Effect(() => {
    values.push(`${state.a}/${Object.keys(state).join(",")}`);
  });

  delete state.a;
  assert.deepStrictEqual(values, ["1/a,b", "undefined/b"]);
});

test("isStore tells a store from the object it was made from", () => {
  const data = { value: 1 };
  const state = store(data);
  assert.strictEqual(isStore(state), true);
  assert.strictEqual(isStore(data), false);
  assert.strictEqual(isStore({ ...state }), false);
  assert.strictEqual(isStore(null), false);
});

test("volatileStore() makes a store a hot reload should not preserve", () => {
  const state = store({ value: 1 });
  const constants = volatileStore({ value: 1 });
  assert.strictEqual(isVolatile(constants), true);
  assert.strictEqual(isVolatile(state), false);
  assert.strictEqual(isVolatile({ value: 1 }), false);
  assert.strictEqual(isVolatile(null), false);
  assert.strictEqual(isStore(constants), true, "it is a store in every other respect");
  constants.value = 2;
  assert.strictEqual(constants.value, 2, "including being writable and reactive");
});

test("replace() moves the keys that changed and leaves the rest alone", () => {
  // What a hot reload does to a store that opted out of preservation.
  const palette = volatileStore({ accent: "#f00", spacing: 8 });
  /** @type {string[]} */
  const accents = [];
  /** @type {number[]} */
  const spacings = [];
  new Effect(() => {
    accents.push(palette.accent);
  });
  new Effect(() => {
    spacings.push(palette.spacing);
  });

  replace(palette, { accent: "#0f0", spacing: 8 });
  assert.deepStrictEqual(accents, ["#f00", "#0f0"], "the reader of the changed key ran");
  assert.deepStrictEqual(spacings, [8], "the reader of the unchanged key did not");
});
