import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { drawOnTop, HEAD_LOCKED, placePanel } from "./panel.js";
import { createDiagnostics, useDiagnostics } from "./diagnostics.js";

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

describe("where the diagnostics panel hangs", () => {
  test("a placement of the scene's own puts the panel there, at its scale", () => {
    // The showcase hangs the readout in the room beside its switcher, since
    // head-locked it covers the card.
    const obj = new THREE.Object3D();
    placePanel(obj, {
      position: new THREE.Vector3(-0.25, -0.3, -0.45),
      rotation: new THREE.Euler(0, 0, 0),
      scale: 0.03,
    });
    assert.deepEqual(obj.position.toArray(), [-0.25, -0.3, -0.45]);
    assert.deepEqual(obj.scale.toArray(), [0.03, 0.03, 0.03]);
  });

  test("a carrier comes with a placement, by type", () => {
    // Never run: what is checked is that `tsc` refuses the call. A carrier
    // without a placement would put the panel at the HUD's place on it.
    const refused = () => {
      // @ts-expect-error a carrier needs a placement
      useDiagnostics({}, createDiagnostics(), { carrier: new THREE.Object3D() });
    };
    assert.equal(typeof refused, "function");
  });

  test("the default is the HUD: up and to the left of the eye, a metre out", () => {
    const obj = new THREE.Object3D();
    placePanel(obj, HEAD_LOCKED);
    assert.deepEqual(obj.position.toArray(), [-0.24, 0.17, -0.95]);
    assert.equal(obj.scale.x, 0.06);
  });
});
