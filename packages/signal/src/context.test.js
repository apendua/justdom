import { test } from "node:test";
import assert from "node:assert/strict";
import { createProperty, isProperty } from "./context.js";

test("isProperty tells a property from an object shaped like one", () => {
  const property = createProperty(() => 1);
  assert.strictEqual(isProperty(property), true);
  assert.strictEqual(isProperty({ get: property.get, set: property.set }), false);
  assert.strictEqual(isProperty(null), false);
  assert.strictEqual(isProperty(undefined), false);
});
