import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isLegacyColor, parseCssColor, srgbTo, toSrgb } from "./cssColor.js";

/**
 * @param {ArrayLike<number> | null} actual
 * @param {ArrayLike<number>} expected
 * @param {number} [tolerance]
 */
function assertClose(actual, expected, tolerance = 1e-3) {
  assert.ok(actual, `expected [${Array.from(expected)}], got null`);
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance,
      `lane ${i}: ${actual[i]} is not ${expected[i]} (in [${Array.from(actual)}])`,
    );
  }
}

/**
 * What Chromium 153 makes of each colour, read back as
 * `color-mix(in srgb, <colour> 100%, transparent 0%)`, which serializes the
 * colour as unclipped sRGB floats. A channel outside 0–1 is the colour being
 * outside sRGB; the parser clips it, as a canvas does.
 *
 * @type {[string, [number, number, number, number]][]}
 */
const CHROMIUM = [
  ["oklch(0.7 0.15 250)", [0.29443, 0.639497, 0.969808, 1]],
  ["oklch(0.7 0.15 250 / 0.5)", [0.29443, 0.639497, 0.969808, 0.5]],
  ["oklab(0.6 0.1 -0.1)", [0.625423, 0.388703, 0.72752, 1]],
  ["lab(50 20 30)", [0.630054, 0.412583, 0.268905, 1]],
  ["lab(50 62.5 -25)", [0.783807, 0.239498, 0.641034, 1]],
  ["lch(50 30 60)", [0.598841, 0.42688, 0.295202, 1]],
  ["color(srgb 0.5 0 0.5)", [0.5, 0, 0.5, 1]],
  ["color(srgb-linear 0.5 0.2 0.1)", [0.735394, 0.484543, 0.349222, 1]],
  ["color(a98-rgb 0.5 0.2 0.1)", [0.577363, 0.186309, 0.0642011, 1]],
  ["color(prophoto-rgb 0.5 0.2 0.1)", [0.760561, 0.0288841, 0.0823975, 1]],
  ["color(rec2020 0.5 0.2 0.1)", [0.662894, 0.190995, 0.127686, 1]],
  ["color(xyz-d65 0.2 0.3 0.4)", [0, 0.654269, 0.644341, 1]],
  ["color(xyz-d50 0.2 0.3 0.4)", [0, 0.659534, 0.740507, 1]],
  ["hsl(200 50% 50%)", [0.25, 0.583333, 0.75, 1]],
  ["hwb(200 20% 30%)", [0.2, 0.533333, 0.7, 1]],
];

describe("parseCssColor", () => {
  test("what browsers compute to rgb(), and what jsdom hands back as written", () => {
    assert.deepEqual(parseCssColor("rgb(255, 0, 0)"), [1, 0, 0, 1]);
    assert.deepEqual(parseCssColor("rgba(0, 0, 255, 0.5)"), [0, 0, 1, 0.5]);
    assert.deepEqual(parseCssColor("rgb(0 255 0 / 25%)"), [0, 1, 0, 0.25]);
    assertClose(parseCssColor("rgb(64.5, 149, 191)"), [64.5 / 255, 149 / 255, 191 / 255, 1]);
    assert.deepEqual(parseCssColor("#f00"), [1, 0, 0, 1]);
    assert.deepEqual(parseCssColor("#0000ff80"), [0, 0, 1, 128 / 255]);
    assert.deepEqual(parseCssColor("transparent"), [0, 0, 0, 0]);
    assert.deepEqual(parseCssColor("currentcolor", "rgb(0, 255, 0)"), [0, 1, 0, 1]);
  });

  test("every space a computed style keeps as written, against Chromium", () => {
    for (const [written, expected] of CHROMIUM) {
      assertClose(parseCssColor(written), expected);
    }
  });

  test("color(xyz) is xyz-d65, and percentages scale as CSS sets out", () => {
    assert.deepEqual(
      parseCssColor("color(xyz 0.2 0.3 0.4)"),
      parseCssColor("color(xyz-d65 0.2 0.3 0.4)"),
    );
    // Chromium computes `oklch(70% 50% 250deg)` as `oklch(0.7 0.2 250)` and
    // `lab(50% 50% -20%)` as `lab(50 62.5 -25)`.
    assert.deepEqual(parseCssColor("oklch(70% 50% 250deg)"), parseCssColor("oklch(0.7 0.2 250)"));
    assert.deepEqual(parseCssColor("lab(50% 50% -20%)"), parseCssColor("lab(50 62.5 -25)"));
    assertClose(
      parseCssColor("oklch(0.7 0.15 0.25turn)"),
      parseCssColor("oklch(0.7 0.15 90)") ?? [],
    );
  });

  test("none reads as 0", () => {
    // Chromium: color(srgb 0.0037871 0.000100235 -0.00833532).
    assertClose(parseCssColor("oklch(none 0.1 30)"), [0.0037871, 0.000100235, 0, 1]);
    assert.deepEqual(parseCssColor("rgb(none 255 0)"), [0, 1, 0, 1]);
  });

  test("an alpha of 0 is kept, so the colour draws nothing", () => {
    assert.equal(parseCssColor("oklch(0.7 0.15 250 / 0)")?.[3], 0);
    assert.equal(parseCssColor("color(display-p3 1 0 0 / 0%)")?.[3], 0);
  });

  test("a colour outside sRGB is clipped per channel", () => {
    // Chromium: color(srgb 1.09302 -0.22669 -0.150073), which a canvas
    // draws as rgb(255, 0, 0).
    assert.deepEqual(parseCssColor("color(display-p3 1 0 0)"), [1, 0, 0, 1]);
  });

  test("what color-mix() computes to", () => {
    // Chromium computes `color-mix(in srgb, red, blue)` to this.
    assert.deepEqual(parseCssColor("color(srgb 0.5 0 0.5)"), [0.5, 0, 0.5, 1]);
    assert.deepEqual(parseCssColor("color(srgb 0.5 0 0.5 / 0.25)"), [0.5, 0, 0.5, 0.25]);
  });

  test("what is not a colour is null", () => {
    for (const text of [
      "10px",
      "none",
      "oklch(0.5 0.1)",
      "color(cmyk 1 0 0)",
      "rgb(a, b, c)",
      "#ggg",
    ]) {
      assert.equal(parseCssColor(text), null, text);
    }
  });
});

describe("conversions", () => {
  test("every space goes there and back", () => {
    /** @type {import('./cssColor.js').ColorSpace[]} */
    const spaces = [
      "srgb",
      "srgb-linear",
      "display-p3",
      "a98-rgb",
      "prophoto-rgb",
      "rec2020",
      "lab",
      "oklab",
      "xyz-d50",
      "xyz-d65",
      "hsl",
      "hwb",
      "lch",
      "oklch",
    ];
    /** @type {[number, number, number]} */
    const colour = [0.8, 0.3, 0.1];
    for (const space of spaces) {
      assertClose(toSrgb(srgbTo(colour, space), space), colour, 1e-9);
    }
  });

  test("a grey has no hue in a polar space", () => {
    assert.ok(Number.isNaN(srgbTo([0.5, 0.5, 0.5], "oklch")[2]));
    assert.ok(Number.isNaN(srgbTo([1, 1, 1], "lch")[2]));
    assert.ok(Number.isNaN(srgbTo([0.5, 0.5, 0.5], "hsl")[0]));
    assert.ok(Number.isNaN(srgbTo([0.5, 0.5, 0.5], "hwb")[0]));
    assert.ok(!Number.isNaN(srgbTo([0, 0, 1], "oklch")[2]));
  });
});

describe("isLegacyColor", () => {
  test("hex, names, rgb(), hsl() and hwb() are legacy; the rest are not", () => {
    for (const text of [
      "#fff",
      "red",
      "transparent",
      "rgb(1, 2, 3)",
      "rgba(1, 2, 3, 0.5)",
      "hsl(1 2% 3%)",
      "hwb(1 2% 3%)",
    ]) {
      assert.ok(isLegacyColor(text), text);
    }
    for (const text of [
      "oklch(0.5 0.1 200)",
      "lab(50 0 0)",
      "color(srgb 1 0 0)",
      "oklab(0.5 0 0)",
    ]) {
      assert.ok(!isLegacyColor(text), text);
    }
  });
});
