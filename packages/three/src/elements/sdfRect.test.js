import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";
import { setSubject } from "./cache.js";
import { createRectMaterial, rectGeometry, writeRectUniforms } from "./sdfRect.js";
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
  /** @type {Subject<import("./cache.js").MutationBatch>} */
  const subject = new Subject();
  setSubject(element, subject);
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
    writeRectUniforms(material, properties);

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
    writeRectUniforms(material, properties);
    const before = {
      size: material.uniforms.uSize.value,
      fill: material.uniforms.uFillColor.value,
    };
    writeRectUniforms(material, properties);
    // Same vectors, mutated in place — what makes per-frame writes safe.
    assert.equal(material.uniforms.uSize.value, before.size);
    assert.equal(material.uniforms.uFillColor.value, before.fill);
  });
});
