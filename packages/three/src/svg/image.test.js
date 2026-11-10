import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createMirror } from "../elements/mirror.js";
import { clipMatrixOf } from "../test/clipUniforms.js";
import { acquireImage, releaseIdleImages, releaseImage } from "../elements/image.js";
import { parsePreserveAspectRatio } from "./geometry.js";
import {
  buildImageGeometry,
  getSvgImageSource,
  image,
  placeImage,
  trimImageGeometry,
} from "./image.js";
import { UNCLIPPED } from "../elements/clip.js";
import { shape } from "./shape.js";

/**
 * @import { Mesh, MeshBasicMaterial, Object3D } from "three";
 */

// As in `elements/image.test.js`, each test starts from an empty texture
// cache, with no picture left idle by the test before.
afterEach(() => releaseIdleImages());

// jsdom-env installs the common DOM globals, but not DOMParser, which three's
// SVGLoader parses its document with.
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = window.DOMParser;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** A data URL, so nothing here can reach for a network. */
const PICTURE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAP8AAAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";

/** @param {string} value */
const aspect = (value) => parsePreserveAspectRatio(value);

/**
 * @param {number} value
 */
function round(value) {
  return Math.round(value * 1e4) / 1e4 + 0;
}

/**
 * A stand-in for a decoded picture: the placement reads its width and height
 * and nothing else. `TextureLoader` is typed to hand back an element's
 * texture, so the stand-in claims to be one.
 *
 * @param {number} width
 * @param {number} height
 */
function fakeTexture(width, height) {
  return new THREE.Texture(/** @type {HTMLImageElement} */ ({ width, height }));
}

/**
 * Make every load answer at once with a picture of the given size, for the
 * length of `body`.
 *
 * @param {THREE.Texture} texture
 * @param {() => void} body
 */
function withLoadedPictures(texture, body) {
  const original = THREE.TextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = function (_url, onLoad) {
    onLoad?.(texture);
    return texture;
  };
  try {
    body();
  } finally {
    THREE.TextureLoader.prototype.load = original;
  }
}

/**
 * Hold every load until `arrive` is called, which is how a picture lands in
 * a browser: after the node that asked for it is built.
 *
 * @param {THREE.Texture} texture
 * @param {(arrive: () => void) => void} body
 */
function withDeferredPictures(texture, body) {
  const original = THREE.TextureLoader.prototype.load;
  /** @type {((texture: THREE.Texture) => void)[]} */
  const waiting = [];
  THREE.TextureLoader.prototype.load = function (_url, onLoad) {
    if (onLoad) {
      waiting.push(/** @type {(texture: THREE.Texture) => void} */ (onLoad));
    }
    return texture;
  };
  try {
    body(() => {
      for (const onLoad of waiting.splice(0)) {
        onLoad(texture);
      }
    });
  } finally {
    THREE.TextureLoader.prototype.load = original;
  }
}

/**
 * An `<image>` inside an `<svg>` root, wired the way the portal wires one,
 * with the root's box measured by a stub since jsdom lays nothing out.
 *
 * @param {Record<string, string>} attributes
 * @param {object} [options]
 * @param {string} [options.viewBox]
 * @param {Record<string, string>} [options.wrap] An element to put the image
 *   in, as its attributes.
 * @param {string} [options.wrapTag] What that element is: a `<g>`, or a
 *   nested `<svg>`.
 */
function setup(attributes, { viewBox, wrap, wrapTag = "g" } = {}) {
  const root = document.createElementNS(SVG_NS, "svg");
  if (viewBox) {
    root.setAttribute("viewBox", viewBox);
  }
  root.getBoundingClientRect = () =>
    /** @type {DOMRect} */ ({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 });
  const element = document.createElementNS(SVG_NS, "image");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  const mirror = createMirror();
  mirror.adopt(root);
  if (wrap) {
    const wrapper = document.createElementNS(SVG_NS, wrapTag);
    for (const [name, value] of Object.entries(wrap)) {
      wrapper.setAttribute(name, value);
    }
    wrapper.appendChild(element);
    root.appendChild(wrapper);
    mirror.adopt(wrapper);
  } else {
    root.appendChild(element);
  }
  document.body.appendChild(root);
  mirror.adopt(element);

  /** @type {Object3D | undefined} */
  let object;
  const subscription = image({}, element).subscribe((value) => {
    object = value;
  });
  assert.ok(object);
  const mesh = /** @type {Mesh} */ (object.children[0]);
  return {
    root,
    element,
    mirror,
    object,
    mesh,
    get material() {
      return /** @type {MeshBasicMaterial} */ (mesh.material);
    },
    teardown() {
      subscription.unsubscribe();
      root.remove();
    },
  };
}

/**
 * The extent of a mesh's vertices in its own space.
 *
 * @param {Mesh} mesh
 */
function bounds(mesh) {
  const position = mesh.geometry.getAttribute("position");
  const box = new THREE.Box2();
  for (let i = 0; i < position.count; i++) {
    box.expandByPoint(new THREE.Vector2(position.getX(i), position.getY(i)));
  }
  return [box.min.x, box.min.y, box.max.x, box.max.y].map(round);
}

describe("placeImage", () => {
  const natural = { width: 200, height: 100 };

  test("nothing is placed before the picture has a size", () => {
    assert.equal(
      placeImage({ x: 0, y: 0, width: 10, height: 10 }, aspect(""), { width: 0, height: 0 }),
      null,
    );
  });

  test("a box with no size takes the picture's", () => {
    const quad = placeImage({ x: 5, y: 6, width: NaN, height: NaN }, aspect(""), natural);
    assert.deepEqual(quad, {
      left: 5,
      top: 6,
      right: 205,
      bottom: 106,
      u0: 0,
      v0: 0,
      u1: 1,
      v1: 1,
    });
  });

  test("a box with one size follows the picture's aspect ratio for the other", () => {
    const quad = placeImage({ x: 0, y: 0, width: 50, height: NaN }, aspect(""), natural);
    assert.deepEqual(quad && [quad.right, quad.bottom], [50, 25]);
  });

  test("meet fits the picture inside the box, centred by default", () => {
    const quad = placeImage({ x: 0, y: 0, width: 100, height: 100 }, aspect(""), natural);
    assert.deepEqual(quad, {
      left: 0,
      top: 25,
      right: 100,
      bottom: 75,
      u0: 0,
      v0: 0,
      u1: 1,
      v1: 1,
    });
  });

  test("the alignment moves a met picture to one end of the slack", () => {
    const quad = placeImage(
      { x: 0, y: 0, width: 100, height: 100 },
      aspect("xMinYMax meet"),
      natural,
    );
    assert.deepEqual(quad && [quad.top, quad.bottom], [50, 100]);
  });

  test("slice covers the box and cuts off what overhangs it, texture and all", () => {
    // A 2:1 picture covering a square: drawn 200 wide, so half of it hangs
    // out of the box, a quarter at each end, and that quarter is not drawn.
    const quad = placeImage(
      { x: 0, y: 0, width: 100, height: 100 },
      aspect("xMidYMid slice"),
      natural,
    );
    assert.deepEqual(quad, {
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      u0: 0.25,
      v0: 0,
      u1: 0.75,
      v1: 1,
    });
  });

  test("none stretches the picture to the box", () => {
    const quad = placeImage({ x: 0, y: 0, width: 30, height: 90 }, aspect("none"), natural);
    assert.deepEqual(quad, { left: 0, top: 0, right: 30, bottom: 90, u0: 0, v0: 0, u1: 1, v1: 1 });
  });

  test("a box with no area draws nothing", () => {
    assert.equal(placeImage({ x: 0, y: 0, width: 0, height: 10 }, aspect(""), natural), null);
  });
});

describe("buildImageGeometry", () => {
  test("the top of the quad samples the top of the picture, which is v = 1", () => {
    const geometry = buildImageGeometry({
      left: 0,
      top: 0,
      right: 10,
      bottom: 20,
      u0: 0.25,
      v0: 0,
      u1: 0.75,
      v1: 1,
    });
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    assert.deepEqual([position.getX(0), position.getY(0)], [0, 0]);
    assert.deepEqual([uv.getX(0), uv.getY(0)], [0.25, 1]);
    assert.deepEqual([position.getX(2), position.getY(2)], [10, 20]);
    assert.deepEqual([uv.getX(2), uv.getY(2)], [0.75, 0]);
    geometry.dispose();
  });
});

describe("trimImageGeometry", () => {
  /** The whole picture on a 10 by 10 quad. */
  const whole = { left: 0, top: 0, right: 10, bottom: 10, u0: 0, v0: 0, u1: 1, v1: 1 };

  /**
   * A clip box, square-cornered.
   *
   * @param {number} left
   * @param {number} top
   * @param {number} right
   * @param {number} bottom
   */
  const box = (left, top, right, bottom) => ({ ...UNCLIPPED, left, top, right, bottom });

  /**
   * The quad's corners and texture coordinates, rounded: the top left
   * corner and the bottom right.
   *
   * @param {THREE.BufferGeometry} geometry
   */
  const corners = (geometry) => {
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    return [
      position.getX(0),
      position.getY(0),
      position.getX(2),
      position.getY(2),
      uv.getX(0),
      uv.getY(0),
      uv.getX(2),
      uv.getY(2),
    ].map(round);
  };

  test("a clip inside the quad cuts it, with a pixel to spare, texture and all", () => {
    const geometry = buildImageGeometry(whole);
    trimImageGeometry(geometry, whole, box(4, 2, 6, 8), new THREE.Matrix3());
    // v runs up the texture: the top of the cut, 0.1 down the picture, is
    // v = 0.9.
    assert.deepEqual(corners(geometry), [3, 1, 7, 9, 0.3, 0.9, 0.7, 0.1]);
    geometry.dispose();
  });

  test("a turned clip cuts the quad to the bounding box of the turn", () => {
    const geometry = buildImageGeometry(whole);
    // A quarter turn: (x, y) in user space lands at (-y, x) in the box's
    // frame, so the box's x from -6 to -4 is y from 4 to 6, and its y from
    // 2 to 8 is x from 2 to 8.
    const turn = new THREE.Matrix3().set(0, -1, 0, 1, 0, 0, 0, 0, 1);
    trimImageGeometry(geometry, whole, box(-6, 2, -4, 8), turn);
    assert.deepEqual(corners(geometry), [1, 3, 9, 7, 0.1, 0.7, 0.9, 0.3]);
    geometry.dispose();
  });

  test("a clip that misses the quad leaves it no area, and no clip leaves it whole", () => {
    const geometry = buildImageGeometry(whole);
    trimImageGeometry(geometry, whole, box(20, 20, 30, 30), new THREE.Matrix3());
    const [left, top, right, bottom] = corners(geometry);
    assert.ok(right <= left && bottom <= top, "nothing left to rasterize");
    trimImageGeometry(geometry, whole, UNCLIPPED, new THREE.Matrix3());
    assert.deepEqual(corners(geometry), [0, 0, 10, 10, 0, 1, 1, 0]);
    geometry.dispose();
  });

  test("a cut that comes out where the last one did uploads nothing", () => {
    const geometry = buildImageGeometry(whole);
    const position = /** @type {THREE.BufferAttribute} */ (geometry.getAttribute("position"));
    trimImageGeometry(geometry, whole, box(4, 2, 6, 8), new THREE.Matrix3());
    const version = position.version;
    trimImageGeometry(geometry, whole, box(4, 2, 6, 8), new THREE.Matrix3());
    assert.equal(position.version, version);
    geometry.dispose();
  });

  test("the bounds follow the cut, for the frustum and the ray", () => {
    const geometry = buildImageGeometry(whole);
    geometry.computeBoundingBox();
    trimImageGeometry(geometry, whole, box(4, 2, 6, 8), new THREE.Matrix3());
    assert.deepEqual(
      [geometry.boundingBox?.min.x, geometry.boundingBox?.max.x].map((v) => round(v ?? NaN)),
      [3, 7],
    );
    assert.ok(round(geometry.boundingSphere?.radius ?? NaN) < 5);
    geometry.dispose();
  });
});

describe("getSvgImageSource", () => {
  test("href is resolved against the document, and xlink:href is read too", () => {
    // jsdom's document is at about:blank, which resolves nothing; a <base>
    // gives it somewhere to be.
    const base = document.createElement("base");
    base.href = "https://example.com/panel/";
    document.head.appendChild(base);
    const element = document.createElementNS(SVG_NS, "image");
    element.setAttribute("href", "pictures/a.png");
    assert.equal(getSvgImageSource(element), "https://example.com/panel/pictures/a.png");
    base.remove();

    const legacy = document.createElementNS(SVG_NS, "image");
    legacy.setAttributeNS(XLINK_NS, "xlink:href", PICTURE);
    assert.equal(getSvgImageSource(legacy), PICTURE);

    assert.equal(getSvgImageSource(document.createElementNS(SVG_NS, "image")), null);
  });
});

describe("svg image", () => {
  test("there is nothing to draw until the picture has arrived", () => {
    // jsdom decodes no pictures, so this is a real panel between mounting
    // an <image> and its picture landing.
    const s = setup({ href: PICTURE, width: "20", height: "10" });
    assert.equal(s.mesh.visible, false);
    assert.equal(s.mesh.geometry.getAttribute("position").count, 0);
    s.teardown();
  });

  test("a picture that arrives is a textured quad in user space, placed by the viewBox", () => {
    const texture = fakeTexture(200, 100);
    withLoadedPictures(texture, () => {
      const s = setup(
        { href: PICTURE, x: "2", y: "1", width: "4", height: "4" },
        { viewBox: "0 0 10 5" },
      );
      assert.equal(s.material.map, texture);
      assert.equal(s.mesh.visible, true);
      // A 2:1 picture met into a 4×4 box: 4 wide and 2 tall, centred.
      assert.deepEqual(bounds(s.mesh), [2, 2, 6, 4]);
      // The viewBox scales user space ten times into the root's 100×50.
      const corner = new THREE.Vector3(2, 2, 1).applyMatrix3(clipMatrixOf(s.mesh));
      assert.deepEqual([round(corner.x), round(corner.y)], [20, 20]);
      s.teardown();
    });
  });

  test("a percentage size is of the viewport, not the picture's own size", () => {
    withLoadedPictures(fakeTexture(2000, 1500), () => {
      const s = setup(
        { href: PICTURE, x: "10%", width: "80%", height: "100%", preserveAspectRatio: "none" },
        { viewBox: "0 0 10 5" },
      );
      assert.deepEqual(bounds(s.mesh), [1, 0, 9, 5]);
      s.teardown();
    });
  });

  test("a percentage size follows a new viewBox", () => {
    withLoadedPictures(fakeTexture(10, 10), () => {
      const s = setup(
        { href: PICTURE, width: "50%", height: "100%", preserveAspectRatio: "none" },
        { viewBox: "0 0 10 5" },
      );
      assert.deepEqual(bounds(s.mesh), [0, 0, 5, 5]);
      s.root.setAttribute("viewBox", "0 0 20 10");
      s.mirror.attributeChanged(s.root);
      assert.deepEqual(bounds(s.mesh), [0, 0, 10, 10]);
      s.teardown();
    });
  });

  test("a percentage inside a nested svg of auto size is of the viewport around it", () => {
    withLoadedPictures(fakeTexture(10, 10), () => {
      const s = setup(
        { href: PICTURE, width: "50%", height: "100%", preserveAspectRatio: "none" },
        { viewBox: "0 0 10 5", wrap: {}, wrapTag: "svg" },
      );
      // The nested svg names no size, so it is the whole 10 by 5.
      assert.deepEqual(bounds(s.mesh), [0, 0, 5, 5]);
      s.teardown();
    });
  });

  test("a picture that arrives after the node is built is faded like one that was there", () => {
    const texture = fakeTexture(10, 10);
    withDeferredPictures(texture, (arrive) => {
      const s = setup(
        { href: PICTURE, width: "10", height: "10", style: "opacity: 0.5" },
        { wrap: { style: "opacity: 0.5" } },
      );
      const before = s.material;
      arrive();
      assert.equal(s.material, before, "one material, whatever picture it shows");
      assert.equal(s.material.map, texture);
      assert.equal(s.material.opacity, 0.25);
      assert.equal(s.mesh.visible, true);
      s.teardown();
    });
  });

  test("a group's rotation turns the picture, through the matrices and not the quad", () => {
    withLoadedPictures(fakeTexture(10, 10), () => {
      const s = setup(
        { href: PICTURE, width: "10", height: "10" },
        // `rotate(90)`, as computed: jsdom does not resolve it.
        { wrap: { style: "transform: matrix(0, 1, -1, 0, 0, 0)" } },
      );
      assert.deepEqual(bounds(s.mesh), [0, 0, 10, 10]);
      // (10, 0), the quad's top-right corner, lands at (0, 10) once turned.
      const corner = new THREE.Vector3(10, 0, 1).applyMatrix3(clipMatrixOf(s.mesh));
      assert.deepEqual([round(corner.x), round(corner.y)], [0, 10]);
      s.teardown();
    });
  });

  test("opacity down the chain fades the picture", () => {
    withLoadedPictures(fakeTexture(10, 10), () => {
      const s = setup(
        { href: PICTURE, width: "10", height: "10", style: "opacity: 0.5" },
        { wrap: { style: "opacity: 0.5" } },
      );
      assert.equal(s.material.opacity, 0.25);
      s.teardown();
    });
  });

  test("the root's own opacity, and its surroundings', fade the picture", () => {
    withLoadedPictures(fakeTexture(10, 10), () => {
      const s = setup({ href: PICTURE, width: "10", height: "10" });
      s.root.style.opacity = "0.5";
      s.mirror.attributeChanged(s.root);
      assert.equal(s.material.opacity, 0.5);
      s.teardown();
    });
  });

  test("an image takes its place in the paint order among the shapes", () => {
    withLoadedPictures(fakeTexture(10, 10), () => {
      const root = document.createElementNS(SVG_NS, "svg");
      root.getBoundingClientRect = () =>
        /** @type {DOMRect} */ ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 });
      const below = document.createElementNS(SVG_NS, "rect");
      const picture = document.createElementNS(SVG_NS, "image");
      const above = document.createElementNS(SVG_NS, "rect");
      for (const rect of [below, above]) {
        for (const [name, value] of Object.entries({ width: "10", height: "10", fill: "red" })) {
          rect.setAttribute(name, value);
        }
      }
      picture.setAttribute("href", PICTURE);
      root.append(below, picture, above);
      document.body.appendChild(root);
      const mirror = createMirror();
      for (const node of [root, below, picture, above]) {
        mirror.adopt(node);
      }
      /** @type {Object3D[]} */
      const objects = [];
      const subscriptions = [
        shape({}, below).subscribe((value) => objects.push(value)),
        image({}, picture).subscribe((value) => objects.push(value)),
        shape({}, above).subscribe((value) => objects.push(value)),
      ];
      const [lower, middle, upper] = objects.map((object) => object.children[0].renderOrder);
      assert.ok(lower < middle && middle < upper, `${lower} < ${middle} < ${upper}`);
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
      root.remove();
    });
  });

  test("display: none takes the picture out, and visibility hides only its quad", () => {
    withLoadedPictures(fakeTexture(10, 10), () => {
      const s = setup({ href: PICTURE, width: "10", height: "10" });
      s.element.setAttribute("style", "display: none");
      s.mirror.attributeChanged(s.element);
      assert.equal(s.object.visible, false);

      s.element.setAttribute("style", "visibility: hidden");
      s.mirror.attributeChanged(s.element);
      assert.equal(s.object.visible, true);
      assert.equal(s.mesh.visible, false);
      s.teardown();
    });
  });

  test("a ray meets the picture, and goes through it under pointer-events: none", () => {
    withLoadedPictures(fakeTexture(10, 10), () => {
      const s = setup({ href: PICTURE, width: "10", height: "10" });
      s.object.updateMatrixWorld(true);
      // Off the diagonal the quad's two triangles share, or it counts twice.
      const raycaster = new THREE.Raycaster(
        new THREE.Vector3(3, 7, 1),
        new THREE.Vector3(0, 0, -1),
      );
      assert.equal(raycaster.intersectObject(s.object).length, 1);

      s.element.setAttribute("style", "pointer-events: none");
      s.mirror.attributeChanged(s.element);
      assert.equal(raycaster.intersectObject(s.object).length, 0);
      s.teardown();
    });
  });

  test("a new href is read when it is written, before any picture loads", () => {
    const other = `${PICTURE}#other`;
    /** @type {string[]} */
    const requested = [];
    const original = THREE.TextureLoader.prototype.load;
    THREE.TextureLoader.prototype.load = function (url) {
      requested.push(url);
      return fakeTexture(10, 10);
    };
    try {
      const s = setup({ href: PICTURE, width: "10", height: "10" });
      s.element.setAttribute("href", other);
      s.mirror.attributeChanged(s.element);
      assert.deepEqual(requested, [PICTURE, other]);
      s.teardown();
    } finally {
      THREE.TextureLoader.prototype.load = original;
    }
  });

  test("a sprite sheet under a one-frame clip draws that frame and not the sheet", () => {
    withLoadedPictures(fakeTexture(80, 40), () => {
      // A sheet of four by two frames, 20 by 20 each, shifted so the second
      // frame of the top row is under the clip.
      const s = setup(
        {
          href: PICTURE,
          width: "80",
          height: "40",
          style: "transform: matrix(1, 0, 0, 1, -20, 0)",
        },
        { wrap: { "clip-path": "url(#one-frame)" } },
      );
      const frame = document.createElementNS(SVG_NS, "rect");
      frame.setAttribute("width", "20");
      frame.setAttribute("height", "20");
      const clipPath = document.createElementNS(SVG_NS, "clipPath");
      clipPath.id = "one-frame";
      clipPath.appendChild(frame);
      s.root.appendChild(clipPath);
      s.mirror.attributeChanged(s.element);
      const geometry = s.mesh.geometry;
      // The frame, from 20 to 40 across and 0 to 20 down, and a pixel
      // around it where the sheet goes that far.
      assert.deepEqual(bounds(s.mesh), [19, 0, 41, 21]);

      // The next frame is a new transform, and the cut moves with it, in
      // the same geometry.
      s.element.setAttribute("style", "transform: matrix(1, 0, 0, 1, -40, 0)");
      s.mirror.attributeChanged(s.element);
      assert.deepEqual(bounds(s.mesh), [39, 0, 61, 21]);
      assert.equal(s.mesh.geometry, geometry);
      const uv = s.mesh.geometry.getAttribute("uv");
      assert.deepEqual([round(uv.getX(0)), round(uv.getX(2))], [round(39 / 80), round(61 / 80)]);
      s.teardown();
    });
  });

  test("teardown gives the picture back and disposes what it made", () => {
    const texture = fakeTexture(10, 10);
    withLoadedPictures(texture, () => {
      const s = setup({ href: PICTURE, width: "10", height: "10" });
      const entry = acquireImage(PICTURE);
      releaseImage(PICTURE);
      const disposed = /** @type {string[]} */ ([]);
      s.mesh.geometry.addEventListener("dispose", () => disposed.push("geometry"));
      s.material.addEventListener("dispose", () => disposed.push("material"));
      texture.addEventListener("dispose", () => disposed.push("texture"));
      s.teardown();
      assert.deepEqual(disposed.sort(), ["geometry", "material"]);
      // The last share went with the element, and the picture is kept idle
      // for whoever asks next, until the idle pictures are released.
      assert.equal(acquireImage(PICTURE), entry);
      releaseImage(PICTURE);
      releaseIdleImages();
      assert.deepEqual(disposed.sort(), ["geometry", "material", "texture"]);
    });
  });
});
