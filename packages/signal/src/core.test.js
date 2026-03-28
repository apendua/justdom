import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { withComputation, makeNonReactive } from "./core.js";

describe("withComputation", function () {
  it("returns callback result", function () {
    const result = withComputation({}, () => 42);
    assert.strictEqual(result, 42);
  });

  it("rethrows callback errors", function () {
    const err = new Error("failure");
    assert.throws(() => {
      withComputation({}, () => {
        throw err;
      });
    }, err);
  });
});

describe("makeNonReactive", function () {
  it("passes arguments through and returns function result", function () {
    const fn = mock.fn((a, b) => a + b);
    const wrapped = makeNonReactive(fn);

    assert.strictEqual(wrapped(2, 3), 5);
    assert.strictEqual(fn.mock.calls.length, 1);
    assert.deepStrictEqual(fn.mock.calls[0].arguments, [2, 3]);
  });

  it("rethrows errors from wrapped function", function () {
    const err = new Error("wrapped failure");
    const wrapped = makeNonReactive(() => {
      throw err;
    });

    assert.throws(() => {
      wrapped();
    }, err);
  });
});
