import { it } from "node:test";
import assert from "node:assert/strict";

import { createRecursiveCache } from "./cache.js";

it("store and retive element from cache", () => {
  const cache = createRecursiveCache();

  const key = {};
  const value = {};

  cache.set([key], value);
  const gotValue = cache.get([key]);
  assert.strictEqual(gotValue, value);
});

it("stores nested values", () => {
  const cache = createRecursiveCache();

  const key1 = {};
  const key2 = {};
  const value = {};

  cache.set([key1, key2], value);
  const gotValue = cache.get([key1, key2]);
  assert.strictEqual(gotValue, value);
});

it("stores value at nil key", () => {
  const cache = createRecursiveCache();

  const value = {};

  cache.set([], value);
  const gotValue = cache.get([]);
  assert.strictEqual(gotValue, value);
});

it("checks if value exists", () => {
  const cache = createRecursiveCache();

  const key = {};
  const value = {};

  assert.strictEqual(cache.has([key]), false);
  cache.set([key], value);
  assert.strictEqual(cache.has([key]), true);
});

it("checks if nested value exists", () => {
  const cache = createRecursiveCache();

  const key1 = {};
  const key2 = {};
  const value = {};

  assert.strictEqual(cache.has([key1, key2]), false);
  cache.set([key1, key2], value);
  assert.strictEqual(cache.has([key1]), false);
  assert.strictEqual(cache.has([key1, key2]), true);
});

it("checks if nil key exists", () => {
  const cache = createRecursiveCache();

  const value = {};

  assert.strictEqual(cache.has([]), false);
  cache.set([], value);
  assert.strictEqual(cache.has([]), true);
});

it("deletes value", () => {
  const cache = createRecursiveCache();

  const key = {};
  const value = {};

  cache.set([key], value);
  assert.strictEqual(cache.get([key]), value);
  cache.delete([key]);
  assert.strictEqual(cache.get([key]), undefined);
});

it("deletes nested value", () => {
  const cache = createRecursiveCache();

  const key1 = {};
  const key2 = {};
  const value = {};

  cache.set([key1, key2], value);
  assert.strictEqual(cache.get([key1, key2]), value);
  cache.delete([key1, key2]);
  assert.strictEqual(cache.get([key1, key2]), undefined);
});

it("deletes nil key", () => {
  const cache = createRecursiveCache();

  const value = {};

  cache.set([], value);
  assert.strictEqual(cache.get([]), value);
  cache.delete([]);
  assert.strictEqual(cache.get([]), undefined);
});
