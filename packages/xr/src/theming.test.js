import { test } from "node:test";
import assert from "node:assert/strict";
import { followOutlinesQuery, followThemingQuery, paintOrderQuery } from "./theming.js";

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

test("?paintOrder asks for paint order, and its absence does not", () => {
  assert.equal(paintOrderQuery(new URLSearchParams("?paintOrder")), true);
  assert.equal(paintOrderQuery(new URLSearchParams("?emulator=bare&paintOrder")), true);
  assert.equal(paintOrderQuery(new URLSearchParams("?emulator")), false);
});
