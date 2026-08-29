import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "./index.js";
import ReactiveMap from "./ReactiveMap.js";

describe("ReactiveMap", () => {
  it("get() is reactive", () => {
    const map = new ReactiveMap();
    /** @type {(number | undefined)[]} */
    const values = [];
    new Effect(() => {
      values.push(map.get("x"));
    });

    map.set("x", 1);
    map.set("x", 2);
    map.set("y", 99); // unrelated key — should not trigger
    map.set("x", 3);
    assert.deepStrictEqual(values, [undefined, 1, 2, 3]);
  });

  it("has() is reactive", () => {
    const map = new ReactiveMap();
    /** @type {boolean[]} */
    const values = [];
    new Effect(() => {
      values.push(map.has("x"));
    });

    map.set("x", 1);
    map.set("y", 99); // unrelated key — should not trigger
    map.delete("x");
    assert.deepStrictEqual(values, [false, true, false]);
  });

  it("size is reactive", () => {
    const map = new ReactiveMap();
    /** @type {number[]} */
    const sizes = [];
    new Effect(() => {
      sizes.push(map.size);
    });

    map.set("a", 1);
    map.set("b", 2);
    map.delete("a");
    map.clear();
    assert.deepStrictEqual(sizes, [0, 1, 2, 1, 0]);
  });

  it("keys() is reactive only to structural changes", () => {
    const map = new ReactiveMap();
    /** @type {string[][]} */
    const snapshots = [];
    new Effect(() => {
      snapshots.push([...map.keys()]);
    });

    map.set("a", 1);
    map.set("a", 2); // update — should NOT retrigger keys()
    map.set("b", 3);
    map.delete("a");
    assert.deepStrictEqual(snapshots, [[], ["a"], ["a", "b"], ["b"]]);
  });

  it("get() does not react to unrelated key changes after delete", () => {
    const map = new ReactiveMap();
    /** @type {(number | undefined)[]} */
    const values = [];
    new Effect(() => {
      values.push(map.get("x"));
    });

    map.set("x", 1);
    map.delete("x");
    map.set("y", 99); // should not trigger after x is gone and cache evicted
    assert.deepStrictEqual(values, [undefined, 1, undefined]);
  });

  it("evicts #keyEvents cache entry on delete", () => {
    const map = new ReactiveMap();
    map.set("x", 1);
    // Access the key to populate the cache
    map.get("x");
    map.has("x");
    // Now delete it — cache for "x" should be evicted
    map.delete("x");
    // Re-add and access — should work normally (fresh observable created)
    /** @type {(number | undefined)[]} */
    const values = [];
    new Effect(() => {
      values.push(map.get("x"));
    });
    map.set("x", 2);
    assert.deepStrictEqual(values, [undefined, 2]);
  });

  it("evicts all #keyEvents cache entries on clear", () => {
    const map = new ReactiveMap();
    map.set("a", 1);
    map.set("b", 2);
    map.clear();
    /** @type {(number | undefined)[]} */
    const values = [];
    new Effect(() => {
      values.push(map.get("a"));
    });
    map.set("a", 10);
    assert.deepStrictEqual(values, [undefined, 10]);
  });

  it("reports one mutation as one update, not one per dependent", () => {
    // A computation reading two things that the same mutation changes must
    // see it once, and must never see the map halfway through it. Announcing
    // a change queues each dependent, and outside a batch a queued dependent
    // drains immediately — so without batching the announcement, the first
    // dependent would recompute before the second had been told.
    const map = new ReactiveMap();
    map.set("k", 1);
    /** @type {string[]} */
    const values = [];
    new Effect(() => {
      values.push(`${map.get("k")}/${map.size}`);
    });

    map.delete("k");
    assert.deepStrictEqual(values, ["1/1", "undefined/0"]);
  });

  it("reports clear() as one update across every key", () => {
    const map = new ReactiveMap();
    map.set("a", 1);
    map.set("b", 2);
    /** @type {string[]} */
    const values = [];
    new Effect(() => {
      values.push(`${map.get("a")}/${map.get("b")}`);
    });

    map.clear();
    assert.deepStrictEqual(values, ["1/2", "undefined/undefined"]);
  });
});
