import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fitImage, parseObjectPosition } from "./objectFit.js";

/**
 * @param {number} percent
 * @param {number} length
 */
const at = (percent, length) => ({ percent, length });

describe("parseObjectPosition", () => {
  test("nothing, or something unparseable, centres both axes", () => {
    assert.deepEqual(parseObjectPosition(""), [at(50, 0), at(50, 0)]);
    // The edge-relative four-value syntax, which browsers do produce.
    assert.deepEqual(parseObjectPosition("right 10px bottom 20px"), [at(50, 0), at(50, 0)]);
    // calc() is not arithmetic this file does; centring beats guessing.
    assert.deepEqual(parseObjectPosition("calc(100% - 10px) 50%"), [at(50, 0), at(50, 0)]);
  });

  test("the computed form browsers actually hand over", () => {
    assert.deepEqual(parseObjectPosition("50% 50%"), [at(50, 0), at(50, 0)]);
    assert.deepEqual(parseObjectPosition("0% 100%"), [at(0, 0), at(100, 0)]);
    assert.deepEqual(parseObjectPosition("12px 30px"), [at(0, 12), at(0, 30)]);
    // Both at once is legal, and the reason a component carries both numbers.
    assert.deepEqual(parseObjectPosition("10px 50%"), [at(0, 10), at(50, 0)]);
  });

  test("keywords, in either order", () => {
    assert.deepEqual(parseObjectPosition("left top"), [at(0, 0), at(0, 0)]);
    assert.deepEqual(parseObjectPosition("top left"), [at(0, 0), at(0, 0)]);
    assert.deepEqual(parseObjectPosition("bottom right"), [at(100, 0), at(100, 0)]);
    assert.deepEqual(parseObjectPosition("center bottom"), [at(50, 0), at(100, 0)]);
  });

  test("one value leaves the other axis centred, whichever axis was named", () => {
    assert.deepEqual(parseObjectPosition("right"), [at(100, 0), at(50, 0)]);
    assert.deepEqual(parseObjectPosition("bottom"), [at(50, 0), at(100, 0)]);
    assert.deepEqual(parseObjectPosition("25%"), [at(25, 0), at(50, 0)]);
  });
});

describe("fitImage", () => {
  const box = { width: 100, height: 50 };
  /** A picture four times as wide as it is tall — the box is only twice. */
  const wide = { width: 200, height: 50 };

  test("fill takes the box, aspect ratio and all", () => {
    assert.deepEqual(fitImage("fill", "50% 50%", box, wide), {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    // The initial value, and what an unknown keyword falls back to.
    assert.deepEqual(fitImage("", "50% 50%", box, wide), { x: 0, y: 0, width: 100, height: 50 });
  });

  test("contain fits the whole picture in and centres what is left over", () => {
    // Scaled by 0.5 to get the width in, which leaves 25px of the height
    // unused — half of it above, half below.
    assert.deepEqual(fitImage("contain", "50% 50%", box, wide), {
      x: 0,
      y: 12.5,
      width: 100,
      height: 25,
    });
  });

  test("cover fills the box and lets the rest hang over the edges", () => {
    // No scaling needed to cover 50px of height, so the picture stays 200
    // wide in a 100-wide box and the overflow is split between both sides.
    assert.deepEqual(fitImage("cover", "50% 50%", box, wide), {
      x: -50,
      y: 0,
      width: 200,
      height: 50,
    });
  });

  test("object-position slides the crop, including out past a negative edge", () => {
    // A percentage of negative free space moves the picture the other way,
    // which is exactly how "show me the right-hand end" is expressed.
    assert.deepEqual(fitImage("cover", "100% 50%", box, wide).x, -100);
    assert.deepEqual(fitImage("cover", "left top", box, wide), {
      x: 0,
      y: 0,
      width: 200,
      height: 50,
    });
    // A length is an offset from the leading edge, free space or not.
    assert.deepEqual(fitImage("cover", "10px 0px", box, wide).x, 10);
  });

  test("none draws the picture at its own size", () => {
    assert.deepEqual(fitImage("none", "50% 50%", box, { width: 20, height: 10 }), {
      x: 40,
      y: 20,
      width: 20,
      height: 10,
    });
  });

  test("scale-down is none or contain, whichever is smaller", () => {
    // Already fits: left alone, like `none`.
    assert.deepEqual(fitImage("scale-down", "50% 50%", box, { width: 20, height: 10 }), {
      x: 40,
      y: 20,
      width: 20,
      height: 10,
    });
    // Does not fit: shrunk, like `contain`.
    assert.deepEqual(
      fitImage("scale-down", "50% 50%", box, wide),
      fitImage("contain", "50% 50%", box, wide),
    );
  });

  test("a picture with no intrinsic size takes the box, whatever the fit asked for", () => {
    // Which is what there is to draw before anything has decoded: the fit is
    // arithmetic over a ratio, and there is no ratio yet.
    for (const fit of ["fill", "contain", "cover", "none", "scale-down"]) {
      assert.deepEqual(fitImage(fit, "50% 50%", box, { width: 0, height: 0 }), {
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      });
    }
  });
});
