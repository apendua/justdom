import { test } from "node:test";
import assert from "node:assert/strict";
import { followThemingQuery } from "./theming.js";

test("?theming turns theming mode on, and its absence does not", () => {
  assert.equal(followThemingQuery("?theming"), true);
  assert.equal(followThemingQuery("?emulator&theming"), true);
  assert.equal(followThemingQuery("?emulator"), false);
  assert.equal(followThemingQuery(""), false);
});
