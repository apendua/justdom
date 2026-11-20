import { test } from "node:test";
import assert from "node:assert/strict";

import { isScroller } from "./scenarios.js";

const tall = { scrollHeight: 600, clientHeight: 252 };

test("a list that scrolls one axis and clips the other is the scroller", () => {
  // The todo list since it scrolls on the page: `overflow-x: hidden;
  // overflow-y: auto`, whose `overflow` shorthand reads "hidden auto".
  assert.equal(isScroller(tall, { overflow: "hidden auto", overflowY: "auto" }), true);
});

test("a list that clips both axes is the scroller", () => {
  // The todo list before it scrolled on the page, which `--against` still
  // drives when it measures an older revision.
  assert.equal(isScroller(tall, { overflow: "hidden", overflowY: "hidden" }), true);
  assert.equal(isScroller(tall, { overflow: "scroll", overflowY: "scroll" }), true);
});

test("an element that is not a scroll container is not the scroller", () => {
  assert.equal(isScroller(tall, { overflow: "visible", overflowY: "visible" }), false);
  assert.equal(isScroller(tall, { overflow: "clip", overflowY: "clip" }), false);
});

test("a list whose rows fit is not the scroller", () => {
  const short = { scrollHeight: 252, clientHeight: 252 };
  assert.equal(isScroller(short, { overflow: "hidden auto", overflowY: "auto" }), false);
});
