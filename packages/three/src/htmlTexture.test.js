import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { canDrawHtmlInCanvas, htmlTextureMaterial } from "./htmlTexture.js";

/** @type {(() => void)[]} */
const restores = [];

afterEach(() => {
  restores.splice(0).forEach((restore) => restore());
});

/**
 * The constructor `name` names, a bare class put in its place for the rest
 * of one test when this environment has none.
 *
 * @param {string} name
 * @returns {{ prototype: object }}
 */
function constructor(name) {
  const global = /** @type {Record<string, unknown>} */ (globalThis);
  if (!(name in global)) {
    global[name] = class {};
    restores.push(() => {
      delete global[name];
    });
  }
  return /** @type {{ prototype: object }} */ (global[name]);
}

/**
 * Give `prototype` a method called `name` for the rest of one test.
 *
 * @param {object} prototype
 * @param {string} name
 */
function stub(prototype, name) {
  Object.defineProperty(prototype, name, { value() {}, configurable: true });
  restores.push(() => {
    delete (/** @type {Record<string, unknown>} */ (prototype)[name]);
  });
}

test("a browser without HTML-in-Canvas cannot draw an element into a texture", () => {
  constructor("WebGL2RenderingContext");
  constructor("HTMLCanvasElement");
  assert.equal(canDrawHtmlInCanvas(), false);
});

test("a browser with both halves of HTML-in-Canvas can", () => {
  stub(constructor("WebGL2RenderingContext").prototype, "texElementImage2D");
  assert.equal(canDrawHtmlInCanvas(), false, "the upload alone is not enough");
  stub(constructor("HTMLCanvasElement").prototype, "requestPaint");
  assert.equal(canDrawHtmlInCanvas(), true);
});

test("the material decodes the texture's sRGB in its shader", () => {
  const material = htmlTextureMaterial();
  assert.deepEqual(material.defines, { DECODE_VIDEO_TEXTURE: "" });
  assert.equal(material.transparent, true);
  assert.equal(material.map, null);
});
