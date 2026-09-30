import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createMirror, resetMeasuringRangeForTests } from "./mirror.js";
import { text } from "./text.js";

// `textHelpers` resolves colours through a bare `getComputedStyle`, which
// jsdom-env installs on `window` and not on the global.
if (typeof globalThis.getComputedStyle === "undefined") {
  globalThis.getComputedStyle = window.getComputedStyle;
}

/**
 * jsdom lays nothing out, and a run is measured through a range: every
 * character 10px wide on a single 16px line is enough to rasterize one.
 *
 * @returns {() => void} Puts the real range back.
 */
function installRange() {
  const original = document.createRange;
  resetMeasuringRangeForTests();
  document.createRange = () => {
    let start = 0;
    let end = 0;
    const rect = () =>
      /** @type {DOMRect} */ ({
        left: start * 10,
        top: 0,
        right: end * 10,
        bottom: 16,
        width: (end - start) * 10,
        height: 16,
      });
    return /** @type {Range} */ (
      /** @type {unknown} */ ({
        selectNodeContents: (/** @type {Node} */ node) => {
          start = 0;
          end = (node.textContent || "").length;
        },
        setStart: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
          start = offset;
        },
        setEnd: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
          end = offset;
        },
        getBoundingClientRect: rect,
        getClientRects: () => /** @type {DOMRectList} */ (/** @type {unknown} */ ([rect()])),
      })
    );
  };
  return () => {
    document.createRange = original;
    resetMeasuringRangeForTests();
  };
}

describe("text visibility", () => {
  test("a run follows its parent's visibility, which a nested element can override", () => {
    const restore = installRange();
    const outer = document.createElement("div");
    outer.style.visibility = "hidden";
    const inner = document.createElement("span");
    outer.append("hidden", inner);
    inner.append("shown");
    document.body.appendChild(outer);
    const mirror = createMirror();
    mirror.adopt(outer);

    try {
      /**
       * @param {Text} node
       */
      const project = (node) => {
        mirror.adopt(node);
        /** @type {THREE.Object3D | undefined} */
        let object;
        const subscription = text({}, node).subscribe({
          next: (value) => {
            object = value;
          },
        });
        assert.ok(object);
        const mesh = object.children[0];
        assert.ok(mesh instanceof THREE.Mesh);
        return { mesh, subscription };
      };
      mirror.adopt(inner);
      const hidden = project(/** @type {Text} */ (outer.firstChild));
      const nested = project(/** @type {Text} */ (inner.firstChild));

      // Inherited: the span says nothing, so its text is hidden with the div's.
      assert.equal(hidden.mesh.visible, false);
      assert.equal(nested.mesh.visible, false);

      inner.style.visibility = "visible";
      mirror.attributeChanged(inner);
      assert.equal(hidden.mesh.visible, false);
      assert.equal(nested.mesh.visible, true, "the span shows its own text again");

      outer.style.visibility = "";
      mirror.attributeChanged(outer);
      assert.equal(hidden.mesh.visible, true);
      assert.equal(nested.mesh.visible, true);

      hidden.subscription.unsubscribe();
      nested.subscription.unsubscribe();
    } finally {
      restore();
      outer.remove();
    }
  });
});

describe("text opacity", () => {
  test("a run is faded by the opacity of every element it is in, and follows it", () => {
    const restore = installRange();
    const outer = document.createElement("div");
    outer.style.opacity = "0.5";
    const inner = document.createElement("span");
    inner.style.opacity = "0.5";
    inner.style.color = "rgb(0, 0, 0)";
    outer.append(inner);
    inner.append("faded");
    document.body.appendChild(outer);
    const mirror = createMirror();
    mirror.adopt(outer);
    mirror.adopt(inner);
    const node = /** @type {Text} */ (inner.firstChild);
    mirror.adopt(node);

    try {
      /** @type {THREE.Object3D | undefined} */
      let object;
      const subscription = text({}, node).subscribe({
        next: (value) => {
          object = value;
        },
      });
      assert.ok(object);
      const mesh = /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>} */ (
        object.children[0]
      );
      assert.equal(mesh.material.opacity, 0.25, "both elements fade it, as on a page");

      outer.style.opacity = "";
      mirror.attributeChanged(outer);
      assert.equal(mesh.material.opacity, 0.5, "and the outer one stops fading it");

      subscription.unsubscribe();
    } finally {
      restore();
      outer.remove();
    }
  });
});
