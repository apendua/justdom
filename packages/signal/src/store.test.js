import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "./index.js";
import { set } from "./operators.js";
import { NoValueError } from "./core.js";
import selector from "./selector.js";
import store, { emit, isStore, replace, reshape, trackWrites } from "./store.js";

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

test("a write to a getter-only key does nothing", () => {
  const palette = store({ amber: "amber" });
  const state = store({
    get color() {
      return palette.amber;
    },
  });
  /** @type {string[]} */
  const values = [];
  new Effect(() => {
    values.push(state.color);
  });
  // @ts-expect-error A getter-only key is readonly.
  state.color = "ivory";
  palette.amber = "orange";
  assert.deepStrictEqual(values, ["amber", "orange"]);
});

test("set() takes no getter-only key", () => {
  const state = store({
    value: 1,
    get double() {
      return this.value * 2;
    },
  });
  /** @param {import("./types.js").EntityEffect<typeof state>} effect */
  const apply = (effect) => effect(state, /** @type {never} */ ({}));
  // @ts-expect-error `double` is readonly, so it is not one of `set`'s keys.
  apply(set({ double: 10 }));
  apply(set({ value: 2 }));
  assert.strictEqual(state.double, 4);
});

test("replace() writes through a setter and leaves a getter-only key computed", () => {
  /** @type {number[]} */
  const written = [];
  /**
   * @param {number} w
   * @param {number} h
   */
  const settable = (w, h) => ({
    w,
    h,
    /** @returns {number} */
    get area() {
      return this.w * this.h;
    },
    /** @param {number} value */
    set area(value) {
      written.push(value);
    },
  });
  /**
   * @param {number} w
   * @param {number} h
   */
  const computed = (w, h) => ({
    w,
    h,
    /** @returns {number} */
    get area() {
      return this.w * this.h;
    },
  });
  const a = store({ size: settable(1, 2) });
  a.size = settable(3, 4);
  assert.deepStrictEqual(written, [12]);
  a.size.w = 5;
  assert.strictEqual(a.size.area, 20);

  const b = store({ size: computed(1, 2) });
  b.size = computed(3, 4);
  b.size.w = 5;
  assert.strictEqual(b.size.area, 20);
});

test("replace() reads a getter of the new value", () => {
  const palette = store({ amber: "amber" });
  const state = store({ size: 1, label: "a" });
  replace(state, {
    size: 2,
    get label() {
      return palette.amber;
    },
  });
  palette.amber = "orange";
  assert.strictEqual(state.size, 2);
  assert.strictEqual(state.label, "amber");
});

/**
 * A theme's definition, as a module would evaluate it: a fresh object, with
 * fresh getter functions, each time.
 *
 * @param {{ amber: string, ivory: string }} palette
 * @param {"amber" | "ivory"} accent
 * @param {number} spacing
 */
function theme(palette, accent, spacing) {
  return {
    spacing,
    get accent() {
      return palette[accent];
    },
    nested: {
      get border() {
        return palette[accent];
      },
    },
  };
}

test("a hot reload moves getters and values", () => {
  const palette = store({ amber: "amber", ivory: "ivory" });
  const kept = store(theme(palette, "amber", 8));
  /** @type {unknown[]} */
  const values = [];
  new Effect(() => {
    values.push(`${kept.accent}/${kept.nested.border}/${kept.spacing}`);
  });
  reshape(kept, store(theme(palette, "ivory", 12)));
  palette.ivory = "white";
  palette.amber = "orange";
  assert.deepStrictEqual(values, ["amber/amber/8", "ivory/ivory/12", "white/white/12"]);
});

test("reshape() drops the keys the definition no longer has", () => {
  const state = store(/** @type {{ a: number, b?: number }} */ ({ a: 1, b: 2 }));
  /** @type {unknown[]} */
  const keys = [];
  new Effect(() => {
    keys.push(Object.keys(state).join(","));
  });
  reshape(state, { a: 1 });
  assert.deepStrictEqual(keys, ["a,b", "a"]);
});

test("reshape() turns data into a getter and back", () => {
  const palette = store({ amber: "amber" });
  const state = store(/** @type {{ color?: string }} */ ({ color: "ivory" }));
  /** @type {unknown[]} */
  const values = [];
  new Effect(() => {
    values.push(state.color);
  });
  const computed = {
    get color() {
      return palette.amber;
    },
  };
  reshape(state, computed);
  palette.amber = "orange";
  reshape(state, { color: "ivory" });
  palette.amber = "yellow";
  assert.deepStrictEqual(values, ["ivory", "amber", "orange", "ivory"]);
});

test("reshape() with the same definition re-runs nothing", () => {
  const definition = theme(store({ amber: "amber", ivory: "ivory" }), "amber", 8);
  const state = store(definition);
  let runs = 0;
  new Effect(() => {
    runs += 1;
    void state.accent;
  });
  reshape(state, definition);
  assert.strictEqual(runs, 1);
});

test("reshape() keeps what was written and takes the definition's shape", () => {
  const kept = store(/** @type {{ x: number, y?: number }} */ ({ x: 1, y: 2 }));
  trackWrites(kept);
  kept.x = 5;
  const definition = {
    x: 1,
    z: 3,
    get sum() {
      return this.x + this.z;
    },
  };
  reshape(kept, definition);
  const shaped = /** @type {{ x: number, z: number, readonly sum: number }} */ (
    /** @type {unknown} */ (kept)
  );
  assert.strictEqual(shaped.x, 5, "a data key both have keeps what was written");
  assert.strictEqual("y" in kept, false, "a key the definition no longer has goes");
  assert.strictEqual(shaped.z, 3, "a key the definition adds takes its value");
  assert.strictEqual(shaped.sum, 8, "a getter the definition adds reads the kept value");
});

test("reshape() takes the definition in full for an untracked store", () => {
  const kept = /** @type {any} */ (
    store({
      a: 1,
      b: { n: 1 },
      get c() {
        return 1;
      },
      d: 4,
    })
  );
  kept.a = 9;
  kept.b.n = 7;
  kept.d = 8;
  reshape(kept, {
    a: { n: 1 },
    b: 2,
    c: 3,
    get d() {
      return 5;
    },
  });
  assert.ok(isStore(kept.a), "a written value that becomes a plain object takes the definition's");
  assert.deepStrictEqual({ ...kept.a }, { n: 1 });
  assert.strictEqual(kept.b, 2, "a written store that becomes a value takes the definition's");
  assert.strictEqual(kept.c, 3, "a getter that becomes a data key takes the definition's value");
  assert.strictEqual(kept.d, 5, "a data key that becomes a getter reads the getter");
  assert.ok(Object.hasOwn(kept, "d"), "and stays a key of the store");
  assert.strictEqual(Object.getOwnPropertyDescriptor(kept, "d")?.value, undefined);
});

test("reshape() reshapes a nested store in place", () => {
  const kept = /** @type {any} */ (store({ layout: { width: 1, height: 2 } }));
  trackWrites(kept);
  const nested = kept.layout;
  kept.layout.width = 10;
  const layout = {
    width: 1,
    depth: 3,
    get area() {
      return this.width * this.depth;
    },
  };
  reshape(kept, { layout });
  assert.strictEqual(kept.layout, nested, "the nested store is the same object");
  assert.strictEqual(kept.layout.width, 10, "what was written to it stays");
  assert.strictEqual("height" in kept.layout, false, "a key gone from the definition goes");
  assert.strictEqual(kept.layout.depth, 3);
  assert.strictEqual(kept.layout.area, 30);
});

test("reshape() re-runs no reader of a kept value", () => {
  const kept = store({ x: 1, y: 2 });
  trackWrites(kept);
  kept.x = 5;
  /** @type {number[]} */
  const xs = [];
  /** @type {number[]} */
  const ys = [];
  new Effect(() => {
    xs.push(kept.x);
  });
  new Effect(() => {
    ys.push(kept.y);
  });
  reshape(kept, {
    x: 1,
    get y() {
      return 3;
    },
  });
  assert.deepStrictEqual(xs, [5], "the reader of the kept key did not run");
  assert.deepStrictEqual(ys, [2, 3], "the reader of the key that gained a getter did");
});

test("reshape() keeps a written key once trackWrites() records it", () => {
  const untracked = store({ accent: "amber" });
  untracked.accent = "ivory";
  reshape(untracked, { accent: "amber" });
  assert.strictEqual(untracked.accent, "amber", "nothing recorded, so the definition wins");
  const tracked = store({ accent: "amber", spacing: 8 });
  trackWrites(tracked);
  tracked.accent = "ivory";
  reshape(tracked, { accent: "amber", spacing: 12 });
  assert.strictEqual(tracked.accent, "ivory", "the written key keeps the program's value");
  assert.strictEqual(tracked.spacing, 12, "an untouched key takes the edited initial value");
});

test("writes before trackWrites() are not recorded", () => {
  const kept = store({ x: 1 });
  kept.x = 5;
  trackWrites(kept);
  reshape(kept, { x: 2 });
  assert.strictEqual(kept.x, 2);
});

test("a key the program added stays, and one it deleted stays deleted", () => {
  const kept = /** @type {any} */ (store({ x: 1, y: 2 }));
  trackWrites(kept);
  kept.z = 3;
  delete kept.y;
  reshape(kept, { x: 1, y: 2 });
  assert.strictEqual(kept.z, 3, "the program's key stays");
  assert.strictEqual("y" in kept, false, "the program's delete stays");
  assert.deepStrictEqual(Reflect.ownKeys(kept), ["x", "z"]);
});

test("a written key that gains a getter follows it, and is the source's again", () => {
  const kept = /** @type {any} */ (store({ x: 1 }));
  trackWrites(kept);
  kept.x = 5;
  reshape(kept, {
    get x() {
      return 7;
    },
  });
  assert.strictEqual(kept.x, 7, "the shape wins over the program's write");
  reshape(kept, { x: 1 });
  assert.strictEqual(kept.x, 1, "as a data key again, it takes the definition's value");
});

test("a write to a getter key marks nothing", () => {
  const kept = /** @type {any} */ (
    store({
      get x() {
        return 1;
      },
    })
  );
  trackWrites(kept);
  kept.x = 9;
  reshape(kept, { x: 2 });
  assert.strictEqual(kept.x, 2);
});

test("an object the program assigns is the program's, key by key", () => {
  const kept = /** @type {any} */ (store({ a: 1 }));
  trackWrites(kept);
  kept.a = { n: 1, m: 2 };
  reshape(kept, {
    a: {
      n: 5,
      get sum() {
        return kept.a.n + kept.a.m;
      },
    },
  });
  assert.strictEqual(kept.a.n, 1, "a key the program wrote stays");
  assert.strictEqual(kept.a.m, 2, "a key the definition lacks stays");
  assert.strictEqual(kept.a.sum, 3, "a getter the definition adds reads them");
  reshape(kept, { a: 7 });
  assert.ok(isStore(kept.a), "the program's object stays where the definition has a value");
});

test("an object assigned over a nested store marks the keys it changes", () => {
  const kept = /** @type {any} */ (store({ layout: { width: 1, height: 2 } }));
  trackWrites(kept);
  const nested = kept.layout;
  kept.layout = { width: 10, height: 2 };
  assert.strictEqual(kept.layout, nested, "assigned into the store the key holds");
  reshape(kept, { layout: { width: 3, height: 4 } });
  assert.strictEqual(kept.layout.width, 10, "a key that changed is the program's");
  assert.strictEqual(kept.layout.height, 4, "one it left as it was is the source's");
  reshape(kept, { layout: 5 });
  assert.strictEqual(kept.layout, 5, "and so is the key it sits at, which holds the same store");
});

test("an object assignment that changes nothing marks nothing", () => {
  const kept = /** @type {any} */ (store({ layout: { width: 1, height: 2 } }));
  trackWrites(kept);
  kept.layout = { width: 1, height: 2 };
  reshape(kept, { layout: { width: 3, height: 4 } });
  assert.deepStrictEqual({ ...kept.layout }, { width: 3, height: 4 });
  reshape(kept, {});
  assert.strictEqual("layout" in kept, false);
});

test("a key an assigned object holds undefined for is not the program's", () => {
  const kept = /** @type {any} */ (store({ layout: { width: 1 } }));
  trackWrites(kept);
  kept.layout = { width: 1, depth: undefined };
  assert.deepStrictEqual(Reflect.ownKeys(kept.layout), ["width"]);
  reshape(kept, { layout: { width: 1, depth: 3 } });
  assert.strictEqual(kept.layout.depth, 3, "the source adds the key");
});

test("a store the definition adds records writes like its parent", () => {
  const kept = /** @type {any} */ (store({ x: 1 }));
  trackWrites(kept);
  reshape(kept, { x: 1, layout: { width: 1 } });
  kept.layout.width = 10;
  reshape(kept, { x: 1, layout: { width: 2 } });
  assert.strictEqual(kept.layout.width, 10);
});

test("a second trackWrites() keeps the marks", () => {
  const kept = store({ x: 1 });
  trackWrites(kept);
  kept.x = 5;
  trackWrites(kept);
  reshape(kept, { x: 1 });
  assert.strictEqual(kept.x, 5);
});

test("a write that changes nothing marks nothing", () => {
  const kept = store({ x: 1 });
  trackWrites(kept);
  kept.x = kept.x;
  reshape(kept, { x: 2 });
  assert.strictEqual(kept.x, 2);
});

test("a delete of a key the store does not have marks nothing", () => {
  const kept = /** @type {any} */ (store({ x: 1 }));
  trackWrites(kept);
  delete kept.z;
  reshape(kept, { x: 1, z: 3 });
  assert.strictEqual(kept.z, 3);
});

test("trackWrites() on the parent keeps the marks of a nested store tracked first", () => {
  const kept = /** @type {any} */ (store({ layout: { width: 1 } }));
  trackWrites(kept.layout);
  kept.layout.width = 10;
  trackWrites(kept);
  reshape(kept, { layout: { width: 2 } });
  assert.strictEqual(kept.layout.width, 10);
});

test("a nested store's key is the source's, whatever was written into it", () => {
  const kept = /** @type {any} */ (store({ layout: { width: 1 }, x: 1 }));
  trackWrites(kept);
  kept.layout.width = 10;
  reshape(kept, { x: 1 });
  assert.strictEqual("layout" in kept, false, "a key the definition drops goes, with the store");
  const other = /** @type {any} */ (store({ layout: { width: 1 } }));
  trackWrites(other);
  other.layout.width = 10;
  reshape(other, { layout: 5 });
  assert.strictEqual(other.layout, 5, "a key the definition makes a value takes it");
});

test("a container mutated in place is untouched and takes the definition's", () => {
  const kept = store({ players: new Map(), x: 1 });
  trackWrites(kept);
  kept.players.set("a", 1);
  const next = new Map();
  reshape(kept, { players: next, x: 1 });
  assert.strictEqual(kept.players, next, "the Map filled in place is replaced");
  kept.players = new Map([["b", 2]]);
  reshape(kept, { players: new Map(), x: 1 });
  assert.deepStrictEqual([...kept.players], [["b", 2]], "the Map assigned through the store stays");
});

test("reshape() takes a store", () => {
  // @ts-expect-error A plain object is not a store, which the type says.
  assert.throws(() => reshape({}, {}), /reshape\(\) takes a store/);
});

test("trackWrites() takes a store", () => {
  // @ts-expect-error A plain object is not a store, which the type says.
  assert.throws(() => trackWrites({}), /trackWrites\(\) takes a store/);
});

test("a data key turned into a getter lets go of its value", () => {
  const kept = store({ n: { a: 1 } });
  reshape(kept, {
    get n() {
      return 5;
    },
  });
  assert.strictEqual(kept.n, 5);
  assert.strictEqual(Object.getOwnPropertyDescriptor(kept, "n")?.value, undefined);
});

test("store() runs no getter and holds undefined for its key", () => {
  let runs = 0;
  const built = store({
    get g() {
      runs += 1;
      return { z: 1 };
    },
  });
  assert.strictEqual(runs, 0);
  assert.strictEqual(Object.getOwnPropertyDescriptor(built, "g")?.value, undefined);
  assert.deepStrictEqual(built.g, { z: 1 });
  assert.strictEqual(runs, 1);
});

test("reshape() writes a data key to state and runs no setter", () => {
  /** @type {unknown[]} */
  const written = [];
  const kept = store({
    x: 1,
    set y(/** @type {unknown} */ value) {
      written.push(value);
    },
  });
  reshape(kept, { x: 2, y: 3 });
  assert.deepStrictEqual(written, []);
  assert.strictEqual(kept.x, 2);
  assert.strictEqual(/** @type {any} */ (kept).y, 3);
});

test("reshape() from a store keeps what was written to it", () => {
  /** @param {number} width */
  const define = (width) => {
    const theme = store({ width: 0 });
    theme.width = width;
    return theme;
  };
  const kept = define(10);
  reshape(kept, define(20));
  assert.strictEqual(kept.width, 20);

  const palette = store({ amber: "amber" });
  palette.amber = "orange";
  const holder = store({ palette, x: 1 });
  reshape(holder, store({ palette, x: 2 }));
  assert.strictEqual(holder.palette.amber, "orange");
});

test("reshape() re-runs no reader of another store", () => {
  const other = store({
    get list() {
      return [1];
    },
  });
  let runs = 0;
  new Effect(() => {
    runs += 1;
    void other.list;
  });
  const kept = store({
    get x() {
      return 1;
    },
  });
  void kept.x;
  reshape(kept, {
    get x() {
      return 1;
    },
  });
  assert.strictEqual(runs, 1);
});

test("a store at a new key keeps its getters", () => {
  const palette = store({ amber: "amber" });
  const inner = store({
    get color() {
      return palette.amber;
    },
  });
  const kept = store({ x: 1 });
  reshape(kept, { x: 1, inner });
  palette.amber = "orange";
  assert.strictEqual(/** @type {any} */ (kept).inner.color, "orange");
  const built = store({ inner });
  palette.amber = "red";
  assert.strictEqual(built.inner.color, "red");
});

test("store() makes a store of a plain object at a symbol key", () => {
  const s = Symbol("s");
  const kept = store({ [s]: { a: 1 }, x: 1 });
  assert.strictEqual(isStore(kept[s]), true);
  let runs = 0;
  new Effect(() => {
    runs += 1;
    void kept[s];
  });
  reshape(kept, { [s]: { a: 1 }, x: 1 });
  assert.strictEqual(runs, 1);
});

test("reshape() puts a key that gains only a setter in the store", () => {
  const kept = store({ x: 1 });
  reshape(kept, {
    x: 1,
    set y(/** @type {unknown} */ _) {},
  });
  assert.strictEqual("y" in kept, true);
  assert.deepStrictEqual(Reflect.ownKeys(kept), ["x", "y"]);
});

test("reshape() takes a key named like an Object.prototype member as new", () => {
  const kept = store({ x: 1 });
  /** @type {string[]} */
  const keys = [];
  new Effect(() => {
    keys.push(Object.keys(kept).join(","));
  });
  reshape(kept, { x: 1, valueOf: 5 });
  assert.deepStrictEqual(keys, ["x", "x,valueOf"]);
  const other = store({ x: 1 });
  reshape(other, {
    x: 1,
    get toString() {
      return "t";
    },
  });
  assert.deepStrictEqual(Reflect.ownKeys(other), ["x", "toString"]);
});

test("a key turned setter-only reads undefined and re-runs its readers", () => {
  const kept = store({ x: { a: 1 } });
  /** @type {unknown[]} */
  const seen = [];
  new Effect(() => {
    seen.push(/** @type {any} */ (kept).x);
  });
  reshape(kept, {
    set x(/** @type {unknown} */ _) {},
  });
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(/** @type {any} */ (kept).x, undefined);
});

test("a getter-only key turned setter-only reads undefined", () => {
  const kept = store({
    get n() {
      return { a: 1 };
    },
  });
  /** @type {unknown[]} */
  const seen = [];
  new Effect(() => {
    seen.push(/** @type {any} */ (kept).n);
  });
  reshape(kept, {
    set n(/** @type {unknown} */ _) {},
  });
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(/** @type {any} */ (kept).n, undefined);
});

test("delete leaves a setter-only key in the store", () => {
  /** @type {unknown[]} */
  const written = [];
  const kept = store({
    x: 1,
    set y(/** @type {unknown} */ value) {
      written.push(value);
    },
  });
  delete (/** @type {any} */ (kept).y);
  assert.strictEqual("y" in kept, true);
  /** @type {any} */ (kept).y = 7;
  assert.deepStrictEqual(written, [7]);
  /** @type {any} */ (store(kept)).y = 8;
  assert.deepStrictEqual(written, [7, 8]);
});

test("reshape() reads only the keys a spread would copy", () => {
  const kept = store(/** @type {Record<string, unknown>} */ ({ a: 1 }));
  const definition = { b: 2 };
  Object.defineProperty(definition, "hidden", { value: 3, enumerable: false });
  reshape(kept, definition);
  assert.deepStrictEqual(Reflect.ownKeys(kept), ["b"]);
});

test("reshape() follows a symbol key as any other", () => {
  const s = Symbol("s");
  const kept = store({ [s]: 1, x: 1 });
  reshape(kept, store({ [s]: 1, x: 2 }));
  assert.strictEqual(kept[s], 1);
  reshape(kept, { [s]: 2, x: 2 });
  assert.strictEqual(kept[s], 2);
});

test("a hot reload re-runs a getter's readers only when its value changes", () => {
  const palette = store({ amber: "amber", ivory: "ivory" });
  /** @param {"amber" | "ivory"} accent */
  const define = (accent) =>
    store({
      get accent() {
        return palette[accent];
      },
      x: 1,
    });
  const kept = define("amber");
  let runs = 0;
  new Effect(() => {
    runs += 1;
    void kept.accent;
  });
  reshape(kept, define("amber"));
  assert.strictEqual(runs, 1);
  // A new getter that agrees for now still follows what it reads.
  palette.ivory = "amber";
  reshape(kept, define("ivory"));
  assert.strictEqual(runs, 1);
  palette.ivory = "white";
  assert.strictEqual(runs, 2);
  assert.strictEqual(kept.accent, "white");
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

test("isStore is true for a store's own proxy only", () => {
  const state = store({ a: 1 });
  const everyKey = new Proxy({}, { get: () => ({}) });
  assert.strictEqual(isStore(Object.create(state)), false);
  assert.strictEqual(isStore(everyKey), false);
  emit(/** @type {any} */ (everyKey), "x", 1);
  assert.throws(() => reshape(Object.create(state), {}), /reshape\(\) takes a store/);
});

test("isStore() reads no key of what it is given", () => {
  let runs = 0;
  const lazy = selector(() => {
    runs += 1;
    throw new NoValueError("not yet");
  });
  assert.strictEqual(isStore(lazy), false);
  assert.strictEqual(runs, 0);
});

test("isStore reads no key of the store and adds none", () => {
  const state = store({ value: 1 });
  let runs = 0;
  new Effect(() => {
    runs += 1;
    isStore(state);
  });
  state.value = 2;
  delete (/** @type {{ value?: number }} */ (state).value);
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual(Reflect.ownKeys(state), []);
  assert.deepStrictEqual(Object.getOwnPropertySymbols({ ...store({ value: 1 }) }), []);
});

test("replace() moves the keys that changed and leaves the rest alone", () => {
  // An assignment through the store, as the running program makes one.
  const palette = store({ accent: "#f00", spacing: 8 });
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

test("an array in a store is a store", () => {
  const state = store({ list: [1, { a: 1 }, [2]] });
  assert.strictEqual(isStore(state.list), true);
  assert.strictEqual(Array.isArray(state.list), true);
  assert.strictEqual(isStore(state.list[1]), true, "an object in it is a store");
  assert.strictEqual(isStore(state.list[2]), true, "and so is an array");
  assert.strictEqual(isStore(store([1, 2])), true, "an array makes a store by itself");
});

test("a reader of an index follows the writes to it", () => {
  const state = store({ list: [1, 2] });
  /** @type {Array<number | undefined>} */
  const values = [];
  new Effect(() => {
    values.push(state.list[1]);
  });
  state.list[0] = 5;
  state.list[1] = 6;
  state.list[1] = 6;
  state.list.length = 1;
  assert.deepStrictEqual(values, [2, 6, undefined]);
});

test("a write past the end tells the length's readers", () => {
  const state = store({ list: [1] });
  /** @type {number[]} */
  const lengths = [];
  new Effect(() => {
    lengths.push(state.list.length);
  });
  state.list[0] = 2;
  state.list[2] = 3;
  assert.deepStrictEqual(lengths, [1, 3]);
});

test("each array method that changes the array is one update", () => {
  const list = store([3, 1, 2]);
  /** @type {string[]} */
  const values = [];
  new Effect(() => {
    values.push(`${list.length}:${list.join(",")}:${Object.keys(list).join("")}`);
  });
  list.push(4, 5);
  list.pop();
  list.shift();
  list.unshift(0);
  list.splice(1, 1, 7, 8);
  list.sort();
  list.reverse();
  list.fill(9, 3);
  list.copyWithin(0, 3);
  assert.deepStrictEqual(values, [
    "3:3,1,2:012",
    "5:3,1,2,4,5:01234",
    "4:3,1,2,4:0123",
    "3:1,2,4:012",
    "4:0,1,2,4:0123",
    "5:0,7,8,2,4:01234",
    "5:0,2,4,7,8:01234",
    "5:8,7,4,2,0:01234",
    "5:8,7,4,9,9:01234",
    "5:9,9,4,9,9:01234",
  ]);
});

test("an array method returns what the native one does", () => {
  const list = store([1, 2, 3]);
  assert.strictEqual(list.push(4), 4);
  assert.strictEqual(list.pop(), 4);
  assert.deepStrictEqual(list.splice(0, 2), [1, 2]);
  assert.strictEqual(list.reverse(), list);
});

test("an effect that pushes does not run again on its own push", () => {
  const state = store({ log: /** @type {number[]} */ ([]), n: 1 });
  let runs = 0;
  new Effect(() => {
    runs += 1;
    state.log.push(state.n);
  });
  state.log.push(0);
  state.n = 2;
  assert.strictEqual(runs, 2);
  assert.deepStrictEqual([...state.log], [1, 0, 2]);
});

test("a cut-off index tells its readers", () => {
  const list = store([1, 2, 3]);
  /** @type {Array<number | undefined>} */
  const values = [];
  new Effect(() => {
    values.push(list[2]);
  });
  list.length = 2;
  list.length = 2;
  assert.deepStrictEqual(values, [3, undefined]);
  assert.throws(() => {
    list.length = -1;
  }, RangeError);
});

test("an object pushed to an array is a store", () => {
  const state = store({ items: /** @type {Array<{ done: boolean }>} */ ([]) });
  state.items.push({ done: false });
  /** @type {boolean[]} */
  const values = [];
  new Effect(() => {
    values.push(state.items[0].done);
  });
  assert.strictEqual(isStore(state.items[0]), true);
  state.items[0].done = true;
  assert.deepStrictEqual(values, [false, true]);
});

test("an array method moves a store rather than copying it", () => {
  const list = store([{ n: 2 }, { n: 1 }, { n: 3 }]);
  const [two, one, three] = list;
  list.sort((a, b) => a.n - b.n);
  assert.deepStrictEqual([...list], [one, two, three]);
  list.shift();
  assert.deepStrictEqual([...list], [two, three]);
  list[0] = list[1];
  assert.strictEqual(list[0], three, "an assigned store is held as itself");
  assert.strictEqual(three.n, 3, "and nothing is written into it");
});

test("a store assigned to a key is held as itself", () => {
  const inner = store({ a: 1 });
  const state = store(/** @type {{ x: object }} */ ({ x: { a: 2 } }));
  const nested = state.x;
  state.x = inner;
  assert.strictEqual(state.x, inner);
  assert.deepStrictEqual({ ...nested }, { a: 2 }, "the store the key held is left as it was");
  assert.strictEqual(store({ inner }).inner, inner);
});

test("an array assigned over an array store is written into it", () => {
  const state = store({ list: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  const list = state.list;
  const first = list[0];
  /** @type {number[]} */
  const firsts = [];
  /** @type {number[]} */
  const lengths = [];
  new Effect(() => {
    firsts.push(state.list[0].n);
  });
  new Effect(() => {
    lengths.push(state.list.length);
  });
  state.list = [{ n: 1 }, { n: 5 }];
  assert.strictEqual(state.list, list, "the key holds the same store");
  assert.strictEqual(state.list[0], first, "and so does each index");
  assert.deepStrictEqual(firsts, [1], "the reader of an unchanged element did not run");
  assert.deepStrictEqual(lengths, [3, 2]);
  assert.deepStrictEqual(
    state.list.map((item) => item.n),
    [1, 5],
  );
  replace(state.list, [{ n: 4 }]);
  assert.deepStrictEqual(firsts, [1, 4]);
  assert.strictEqual(state.list[0], first);
});

test("an array and an object do not stand in for each other", () => {
  const state = store(/** @type {{ x: unknown }} */ ({ x: { 0: "a" } }));
  const object = state.x;
  state.x = ["a"];
  assert.notStrictEqual(state.x, object);
  assert.strictEqual(Array.isArray(state.x), true);
  state.x = { 0: "a" };
  assert.strictEqual(Array.isArray(state.x), false);
});

test("an array that is not a plain one is held as it is", () => {
  class List extends Array {}
  const typed = new Float32Array(2);
  const list = new List();
  const state = store({ typed, list });
  assert.strictEqual(state.typed, typed);
  assert.strictEqual(state.list, list);
});

test("reshape() takes the definition's elements for an array the program has not written", () => {
  const kept = store({ list: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  trackWrites(kept);
  const list = kept.list;
  const first = list[0];
  first.n = 10;
  /** @type {number[]} */
  const seconds = [];
  /** @type {number[]} */
  const lengths = [];
  new Effect(() => {
    seconds.push(kept.list[1].n);
  });
  new Effect(() => {
    lengths.push(kept.list.length);
  });
  reshape(kept, { list: [{ n: 1 }, { n: 2 }] });
  assert.strictEqual(kept.list, list, "the array store is reshaped in place");
  assert.strictEqual(kept.list[0], first, "and so is a store it holds");
  assert.strictEqual(first.n, 10, "which keeps what was written into it");
  assert.deepStrictEqual(seconds, [2], "the reader of an unchanged element did not run");
  assert.deepStrictEqual(lengths, [3, 2]);
  reshape(kept, { list: [{ n: 1 }, { n: 7 }, 4] });
  assert.deepStrictEqual(seconds, [2, 7]);
  assert.deepStrictEqual(lengths, [3, 2, 3]);
  assert.strictEqual(kept.list[2], 4);
});

test("an array the program wrote to is the program's as a whole", () => {
  const kept = store({ list: [1, 2], other: [1, 2], assigned: 0 });
  trackWrites(kept);
  kept.list.push(3);
  kept.other[0] = 5;
  /** @type {any} */ (kept).assigned = [];
  reshape(kept, { list: [9, 9], other: [9, 9], assigned: [9] });
  assert.deepStrictEqual([...kept.list], [1, 2, 3]);
  assert.deepStrictEqual([...kept.other], [5, 2]);
  assert.deepStrictEqual([.../** @type {any} */ (kept).assigned], []);
});

test("an array emptied by an assignment is the program's", () => {
  const kept = store({ list: [1, 2] });
  trackWrites(kept);
  kept.list = [];
  reshape(kept, { list: [3] });
  assert.deepStrictEqual([...kept.list], []);
});

test("a write that leaves an array as it was marks nothing", () => {
  const kept = store({ list: [1, 2, 3] });
  trackWrites(kept);
  kept.list.sort();
  kept.list = [1, 2, 3];
  reshape(kept, { list: [4] });
  assert.deepStrictEqual([...kept.list], [4]);
});

test("reshape() of an array store takes an array", () => {
  const list = store([1, 2, 3]);
  reshape(list, store([1, 5]));
  assert.deepStrictEqual([...list], [1, 5]);
  // eslint-disable-next-line no-sparse-arrays
  reshape(list, [1, , 3]);
  assert.strictEqual(1 in list, false, "a hole in the definition is one in the store");
  assert.strictEqual(list.length, 3);
  assert.throws(() => reshape(store({}), []), /reshape\(\) takes a definition of the store's kind/);
});

test("Object.hasOwn() follows the key", () => {
  /** @type {{ value?: number }} */
  const state = store({ value: 1 });
  /** @type {boolean[]} */
  const values = [];
  new Effect(() => {
    values.push(Object.hasOwn(state, "value"));
  });
  delete state.value;
  state.value = 2;
  assert.deepStrictEqual(values, [true, false, true]);
});

test("unshift and splice insert a new store rather than writing into a moved one", () => {
  const list = store([{ n: 1 }, { n: 2 }]);
  const [one, two] = list;
  list.unshift({ n: 0 });
  assert.deepStrictEqual(
    list.map((item) => item.n),
    [0, 1, 2],
  );
  assert.strictEqual(list[1], one, "the store that moved is the one that was there");
  assert.strictEqual(list[2], two);
  const other = store([{ n: 1 }, { n: 2 }, { n: 3 }]);
  other.splice(0, 1, { n: 8 }, { n: 9 });
  assert.deepStrictEqual(
    other.map((item) => item.n),
    [8, 9, 2, 3],
  );
  const nested = store([[1], [2]]);
  nested.unshift([0]);
  assert.deepStrictEqual(
    nested.map((item) => [...item]),
    [[0], [1], [2]],
  );
});

test("an effect that sorts follows what its comparator reads", () => {
  const state = store({ list: [{ n: 2 }, { n: 1 }] });
  new Effect(() => {
    state.list.sort((a, b) => a.n - b.n);
  });
  assert.deepStrictEqual(
    state.list.map((item) => item.n),
    [1, 2],
  );
  state.list[0].n = 5;
  assert.deepStrictEqual(
    state.list.map((item) => item.n),
    [2, 5],
  );
});

test("reshape() reaches the element stores of an array the program wrote to", () => {
  const levels = store([
    {
      get label() {
        return "old";
      },
    },
  ]);
  trackWrites(levels);
  levels.push({
    get label() {
      return "pushed";
    },
  });
  reshape(levels, [
    {
      get label() {
        return "new";
      },
    },
  ]);
  assert.strictEqual(levels.length, 2, "the program's elements and length stay");
  assert.strictEqual(levels[0].label, "new", "a store at an index the definition has is reshaped");
  assert.strictEqual(levels[1].label, "pushed");
});

test("a length that grows tells no reader of the key set", () => {
  const list = store([1]);
  let runs = 0;
  new Effect(() => {
    runs += 1;
    void Reflect.ownKeys(list);
  });
  list.length = 5;
  assert.strictEqual(runs, 1);
  list.length = 0;
  assert.strictEqual(runs, 2);
});

test("reshape() of an array store refuses an object by its type", () => {
  const list = store([1]);
  // @ts-expect-error An array store takes an array.
  assert.throws(() => reshape(list, {}), /reshape\(\) takes a definition of the store's kind/);
});

test("a getter read inside an array method still follows the array", () => {
  const state = store({
    items: [{ n: 2 }, { n: 1 }],
    get count() {
      return this.items.length;
    },
  });
  new Effect(() => {
    state.items.sort((a, b) => {
      void state.count;
      return a.n - b.n;
    });
  });
  state.items.push({ n: 3 });
  assert.strictEqual(state.count, 3);
});

test("an array method taken off its store runs on what it is called on", () => {
  const { push } = store([1]);
  /** @type {number[]} */
  const plain = [];
  push.call(plain, 2);
  assert.deepStrictEqual(plain, [2]);
});

test("a reload reshapes no store the program brought to a key from elsewhere", () => {
  const levels = store([
    { id: 1, name: "a" },
    { id: 2, name: "b" },
  ]);
  trackWrites(levels);
  const game = store({ current: { id: 0, name: "none" } });
  trackWrites(game);
  game.current = levels[1];
  reshape(game, { current: { score: 0 } });
  assert.strictEqual(game.current, levels[1], "the key the program assigned keeps the store");
  assert.deepStrictEqual({ ...levels[1] }, { id: 2, name: "b" }, "which nothing wrote into");

  const untracked = store(/** @type {{ x: object }} */ ({ x: { a: 0 } }));
  const assigned = store({ a: 5 });
  untracked.x = assigned;
  reshape(untracked, { x: { a: 1, b: 2 } });
  assert.deepStrictEqual({ ...untracked.x }, { a: 1, b: 2 }, "an untracked key takes the source's");
  assert.deepStrictEqual({ ...assigned }, { a: 5 }, "and leaves the assigned store as it was");
});

test("a reload reshapes no element store moved in from another array", () => {
  const a = store([{ n: 1 }]);
  const b = store([{ n: 2 }]);
  trackWrites(a);
  trackWrites(b);
  const moved = /** @type {{ n: number }} */ (a.shift());
  b.push(moved);
  reshape(b, [{ n: 2 }, { n: 9 }]);
  assert.strictEqual(b[1], moved);
  assert.strictEqual(moved.n, 1);
});

test("a value assigned over a store from elsewhere makes a new store", () => {
  const levels = store([
    { id: 1, name: "a" },
    { id: 2, name: "b" },
  ]);
  const game = store({ current: { id: 0, name: "none" } });
  game.current = levels[1];
  game.current = { id: 0, name: "none" };
  assert.deepStrictEqual({ ...levels[1] }, { id: 2, name: "b" }, "nothing wrote into it");
  assert.notStrictEqual(game.current, levels[1]);
  const a = store([{ n: 1 }]);
  const b = store([{ n: 2 }]);
  a[0] = b[0];
  a[0] = { n: 9 };
  assert.strictEqual(b[0].n, 2);
});

test("push(undefined) makes an index", () => {
  const list = store(/** @type {unknown[]} */ ([]));
  /** @type {string[]} */
  const keys = [];
  new Effect(() => {
    keys.push(Object.keys(list).join(","));
  });
  list.push(undefined);
  assert.strictEqual(Object.hasOwn(list, 0), true);
  assert.deepStrictEqual(keys, ["", "0"]);
});

test("a value assigned over a store held at two keys makes a new store", () => {
  const list = store([{ n: 1 }, { n: 2 }]);
  list[1] = list[0];
  list[1] = { n: 9 };
  assert.strictEqual(list[0].n, 1, "the other index keeps its store as it was");
  assert.strictEqual(list[1].n, 9);
  assert.notStrictEqual(list[0], list[1]);
  const s = /** @type {{ a: { v: number }, b?: { v: number } }} */ (store({ a: { v: 1 } }));
  s.b = s.a;
  s.b = { v: 2 };
  assert.strictEqual(s.a.v, 1);
  assert.strictEqual(s.b.v, 2);
});

test("a reader of a key an array does not have follows its key set", () => {
  const list = /** @type {any} */ (store([1]));
  /** @type {unknown[]} */
  const metas = [];
  new Effect(() => {
    metas.push(list.meta);
  });
  /** @type {string[]} */
  const strings = [];
  new Effect(() => {
    strings.push(JSON.stringify(list));
  });
  list.meta = 1;
  list.meta = 2;
  list.toJSON = () => "x";
  assert.deepStrictEqual(metas, [undefined, 1, 2]);
  assert.strictEqual(strings.at(-1), '"x"', "the reader hears the key it looked for appear");
});

test("an assignment over a store an array also holds at a non-index key makes a new store", () => {
  const list = /** @type {any} */ (store([{ n: 1 }]));
  list.meta = list[0];
  list[0] = { n: 9 };
  assert.strictEqual(list.meta.n, 1);
  const other = /** @type {any} */ (store([{ n: 1 }]));
  other.meta = other[0];
  other.meta = { n: 9 };
  assert.strictEqual(other[0].n, 1);
});

test("replace() writes no value into a store it also places elsewhere", () => {
  const list = store([{ n: 1 }, { n: 2 }]);
  const second = list[1];
  replace(list, [second, { n: 5 }]);
  assert.strictEqual(list[0], second);
  assert.strictEqual(second.n, 2, "the store moved to index 0 is not written through index 1");
  assert.strictEqual(list[1].n, 5);
});

test("replace() writes nothing into a store it places at a later key", () => {
  const list = store([{ n: 1 }, { n: 2 }]);
  const first = list[0];
  replace(list, [{ n: 5 }, first]);
  assert.strictEqual(list[1], first);
  assert.strictEqual(first.n, 1);
  assert.strictEqual(list[0].n, 5);
  assert.notStrictEqual(list[0], first);
  const s = /** @type {any} */ (store({ a: { v: 1 } }));
  const S = s.a;
  replace(s, { a: { v: 9 }, c: S });
  assert.strictEqual(s.c, S);
  assert.strictEqual(S.v, 1);
});

test("an effect that a replace() runs assigns as any assignment does", () => {
  const s = store({ a: { v: 1 }, n: 0 });
  const A = s.a;
  new Effect(() => {
    if (s.n === 1) {
      s.a = { v: 7 };
    }
  });
  replace(s, { a: A, n: 1 });
  assert.strictEqual(s.a, A, "written into the store the key holds once");
  assert.strictEqual(A.v, 7);
});

test("replace() writes into an aliased store once the alias is gone, as assignments do", () => {
  const s = /** @type {any} */ (store({ a: { v: 1 } }));
  s.b = s.a;
  const S = s.a;
  replace(s, { a: { v: 2 }, b: { v: 3 } });
  assert.notStrictEqual(s.a, S);
  assert.strictEqual(s.b, S, "held at b alone by then, so written into");
  assert.strictEqual(S.v, 3);
});

test("a reload leaves an array's non-index keys as they are", () => {
  const def = /** @type {any} */ ([1, 2]);
  def.meta = "x";
  const list = /** @type {any} */ (store(def));
  trackWrites(list);
  const next = /** @type {any} */ ([1, 2]);
  next.meta = "y";
  reshape(list, next);
  assert.strictEqual(list.meta, "x");
  reshape(list, [1, 2]);
  assert.strictEqual(Object.hasOwn(list, "meta"), true);
});
