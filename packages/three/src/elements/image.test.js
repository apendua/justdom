import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Derived } from "justdom-signal";
import { InteractionContext } from "../interactions.js";
import { div } from "./div.js";
import {
  acquireImage,
  contentImage,
  getContentBox,
  getImageSource,
  isImageElement,
  placeContentImage,
  releaseImage,
} from "./image.js";
import VisualProperties from "./VisualProperties.js";

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

/**
 * A data URL, so that nothing here can reach for a network however the suite
 * is run. jsdom decodes no images either way, which is the point of every
 * test below that stops at "nothing has loaded yet".
 */
const RED_DOT =
  "data:image/gif;base64,R0lGODlhAQABAIAAAP8AAAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";

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

    // The last one out forgets the URL, so asking again starts over.
    const reacquired = acquireImage(RED_DOT);
    assert.notEqual(reacquired, first, "the entry should not survive its last user");
    releaseImage(RED_DOT);
  });

  test("releasing something nobody acquired is not an error", () => {
    releaseImage("data:image/gif;base64,unclaimed");
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
    // `src` is not in the portal's attributeFilter, so the load event is the
    // whole invalidation story: swap the source and the element says so a
    // moment later, with `currentSrc` settled.
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

    const texture = new THREE.Texture();
    texture.image = { width: 200, height: 50 };
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

    const texture = new THREE.Texture();
    texture.image = { width: 200, height: 50 };
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
