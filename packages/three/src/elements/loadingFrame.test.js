import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createLoadingFrame } from "./loadingFrame.js";

/**
 * @param {THREE.Object3D} object
 * @returns {THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>}
 */
function asMesh(object) {
  return /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>} */ (object);
}

describe("createLoadingFrame", () => {
  test("a quad the panel's size, rounded and bordered, with three dots in the middle", () => {
    const frame = createLoadingFrame({ radius: 10, borderWidth: 3 });
    const [quad, ...dots] = frame.object.children.map(asMesh);
    assert.equal(dots.length, 3);

    frame.layout(300, 120);
    assert.deepEqual(
      [quad.material.uniforms.uSize.value.x, quad.material.uniforms.uSize.value.y],
      [300, 120],
    );
    assert.deepEqual([quad.scale.x, quad.scale.y], [300, 120]);
    assert.deepEqual([quad.position.x, quad.position.y], [0, 0], "top-left origin, like a box");
    assert.deepEqual(quad.material.uniforms.uRadii.value.toArray(), [10, 10, 10, 10]);
    assert.deepEqual(quad.material.uniforms.uBorder.value.toArray(), [3, 3, 3, 3]);

    // Centred on the panel: the middle dot's centre is the panel's centre,
    // and the other two sit either side of it at one spacing each.
    const centres = dots.map((dot) => [
      dot.position.x + dot.scale.x / 2,
      dot.position.y + dot.scale.y / 2,
    ]);
    assert.deepEqual(centres[1], [150, 60]);
    assert.equal(centres[0][1], 60);
    assert.equal(centres[2][1], 60);
    assert.equal(centres[1][0] - centres[0][0], centres[2][0] - centres[1][0]);
    for (const dot of dots) {
      assert.ok(dot.position.z < 0, "a step toward the viewer, in front of the quad");
      assert.equal(dot.material.uniforms.uRadii.value.x, dot.scale.x / 2, "a circle");
    }
  });

  test("the fill is see-through and the border is not", () => {
    const frame = createLoadingFrame({ fill: "white", fillOpacity: 0.3, color: "black" });
    const quad = asMesh(frame.object.children[0]);
    assert.equal(quad.material.uniforms.uFillColor.value.w, 0.3);
    assert.equal(quad.material.uniforms.uBorderColor.value.w, 1);
    assert.deepEqual(
      quad.material.uniforms.uBorderColor.value.toArray().slice(0, 3),
      [0, 0, 0],
      "black, in any colour space",
    );
  });

  test("the dots fade in, then breathe in turn", () => {
    const frame = createLoadingFrame();
    const dots = frame.object.children.slice(1).map(asMesh);
    const alpha = () => dots.map((dot) => dot.material.uniforms.uFillColor.value.w);

    frame.tick(500);
    assert.deepEqual(alpha(), [0, 0, 0], "nothing drawn before the frame is shown");
    assert.equal(frame.isShown(), false);
    frame.show(1000);
    frame.tick(1000);
    assert.deepEqual(alpha(), [0, 0, 0], "and nothing at the showing, which starts the clock");
    assert.equal(frame.isShown(), true);

    frame.tick(1100);
    const early = alpha();
    frame.tick(1500);
    const later = alpha();
    for (let index = 0; index < 3; index += 1) {
      assert.ok(early[index] > 0, "fading in");
      assert.ok(early[index] < 1);
      assert.ok(later[index] <= 0.85, "and never opaque once in");
      assert.ok(later[index] >= 0.2, "nor gone");
    }
    assert.ok(new Set(later).size === 3, "at different points of the same breath");

    // One period later the wave is back where it was.
    frame.tick(2700);
    const round = alpha();
    for (let index = 0; index < 3; index += 1) {
      assert.ok(Math.abs(round[index] - later[index]) < 1e-9);
    }
  });

  test("it is due once it has been up for its minimum time, on the clock it ticks by", () => {
    const frame = createLoadingFrame({ minimumTime: 500 });
    assert.equal(frame.isDue(0), true, "never shown: nobody saw it, so nothing to hold for");
    frame.show(1000);
    assert.equal(frame.isDue(1000), false);
    assert.equal(frame.isDue(1499), false);
    assert.equal(frame.isDue(1500), true);
    frame.show(5000);
    assert.equal(frame.isDue(1500), true, "shown once; a second showing changes nothing");

    const none = createLoadingFrame({ minimumTime: 0 });
    none.show(0);
    assert.equal(none.isDue(0), true, "nothing to wait for");
  });

  test("laying out the same size again writes nothing", () => {
    const frame = createLoadingFrame();
    const quad = asMesh(frame.object.children[0]);
    frame.layout(50, 50);
    const matrix = quad.matrix.clone();
    quad.matrix.identity();
    frame.layout(50, 50);
    assert.ok(quad.matrix.equals(new THREE.Matrix4()), "left alone");
    frame.layout(51, 50);
    assert.ok(!quad.matrix.equals(matrix), "and recomposed for a new size");
  });

  test("dispose takes it out of the scene and lets go of its materials", () => {
    const frame = createLoadingFrame();
    const parent = new THREE.Group();
    parent.add(frame.object);
    let disposed = 0;
    for (const child of frame.object.children) {
      asMesh(child).material.addEventListener("dispose", () => {
        disposed += 1;
      });
    }
    frame.dispose();
    assert.equal(frame.object.parent, null);
    assert.equal(disposed, 4, "the quad's and the three dots'");
  });
});
