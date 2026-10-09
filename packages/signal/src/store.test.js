import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "./index.js";
import { set } from "./operators.js";
import { NoValueError } from "./core.js";
import selector from "./selector.js";
import store, {
  emit,
  isStore,
  isVolatile,
  reconfigure,
  replace,
  reshape,
  volatileStore,
} from "./store.js";

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
  const kept = volatileStore(theme(palette, "amber", 8));
  /** @type {unknown[]} */
  const values = [];
  new Effect(() => {
    values.push(`${kept.accent}/${kept.nested.border}/${kept.spacing}`);
  });
  reconfigure(kept, volatileStore(theme(palette, "ivory", 12)));
  palette.ivory = "white";
  palette.amber = "orange";
  assert.deepStrictEqual(values, ["amber/amber/8", "ivory/ivory/12", "white/white/12"]);
});

test("reconfigure() drops the keys the definition no longer has", () => {
  const state = store(/** @type {{ a: number, b?: number }} */ ({ a: 1, b: 2 }));
  /** @type {unknown[]} */
  const keys = [];
  new Effect(() => {
    keys.push(Object.keys(state).join(","));
  });
  reconfigure(state, { a: 1 });
  assert.deepStrictEqual(keys, ["a,b", "a"]);
});

test("reconfigure() turns data into a getter and back", () => {
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
  reconfigure(state, computed);
  palette.amber = "orange";
  reconfigure(state, { color: "ivory" });
  palette.amber = "yellow";
  assert.deepStrictEqual(values, ["ivory", "amber", "orange", "ivory"]);
});

test("reconfigure() with the same definition re-runs nothing", () => {
  const definition = theme(store({ amber: "amber", ivory: "ivory" }), "amber", 8);
  const state = store(definition);
  let runs = 0;
  new Effect(() => {
    runs += 1;
    void state.accent;
  });
  reconfigure(state, definition);
  assert.strictEqual(runs, 1);
});

test("reconfigure() takes a store", () => {
  // @ts-expect-error A plain object is not a store, which the type says.
  assert.throws(() => reconfigure({}, {}), /takes a store/);
});

test("reshape() keeps what was written and takes the definition's shape", () => {
  const kept = store(/** @type {{ x: number, y?: number }} */ ({ x: 1, y: 2 }));
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

test("reshape() lets the definition win where the shape changes", () => {
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
  assert.ok(isStore(kept.a), "a value that becomes a plain object takes the definition's");
  assert.deepStrictEqual({ ...kept.a }, { n: 1 });
  assert.strictEqual(kept.b, 2, "a store that becomes a value takes the definition's");
  assert.strictEqual(kept.c, 3, "a getter that becomes a data key takes the definition's value");
  assert.strictEqual(kept.d, 5, "a data key that becomes a getter reads the getter");
  assert.strictEqual(Object.getOwnPropertyDescriptor(kept, "d")?.value, undefined);
});

test("reshape() reshapes a nested store in place", () => {
  const kept = /** @type {any} */ (store({ layout: { width: 1, height: 2 } }));
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

test("reconfigure() takes the definition's value where reshape() keeps the store's", () => {
  const theme = volatileStore({ accent: "amber" });
  theme.accent = "ivory";
  reconfigure(theme, { accent: "amber" });
  assert.strictEqual(theme.accent, "amber");
  const settings = store({ accent: "amber" });
  settings.accent = "ivory";
  reshape(settings, { accent: "amber" });
  assert.strictEqual(settings.accent, "ivory");
});

test("reshape() takes a store", () => {
  // @ts-expect-error A plain object is not a store, which the type says.
  assert.throws(() => reshape({}, {}), /reshape\(\) takes a store/);
});

test("a data key turned into a getter lets go of its value", () => {
  const kept = volatileStore({ n: { a: 1 } });
  reconfigure(kept, {
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

test("reconfigure() writes a data key to state and runs no setter", () => {
  /** @type {unknown[]} */
  const written = [];
  const kept = volatileStore({
    x: 1,
    set y(/** @type {unknown} */ value) {
      written.push(value);
    },
  });
  reconfigure(kept, { x: 2, y: 3 });
  assert.deepStrictEqual(written, []);
  assert.strictEqual(kept.x, 2);
  assert.strictEqual(/** @type {any} */ (kept).y, 3);
});

test("reconfigure() from a store keeps what was written to it", () => {
  /** @param {number} width */
  const define = (width) => {
    const theme = volatileStore({ width: 0 });
    theme.width = width;
    return theme;
  };
  const kept = define(10);
  reconfigure(kept, define(20));
  assert.strictEqual(kept.width, 20);

  const palette = store({ amber: "amber" });
  palette.amber = "orange";
  const holder = volatileStore({ palette, x: 1 });
  reconfigure(holder, volatileStore({ palette, x: 2 }));
  assert.strictEqual(holder.palette.amber, "orange");
});

test("reconfigure() re-runs no reader of another store", () => {
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
  const kept = volatileStore({
    get x() {
      return 1;
    },
  });
  void kept.x;
  reconfigure(kept, {
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
  const kept = volatileStore({ x: 1 });
  reconfigure(kept, { x: 1, inner });
  palette.amber = "orange";
  assert.strictEqual(/** @type {any} */ (kept).inner.color, "orange");
  const built = store({ inner });
  palette.amber = "red";
  assert.strictEqual(built.inner.color, "red");
});

test("store() makes a store of a plain object at a symbol key", () => {
  const s = Symbol("s");
  const kept = volatileStore({ [s]: { a: 1 }, x: 1 });
  assert.strictEqual(isStore(kept[s]), true);
  let runs = 0;
  new Effect(() => {
    runs += 1;
    void kept[s];
  });
  reconfigure(kept, { [s]: { a: 1 }, x: 1 });
  assert.strictEqual(runs, 1);
});

test("reconfigure() puts a key that gains only a setter in the store", () => {
  const kept = volatileStore({ x: 1 });
  reconfigure(kept, {
    x: 1,
    set y(/** @type {unknown} */ _) {},
  });
  assert.strictEqual("y" in kept, true);
  assert.deepStrictEqual(Reflect.ownKeys(kept), ["x", "y"]);
});

test("reconfigure() takes a key named like an Object.prototype member as new", () => {
  const kept = volatileStore({ x: 1 });
  /** @type {string[]} */
  const keys = [];
  new Effect(() => {
    keys.push(Object.keys(kept).join(","));
  });
  reconfigure(kept, { x: 1, valueOf: 5 });
  assert.deepStrictEqual(keys, ["x", "x,valueOf"]);
  const other = volatileStore({ x: 1 });
  reconfigure(other, {
    x: 1,
    get toString() {
      return "t";
    },
  });
  assert.deepStrictEqual(Reflect.ownKeys(other), ["x", "toString"]);
});

test("a key turned setter-only reads undefined and re-runs its readers", () => {
  const kept = volatileStore({ x: { a: 1 } });
  /** @type {unknown[]} */
  const seen = [];
  new Effect(() => {
    seen.push(/** @type {any} */ (kept).x);
  });
  reconfigure(kept, {
    set x(/** @type {unknown} */ _) {},
  });
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(/** @type {any} */ (kept).x, undefined);
});

test("a getter-only key turned setter-only reads undefined", () => {
  const kept = volatileStore({
    get n() {
      return { a: 1 };
    },
  });
  /** @type {unknown[]} */
  const seen = [];
  new Effect(() => {
    seen.push(/** @type {any} */ (kept).n);
  });
  reconfigure(kept, {
    set n(/** @type {unknown} */ _) {},
  });
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(/** @type {any} */ (kept).n, undefined);
});

test("delete leaves a setter-only key in the store", () => {
  /** @type {unknown[]} */
  const written = [];
  const kept = volatileStore({
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

test("reconfigure() reads only the keys a spread would copy", () => {
  const kept = store(/** @type {Record<string, unknown>} */ ({ a: 1 }));
  const definition = { b: 2 };
  Object.defineProperty(definition, "hidden", { value: 3, enumerable: false });
  reconfigure(kept, definition);
  assert.deepStrictEqual(Reflect.ownKeys(kept), ["b"]);
});

test("reconfigure() follows a symbol key as any other", () => {
  const s = Symbol("s");
  const kept = volatileStore({ [s]: 1, x: 1 });
  reconfigure(kept, volatileStore({ [s]: 1, x: 2 }));
  assert.strictEqual(kept[s], 1);
  reconfigure(kept, { [s]: 2, x: 2 });
  assert.strictEqual(kept[s], 2);
});

test("a hot reload re-runs a getter's readers only when its value changes", () => {
  const palette = store({ amber: "amber", ivory: "ivory" });
  /** @param {"amber" | "ivory"} accent */
  const define = (accent) =>
    volatileStore({
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
  reconfigure(kept, define("amber"));
  assert.strictEqual(runs, 1);
  // A new getter that agrees for now still follows what it reads.
  palette.ivory = "amber";
  reconfigure(kept, define("ivory"));
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
  assert.throws(() => reconfigure(Object.create(state), {}), /reconfigure\(\) takes a store/);
});

test("isStore() reads no key of what it is given", () => {
  let runs = 0;
  const lazy = selector(() => {
    runs += 1;
    throw new NoValueError("not yet");
  });
  assert.strictEqual(isStore(lazy), false);
  assert.strictEqual(isVolatile(lazy), false);
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
