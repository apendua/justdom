import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { PORTAL_ATTRIBUTE } from "./portalRoot.js";
import {
  composeTransform,
  isTransformed,
  parseTransform,
  parseTransformOrigin,
} from "./cssTransform.js";

/**
 * @param {THREE.Matrix4} matrix
 * @param {number} x
 * @param {number} y
 * @param {number} [z]
 */
function apply(matrix, x, y, z = 0) {
  const point = new THREE.Vector3(x, y, z).applyMatrix4(matrix);
  return [point.x, point.y, point.z];
}

describe("parseTransform", () => {
  test("none and empty are no transform at all", () => {
    assert.equal(parseTransform(""), null);
    assert.equal(parseTransform("none"), null);
  });

  test("an unserialized author value is not a matrix", () => {
    // Real engines serialize every computed transform to matrix()/matrix3d();
    // only jsdom passes author values through, and there they count as
    // untransformed rather than half-parsed.
    assert.equal(parseTransform("scale(2)"), null);
    assert.equal(parseTransform("matrix(1, 2)"), null);
    assert.equal(parseTransform("matrix(a, b, c, d, e, f)"), null);
  });

  test("matrix() carries translation in its last two values", () => {
    const matrix = parseTransform("matrix(1, 0, 0, 1, 10, 20)");
    assert.ok(matrix);
    assert.deepEqual(apply(matrix, 0, 0), [10, 20, 0]);
    assert.deepEqual(apply(matrix, 3, 4), [13, 24, 0]);
  });

  test("matrix() applies its linear part in CSS column order", () => {
    // matrix(a, b, c, d, …): x' = a·x + c·y, y' = b·x + d·y.
    const matrix = parseTransform("matrix(2, 1, 3, 4, 0, 0)");
    assert.ok(matrix);
    assert.deepEqual(apply(matrix, 1, 0), [2, 1, 0]);
    assert.deepEqual(apply(matrix, 0, 1), [3, 4, 0]);
  });

  test("matrix3d() reads column-major, with CSS z mirrored into local z", () => {
    // CSS +z is toward the viewer; portal content lives at negative local z,
    // so a translateZ toward the viewer must land at −z.
    const matrix = parseTransform("matrix3d(2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1)");
    assert.ok(matrix);
    assert.deepEqual(apply(matrix, 1, 1, 0), [12, 23, -30]);
  });

  test("a rotateY swings x toward the viewer on the side CSS says it does", () => {
    // rotateY(90deg) in CSS takes the +x axis to −z (away from the viewer):
    // matrix3d(cos, 0, -sin, 0, 0, 1, 0, 0, sin, 0, cos, 0, 0, 0, 0, 1).
    // Away from the viewer is *positive* local z.
    const matrix = parseTransform("matrix3d(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1)");
    assert.ok(matrix);
    const [x, y, z] = apply(matrix, 1, 0, 0);
    assert.ok(Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9);
    assert.equal(z, 1);
  });
});

describe("parseTransformOrigin", () => {
  test("computed px pairs pass straight through", () => {
    assert.deepEqual(parseTransformOrigin("10px 20px", 100, 50), { x: 10, y: 20, z: 0 });
  });

  test("percentages resolve against the untransformed box", () => {
    assert.deepEqual(parseTransformOrigin("50% 100%", 100, 50), { x: 50, y: 50, z: 0 });
  });

  test("absent or unparseable components default to the center", () => {
    // Computed values are always px lengths; keywords only ever reach this
    // through jsdom's author-value passthrough, and degrade to the center
    // rather than carrying dedicated handling.
    assert.deepEqual(parseTransformOrigin("", 100, 50), { x: 50, y: 25, z: 0 });
    assert.deepEqual(parseTransformOrigin("left top", 100, 50), { x: 50, y: 25, z: 0 });
  });

  test("a third component is a z length in px", () => {
    assert.deepEqual(parseTransformOrigin("10px 20px 5px", 100, 50), { x: 10, y: 20, z: 5 });
  });
});

describe("composeTransform", () => {
  test("applies the matrix about its origin, at the layout position", () => {
    const scale = parseTransform("matrix(2, 0, 0, 2, 0, 0)");
    assert.ok(scale);
    const target = new THREE.Matrix4();
    composeTransform(target, 30, 40, -2, scale, { x: 50, y: 25, z: 0 });
    // The origin itself only translates: layout position plus origin.
    assert.deepEqual(apply(target, 50, 25), [80, 65, -2]);
    // A corner doubles its distance from the origin.
    assert.deepEqual(apply(target, 0, 0), [30 + 50 - 100, 40 + 25 - 50, -2]);
  });
});

describe("transform ancestry", () => {
  /**
   * A chain mounted under a portal-marked root, so the walks stop where a
   * real portal's would.
   * @param {...string} transforms Outermost first; one element per value.
   */
  function chain(...transforms) {
    const root = document.createElement("div");
    root.setAttribute(PORTAL_ATTRIBUTE, "");
    document.body.appendChild(root);
    let parent = root;
    /** @type {HTMLElement[]} */
    const elements = [];
    for (const transform of transforms) {
      const element = document.createElement("div");
      if (transform) {
        element.style.transform = transform;
      }
      parent.appendChild(element);
      elements.push(element);
      parent = element;
    }
    return { root, elements, cleanup: () => root.remove() };
  }

  test("isTransformed sees its own transform, and any ancestor's", () => {
    const { elements, cleanup } = chain("matrix(2, 0, 0, 2, 0, 0)", "", "");
    try {
      assert.equal(isTransformed(elements[0]), true);
      assert.equal(isTransformed(elements[2]), true);
    } finally {
      cleanup();
    }
  });

  test("isTransformed stops at the portal root", () => {
    const { root, elements, cleanup } = chain("", "");
    root.style.transform = "matrix(2, 0, 0, 2, 0, 0)";
    try {
      // The container's own styling is the portal's business — apps transform
      // the Group the portal mounts on, not the hidden DOM container.
      assert.equal(isTransformed(elements[1]), false);
    } finally {
      cleanup();
    }
  });
});
