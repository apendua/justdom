import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BOX_SHADOWS, parseBoxShadow, splitShadowLayers } from "./shadows.js";

describe("splitShadowLayers", () => {
  test("splits at the commas between layers, not those in a colour", () => {
    assert.deepEqual(splitShadowLayers("rgb(0, 0, 0) 1px 2px, red 3px 4px"), [
      "rgb(0, 0, 0) 1px 2px",
      " red 3px 4px",
    ]);
  });
});

describe("parseBoxShadow", () => {
  test("reads what Chromium computes: colour first, then lengths, then inset", () => {
    assert.deepEqual(
      parseBoxShadow("rgb(255, 0, 0) 0px 0px 0px 1px inset, rgba(0, 0, 0, 0.3) 0px 4px 8px -2px"),
      [
        { color: [1, 0, 0, 1], x: 0, y: 0, blur: 0, spread: 1, inset: true },
        { color: [0, 0, 0, 0.3], x: 0, y: 4, blur: 8, spread: -2, inset: false },
      ],
    );
  });

  test("reads author syntax, a colour in any space, and none in the element's colour", () => {
    assert.deepEqual(parseBoxShadow("inset 2px 3px blue"), [
      { color: [0, 0, 1, 1], x: 2, y: 3, blur: 0, spread: 0, inset: true },
    ]);
    const [oklch] = parseBoxShadow("oklch(0.7 0.15 250) 1px 1px");
    assert.ok(Math.abs(oklch.color[2] - 0.969808) < 1e-3, `${oklch.color}`);
    assert.deepEqual(parseBoxShadow("1px 1px 2px", "rgb(0, 255, 0)")[0].color, [0, 1, 0, 1]);
  });

  test("draws the topmost layers, at most four", () => {
    const layers = Array.from({ length: 6 }, (_, i) => `red ${i}px 0px`).join(", ");
    const shadows = parseBoxShadow(layers);
    assert.equal(MAX_BOX_SHADOWS, 4);
    assert.deepEqual(
      shadows.map((shadow) => shadow.x),
      [0, 1, 2, 3],
    );
  });

  test("drops a layer that draws nothing or cannot be read", () => {
    assert.deepEqual(parseBoxShadow("none"), []);
    assert.deepEqual(parseBoxShadow(""), []);
    assert.deepEqual(parseBoxShadow("transparent 1px 1px"), []);
    assert.deepEqual(parseBoxShadow("rgba(0, 0, 0, 0) 1px 1px, red 1px"), []);
    assert.deepEqual(parseBoxShadow("flurb 1px 1px"), []);
  });
});
