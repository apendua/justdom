import { test } from "node:test";
import assert from "node:assert/strict";
import { Signal } from "@apendua.dev/signal";
import { observable } from "./factories.js";
import fields from "./fields.js";
import { use } from "./operators.js";

test("observes individual fields", (t) => {
  const source = new Signal({ value: { x: 1, y: 1 } });
  const properties = fields(() => source.get());
  /** @type {number[]} */
  const values = [];
  observable(() => {
    use(() => {
      values.push(properties.x);
    });
  }).subscribe();
  source.set({ x: 1, y: 2 });
  source.set({ x: 2, y: 2 });
  source.set({ x: 2, y: 3 });
  source.set({ x: 3, y: 3 });
  assert.deepStrictEqual(values, [1, 2, 3]);
});

test("handles nested fields", () => {
  const source = new Signal({ value: { x: { a: 1 }, y: 1 } });
  const properties = fields(() => source.get());
  /** @type {number[]} */
  const values = [];
  observable(() => {
    use(() => {
      values.push(properties.x.a);
    });
  }).subscribe();
  source.set({ x: { a: 1 }, y: 2 });
  source.set({ x: { a: 2 }, y: 2 });
  source.set({ x: { a: 2 }, y: 3 });
  source.set({ x: { a: 3 }, y: 3 });
  assert.deepStrictEqual(values, [1, 2, 3]);
});
