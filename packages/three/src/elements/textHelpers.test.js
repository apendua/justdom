import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isTintableText } from "./textHelpers.js";

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
