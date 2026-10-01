import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Derived } from "@apendua/signal";
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

describe("VisualProperties x-height", () => {
  test("measures with the fonts at hand, and follows loadingdone", () => {
    // The regression this pins down: while a font was on the wire, asking for
    // an x-height used to refuse (throw), and the refusal parked every box
    // that asked mid-load — under a second loading window, permanently, and a
    // whole panel's quads never drew. The contract now is to answer with the
    // fallback metrics immediately and re-measure when the loading period
    // closes.
    /** @type {Set<EventListener>} */
    const listeners = new Set();
    const fonts = {
      status: "loading",
      ready: new Promise(() => {}),
      /** @param {string} type @param {EventListener} listener */
      addEventListener: (type, listener) => {
        if (type === "loadingdone") {
          listeners.add(listener);
        }
      },
      /** @param {string} type @param {EventListener} listener */
      removeEventListener: (type, listener) => {
        listeners.delete(listener);
      },
    };
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });

    let probes = 0;
    const originalGetRect = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function countedRect() {
      probes += 1;
      return originalGetRect.call(this);
    };

    try {
      const properties = new VisualProperties();
      // A face name no other test shares: the cache is keyed by it.
      const ratio = new Derived(() =>
        properties.getRelativeXHeight("XHeightRegressionFace", "400"),
      );
      const subscription = ratio.subscribe({ next: () => ratio.get() });

      assert.equal(typeof ratio.get(), "number", "answers instead of refusing while fonts load");
      assert.equal(probes, 1, "measured with the fallback metrics");

      fonts.status = "loaded";
      // A snapshot, not the live set: re-measuring resubscribes, and a Set
      // being iterated visits entries added mid-iteration — forever.
      [...listeners].forEach((listener) => listener(new Event("loadingdone")));
      assert.ok(probes >= 2, "the loading period closing re-measures");

      subscription.unsubscribe();
    } finally {
      window.Element.prototype.getBoundingClientRect = originalGetRect;
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: {
          status: "loaded",
          ready: Promise.resolve(),
          addEventListener: () => {},
          removeEventListener: () => {},
        },
      });
    }
  });
});

describe("VisualProperties border colour", () => {
  test("a border on one side is drawn in that side's colour, not the text's", () => {
    // The sides with no border have a colour too, the text's, and the
    // computed shorthand lists them all.
    const properties = propertiesOf({
      color: "rgb(51, 51, 51)",
      borderBottom: "1px solid rgb(238, 238, 238)",
    });
    assert.equal(properties.borderBottomWidth, 1);
    assert.equal(properties.borderTopWidth, 0);
    assert.equal(properties.borderColor.getHex(), asThreeWouldParse("rgb(238, 238, 238)"));
    assert.equal(properties.borderAlpha, 1);
  });

  test("the first side that has a border decides it", () => {
    const properties = propertiesOf({
      color: "rgb(51, 51, 51)",
      borderRight: "2px solid rgb(255, 0, 0)",
      borderLeft: "2px solid rgb(0, 0, 255)",
    });
    assert.equal(properties.borderColor.getHex(), asThreeWouldParse("rgb(255, 0, 0)"));
  });

  test("a transparent side has no say either", () => {
    // Tabs keep their heights equal with a transparent border over the
    // underline that marks the chosen one.
    const properties = propertiesOf({
      color: "rgb(51, 51, 51)",
      borderTop: "2px solid transparent",
      borderBottom: "2px solid rgb(0, 123, 255)",
    });
    assert.equal(properties.borderColor.getHex(), asThreeWouldParse("rgb(0, 123, 255)"));
    assert.equal(properties.borderAlpha, 1);
  });

  test("a border all round is drawn in its colour", () => {
    const properties = propertiesOf({ border: "2px solid rgb(0, 123, 255)" });
    assert.equal(properties.borderColor.getHex(), asThreeWouldParse("rgb(0, 123, 255)"));
  });
});

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
