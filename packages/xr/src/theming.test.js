import { test } from "node:test";
import assert from "node:assert/strict";
import { followOutlinesQuery, followThemingQuery } from "./theming.js";

test("?theming turns theming mode on, and its absence does not", () => {
  for (const search of ["?theming", "?emulator&theming"]) {
    const stop = followThemingQuery(new URLSearchParams(search));
    assert.equal(typeof stop, "function", search);
    stop?.();
  }
  assert.equal(followThemingQuery(new URLSearchParams("?emulator")), null);
  assert.equal(followThemingQuery(new URLSearchParams("")), null);
});

test("?outlines turns outlines mode on, and its absence does not", () => {
  for (const search of ["?outlines", "?emulator&outlines"]) {
    const stop = followOutlinesQuery(new URLSearchParams(search));
    assert.equal(typeof stop, "function", search);
    stop?.();
  }
  assert.equal(followOutlinesQuery(new URLSearchParams("?theming")), null);
  assert.equal(followOutlinesQuery(new URLSearchParams("")), null);
});
