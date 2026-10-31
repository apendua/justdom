import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "./index.js";
import ReactiveSet from "./ReactiveSet.js";

describe("ReactiveSet", () => {
  it("has() is reactive", () => {
    const set = new ReactiveSet();
    /** @type {boolean[]} */
    const values = [];
    new Effect(() => {
      values.push(set.has("x"));
    });

    set.add("x");
    set.add("x"); // duplicate — should not retrigger
    set.add("y"); // unrelated value — should not trigger
    set.delete("x");
    assert.deepStrictEqual(values, [false, true, false]);
  });

  it("size is reactive", () => {
    const set = new ReactiveSet();
    /** @type {number[]} */
    const sizes = [];
    new Effect(() => {
      sizes.push(set.size);
    });

    set.add("a");
    set.add("b");
    set.delete("a");
    set.clear();
    assert.deepStrictEqual(sizes, [0, 1, 2, 1, 0]);
  });

  it("values() is reactive", () => {
    const set = new ReactiveSet();
    /** @type {string[][]} */
    const snapshots = [];
    new Effect(() => {
      snapshots.push([...set.values()]);
    });

    set.add("a");
    set.add("b");
    set.delete("a");
    assert.deepStrictEqual(snapshots, [[], ["a"], ["a", "b"], ["b"]]);
  });

  it("evicts #valueEvents cache entry on delete", () => {
    const set = new ReactiveSet();
    set.add("x");
    // Access the value to populate the cache
    set.has("x");
    // Delete — cache for "x" should be evicted
    set.delete("x");
    // Re-add and observe — should work normally (fresh observable created)
    /** @type {boolean[]} */
    const values = [];
    new Effect(() => {
      values.push(set.has("x"));
    });
    set.add("x");
    assert.deepStrictEqual(values, [false, true]);
  });

  it("evicts all #valueEvents cache entries on clear", () => {
    const set = new ReactiveSet();
    set.add("a");
    set.add("b");
    set.clear();
    /** @type {boolean[]} */
    const values = [];
    new Effect(() => {
      values.push(set.has("a"));
    });
    set.add("a");
    assert.deepStrictEqual(values, [false, true]);
  });

  it("reports one mutation as one update, not one per dependent", () => {
    const set = new ReactiveSet();
    set.add("a");
    /** @type {string[]} */
    const values = [];
    new Effect(() => {
      values.push(`${set.has("a")}/${set.size}`);
    });

    set.delete("a");
    assert.deepStrictEqual(values, ["true/1", "false/0"]);
  });

  it("reports clear() as one update across every value", () => {
    const set = new ReactiveSet();
    set.add("a");
    set.add("b");
    /** @type {string[]} */
    const values = [];
    new Effect(() => {
      values.push(`${set.has("a")}/${set.has("b")}`);
    });

    set.clear();
    assert.deepStrictEqual(values, ["true/true", "false/false"]);
  });
});
