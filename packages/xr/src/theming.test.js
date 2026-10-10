import { test } from "node:test";
import assert from "node:assert/strict";
import { followThemingQuery } from "./theming.js";

test("?theming turns theming mode on, and its absence does not", () => {
  for (const search of ["?theming", "?emulator&theming"]) {
    const stop = followThemingQuery(new URLSearchParams(search));
    assert.equal(typeof stop, "function", search);
    stop?.();
  }
  assert.equal(followThemingQuery(new URLSearchParams("?emulator")), null);
  assert.equal(followThemingQuery(new URLSearchParams("")), null);
});
