import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  canDrawHtmlInCanvas,
  createElementTexture,
  drawInCanvas,
  htmlTextureMaterial,
  paintedElement,
} from "./htmlTexture.js";

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

test("a browser with both halves of the shipping HTML-in-Canvas can", () => {
  stub(constructor("WebGL2RenderingContext").prototype, "texElementSubImage2D");
  assert.equal(canDrawHtmlInCanvas(), false, "the upload alone is not enough");
  stub(constructor("HTMLCanvasElement").prototype, "requestPaint");
  assert.equal(canDrawHtmlInCanvas(), true);
});

test("the names Chromium had before 155 do not count", () => {
  stub(constructor("WebGL2RenderingContext").prototype, "texElementImage2D");
  stub(constructor("HTMLCanvasElement").prototype, "requestPaint");
  assert.equal(canDrawHtmlInCanvas(), false);
});

test("the material decodes the texture's sRGB in its shader", () => {
  const material = htmlTextureMaterial();
  assert.deepEqual(material.defines, { DECODE_VIDEO_TEXTURE: "" });
  assert.equal(material.transparent, true);
  assert.equal(material.map, null);
});

test("an element drawn in a canvas is a drawable child of it, and asks for a paint", () => {
  const canvas = document.createElement("canvas");
  let asked = 0;
  Object.assign(canvas, { requestPaint: () => asked++ });
  const desk = document.createElement("div");
  const note = document.createElement("div");
  document.body.append(desk);

  const undrawDesk = drawInCanvas(canvas, desk);
  const undrawNote = drawInCanvas(canvas, note);
  assert.equal(canvas.getAttribute("content"), "drawable");
  assert.equal(desk.parentElement, canvas);
  assert.equal(desk.hasAttribute("drawable"), true);
  assert.equal(asked, 2);

  document.body.append(desk);
  undrawDesk();
  assert.equal(desk.hasAttribute("drawable"), false);
  assert.equal(canvas.getAttribute("content"), "drawable", "the note is still drawn there");
  note.remove();
  undrawNote();
  assert.equal(canvas.hasAttribute("content"), false);
  desk.remove();
});

test("a paint painted an element when it lists it", () => {
  const panel = /** @type {Element} */ ({});
  const other = /** @type {Element} */ ({});
  const paint = (/** @type {Element[]} */ changedElements) =>
    /** @type {Event} */ (/** @type {unknown} */ ({ changedElements }));
  assert.equal(paintedElement(paint([panel]), panel), true);
  assert.equal(paintedElement(paint([other]), panel), false);
  assert.equal(paintedElement(paint([]), panel), false, "a requested paint with no change");
});

/**
 * A renderer whose context records the calls an element texture makes.
 *
 * @returns {{ renderer: THREE.WebGLRenderer, calls: unknown[][], bound: unknown[] }}
 */
function recordingRenderer() {
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {unknown[]} */
  const bound = [];
  const glTexture = { name: "the element's" };
  const record =
    (/** @type {string} */ name) =>
    (/** @type {unknown[]} */ ...args) => {
      calls.push([name, ...args]);
    };
  const gl = {
    TEXTURE_2D: "TEXTURE_2D",
    RGBA8: "RGBA8",
    RGBA: "RGBA",
    UNSIGNED_BYTE: "UNSIGNED_BYTE",
    UNPACK_FLIP_Y_WEBGL: "UNPACK_FLIP_Y_WEBGL",
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: "UNPACK_PREMULTIPLY_ALPHA_WEBGL",
    createTexture: () => glTexture,
    deleteTexture: record("deleteTexture"),
    texImage2D: record("texImage2D"),
    texParameteri: () => {},
    pixelStorei: record("pixelStorei"),
    texElementSubImage2D: record("texElementSubImage2D"),
  };
  const renderer = {
    getContext: () => gl,
    state: {
      bindTexture: (/** @type {unknown} */ _type, /** @type {unknown} */ texture) =>
        bound.push(texture),
      unbindTexture: () => bound.push(null),
    },
  };
  return { renderer: /** @type {never} */ (renderer), calls, bound };
}

test("an element texture allocates at the element's size and draws the whole element into it", () => {
  const { renderer, calls, bound } = recordingRenderer();
  const element = document.createElement("div");
  let size = { offsetWidth: 160, offsetHeight: 100 };
  Object.defineProperties(element, {
    offsetWidth: { get: () => size.offsetWidth },
    offsetHeight: { get: () => size.offsetHeight },
  });
  const { texture, upload } = createElementTexture(renderer, element);
  assert.ok(texture instanceof THREE.ExternalTexture);
  assert.deepEqual(bound, [], "nothing is touched before the first paint");

  upload();
  upload();
  const allocations = () => calls.filter(([name]) => name === "texImage2D");
  const draws = () => calls.filter(([name]) => name === "texElementSubImage2D");
  assert.equal(allocations().length, 1, "storage is allocated once for one size");
  assert.deepEqual(allocations()[0].slice(4, 6), [160, 100]);
  assert.equal(draws().length, 2);
  assert.deepEqual(draws()[1], [
    "texElementSubImage2D",
    "TEXTURE_2D",
    0,
    0,
    0,
    element,
    { width: 160, height: 100 },
  ]);
  assert.deepEqual(bound.slice(0, 2), [texture.sourceTexture, null], "bound through three's state");

  size = { offsetWidth: 200, offsetHeight: 120 };
  upload();
  assert.equal(allocations().length, 2, "a new size is allocated anew");
  assert.deepEqual(allocations()[1].slice(4, 6), [200, 120]);
});

test("an element texture holds the element at the page's pixel ratio", () => {
  const global = /** @type {{ devicePixelRatio?: number }} */ (globalThis);
  const before = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
  Object.defineProperty(globalThis, "devicePixelRatio", { value: 1.5, configurable: true });
  restores.push(() => {
    delete global.devicePixelRatio;
    if (before) {
      Object.defineProperty(globalThis, "devicePixelRatio", before);
    }
  });
  const { renderer, calls } = recordingRenderer();
  const element = document.createElement("div");
  Object.defineProperties(element, {
    offsetWidth: { value: 101 },
    offsetHeight: { value: 40 },
  });
  createElementTexture(renderer, element).upload();
  const draw = calls.find(([name]) => name === "texElementSubImage2D");
  assert.deepEqual(draw?.at(-1), { width: 152, height: 60 });
});

test("an element texture's rows follow its flipY, whatever three left set", () => {
  const { renderer, calls } = recordingRenderer();
  const element = document.createElement("div");
  const { texture, upload } = createElementTexture(renderer, element);
  const flips = () =>
    calls.filter(([name, what]) => name === "pixelStorei" && what === "UNPACK_FLIP_Y_WEBGL");
  upload();
  texture.flipY = false;
  upload();
  assert.deepEqual(
    flips().map(([, , value]) => value),
    [true, false],
  );
});

test("disposing an element texture deletes its WebGL texture", () => {
  const { renderer, calls } = recordingRenderer();
  const { texture, dispose } = createElementTexture(renderer, document.createElement("div"));
  dispose();
  assert.deepEqual(
    calls.filter(([name]) => name === "deleteTexture"),
    [["deleteTexture", texture.sourceTexture]],
  );
});
