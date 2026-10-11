import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Derived } from "@apendua/signal";
import { InteractionContext } from "../interactions.js";
import { div } from "./div.js";
import {
  acquireImage,
  contentImage,
  getContentBox,
  getImageSource,
  IDLE_BUDGET,
  isImageElement,
  placeContentImage,
  releaseIdleImages,
  releaseImage,
} from "./image.js";
import VisualProperties from "./VisualProperties.js";
import { stubCanvas } from "../test/stubCanvas.js";

// Same stub as the other element suites: jsdom has no Font Loading API, and
// `VisualProperties` will not resolve size units until `document.fonts` says
// the fonts are in.
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: {
    status: "loaded",
    ready: Promise.resolve(),
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

// The texture cache keeps what its last user lets go of. Each test starts
// from an empty one, as a test that stubs the loader expects: a URL left
// idle by the test before would be handed back without loading.
afterEach(() => releaseIdleImages());

/**
 * A data URL, so that nothing here can reach for a network however the suite
 * is run. jsdom decodes no images either way, which is the point of every
 * test below that stops at "nothing has loaded yet".
 */
const RED_DOT =
  "data:image/gif;base64,R0lGODlhAQABAIAAAP8AAAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";

/**
 * The picture a stubbed loader hands back.
 *
 * `@types/three` 0.185 made `Texture` generic over its image and declared
 * `TextureLoader` to produce a `Texture<HTMLImageElement>`, so a stand-in has
 * to claim to be an element to be handed to one. This is that claim, made
 * once and in the open: the fitting maths reads a width and a height and
 * nothing else, which is all there is here.
 *
 * @param {number} width
 * @param {number} height
 */
function fakeTexture(width, height) {
  return new THREE.Texture(/** @type {HTMLImageElement} */ ({ width, height }));
}

/**
 * @param {string} tag
 * @param {Partial<CSSStyleDeclaration>} [style]
 */
function element(tag, style = {}) {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  document.body.appendChild(node);
  return { node };
}

/**
 * @param {Partial<CSSStyleDeclaration>} style
 * @returns {[HTMLElement, VisualProperties]}
 */
function propertiesOf(style) {
  const { node } = element("div", style);
  const properties = new VisualProperties();
  properties.setFromElement(/** @type {HTMLElement} */ (node));
  return [/** @type {HTMLElement} */ (node), properties];
}

describe("isImageElement", () => {
  test("only an img carries a picture of its own", () => {
    assert.equal(isImageElement(document.createElement("img")), true);
    assert.equal(isImageElement(document.createElement("div")), false);
    assert.equal(isImageElement(document.createElement("picture")), false);
  });
});

describe("getContentBox", () => {
  test("the border box less its borders and its padding", () => {
    const [node, properties] = propertiesOf({
      borderTopWidth: "2px",
      borderRightWidth: "3px",
      borderBottomWidth: "4px",
      borderLeftWidth: "5px",
      paddingTop: "6px",
      paddingRight: "7px",
      paddingBottom: "8px",
      paddingLeft: "9px",
    });
    const box = getContentBox(node, properties);
    assert.equal(box.left, 14);
    assert.equal(box.top, 8);
    // jsdom lays nothing out, so the border box is empty and the edges that
    // are measured from the far side land on the near one — which is the
    // clamp, and the only thing this environment can say about them.
    assert.equal(box.right, 14);
    assert.equal(box.bottom, 8);
  });

  test("an element with no border and no padding paints in the whole box", () => {
    const box = getContentBox(...propertiesOf({}));
    assert.deepEqual(box, { left: 0, top: 0, right: 0, bottom: 0 });
  });
});

describe("placeContentImage", () => {
  const texture = new THREE.Texture();
  const content = { left: 10, top: 20, right: 110, bottom: 70 };

  test("the fit is worked out in the content box and reported in element px", () => {
    const image = placeContentImage(
      content,
      "contain",
      "50% 50%",
      { width: 200, height: 50 },
      texture,
      1,
    );
    // 100x50 of room, a 4:1 picture: 100x25, centred vertically — then
    // shifted by the content box's own origin, which is where the shader
    // reads it.
    assert.equal(image.left, 10);
    assert.equal(image.right, 110);
    assert.equal(image.top, 20 + 12.5);
    assert.equal(image.bottom, 20 + 37.5);
    assert.equal(image.texture, texture);
    assert.equal(image.opacity, 1);
    // What crops it is the content box, unchanged — the two rectangles are
    // the same only when the picture happens to fit exactly.
    assert.deepEqual(image.content, content);
  });

  test("a cover crop reaches outside the box that clips it", () => {
    const image = placeContentImage(
      content,
      "cover",
      "50% 50%",
      { width: 200, height: 50 },
      texture,
      0.5,
    );
    assert.equal(image.left, -40);
    assert.equal(image.right, 160);
    assert.deepEqual(image.content, content);
    assert.equal(image.opacity, 0.5);
  });
});

describe("the texture cache", () => {
  test("one texture per URL, however many elements ask for it", () => {
    const first = acquireImage(RED_DOT);
    const second = acquireImage(RED_DOT);
    assert.equal(first, second, "two askers should share one entry");

    // One release is not the last one: the entry, and the texture it will
    // hold, outlive it.
    releaseImage(RED_DOT);
    assert.equal(acquireImage(RED_DOT), first);
    releaseImage(RED_DOT);
    releaseImage(RED_DOT);
  });

  /**
   * A loader that answers only when told to, and counts what it was asked
   * for. Restore it when done.
   */
  function deferredLoader() {
    const original = THREE.TextureLoader.prototype.load;
    /** @type {{ url: string, land: (width: number, height: number) => { texture: THREE.Texture, disposed: () => number }, fail: () => void }[]} */
    const loads = [];
    THREE.TextureLoader.prototype.load = function (url, onLoad, _onProgress, onError) {
      loads.push({
        url,
        land: (width, height) => {
          const texture = fakeTexture(width, height);
          // Counted from before it lands, since landing can dispose it.
          const disposed = disposals(texture);
          onLoad?.(/** @type {THREE.Texture<HTMLImageElement>} */ (texture));
          return { texture, disposed };
        },
        fail: () => onError?.(new Error("404")),
      });
      return /** @type {THREE.Texture<HTMLImageElement>} */ (new THREE.Texture());
    };
    return {
      loads,
      restore: () => {
        THREE.TextureLoader.prototype.load = original;
      },
    };
  }

  /** @param {THREE.Texture} texture */
  function disposals(texture) {
    let count = 0;
    texture.addEventListener("dispose", () => {
      count += 1;
    });
    return () => count;
  }

  test("a picture its last user let go of is drawn again without loading", () => {
    const loader = deferredLoader();
    try {
      const url = "/kept.png";
      const entry = acquireImage(url);
      const { texture, disposed } = loader.loads[0].land(4, 4);
      releaseImage(url);

      const again = acquireImage(url);
      assert.equal(again, entry, "the idle entry is handed back");
      assert.equal(again.state.get().texture, texture);
      assert.equal(loader.loads.length, 1, "and nothing is loaded again");
      assert.equal(disposed(), 0);
      releaseImage(url);
    } finally {
      loader.restore();
    }
  });

  test("idle pictures over the budget are disposed, the oldest first", () => {
    const loader = deferredLoader();
    try {
      // Each a quarter of the budget, at four bytes a pixel.
      const side = Math.sqrt(IDLE_BUDGET / 4 / 4);
      const urls = ["/a.png", "/b.png", "/c.png", "/d.png", "/e.png"];
      const counts = urls.map((url, i) => {
        acquireImage(url);
        return loader.loads[i].land(side, side).disposed;
      });
      // `b` goes idle first, then `a`; touching `b` again makes `a` the
      // oldest.
      releaseImage("/b.png");
      releaseImage("/a.png");
      acquireImage("/b.png");
      releaseImage("/b.png");
      for (const url of ["/c.png", "/d.png"]) {
        releaseImage(url);
      }
      assert.deepEqual(
        counts.map((count) => count()),
        [0, 0, 0, 0, 0],
        "four quarters fit",
      );
      releaseImage("/e.png");
      assert.deepEqual(
        counts.map((count) => count()),
        [1, 0, 0, 0, 0],
        "a fifth evicts the oldest idle one",
      );
      acquireImage("/a.png");
      assert.equal(loader.loads.length, 6, "and asking for it loads it again");
      releaseImage("/a.png");
    } finally {
      loader.restore();
    }
  });

  test("a picture that lands after its last user let go is kept idle", () => {
    const loader = deferredLoader();
    try {
      const url = "/late.png";
      acquireImage(url);
      releaseImage(url);
      const { texture, disposed } = loader.loads[0].land(4, 4);
      assert.equal(disposed(), 0);
      assert.equal(acquireImage(url).state.get().texture, texture);
      assert.equal(loader.loads.length, 1);
      releaseImage(url);
    } finally {
      loader.restore();
    }
  });

  test("a picture too big for the budget is disposed as it lands idle", () => {
    const loader = deferredLoader();
    try {
      const url = "/huge.png";
      acquireImage(url);
      releaseImage(url);
      const side = Math.sqrt(IDLE_BUDGET / 4) + 1;
      const { disposed } = loader.loads[0].land(side, side);
      assert.equal(disposed(), 1);
      acquireImage(url);
      assert.equal(loader.loads.length, 2);
      releaseImage(url);
    } finally {
      loader.restore();
    }
  });

  test("a picture bigger than the budget is disposed alone", () => {
    const loader = deferredLoader();
    try {
      acquireImage("/icon.png");
      acquireImage("/photo.png");
      const icon = loader.loads[0].land(64, 64).disposed;
      const side = Math.sqrt(IDLE_BUDGET / 4) + 1;
      const photo = loader.loads[1].land(side, side).disposed;
      releaseImage("/icon.png");
      releaseImage("/photo.png");
      assert.deepEqual([icon(), photo()], [0, 1], "the icon stays idle");
      acquireImage("/icon.png");
      assert.equal(loader.loads.length, 2, "and comes back without loading");
      releaseImage("/icon.png");
    } finally {
      loader.restore();
    }
  });

  test("the budget never evicts a picture still on its way", () => {
    const loader = deferredLoader();
    try {
      acquireImage("/inflight.png");
      releaseImage("/inflight.png");
      const side = Math.sqrt(IDLE_BUDGET / 4 / 2);
      for (const url of ["/half-a.png", "/half-b.png", "/half-c.png"]) {
        acquireImage(url);
        loader.loads[loader.loads.length - 1].land(side, side);
        releaseImage(url);
      }
      const { disposed } = loader.loads[0].land(4, 4);
      assert.equal(disposed(), 0, "the fetch already in flight lands idle");
      acquireImage("/inflight.png");
      assert.equal(loader.loads.length, 4, "and is not loaded again");
      releaseImage("/inflight.png");
    } finally {
      loader.restore();
    }
  });

  test("a picture acquired back off the idle list no longer counts", () => {
    const loader = deferredLoader();
    try {
      const side = Math.sqrt(IDLE_BUDGET / 4 / 4);
      const urls = ["/q1.png", "/q2.png", "/q3.png", "/q4.png", "/q5.png"];
      const counts = urls.map((url, i) => {
        acquireImage(url);
        return loader.loads[i].land(side, side).disposed;
      });
      for (const url of urls.slice(0, 4)) {
        releaseImage(url);
      }
      acquireImage("/q1.png");
      releaseImage("/q5.png");
      assert.deepEqual(
        counts.map((count) => count()),
        [0, 0, 0, 0, 0],
        "four quarters idle, one of them in use again",
      );
      releaseImage("/q1.png");
    } finally {
      loader.restore();
    }
  });

  test("a picture that fails after its last user let go is tried again", () => {
    const loader = deferredLoader();
    try {
      const url = "/gone-missing.png";
      acquireImage(url);
      releaseImage(url);
      loader.loads[0].fail();
      assert.equal(acquireImage(url).state.get().status, "loading");
      assert.equal(loader.loads.length, 2);
      releaseImage(url);
    } finally {
      loader.restore();
    }
  });

  test("a picture released from the idle list in flight is disposed as it lands", () => {
    const loader = deferredLoader();
    try {
      const url = "/dropped.png";
      acquireImage(url);
      releaseImage(url);
      releaseIdleImages();
      const { disposed } = loader.loads[0].land(4, 4);
      assert.equal(disposed(), 1);
    } finally {
      loader.restore();
    }
  });

  test("a picture that failed is tried again once its users let go", () => {
    const loader = deferredLoader();
    try {
      const url = "/missing.png";
      acquireImage(url);
      loader.loads[0].fail();
      releaseImage(url);
      assert.equal(acquireImage(url).state.get().status, "loading");
      assert.equal(loader.loads.length, 2);
      releaseImage(url);
    } finally {
      loader.restore();
    }
  });

  test("releasing the idle pictures disposes them and leaves the used ones", () => {
    const loader = deferredLoader();
    try {
      acquireImage("/used.png");
      acquireImage("/idle.png");
      const used = loader.loads[0].land(4, 4).disposed;
      const unused = loader.loads[1].land(4, 4).disposed;
      releaseImage("/idle.png");
      releaseIdleImages();
      assert.deepEqual([used(), unused()], [0, 1]);
      acquireImage("/idle.png");
      assert.equal(loader.loads.length, 3, "a released idle picture loads again");
      releaseImage("/idle.png");
      releaseImage("/used.png");
    } finally {
      loader.restore();
    }
  });

  /**
   * Load each URL through a loader that answers at once with `picture(url)`,
   * hand back each entry's state, and let go of every one.
   *
   * @param {string[]} urls
   * @param {(url: string) => object} picture
   */
  function loadThrough(urls, picture) {
    const original = THREE.TextureLoader.prototype.load;
    THREE.TextureLoader.prototype.load = function (url, onLoad) {
      const texture = new THREE.Texture(/** @type {HTMLImageElement} */ (picture(url)));
      onLoad?.(/** @type {THREE.Texture<HTMLImageElement>} */ (texture));
      return /** @type {THREE.Texture<HTMLImageElement>} */ (texture);
    };
    try {
      return urls.map((url) => acquireImage(url).state.get());
    } finally {
      for (const url of urls) {
        releaseImage(url);
      }
      THREE.TextureLoader.prototype.load = original;
    }
  }

  test("an SVG is drawn on a canvas at its natural size, and the canvas uploaded", () => {
    // Chrome on a laptop refuses to upload an SVG with no size of its own
    // as a texture ("texSubImage2D: bad image data"), while it draws one on
    // a canvas at the size it gives it, 185 by 150 here. A canvas uploads.
    const canvas = stubCanvas();
    const svg = { naturalWidth: 185, naturalHeight: 150 };
    const png = { naturalWidth: 4, naturalHeight: 2 };
    try {
      const states = loadThrough(
        [
          "/photo.svg",
          "/photo.svg?v=2#frame",
          "/photo.svgz",
          "data:image/svg+xml;utf8,%3Csvg%3E%3C%2Fsvg%3E",
          "/photo.png",
        ],
        (url) => (url.endsWith(".png") ? png : svg),
      );
      const bitmap = /** @type {(typeof states)[number]} */ (states.pop());
      for (const state of states) {
        const image = /** @type {{ width: number, height: number }} */ (state.texture?.image);
        assert.notEqual(image, svg, "the texture holds the canvas");
        assert.deepEqual([image.width, image.height], [185, 150]);
        assert.deepEqual([state.width, state.height], [185, 150]);
      }
      assert.deepEqual(
        canvas.images,
        states.map(() => [svg, 0, 0, 185, 150]),
      );
      assert.equal(bitmap.texture?.image, png, "a bitmap is uploaded as it came");
    } finally {
      canvas.restore();
    }
  });

  test("an SVG the browser reports no size for is drawn at 300 by 150", () => {
    // Firefox has reported 0 by 0 for an SVG with only a `viewBox`. Handed
    // back as it came, it is the picture Chrome refuses, so it is drawn at
    // the size CSS gives a replaced element with none.
    const canvas = stubCanvas();
    const svg = { naturalWidth: 0, naturalHeight: 0 };
    try {
      const [state] = loadThrough(["/unsized.svg"], () => svg);
      const image = /** @type {{ width: number, height: number }} */ (state.texture?.image);
      assert.deepEqual([image.width, image.height], [300, 150]);
      assert.deepEqual(canvas.images, [[svg, 0, 0, 300, 150]]);
    } finally {
      canvas.restore();
    }
  });

  test("an SVG with no 2D canvas to draw on is uploaded as it came", () => {
    const realContext = window.HTMLCanvasElement.prototype.getContext;
    window.HTMLCanvasElement.prototype.getContext = /** @type {never} */ (() => null);
    const svg = { naturalWidth: 185, naturalHeight: 150 };
    try {
      const [state] = loadThrough(["/photo.svg"], () => svg);
      assert.equal(state.texture?.image, svg);
    } finally {
      window.HTMLCanvasElement.prototype.getContext = realContext;
    }
  });

  test("releasing something nobody acquired is not an error", () => {
    releaseImage("data:image/gif;base64,unclaimed");
  });

  test("releasing an idle picture again does not make its count negative", () => {
    const loader = deferredLoader();
    try {
      const url = "/twice.png";
      const entry = acquireImage(url);
      releaseImage(url);
      releaseImage(url);
      acquireImage(url);
      assert.equal(entry.users, 1);
      releaseImage(url);
    } finally {
      loader.restore();
    }
  });
});

describe("getImageSource", () => {
  test("an img with no src has nothing to show", () => {
    const { node } = element("img");
    const source = new Derived(() => getImageSource(/** @type {HTMLElement} */ (node)));
    const subscription = source.subscribe({});
    assert.equal(source.get(), null);
    subscription.unsubscribe();
  });

  test("the URL is re-read when the image announces itself", () => {
    // The load event is the whole invalidation story, with no portal and no
    // observer: swap the source and the element says so a moment later, with
    // `currentSrc` settled.
    const { node } = element("img");
    const image = /** @type {HTMLImageElement} */ (node);
    image.src = RED_DOT;

    const source = new Derived(() => getImageSource(image));
    const subscription = source.subscribe({});
    assert.equal(source.get(), RED_DOT);

    image.src = "data:image/gif;base64,second";
    image.dispatchEvent(new Event("load"));
    assert.equal(source.get(), "data:image/gif;base64,second");

    subscription.unsubscribe();
  });
});

describe("contentImage", () => {
  test("there is nothing to paint until a texture has arrived", () => {
    // jsdom decodes no images, so this is the state a real panel is in for
    // the frames between mounting an <img> and its picture landing: the
    // element's box is drawn, and nothing is drawn inside it.
    const { node } = element("img");
    const image = /** @type {HTMLImageElement} */ (node);
    image.src = RED_DOT;
    const properties = new VisualProperties();
    properties.setFromElement(image);

    const signal = contentImage(image, properties);
    const subscription = signal.subscribe({});
    assert.equal(signal.get(), null);
    subscription.unsubscribe();
  });

  test("a picture that arrives is fitted to the box the element was given", () => {
    // The one place the whole chain can be walked in a browserless
    // environment: a loader that answers immediately, a rect that says the
    // element was laid out, and the rectangles the shader would be handed at
    // the end of it.
    const { node } = element("img", { objectFit: "cover", padding: "5px" });
    const image = /** @type {HTMLImageElement} */ (node);
    image.src = RED_DOT;
    // jsdom lays nothing out; this is the layout the test is talking about.
    image.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, width: 110, height: 60 });

    const texture = fakeTexture(200, 50);
    const original = THREE.TextureLoader.prototype.load;
    THREE.TextureLoader.prototype.load = function (_url, onLoad) {
      onLoad?.(texture);
      return texture;
    };

    try {
      const properties = new VisualProperties();
      properties.setFromElement(image);
      const signal = contentImage(image, properties);
      const subscription = signal.subscribe({});
      const painted = signal.get();

      assert.ok(painted, "a loaded picture should be something to paint");
      assert.equal(painted.texture, texture);
      // 5px of padding on every side leaves a 100x50 content box.
      assert.deepEqual(painted.content, { left: 5, top: 5, right: 105, bottom: 55 });
      // A 4:1 picture covering a 2:1 box keeps its height and overhangs by
      // half its excess width at each end — outside the box that clips it,
      // which is the arrangement the two rectangles exist to express.
      assert.equal(painted.left, -45);
      assert.equal(painted.right, 155);
      assert.equal(painted.top, 5);
      assert.equal(painted.bottom, 55);

      subscription.unsubscribe();
    } finally {
      THREE.TextureLoader.prototype.load = original;
      releaseImage(RED_DOT);
    }
  });

  test("an img with no source never takes a share in anything", () => {
    const { node } = element("img");
    const properties = new VisualProperties();
    properties.setFromElement(/** @type {HTMLElement} */ (node));
    const signal = contentImage(/** @type {HTMLElement} */ (node), properties);
    const subscription = signal.subscribe({});
    assert.equal(signal.get(), null);
    subscription.unsubscribe();
  });
});

/**
 * The quad an element draws itself with — the one mesh under it carrying the
 * rect shader, which is where every uniform in this feature ends up.
 *
 * @param {THREE.Object3D} object
 * @returns {THREE.ShaderMaterial}
 */
function boxMaterialOf(object) {
  for (const child of object.children) {
    const material = /** @type {THREE.Mesh} */ (child).material;
    if (material instanceof THREE.ShaderMaterial) {
      return material;
    }
  }
  throw new Error("no box mesh under this element");
}

/**
 * @param {HTMLElement} element
 */
function project(element) {
  const manager = /** @type {import('../interactions.js').InteractionManager} */ (
    /** @type {unknown} */ ({ add: () => {}, remove: () => {}, stopPropagation: () => {} })
  );
  /** @type {THREE.Object3D | undefined} */
  let object;
  const subscription = div(InteractionContext.set({}, manager), element).subscribe((value) => {
    object = value;
  });
  if (!object) {
    throw new Error("the element was never projected");
  }
  return { object, subscription };
}

describe("an image projected through the element path", () => {
  test("the picture rides on the box the element already draws", () => {
    // No second mesh, no second set of rounded corners to keep in step: the
    // uniforms land on the same quad that draws the background and the border
    // ring, which is what makes an avatar in a circular box come out circular.
    const { node } = element("img", { objectFit: "cover" });
    const image = /** @type {HTMLImageElement} */ (node);
    image.src = RED_DOT;
    image.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, width: 100, height: 50 });

    const texture = fakeTexture(200, 50);
    const original = THREE.TextureLoader.prototype.load;
    THREE.TextureLoader.prototype.load = function (_url, onLoad) {
      onLoad?.(texture);
      return texture;
    };

    try {
      const { object, subscription } = project(image);
      const material = boxMaterialOf(object);
      assert.equal(material.uniforms.uImage.value, texture);
      assert.equal(material.uniforms.uImageOpacity.value, 1);
      const rect = material.uniforms.uImageRect.value;
      assert.deepEqual([rect.x, rect.y, rect.z, rect.w], [-50, 0, 150, 50]);
      subscription.unsubscribe();
    } finally {
      THREE.TextureLoader.prototype.load = original;
      releaseImage(RED_DOT);
    }
  });

  test("an ordinary div pays nothing for a feature it will never use", () => {
    const { node } = element("div");
    const { object, subscription } = project(/** @type {HTMLElement} */ (node));
    const material = boxMaterialOf(object);
    assert.equal(material.uniforms.uImageOpacity.value, 0);
    assert.equal(material.uniforms.uImage.value, null);
    subscription.unsubscribe();
  });
});
