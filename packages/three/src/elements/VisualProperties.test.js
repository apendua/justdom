import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import VisualProperties from "./VisualProperties.js";

// Same stub as div.test.js: jsdom has no Font Loading API, and
// `VisualProperties` will not measure text until `document.fonts` says the
// fonts are in. Nothing here measures text.
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: {
    status: "loaded",
    ready: Promise.resolve(),
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

/**
 * @param {Partial<CSSStyleDeclaration>} style
 * @returns {VisualProperties}
 */
function propertiesOf(style) {
  const element = document.createElement("div");
  Object.assign(element.style, style);
  document.body.appendChild(element);
  const properties = new VisualProperties();
  properties.setFromElement(element);
  return properties;
}

/**
 * What three.js itself makes of the same colour written as CSS. Reaching the
 * same answer is the whole contract: a stylesheet is authored in sRGB, so a
 * colour has to arrive in the scene as the one that was written down.
 *
 * @param {string} css
 */
function asThreeWouldParse(css) {
  return new THREE.Color().setStyle(css, THREE.SRGBColorSpace).getHex();
}

describe("VisualProperties colours", () => {
  test("reads a background colour as sRGB", () => {
    const properties = propertiesOf({ backgroundColor: "rgb(18, 22, 28)" });
    assert.equal(properties.backgroundColor.getHex(), asThreeWouldParse("rgb(18, 22, 28)"));
    assert.equal(properties.backgroundAlpha, 1);
  });

  test("reads a border colour as sRGB, with its alpha", () => {
    const properties = propertiesOf({ borderColor: "rgba(255, 210, 31, 0.5)" });
    assert.equal(properties.borderColor.getHex(), asThreeWouldParse("rgb(255, 210, 31)"));
    assert.equal(properties.borderAlpha, 0.5);
  });

  test("does not lighten a dark colour", () => {
    // The failure this guards against: taking the channels for linear values
    // turned a near-black card into mid grey, and every panel with it.
    const properties = propertiesOf({ backgroundColor: "rgb(18, 22, 28)" });
    const { r, g, b } = properties.backgroundColor;
    assert.ok(Math.max(r, g, b) < 0.02, `expected a dark colour, got ${r}, ${g}, ${b}`);
  });
});
