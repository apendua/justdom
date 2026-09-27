/**
 * A 2D canvas for a test runner that has none.
 *
 * jsdom lays out no text and draws none: `getContext("2d")` on its canvas
 * is null, and a run that goes to be rasterized throws. Text nodes are
 * kept out of the portal tests for that reason, but a text field draws its
 * value itself, from a canvas measurement rather than a range read, so a
 * test of one needs a canvas to measure and draw with. This is that
 * canvas: every character is seven px wide and every font ten tall, which
 * is all a test asserting *what* was drawn needs to know, and what was
 * drawn is recorded.
 */

const GLYPH_WIDTH = 7;
const ASCENT = 8;
const DESCENT = 2;

/**
 * Stand in for the document's canvases until `restore` is called. Only
 * `<canvas>` is intercepted; every other element is the real one.
 *
 * @returns {{
 *   drawn: string[],
 *   restore: () => void,
 * }}
 */
export function stubCanvas() {
  /** @type {string[]} */
  const drawn = [];
  const real = document.createElement;
  /**
   * @param {number} width
   * @param {number} height
   */
  const makeContext = (width, height) => ({
    font: "",
    fillStyle: "",
    textAlign: "",
    textBaseline: "",
    shadowColor: "",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowBlur: 0,
    imageSmoothingEnabled: false,
    lineWidth: 0,
    strokeStyle: "",
    scale() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    clearRect() {},
    drawImage() {},
    /** @param {string} text */
    fillText(text) {
      drawn.push(text);
    },
    /** @param {string} text */
    measureText(text) {
      return {
        width: text.length * GLYPH_WIDTH,
        fontBoundingBoxAscent: ASCENT,
        fontBoundingBoxDescent: DESCENT,
        actualBoundingBoxAscent: ASCENT,
        actualBoundingBoxDescent: DESCENT,
      };
    },
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     */
    getImageData(x, y, w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(Math.max(w * h * 4, 4)) };
    },
    canvas: { width, height },
  });
  // @ts-expect-error -- a stand-in for one tag, restored below.
  document.createElement = (/** @type {string} */ tag, /** @type {unknown} */ options) => {
    if (tag !== "canvas") {
      return real.call(document, tag, /** @type {ElementCreationOptions} */ (options));
    }
    const canvas = {
      width: 0,
      height: 0,
      /** @type {ReturnType<typeof makeContext> | null} */
      context: null,
      getContext() {
        if (!canvas.context) {
          canvas.context = makeContext(canvas.width, canvas.height);
        }
        return canvas.context;
      },
    };
    return canvas;
  };
  return {
    drawn,
    restore: () => {
      document.createElement = real;
    },
  };
}

export const STUB_GLYPH_WIDTH = GLYPH_WIDTH;
export const STUB_ASCENT = ASCENT;
export const STUB_DESCENT = DESCENT;
