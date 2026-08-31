import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTextCanvas, isTintableText } from "./textHelpers.js";

/**
 * @param {Partial<CSSStyleDeclaration>} style
 * @returns {CSSStyleDeclaration}
 */
function styleOf(style) {
  return /** @type {CSSStyleDeclaration} */ (style);
}

describe("isTintableText", () => {
  test("plain text is a mask: the material carries the color", () => {
    assert.equal(isTintableText(styleOf({})), true);
    assert.equal(isTintableText(styleOf({ textShadow: "none", color: "rgb(20, 30, 40)" })), true);
  });

  test("a shadow bakes: it must not take the text's color", () => {
    assert.equal(isTintableText(styleOf({ textShadow: "rgb(0, 0, 0) 2px 2px 4px" })), false);
  });

  test("a decoration in currentcolor tints along with the glyphs", () => {
    assert.equal(isTintableText(styleOf({ textDecorationLine: "underline" })), true);
    assert.equal(
      isTintableText(
        styleOf({ textDecorationLine: "underline", textDecorationColor: "currentcolor" }),
      ),
      true,
    );
  });

  test("an explicitly colored decoration bakes: two colors, one mask", () => {
    assert.equal(
      isTintableText(
        styleOf({ textDecorationLine: "underline", textDecorationColor: "rgb(255, 0, 0)" }),
      ),
      false,
    );
  });

  test("an explicit decoration color without a decoration is no decoration", () => {
    assert.equal(
      isTintableText(
        styleOf({ textDecorationLine: "none", textDecorationColor: "rgb(255, 0, 0)" }),
      ),
      true,
    );
  });
});

describe("createTextCanvas", () => {
  /**
   * Stands in for the one call this makes on the document, since jsdom has
   * no canvas to give and the argument under test is the one it would be
   * asked with. `document` itself is read-only here; its method is not.
   *
   * @param {(type: string, options: unknown) => unknown} getContext
   */
  function withStubbedCanvas(getContext) {
    const canvas = { width: 0, height: 0, getContext };
    const real = document.createElement;
    // @ts-expect-error -- a stand-in for one tag, restored below.
    document.createElement = () => canvas;
    return {
      canvas,
      restore: () => {
        document.createElement = real;
      },
    };
  }

  test("asks for a canvas it can read back from cheaply", () => {
    /** @type {unknown[]} */
    const asked = [];
    const stub = withStubbedCanvas((type, options) => {
      asked.push({ type, options });
      return {};
    });
    try {
      const made = createTextCanvas(37, 11);
      assert.equal(made.canvas, stub.canvas);
      assert.equal(stub.canvas.width, 37);
      assert.equal(stub.canvas.height, 11);
      // The whole point: without this the pixels come back off the GPU, and
      // the frame waits for them once per run.
      assert.deepEqual(asked, [{ type: "2d", options: { willReadFrequently: true } }]);
    } finally {
      stub.restore();
    }
  });

  test("says so rather than handing back a canvas with no context", () => {
    const stub = withStubbedCanvas(() => null);
    try {
      assert.throws(() => createTextCanvas(1, 1), /2D context/);
    } finally {
      stub.restore();
    }
  });
});
