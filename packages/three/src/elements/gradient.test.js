import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  bakeRamp,
  colorAt,
  GRADIENT_CONIC,
  GRADIENT_LINEAR,
  GRADIENT_RADIAL,
  layoutGradient,
  parseAngle,
  parseBackground,
  parseCssColor,
  parseGradient,
  parseLengthPercentage,
  parsePosition,
  RAMP_WIDTH,
  rampAtlas,
  rampUniforms,
  RampSlot,
  resolveStops,
  splitTopLevel,
} from "./gradient.js";

/**
 * @import {BackgroundBox, GradientLayout} from './gradient.js';
 */

/** @type {BackgroundBox} */
const BOX = { width: 200, height: 100, border: [0, 0, 0, 0], padding: [0, 0, 0, 0] };

/**
 * @param {string} image
 * @param {Partial<import('./gradient.js').BackgroundStyle>} [rest]
 * @param {BackgroundBox} [box]
 * @returns {GradientLayout}
 */
function layout(image, rest = {}, box = BOX) {
  const result = layoutGradient(parseBackground({ image, ...rest }), box);
  assert.ok(result, `expected ${image} to lay out`);
  return result;
}

/**
 * How far along its ramp the shader would find a point of the tile — the
 * shader's arithmetic, in JavaScript, before the repeat or clamp.
 *
 * @param {GradientLayout} layout
 * @param {number} x Tile px.
 * @param {number} y
 * @returns {number}
 */
function rampPosition(layout, x, y) {
  const [a, b, c, d] = layout.geometry;
  if (layout.kind === GRADIENT_LINEAR) {
    return x * a + y * b + c;
  }
  if (layout.kind === GRADIENT_RADIAL) {
    return Math.hypot((x - a) / c, (y - b) / d);
  }
  const turns = Math.atan2(x - a, -(y - b)) / (2 * Math.PI) - c;
  return (turns - Math.floor(turns)) * d;
}

/**
 * @param {number[]} actual
 * @param {number[]} expected
 * @param {number} [tolerance]
 */
function assertClose(actual, expected, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => {
    assert.ok(
      Math.abs(value - expected[i]) <= tolerance,
      `lane ${i}: ${value} is not ${expected[i]} (in [${actual}] vs [${expected}])`,
    );
  });
}

describe("gradient parsing", () => {
  test("lists split only at the top level", () => {
    assert.deepEqual(splitTopLevel("linear-gradient(red, rgb(0, 0, 255)), none", ","), [
      "linear-gradient(red, rgb(0, 0, 255))",
      "none",
    ]);
    assert.deepEqual(splitTopLevel("rgb(1, 2, 3)  10px", " "), ["rgb(1, 2, 3)", "10px"]);
  });

  test("colours: what browsers compute, and what jsdom hands back as written", () => {
    assert.deepEqual(parseCssColor("rgb(255, 0, 0)"), [1, 0, 0, 1]);
    assert.deepEqual(parseCssColor("rgba(0, 0, 255, 0.5)"), [0, 0, 1, 0.5]);
    assert.deepEqual(parseCssColor("rgb(0 255 0 / 25%)"), [0, 1, 0, 0.25]);
    assert.deepEqual(parseCssColor("#f00"), [1, 0, 0, 1]);
    assert.deepEqual(parseCssColor("#0000ff80"), [0, 0, 1, 128 / 255]);
    assert.deepEqual(parseCssColor("transparent"), [0, 0, 0, 0]);
    assert.deepEqual(parseCssColor("currentcolor", "rgb(0, 255, 0)"), [0, 1, 0, 1]);
    assert.equal(parseCssColor("oklch(0.5 0.1 200)"), null);
    assert.equal(parseCssColor("10px"), null);
  });

  test("length-percentages, including the calc() a computed position can be", () => {
    assert.deepEqual(parseLengthPercentage("10px"), { percent: 0, px: 10 });
    assert.deepEqual(parseLengthPercentage("25%"), { percent: 25, px: 0 });
    assert.deepEqual(parseLengthPercentage("0"), { percent: 0, px: 0 });
    assert.deepEqual(parseLengthPercentage("calc(100% - 10px)"), { percent: 100, px: -10 });
    assert.deepEqual(parseLengthPercentage("calc(50% + -4px)"), { percent: 50, px: -4 });
    assert.equal(parseLengthPercentage("12"), null);
    assert.equal(parseLengthPercentage("red"), null);
  });

  test("angles, in turns", () => {
    assert.equal(parseAngle("90deg"), 0.25);
    assert.equal(parseAngle("0.5turn"), 0.5);
    assert.equal(parseAngle("100grad"), 0.25);
    assert.ok(Math.abs(/** @type {number} */ (parseAngle("3.14159265rad")) - 0.5) < 1e-6);
    assert.equal(parseAngle("0"), 0);
    assert.equal(parseAngle("90"), null);
  });

  test("positions: keywords, lengths, and offsets from an edge", () => {
    assert.deepEqual(parsePosition(["center"]), {
      x: { percent: 50, px: 0 },
      y: { percent: 50, px: 0 },
    });
    assert.deepEqual(parsePosition(["top", "left"]), {
      x: { percent: 0, px: 0 },
      y: { percent: 0, px: 0 },
    });
    assert.deepEqual(parsePosition(["30%", "12px"]), {
      x: { percent: 30, px: 0 },
      y: { percent: 0, px: 12 },
    });
    assert.deepEqual(parsePosition(["right", "10px", "bottom", "20%"]), {
      x: { percent: 100, px: -10 },
      y: { percent: 80, px: -0 },
    });
    assert.equal(parsePosition(["left", "right"]), null);
  });

  test("a linear gradient's direction: default, side, corner and angle", () => {
    const plain = parseGradient("linear-gradient(red, blue)");
    assert.ok(plain && plain.kind === "linear");
    assert.equal(plain.angle, 0.5);
    assert.equal(plain.stops.length, 2);

    const side = parseGradient("linear-gradient(to right, red, blue)");
    assert.ok(side && side.kind === "linear");
    assert.equal(side.angle, 0.25);

    const corner = parseGradient("linear-gradient(to top right, red, blue)");
    assert.ok(corner && corner.kind === "linear");
    assert.deepEqual(corner.corner, [1, -1]);

    const angle = parseGradient("repeating-linear-gradient(45deg, red 0 10px, blue 10px 20px)");
    assert.ok(angle && angle.kind === "linear");
    assert.equal(angle.repeating, true);
    assert.equal(angle.angle, 0.125);
    // Double-position stops are the two stops they abbreviate.
    assert.equal(angle.stops.length, 4);
  });

  test("radial and conic preludes", () => {
    const radial = parseGradient("radial-gradient(circle closest-side at 30% 40%, red, blue)");
    assert.ok(radial && radial.kind === "radial");
    assert.equal(radial.shape, "circle");
    assert.equal(radial.size, "closest-side");
    assert.deepEqual(radial.center.x, { percent: 30, px: 0 });

    const sized = parseGradient("radial-gradient(20px, red, blue)");
    assert.ok(sized && sized.kind === "radial");
    assert.equal(sized.shape, "circle");

    const ellipse = parseGradient("radial-gradient(40px 20%, red, blue)");
    assert.ok(ellipse && ellipse.kind === "radial");
    assert.equal(ellipse.shape, "ellipse");
    assert.deepEqual(ellipse.size, [
      { percent: 0, px: 40 },
      { percent: 20, px: 0 },
    ]);

    const defaulted = parseGradient("radial-gradient(red, blue)");
    assert.ok(defaulted && defaulted.kind === "radial");
    assert.equal(defaulted.shape, "ellipse");
    assert.equal(defaulted.size, "farthest-corner");

    const conic = parseGradient("conic-gradient(from 90deg at 10px 20px, red, blue 0.25turn)");
    assert.ok(conic && conic.kind === "conic");
    assert.equal(conic.from, 0.25);
    assert.deepEqual(conic.stops[1].position, { percent: 25, px: 0 });
  });

  test("an interpolation space is read past, not refused", () => {
    const gradient = parseGradient("linear-gradient(in oklab to right, red, blue)");
    assert.ok(gradient && gradient.kind === "linear");
    assert.equal(gradient.angle, 0.25);
  });

  test("what cannot be drawn parses as nothing", () => {
    assert.equal(parseGradient("url(image.png)"), null);
    assert.equal(parseGradient("linear-gradient(to nowhere, red, blue)"), null);
    assert.equal(parseGradient("linear-gradient(red, 10%)"), null, "a hint needs a stop after it");
    assert.equal(parseGradient("linear-gradient(red, oklch(0.5 0.1 200))"), null);
    assert.equal(
      parseGradient("conic-gradient(red 10px, blue)"),
      null,
      "no lengths around a point",
    );
    assert.equal(parseGradient("radial-gradient(circle 10%, red, blue)"), null);
  });

  test("the topmost gradient layer is drawn, with its own entries of the other lists", () => {
    const background = parseBackground({
      image: 'url("a.png"), linear-gradient(red, blue), radial-gradient(red, blue)',
      size: "auto, 10px 20px",
      repeat: "repeat, no-repeat",
      positionX: "0%, right 4px",
      positionY: "0%, center",
      origin: "padding-box, border-box",
    });
    assert.ok(background);
    assert.equal(background.gradient.kind, "linear");
    assert.deepEqual(background.size, [
      { percent: 0, px: 10 },
      { percent: 0, px: 20 },
    ]);
    assert.deepEqual(background.repeat, ["no-repeat", "no-repeat"]);
    assert.deepEqual(background.position, {
      x: { percent: 100, px: -4 },
      y: { percent: 50, px: 0 },
    });
    assert.equal(background.origin, "border-box");
  });

  test("the position shorthand stands in when the longhands are not computed", () => {
    const background = parseBackground({
      image: "linear-gradient(red, blue)",
      position: "right 10px top",
    });
    assert.ok(background);
    assert.deepEqual(background.position.x, { percent: 100, px: -10 });
    assert.deepEqual(background.position.y, { percent: 0, px: 0 });
  });

  test("no gradient, no background", () => {
    assert.equal(parseBackground({ image: "none" }), null);
    assert.equal(parseBackground({ image: 'url("a.png")' }), null);
  });
});

describe("stops", () => {
  test("unplaced stops are placed the way CSS places them", () => {
    const gradient = parseGradient("linear-gradient(red, lime, blue 80%, white 40%, black)");
    assert.ok(gradient);
    const { stops } = resolveStops(gradient.stops, 100);
    assertClose(
      stops.map((stop) => stop.position),
      // First to 0, last to 1; lime evenly between red and blue; white
      // clamped up to the blue before it.
      [0, 0.4, 0.8, 0.8, 1],
    );
  });

  test("px positions are fractions of the gradient's length", () => {
    const gradient = parseGradient("linear-gradient(red 10px, blue calc(50% + 10px))");
    assert.ok(gradient);
    const { stops } = resolveStops(gradient.stops, 200);
    assertClose(
      stops.map((stop) => stop.position),
      [0.05, 0.55],
    );
  });

  test("interpolation is premultiplied: fading to transparent keeps the hue", () => {
    const gradient = parseGradient("linear-gradient(red, transparent)");
    assert.ok(gradient);
    const { stops, hints } = resolveStops(gradient.stops, 100);
    const ramp = { repeating: false, start: 0, period: 1, stops, hints };
    assertClose(colorAt(ramp, 0.5), [1, 0, 0, 0.5]);
  });

  test("a hint moves the midpoint of its transition", () => {
    const gradient = parseGradient("linear-gradient(black, 20%, white)");
    assert.ok(gradient);
    const { stops, hints } = resolveStops(gradient.stops, 100);
    assert.deepEqual(hints, [0.2]);
    const ramp = { repeating: false, start: 0, period: 1, stops, hints };
    assertClose(colorAt(ramp, 0.2), [0.5, 0.5, 0.5, 1]);
    // Past the hint the transition has mostly happened: 0.5 ** (ln 0.5 / ln 0.2).
    assertClose([colorAt(ramp, 0.5)[0]], [Math.pow(0.5, Math.log(0.5) / Math.log(0.2))]);
  });

  test("two stops at one place are a hard edge", () => {
    const gradient = parseGradient("linear-gradient(red 50%, blue 50%)");
    assert.ok(gradient);
    const { stops, hints } = resolveStops(gradient.stops, 100);
    const ramp = { repeating: false, start: 0, period: 1, stops, hints };
    assert.deepEqual(colorAt(ramp, 0.4999), [1, 0, 0, 1]);
    assert.deepEqual(colorAt(ramp, 0.5), [0, 0, 1, 1]);
  });
});

describe("gradient layout", () => {
  test("the tile is the padding box unless something says otherwise", () => {
    const result = layout(
      "linear-gradient(red, blue)",
      {},
      {
        width: 200,
        height: 100,
        border: [1, 2, 3, 4],
        padding: [10, 10, 10, 10],
      },
    );
    assert.deepEqual(result.tile, [4, 1, 194, 96]);
    assert.equal(result.repeatX, true);
    assert.equal(result.repeatY, true);
  });

  test("size, position and origin place the tile", () => {
    const box = { width: 200, height: 100, border: [2, 2, 2, 2], padding: [5, 10, 5, 10] };
    const result = layout(
      "linear-gradient(red, blue)",
      {
        size: "50% 20px",
        positionX: "right 10px",
        positionY: "center",
        repeat: "no-repeat",
        origin: "content-box",
      },
      /** @type {BackgroundBox} */ (box),
    );
    // Content box: 12..188 across, 7..93 down.
    const [x, y, width, height] = result.tile;
    assertClose([width, height], [88, 20]);
    assertClose([x, y], [12 + 176 - 88 - 10, 7 + (86 - 20) / 2]);
    assert.equal(result.repeatX, false);
    assert.equal(result.repeatY, false);
  });

  test("round fits a whole number of tiles, and keeps an auto side in proportion", () => {
    const result = layout("linear-gradient(red, blue)", { size: "45px auto", repeat: "round" });
    // 200 / 45 rounds to 4 tiles of 50; the auto height is the area's 100,
    // which then rounds on its own axis too: 100 / 100 is one tile.
    assertClose(result.tile.slice(2), [50, 100]);
    const oneAxis = layout("linear-gradient(red, blue)", {
      size: "45px auto",
      repeat: "round no-repeat",
    });
    assertClose(oneAxis.tile.slice(2), [50, 100 * (50 / 45)]);
  });

  test("a linear gradient runs from 0 to 1 across its line", () => {
    const down = layout("linear-gradient(red, blue)");
    assertClose([rampPosition(down, 50, 0), rampPosition(down, 50, 100)], [0, 1]);
    const across = layout("linear-gradient(to right, red, blue)");
    assertClose([rampPosition(across, 0, 30), rampPosition(across, 200, 30)], [0, 1]);
    // A corner gradient puts its ends at the corners and its middle through
    // the other two.
    const corner = layout("linear-gradient(to top right, red, blue)");
    assertClose(
      [
        rampPosition(corner, 0, 100),
        rampPosition(corner, 200, 0),
        rampPosition(corner, 0, 0),
        rampPosition(corner, 200, 100),
      ],
      [0, 1, 0.5, 0.5],
    );
    const angled = layout("linear-gradient(45deg, red, blue)");
    assertClose([rampPosition(angled, 0, 100), rampPosition(angled, 200, 0)], [0, 1]);
  });

  test("a repeating linear gradient counts in periods", () => {
    const result = layout("repeating-linear-gradient(to right, red 20px, blue 40px)");
    assert.equal(result.repeating, true);
    // 20px per period: the line's 200px is ten of them.
    assertClose([rampPosition(result, 0, 0), rampPosition(result, 200, 0)], [0, 10]);
  });

  test("radial extents", () => {
    const corner = layout("radial-gradient(circle, red, blue)");
    assert.equal(corner.kind, GRADIENT_RADIAL);
    assertClose(corner.geometry, [100, 50, Math.hypot(100, 50), Math.hypot(100, 50)]);
    assertClose([rampPosition(corner, 0, 0)], [1]);

    const side = layout("radial-gradient(closest-side at 50px 50%, red, blue)");
    assertClose(side.geometry, [50, 50, 50, 50]);

    // The default ellipse passes through the corners with the shape its
    // sides would have given it.
    const ellipse = layout("radial-gradient(red, blue)");
    assertClose(ellipse.geometry, [100, 50, 100 * Math.SQRT2, 50 * Math.SQRT2]);
    assertClose([rampPosition(ellipse, 0, 0), rampPosition(ellipse, 200, 50)], [1, 1 / Math.SQRT2]);

    const explicit = layout("radial-gradient(40px 20%, red, blue)");
    assertClose(explicit.geometry, [100, 50, 40, 20]);
  });

  test("a conic gradient turns clockwise from its starting angle", () => {
    const result = layout("conic-gradient(from 90deg, red, blue)");
    assert.equal(result.kind, GRADIENT_CONIC);
    // Straight right is where it starts; straight down a quarter of the way
    // round from there.
    assertClose([rampPosition(result, 150, 50), rampPosition(result, 100, 90)], [0, 0.25]);
  });

  test("a tile with no area draws nothing", () => {
    assert.equal(
      layoutGradient(parseBackground({ image: "linear-gradient(red, blue)" }), {
        width: 0,
        height: 0,
        border: [0, 0, 0, 0],
        padding: [0, 0, 0, 0],
      }),
      null,
    );
  });

  test("percentage stops keep their ramp through a resize; px stops do not", () => {
    const percent = "linear-gradient(red 10%, blue 90%)";
    assert.equal(layout(percent).rampKey, layout(percent, {}, { ...BOX, width: 400 }).rampKey);
    const px = "linear-gradient(to right, red 10px, blue 90%)";
    assert.notEqual(layout(px).rampKey, layout(px, {}, { ...BOX, width: 400 }).rampKey);
  });
});

describe("ramps", () => {
  test("a texel holds the colour its place along the line has", () => {
    const result = layout("linear-gradient(to right, rgb(0, 0, 0), rgb(255, 255, 255))");
    const texels = bakeRamp(result.ramp);
    assert.equal(texels.length, RAMP_WIDTH * 4);
    assert.deepEqual([...texels.slice(0, 4)], [0, 0, 0, 255]);
    assert.deepEqual([...texels.slice(-4)], [255, 255, 255, 255]);
    const middle = (RAMP_WIDTH / 2) * 4;
    assert.ok(Math.abs(texels[middle] - 128) <= 1);
  });

  test("a repeating ramp is phased so fract(t / period) finds the right texel", () => {
    // Starts 30px in, repeats every 40px: a start that is not a whole number
    // of periods, which is what the phase exists for.
    const result = layout(
      "repeating-linear-gradient(to right, rgb(255, 0, 0) 30px, rgb(0, 0, 255) 50px, rgb(0, 255, 0) 70px)",
    );
    const texels = bakeRamp(result.ramp);
    const { start, period } = result.ramp;
    for (const x of [3, 31, 47, 69, 101, 144, 199]) {
      const t = rampPosition(result, x, 0);
      const u = t - Math.floor(t);
      const i = Math.round(u * (RAMP_WIDTH - 1));
      const line = x / 200;
      const within = start + ((((line - start) % period) + period) % period);
      const expected = colorAt(result.ramp, within).map((c) => Math.round(c * 255));
      const actual = [...texels.slice(i * 4, i * 4 + 4)];
      actual.forEach((value, c) => {
        assert.ok(
          Math.abs(value - expected[c]) <= 3,
          `x=${x}: texel ${i} is [${actual}], wanted [${expected}]`,
        );
      });
    }
  });

  test("a repeating gradient with no period is its average colour", () => {
    const result = layout("repeating-linear-gradient(rgb(255, 0, 0) 10px, rgb(0, 0, 255) 10px)");
    assert.equal(result.repeating, false);
    assert.equal(result.ramp.stops.length, 1);
    assertClose(result.ramp.stops[0].color, [0.5, 0, 0.5, 1]);
  });
});

describe("the ramp atlas", () => {
  test("boxes wearing one gradient share a row; a row goes when its last user does", () => {
    const result = layout("linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))");
    const before = rampAtlas.size;
    const a = new RampSlot();
    const b = new RampSlot();
    const row = a.set(result);
    assert.equal(b.set(result), row);
    assert.equal(rampAtlas.size, before + 1);
    a.release();
    assert.equal(rampAtlas.size, before + 1);
    b.release();
    assert.equal(rampAtlas.size, before);
  });

  test("setting the ramp a slot already holds is free", () => {
    const result = layout("linear-gradient(rgb(7, 8, 9), rgb(10, 11, 12))");
    const slot = new RampSlot();
    slot.set(result);
    const texture = rampUniforms.uRamp.value;
    assert.ok(texture);
    const version = texture.version;
    slot.set(layout("linear-gradient(rgb(7, 8, 9), rgb(10, 11, 12))", {}, { ...BOX, width: 300 }));
    assert.equal(texture.version, version, "no upload for a ramp that did not change");
    slot.release();
  });

  test("moving to another gradient hands the old row back", () => {
    const slot = new RampSlot();
    const before = rampAtlas.size;
    slot.set(layout("linear-gradient(rgb(20, 0, 0), rgb(0, 0, 20))"));
    slot.set(layout("linear-gradient(rgb(0, 20, 0), rgb(0, 0, 20))"));
    assert.equal(rampAtlas.size, before + 1);
    slot.set(null);
    assert.equal(rampAtlas.size, before);
  });

  test("the atlas grows without moving the rows it has handed out", () => {
    /** @type {RampSlot[]} */
    const slots = [];
    const first = new RampSlot();
    const firstRow = first.set(layout("linear-gradient(rgb(99, 0, 0), rgb(0, 0, 99))"));
    const height = rampUniforms.uRampHeight.value;
    for (let i = 0; i < height + 1; i++) {
      const slot = new RampSlot();
      slot.set(layout(`linear-gradient(rgb(${i % 256}, ${Math.floor(i / 256)}, 1), rgb(0, 0, 0))`));
      slots.push(slot);
    }
    assert.ok(rampUniforms.uRampHeight.value > height);
    const texture = rampUniforms.uRamp.value;
    assert.ok(texture);
    assert.equal(texture.image.height, rampUniforms.uRampHeight.value);
    // Its texels came along too.
    const at = firstRow * RAMP_WIDTH * 4;
    const data = texture.image.data;
    assert.ok(data);
    assert.deepEqual([...data.slice(at, at + 4)], [99, 0, 0, 255]);
    first.release();
    for (const slot of slots) {
      slot.release();
    }
  });
});
