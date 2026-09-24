import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createRectMaterial,
  rectGeometry,
  writeImageUniforms,
  writeRectUniforms,
} from "./sdfRect.js";
import VisualProperties from "./VisualProperties.js";

// Same stub as div.test.js: jsdom has no Font Loading API, and
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

describe("sdf rect", () => {
  test("the quad is shared: one geometry for every box there will ever be", () => {
    assert.equal(rectGeometry.getAttribute("position").count, 4);
    assert.equal(rectGeometry.index?.count, 6);
  });

  test("styles land as uniform values, in the documented lanes", () => {
    const properties = propertiesOf({
      borderTopWidth: "2px",
      borderRightWidth: "3px",
      borderBottomWidth: "4px",
      borderLeftWidth: "5px",
      borderTopLeftRadius: "6px",
      borderTopRightRadius: "7px",
      borderBottomRightRadius: "8px",
      borderBottomLeftRadius: "9px",
      backgroundColor: "rgba(255, 0, 0, 0.5)",
      borderColor: "rgb(0, 0, 255)",
    });
    const material = createRectMaterial();
    writeRectUniforms(material.uniforms, properties);

    const { uSize, uRadii, uBorder, uFillColor, uBorderColor } = material.uniforms;
    // jsdom lays nothing out, so the box itself is empty.
    assert.deepEqual([uSize.value.x, uSize.value.y], [0, 0]);
    // Borders: (top, right, bottom, left).
    const border = uBorder.value;
    assert.deepEqual([border.x, border.y, border.z, border.w], [2, 3, 4, 5]);
    // Radii: (topLeft, topRight, bottomRight, bottomLeft).
    const radii = uRadii.value;
    assert.deepEqual([radii.x, radii.y, radii.z, radii.w], [6, 7, 8, 9]);
    // Pure red and pure blue survive the sRGB conversion exactly, and the
    // alphas ride in w.
    const fill = uFillColor.value;
    assert.deepEqual([fill.x, fill.y, fill.z, fill.w], [1, 0, 0, 0.5]);
    const borderColor = uBorderColor.value;
    assert.deepEqual([borderColor.x, borderColor.y, borderColor.z, borderColor.w], [0, 0, 1, 1]);
  });

  test("rewriting uniforms allocates no new material state", () => {
    const properties = propertiesOf({ backgroundColor: "rgb(10, 20, 30)" });
    const material = createRectMaterial();
    writeRectUniforms(material.uniforms, properties);
    const before = {
      size: material.uniforms.uSize.value,
      fill: material.uniforms.uFillColor.value,
    };
    writeRectUniforms(material.uniforms, properties);
    // Same vectors, mutated in place — what makes per-frame writes safe.
    assert.equal(material.uniforms.uSize.value, before.size);
    assert.equal(material.uniforms.uFillColor.value, before.fill);
  });
});

describe("the picture layer", () => {
  test("a box with no picture carries the feature switched off", () => {
    const material = createRectMaterial();
    assert.equal(material.uniforms.uImageOpacity.value, 0);
    assert.equal(material.uniforms.uImage.value, null);
  });

  test("both rectangles land, and they are allowed to disagree", () => {
    const material = createRectMaterial();
    const texture = new THREE.Texture();
    writeImageUniforms(material.uniforms, {
      texture,
      opacity: 0.75,
      left: -45,
      top: 5,
      right: 155,
      bottom: 55,
      content: { left: 5, top: 5, right: 105, bottom: 55 },
    });

    const { uImage, uImageRect, uImageClip, uImageOpacity } = material.uniforms;
    assert.equal(uImage.value, texture);
    assert.equal(uImageOpacity.value, 0.75);
    // Where the picture is drawn — outside the box, which is what a `cover`
    // crop looks like from here.
    const rect = uImageRect.value;
    assert.deepEqual([rect.x, rect.y, rect.z, rect.w], [-45, 5, 155, 55]);
    // What crops it.
    const clip = uImageClip.value;
    assert.deepEqual([clip.x, clip.y, clip.z, clip.w], [5, 5, 105, 55]);
  });

  test("letting go of a picture drops the reference, not just the opacity", () => {
    // An element that has stopped showing an image must not be the reason its
    // texture stays uploaded — the cache disposes on the last release, and a
    // material still holding it would be that last user.
    const material = createRectMaterial();
    const texture = new THREE.Texture();
    writeImageUniforms(material.uniforms, {
      texture,
      opacity: 1,
      left: 0,
      top: 0,
      right: 10,
      bottom: 10,
      content: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    writeImageUniforms(material.uniforms, null);
    assert.equal(material.uniforms.uImageOpacity.value, 0);
    assert.equal(material.uniforms.uImage.value, null);
  });

  test("rewriting the picture allocates no new material state", () => {
    const material = createRectMaterial();
    const texture = new THREE.Texture();
    /** @type {import('./image.js').ContentImage} */
    const image = {
      texture,
      opacity: 1,
      left: 0,
      top: 0,
      right: 10,
      bottom: 10,
      content: { left: 0, top: 0, right: 10, bottom: 10 },
    };
    writeImageUniforms(material.uniforms, image);
    const before = material.uniforms.uImageRect.value;
    writeImageUniforms(material.uniforms, { ...image, left: 1 });
    // The same vector, mutated — which is what makes an object-position
    // transition a per-frame write and not a per-frame allocation.
    assert.equal(material.uniforms.uImageRect.value, before);
    assert.equal(before.x, 1);
  });
});
