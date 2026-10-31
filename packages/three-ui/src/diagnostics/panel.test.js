import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { drawOnTop } from "./panel.js";

describe("the diagnostics panel's draw on top", () => {
  test("stops depth testing what draws colour and leaves what writes only depth", () => {
    // A panel drawn in paint order has a depth quad, which writes depth and
    // no colour, and a host may share one material among every panel's.
    // Goes red with the quad's depth test turned off too, which would turn
    // off every panel's and let what passes behind one draw over it.
    const root = new THREE.Group();
    const glyphs = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true }),
    );
    root.add(glyphs, quad);
    drawOnTop(root)();
    assert.equal(glyphs.material.depthTest, false, "the readout draws over the scene");
    assert.equal(quad.material.depthTest, true, "the depth quad keeps its test");
  });
});
