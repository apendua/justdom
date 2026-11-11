import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createRectMaterial,
  rectGeometry,
  writeGradientUniforms,
  writeImageUniforms,
  writeRectUniforms,
} from "./sdfRect.js";
import VisualProperties from "./VisualProperties.js";
import { BoxNumbers } from "./boxNumbers.js";
import {
  GRADIENT_LINEAR,
  layoutGradient,
  parseBackground,
  rampAtlas,
  rampUniforms,
  RampSlot,
} from "./gradient.js";

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

  test("an outline lands as (width, offset) and its colour, and none as no width", () => {
    // jsdom keeps the `outline` shorthand to itself, so the longhands.
    const material = createRectMaterial();
    writeRectUniforms(
      material.uniforms,
      propertiesOf({
        outlineStyle: "solid",
        outlineWidth: "3px",
        outlineOffset: "-2px",
        outlineColor: "rgba(0, 0, 255, 0.5)",
      }),
    );
    const { uOutline, uOutlineColor } = material.uniforms;
    assert.deepEqual([uOutline.value.x, uOutline.value.y], [3, -2]);
    const color = uOutlineColor.value;
    assert.deepEqual([color.x, color.y, color.z, color.w], [0, 0, 1, 0.5]);

    writeRectUniforms(
      material.uniforms,
      propertiesOf({ outlineStyle: "none", outlineWidth: "3px", outlineOffset: "4px" }),
    );
    assert.deepEqual([uOutline.value.x, uOutline.value.y], [0, 0]);
  });

  test("a box-shadow lands layer by layer, topmost first, the opacity in its alpha", () => {
    const material = createRectMaterial();
    writeRectUniforms(
      material.uniforms,
      propertiesOf({
        boxShadow: "rgb(255, 0, 0) 1px 2px 3px 4px inset, rgba(0, 0, 255, 0.5) 0px 4px 8px -2px",
        opacity: "0.5",
      }),
    );
    const { uShadowCount, uShadows, uShadowColors, uShadowInset } = material.uniforms;
    assert.equal(uShadowCount.value, 2);
    const lanes = (/** @type {THREE.Vector4} */ v) => [v.x, v.y, v.z, v.w];
    assert.deepEqual(lanes(uShadows.value[0]), [1, 2, 3, 4]);
    assert.deepEqual(lanes(uShadows.value[1]), [0, 4, 8, -2]);
    assert.deepEqual(lanes(uShadowColors.value[0]), [1, 0, 0, 0.5]);
    assert.deepEqual(lanes(uShadowColors.value[1]), [0, 0, 1, 0.25]);
    assert.deepEqual(uShadowInset.value.slice(0, 2), [1, 0]);

    writeRectUniforms(material.uniforms, propertiesOf({ boxShadow: "none" }));
    assert.equal(uShadowCount.value, 0);
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

  test("a repeated picture picks its mipmap from the unwrapped coordinate", () => {
    // Where the wrapped coordinate jumps from 1 back to 0 at a seam between
    // two tiles, a sampler measuring it reads the smallest mipmap: a line of
    // the picture's average colour along every seam.
    const { fragmentShader } = createRectMaterial();
    assert.match(fragmentShader, /vec2 qdx = dFdx\(q\);/);
    assert.match(fragmentShader, /vec2 dx = qdx \/ imageSize;/);
    assert.match(fragmentShader, /vec2 dy = qdy \/ imageSize;/);
    assert.match(fragmentShader, /textureGrad\(\s*uImage,/);
    assert.doesNotMatch(fragmentShader, /texture2D\(uImage/);
  });

  test("a picture is whole up to the edge it is cut to, so its border leaves no seam", () => {
    // The content box's edge is the border's inner edge, which the fill's
    // coverage already fades. A picture faded across it as well leaves a
    // quarter of the fragment there to the page behind.
    const { fragmentShader } = createRectMaterial();
    assert.match(fragmentShader, /return 1\.0 - smoothstep\(0\.0, 2\.0 \* w, dist\);/);
    assert.match(
      fragmentShader,
      /pictureCoverage\(q, bounds\) \* pictureCoverage\(q, uImageClip\)/,
    );
  });

  test("a gradient that does not repeat is whole up to its tile's edge, as a picture is", () => {
    const { fragmentShader } = createRectMaterial();
    assert.match(
      fragmentShader,
      /return 1\.0 - smoothstep\(0\.0, 2\.0 \* w, abs\(q - start - 0\.5 \* size\) - 0\.5 \* size\);/,
    );
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

describe("the gradient layer", () => {
  test("a box without a background image draws no gradient and holds no ramp", () => {
    const properties = propertiesOf({ backgroundColor: "rgb(10, 20, 30)" });
    const material = createRectMaterial();
    const slot = new RampSlot();
    const before = rampAtlas.size;
    writeGradientUniforms(material.uniforms, properties, slot);
    assert.equal(material.uniforms.uGradient.value.x, 0);
    assert.equal(rampAtlas.size, before);
  });

  test("a laid-out gradient lands in its documented lanes", () => {
    const layout = layoutGradient(
      parseBackground({
        image: "repeating-linear-gradient(to right, rgb(1, 2, 3) 0 10px, rgb(4, 5, 6) 10px 20px)",
        size: "50px 40px",
        repeat: "repeat no-repeat",
        positionX: "10px",
        positionY: "5px",
      }),
      { width: 200, height: 100, border: [0, 0, 0, 0], padding: [0, 0, 0, 0] },
    );
    assert.ok(layout);
    const properties = /** @type {VisualProperties} */ (
      /** @type {unknown} */ ({ backgroundGradient: layout, opacity: 0.75 })
    );
    const material = createRectMaterial();
    const slot = new RampSlot();
    writeGradientUniforms(material.uniforms, properties, slot);
    const { uGradient, uGradientGeometry, uGradientTile, uGradientRamp } = material.uniforms;
    // (kind, repeating, repeat-x, repeat-y)
    assert.deepEqual(uGradient.value.toArray(), [GRADIENT_LINEAR, 1, 1, 0]);
    assert.deepEqual(uGradientGeometry.value.toArray(), layout.geometry);
    assert.deepEqual(uGradientTile.value.toArray(), [10, 5, 50, 40]);
    // (row, opacity)
    assert.deepEqual(uGradientRamp.value.toArray(), [slot.row, 0.75]);
    // The ramp texture is the page's, by reference.
    assert.equal(material.uniforms.uRamp, rampUniforms.uRamp);
    slot.release();
  });
});

describe("BoxNumbers", () => {
  /** @returns {{ numbers: BoxNumbers, mesh: THREE.Mesh, marks: () => number }} */
  const box = () => {
    const mesh = new THREE.Mesh(rectGeometry);
    let marked = 0;
    const numbers = new BoxNumbers(mesh, () => {
      marked += 1;
    });
    return { numbers, mesh, marks: () => marked };
  };

  test("each write tells the batch when it changed something, and only then", () => {
    const { numbers, mesh, marks } = box();
    const slot = new RampSlot();
    const blue = propertiesOf({ width: "20px", height: "10px", background: "rgb(0, 0, 255)" });
    const clip = {
      left: 0,
      top: 0,
      right: 20,
      bottom: 10,
      topLeft: 0,
      topRight: 0,
      bottomRight: 0,
      bottomLeft: 0,
    };
    /** @type {[string, () => void][]} */
    const writes = [
      ["paint", () => numbers.paint(blue, slot)],
      ["clip", () => numbers.clip(clip)],
      ["place", () => numbers.place(1, 2, 20, 10)],
      ["order", () => numbers.order(3)],
      ["show", () => numbers.show(false)],
    ];
    for (const [name, write] of writes) {
      const before = marks();
      write();
      assert.equal(marks(), before + 1, `${name}: a new value is marked`);
      write();
      assert.equal(marks(), before + 1, `${name}: the same value again is not`);
    }
    assert.equal(numbers.uniforms.uFillColor.value.z, 1);
    assert.deepEqual([mesh.position.x, mesh.position.y, mesh.scale.x], [1, 2, 20]);
    assert.equal(mesh.renderOrder, 3);
    assert.equal(mesh.visible, false);
    numbers.paint(propertiesOf({ width: "20px", height: "10px", background: "red" }), slot);
    assert.equal(marks(), writes.length + 1, "a colour that changed is marked");
    slot.release();
  });

  test("a picture, and none, are marked once each", () => {
    const { numbers, marks } = box();
    numbers.image(null);
    assert.equal(marks(), 0, "no picture is what a box starts with");
    const image = {
      texture: new THREE.Texture(),
      left: 0,
      top: 0,
      right: 10,
      bottom: 10,
      content: { left: 0, top: 0, right: 10, bottom: 10 },
      opacity: 1,
      repeatX: false,
      repeatY: false,
      underGradient: false,
    };
    numbers.image(/** @type {never} */ (image));
    numbers.image(/** @type {never} */ (image));
    assert.equal(marks(), 1);
    numbers.image(null);
    assert.equal(marks(), 2);
  });

  test("an empty box is placed very small rather than at a zero scale", () => {
    const { numbers, mesh } = box();
    numbers.place(0, 0, 0, 0);
    assert.ok(mesh.scale.x > 0 && mesh.scale.y > 0);
  });
});
