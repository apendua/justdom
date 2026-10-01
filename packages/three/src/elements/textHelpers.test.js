import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Derived } from "@apendua/signal";
import {
  buildTextMipmaps,
  createTextCanvas,
  generateTextTexture,
  getRenderBleed,
  getTextRenderStyle,
  isTintableText,
  parseTextShadow,
} from "./textHelpers.js";

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

describe("buildTextMipmaps", () => {
  /**
   * The canvases the chain is made of, as the chain makes them. Each one
   * remembers what was drawn into it, which is the half of this worth
   * asserting: that a level is the level above it halved, and not level 0
   * resampled five times over.
   */
  function withStubbedCanvases() {
    /**
     * @type {{
     *   width: number,
     *   height: number,
     *   drawn: { source: unknown, width: number, height: number }[],
     *   getContext: () => unknown,
     * }[]}
     */
    const made = [];
    const real = document.createElement;
    // @ts-expect-error -- a stand-in for one tag, restored below.
    document.createElement = () => {
      const canvas = {
        width: 0,
        height: 0,
        /** @type {{ source: unknown, width: number, height: number }[]} */
        drawn: [],
        getContext: () => ({
          imageSmoothingEnabled: false,
          /**
           * @param {unknown} source
           * @param {number} x
           * @param {number} y
           * @param {number} width
           * @param {number} height
           */
          drawImage: (source, x, y, width, height) => {
            canvas.drawn.push({ source, width, height });
          },
        }),
      };
      made.push(canvas);
      return canvas;
    };
    return {
      made,
      restore: () => {
        document.createElement = real;
      },
    };
  }

  test("goes all the way down to 1x1, halving as the driver would", () => {
    const base = /** @type {HTMLCanvasElement} */ (
      /** @type {unknown} */ ({ width: 37, height: 11 })
    );
    const stub = withStubbedCanvases();
    try {
      const chain = buildTextMipmaps(base);
      // Level 0 is the run's own canvas, not a copy of it.
      assert.equal(chain[0], base);
      assert.deepEqual(chain.slice(1), stub.made);
      // A level short of 1x1 is a texture `LinearMipmapLinearFilter` cannot
      // sample, so the count is the point as much as the sizes are.
      assert.deepEqual(
        stub.made.map((canvas) => `${canvas.width}x${canvas.height}`),
        ["18x5", "9x2", "4x1", "2x1", "1x1"],
      );
    } finally {
      stub.restore();
    }
  });

  test("each level is drawn from the one above it, whole", () => {
    const base = /** @type {HTMLCanvasElement} */ (
      /** @type {unknown} */ ({ width: 8, height: 4 })
    );
    const stub = withStubbedCanvases();
    try {
      buildTextMipmaps(base);
      assert.deepEqual(
        stub.made.map((canvas) => canvas.drawn),
        [
          [{ source: base, width: 4, height: 2 }],
          [{ source: stub.made[0], width: 2, height: 1 }],
          [{ source: stub.made[1], width: 1, height: 1 }],
        ],
      );
    } finally {
      stub.restore();
    }
  });

  test("a run that is already one texel is a chain of one", () => {
    const base = /** @type {HTMLCanvasElement} */ (
      /** @type {unknown} */ ({ width: 1, height: 1 })
    );
    const stub = withStubbedCanvases();
    try {
      assert.deepEqual(buildTextMipmaps(base), [base]);
      assert.deepEqual(stub.made, []);
    } finally {
      stub.restore();
    }
  });
});

describe("parseTextShadow", () => {
  test("reads the computed serialization: color first, in functional form", () => {
    // What `getComputedStyle` actually returns for `text-shadow: 2px 3px 4px
    // black`. Splitting this on every comma leaves `rgb(0`, which is how this
    // parsed to nothing at all for as long as it did.
    assert.deepEqual(parseTextShadow("rgb(0, 0, 0) 2px 3px 4px"), {
      color: "rgb(0, 0, 0)",
      offsetX: 2,
      offsetY: 3,
      blur: 4,
    });
  });

  test("keeps the alpha of an rgba color", () => {
    assert.deepEqual(parseTextShadow("rgba(0, 0, 0, 0.5) 2px 3px 4px"), {
      color: "rgba(0, 0, 0, 0.5)",
      offsetX: 2,
      offsetY: 3,
      blur: 4,
    });
  });

  test("reads the modern color syntaxes an engine may serialize to", () => {
    assert.equal(parseTextShadow("rgb(0 0 0 / 50%) 1px 1px")?.color, "rgb(0 0 0 / 50%)");
    assert.equal(parseTextShadow("oklch(0.7 0.1 200) 1px 1px")?.color, "oklch(0.7 0.1 200)");
    assert.equal(parseTextShadow("color(srgb 1 0 0) 1px 1px")?.color, "color(srgb 1 0 0)");
  });

  test("takes the first layer, which is the one CSS paints on top", () => {
    // Documented limit rather than an accident: the canvas has one shadow.
    assert.deepEqual(parseTextShadow("rgb(0, 0, 0) 2px 3px 4px, rgb(255, 0, 0) 1px 1px 0px"), {
      color: "rgb(0, 0, 0)",
      offsetX: 2,
      offsetY: 3,
      blur: 4,
    });
  });

  test("two lengths are a shadow: the blur is optional and offsets may be negative", () => {
    assert.deepEqual(parseTextShadow("rgb(0, 0, 0) -2px -3px"), {
      color: "rgb(0, 0, 0)",
      offsetX: -2,
      offsetY: -3,
      blur: 0,
    });
    assert.deepEqual(parseTextShadow("rgb(0, 0, 0) 0.5px -1.25px 2.5px"), {
      color: "rgb(0, 0, 0)",
      offsetX: 0.5,
      offsetY: -1.25,
      blur: 2.5,
    });
  });

  test("reads author syntax too, color-last, without taking `px` for a color", () => {
    assert.deepEqual(parseTextShadow("2px 3px 4px black"), {
      color: "black",
      offsetX: 2,
      offsetY: 3,
      blur: 4,
    });
    assert.deepEqual(parseTextShadow("#000 2px 3px"), {
      color: "#000",
      offsetX: 2,
      offsetY: 3,
      blur: 0,
    });
  });

  test("a layer that names no color leaves it to the paint", () => {
    // `null` means currentcolor: the text's own color, which the parse has
    // no way of knowing.
    assert.deepEqual(parseTextShadow("2px 3px"), {
      color: null,
      offsetX: 2,
      offsetY: 3,
      blur: 0,
    });
  });

  test("no shadow: none, empty, one length, or a color nothing can paint", () => {
    assert.equal(parseTextShadow("none"), null);
    assert.equal(parseTextShadow(""), null);
    assert.equal(parseTextShadow("rgb(0, 0, 0) 2px"), null);
    // Better no shadow than one the canvas declines to set and never says so.
    assert.equal(parseTextShadow("calc(1px) 2px 3px"), null);
    assert.equal(parseTextShadow("rgb(0, 0, 0) 2px 3px !important"), null);
  });
});

describe("getRenderBleed", () => {
  test("a run with no shadow gets the bare margin", () => {
    assert.deepEqual(getRenderBleed(null), { right: 2, bottom: 2 });
  });

  test("the texture grows by offset plus blur, so the shadow is not clipped", () => {
    const shadow = parseTextShadow("rgb(0, 0, 0) 2px 3px 4px");
    assert.deepEqual(getRenderBleed(shadow), { right: 2 + 2 + 4, bottom: 2 + 3 + 4 });
  });

  test("a shadow cast up and left needs no room on the right or bottom", () => {
    // The bleed is one-sided: the texture starts at the run's origin, so a
    // negative offset moves the shadow into space the glyphs already own.
    const shadow = parseTextShadow("rgb(0, 0, 0) -2px -3px");
    assert.deepEqual(getRenderBleed(shadow), { right: 2, bottom: 2 });
  });
});

describe("getTextRenderStyle", () => {
  // `normalizeColor` resolves a colour through a probe element, and the
  // jsdom environment installs `window` without putting `getComputedStyle`
  // on the global. Lending it for the suite is cheaper than widening what
  // the environment installs for one helper.
  const missing = typeof globalThis.getComputedStyle === "undefined";
  before(() => {
    if (missing) {
      globalThis.getComputedStyle = (element) => window.getComputedStyle(element);
    }
  });
  after(() => {
    if (missing) {
      // @ts-expect-error -- putting back what was not there to begin with.
      globalThis.getComputedStyle = undefined;
    }
  });

  test("builds a font string a canvas will actually take", () => {
    const style = getTextRenderStyle(
      styleOf({
        fontStyle: "normal",
        fontWeight: "600",
        fontSize: "32px",
        fontFamily: "sans-serif",
      }),
    );
    assert.equal(style.font, "normal normal 600 32px sans-serif");
    assert.equal(style.fontSize, 32);
  });

  test("small caps are the one variant the shorthand admits", () => {
    const style = getTextRenderStyle(
      styleOf({
        fontVariant: "small-caps",
        fontVariantCaps: "small-caps",
        fontSize: "16px",
        fontFamily: "serif",
      }),
    );
    assert.equal(style.font, "normal small-caps 400 16px serif");
    assert.equal(style.fontVariant, "small-caps");
  });

  /**
   * The `font-variant` slot of the canvas shorthand is the CSS2 one, and
   * `style.fontVariant` is the computed shorthand: an element carrying
   * `font-variant-numeric: tabular-nums` -- which is what anything with a
   * clock or a counter on it wants -- reports "tabular-nums" there. Passing
   * that through makes the whole font string invalid, and an invalid string
   * assigned to `context.font` is a no-op rather than a throw, so the run is
   * drawn in the canvas default of 10px sans-serif with no sign of anything
   * wrong. Nothing but the caps keyword may reach the shorthand.
   */
  test("a numeric variant does not reach the shorthand and void the font", () => {
    const style = getTextRenderStyle(
      styleOf({
        fontVariant: "tabular-nums",
        fontVariantCaps: "normal",
        fontWeight: "600",
        fontSize: "32px",
        fontFamily: "sans-serif",
      }),
    );
    assert.equal(style.font, "normal normal 600 32px sans-serif");
    assert.equal(style.fontVariant, "normal");
  });
});

describe("generateTextTexture", () => {
  // `textHelpers` resolves colours through a bare `getComputedStyle`, which
  // jsdom-env installs on `window` and not on the global.
  before(() => {
    if (typeof globalThis.getComputedStyle === "undefined") {
      globalThis.getComputedStyle = window.getComputedStyle;
    }
  });

  /**
   * How wide a canvas one short run is drawn on.
   *
   * @param {number} renderScale
   * @param {number} [unitScale]
   */
  const canvasWidth = (renderScale, unitScale) => {
    const style = getTextRenderStyle(
      styleOf({ fontSize: "10px", fontFamily: "sans-serif", color: "#ffffff" }),
    );
    const drawn = new Derived(() =>
      generateTextTexture(
        [{ text: "A", left: 0, top: 0, width: 10, height: 12 }],
        style,
        { width: 10, height: 12 },
        renderScale,
        true,
        unitScale,
      ),
    );
    const subscription = drawn.subscribe({});
    const width = /** @type {HTMLCanvasElement} */ (drawn.get().texture.image).width;
    subscription.unsubscribe();
    return width;
  };

  test("a panel's scale is capped, and a unit's size is multiplied in after it", () => {
    // The cap is MAX_TEXT_SCALE, 4: a panel asking for 64 gets 4.
    assert.equal(canvasWidth(64), canvasWidth(4));
    // A user unit eight CSS pixels wide is drawn eight times as finely,
    // however the cap stands.
    const base = canvasWidth(4);
    const scaled = canvasWidth(4, 8);
    assert.ok(scaled >= base * 8 - 8 && scaled <= base * 8, `${scaled} is about ${base} * 8`);
  });
});
