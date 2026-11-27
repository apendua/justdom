import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BAND_AREA, cutIntoBands } from "./textBands.js";

/**
 * Lines of one height stacked from the top, each as wide as `width`.
 *
 * @param {number} count
 * @param {number} width
 * @param {number} height
 * @param {(index: number) => string} [text]
 */
function stacked(count, width, height, text = (index) => `line ${index}`) {
  return Array.from({ length: count }, (_, index) => ({
    text: text(index),
    left: 0,
    top: index * height,
    width,
    height,
  }));
}

describe("cutIntoBands", () => {
  test("lines within the area are one band, the node as it was measured", () => {
    const lines = stacked(3, 100, 20);
    const bounds = { width: 100, height: 60 };

    const bands = cutIntoBands(lines, bounds, 5, [], 6000);

    assert.equal(bands.length, 1);
    assert.equal(bands[0].top, 0, "no room above");
    assert.equal(bands[0].lines, lines);
    assert.equal(bands[0].bounds, bounds);
  });

  test("lines past the area are cut into bands of whole lines within it", () => {
    // Ten lines of 100 by 20 px, and room for three in a band.
    const lines = stacked(10, 100, 20);

    const bands = cutIntoBands(lines, { width: 100, height: 200 }, 0, [], 6000);

    assert.deepEqual(
      bands.map((band) => [band.top, band.bounds.height, band.lines.length]),
      [
        [0, 60, 3],
        [60, 60, 3],
        [120, 60, 3],
        [180, 20, 1],
      ],
    );
    for (const band of bands) {
      assert.equal(band.bounds.width, 100, "as wide as the node");
      assert.deepEqual(
        band.lines.map((line) => line.top),
        band.lines.map((_, index) => index * 20),
        "placed from the band's top",
      );
    }
    assert.deepEqual(
      bands.flatMap((band) => band.lines.map((line) => line.text)),
      lines.map((line) => line.text),
      "every line once, in order",
    );
  });

  test("a line larger than the area is a band of its own, uncut", () => {
    const lines = stacked(2, 1000, 20);

    const bands = cutIntoBands(lines, { width: 1000, height: 40 }, 0, [], 6000);

    assert.deepEqual(
      bands.map((band) => band.lines.length),
      [1, 1],
    );
  });

  test("a band of a cut node starts above its first line by the room asked for", () => {
    const lines = stacked(4, 100, 20);

    const bands = cutIntoBands(lines, { width: 100, height: 80 }, 5, [], 5000);

    // Two lines and the room are 45 px, and a third would be 65.
    assert.deepEqual(
      bands.map((band) => [band.top, band.bounds.height, band.lines.map((line) => line.top)]),
      [
        [-5, 45, [5, 25]],
        [35, 45, [5, 25]],
      ],
    );
  });

  test("the last band runs to the bottom of the node's bounds", () => {
    const lines = stacked(4, 100, 20);

    // Bounds a little taller than the lines, as a measured node's can be.
    const bands = cutIntoBands(lines, { width: 100, height: 83 }, 0, [], 4000);

    assert.deepEqual(
      bands.map((band) => band.bounds.height),
      [40, 43],
    );
  });

  test("a band whose lines did not change is the object it was", () => {
    const bounds = { width: 100, height: 200 };
    const before = cutIntoBands(stacked(10, 100, 20), bounds, 0, [], 6000);

    // The same lines measured again, as new objects, with one retyped.
    const after = cutIntoBands(
      stacked(10, 100, 20, (index) => (index === 4 ? "retyped" : `line ${index}`)),
      { ...bounds },
      0,
      before,
      6000,
    );

    assert.notEqual(after, before);
    assert.equal(after[0], before[0]);
    assert.notEqual(after[1], before[1], "the band with the retyped line");
    assert.equal(after[2], before[2]);
    assert.equal(after[3], before[3]);
  });

  test("the same bands again are the array they were", () => {
    const bounds = { width: 100, height: 200 };
    const before = cutIntoBands(stacked(10, 100, 20), bounds, 0, [], 6000);

    assert.equal(cutIntoBands(stacked(10, 100, 20), { ...bounds }, 0, before, 6000), before);
    // One band less is another array, of the bands that stayed.
    const fewer = cutIntoBands(stacked(9, 100, 20), { width: 100, height: 180 }, 0, before, 6000);
    assert.notEqual(fewer, before);
    assert.equal(fewer.length, 3);
    assert.equal(fewer[0], before[0]);
  });

  test("the area a band may cover is a megabyte at the top step", () => {
    assert.equal(BAND_AREA * 16 * 4, 1024 * 1024);
  });
});
