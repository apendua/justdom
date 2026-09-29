import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  applyClip,
  applyReveal,
  clipBoxEqual,
  clipBoxShows,
  clipRaycast,
  intersectClipBoxes,
  isEmptyClipBox,
  toLocalClipBox,
  IDENTITY_CLIP_MATRIX,
  UNCLIPPED,
} from "./clip.js";

/**
 * @param {number} left
 * @param {number} top
 * @param {number} right
 * @param {number} bottom
 * @param {number} [radius] The same radius on all four corners.
 * @returns {import('./clip.js').ClipBox}
 */
function box(left, top, right, bottom, radius = 0) {
  return {
    left,
    top,
    right,
    bottom,
    topLeft: radius,
    topRight: radius,
    bottomRight: radius,
    bottomLeft: radius,
  };
}

describe("clip boxes", () => {
  test("intersecting edges is what makes nesting free", () => {
    // A scroller inside a clipped panel: two windows, one box by the time it
    // reaches the shader.
    const panel = box(0, 0, 200, 100);
    const scroller = box(20, 40, 300, 300);
    const clip = intersectClipBoxes(panel, scroller);
    assert.equal(clip.left, 20);
    assert.equal(clip.top, 40);
    assert.equal(clip.right, 200);
    assert.equal(clip.bottom, 100);
  });

  test("an unclipped box leaves the other one alone", () => {
    const window = box(10, 20, 30, 40, 6);
    assert.deepEqual(intersectClipBoxes(UNCLIPPED, window), window);
  });

  test("boxes that miss each other come back empty rather than inside out", () => {
    assert.ok(isEmptyClipBox(intersectClipBoxes(box(0, 0, 10, 10), box(50, 50, 60, 60))));
    assert.ok(!isEmptyClipBox(box(0, 0, 1, 1)));
    // Zero height is empty too: a scroller collapsed to nothing shows nothing.
    assert.ok(isEmptyClipBox(box(0, 10, 100, 10)));
  });

  test("a corner stays round only where one box binds both of its edges", () => {
    const rounded = box(0, 0, 100, 100, 8);
    // Cutting the bottom off: the two top corners are still the rounded box's
    // own, the two bottom ones are now square edges of the cut.
    const cut = intersectClipBoxes(rounded, box(-50, -50, 150, 60));
    assert.equal(cut.topLeft, 8);
    assert.equal(cut.topRight, 8);
    assert.equal(cut.bottomLeft, 0);
    assert.equal(cut.bottomRight, 0);

    // Crossing boxes: the top-left corner is where one box's left meets the
    // other's top, which is a right angle whatever either of them rounds.
    const crossed = intersectClipBoxes(box(0, -50, 100, 50, 8), box(-50, 0, 50, 100, 8));
    assert.equal(crossed.topLeft, 0, "left from the first box, top from the second");
    // The bottom-left of that same intersection is not a crossing: the first
    // box binds the left edge and the bottom edge both, so the corner between
    // them is its own, and stays rounded.
    assert.equal(crossed.bottomLeft, 8);
  });

  test("a box nested well inside another keeps all of its corners", () => {
    const inner = intersectClipBoxes(box(0, 0, 200, 200), box(20, 20, 80, 80, 5));
    assert.equal(inner.topLeft, 5);
    assert.equal(inner.bottomRight, 5);
  });

  test("moving into an element's own coordinates is a translation", () => {
    // The scroller's window in client space, read by a row 60px down the list.
    const local = toLocalClipBox(box(100, 200, 300, 400, 4), 100, 260);
    assert.deepEqual(local, box(0, -60, 200, 140, 4));
  });

  test("a box is shown when any of it survives, and only then", () => {
    assert.ok(clipBoxShows(box(0, -60, 200, 140), 200, 30), "a row inside the window");
    assert.ok(clipBoxShows(box(0, -20, 200, 5), 200, 30), "a row straddling the top edge");
    assert.ok(!clipBoxShows(box(0, -90, 200, -60), 200, 30), "a row scrolled past the top");
    assert.ok(!clipBoxShows(box(0, 140, 200, 200), 200, 30), "a row below the window");
  });

  test("equality is by value, corners included, so a still clip does not propagate", () => {
    assert.ok(clipBoxEqual(box(1, 2, 3, 4, 5), box(1, 2, 3, 4, 5)));
    assert.ok(!clipBoxEqual(box(1, 2, 3, 4, 5), box(1, 2, 3, 5, 5)));
    assert.ok(!clipBoxEqual(box(1, 2, 3, 4, 5), box(1, 2, 3, 4, 6)));
  });
});

describe("clipRaycast", () => {
  /**
   * A 100x40 quad in the portal's coordinates: origin top left, y down, which
   * is how everything below a portal is laid out.
   */
  function setup() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 100, 0, 0, 0, 40, 0, 100, 40, 0]), 3),
    );
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  /**
   * @param {THREE.Object3D} object
   * @param {number} x
   * @param {number} y
   */
  function hitsAt(object, x, y) {
    const raycaster = new THREE.Raycaster(new THREE.Vector3(x, y, 10), new THREE.Vector3(0, 0, -1));
    return raycaster.intersectObject(object).length;
  }

  test("without a clip the whole quad is hit", () => {
    const mesh = setup();
    assert.equal(hitsAt(mesh, 20, 20), 1);
    assert.equal(hitsAt(mesh, 20, 5), 1);
  });

  test("hits outside the box are dropped, hits inside survive", () => {
    const mesh = setup();
    // The top 10px of this button have scrolled out from under its scroller.
    let clip = box(0, 10, 100, 40);
    clipRaycast(mesh, () => clip);

    assert.equal(hitsAt(mesh, 20, 20), 1, "the visible part is still clickable");
    assert.equal(hitsAt(mesh, 20, 5), 0, "the part scrolled out of view is not");

    // Scrolling on: the same mesh, a different window, no re-wrapping.
    clip = box(0, 0, 100, 8);
    assert.equal(hitsAt(mesh, 20, 20), 0);
    assert.equal(hitsAt(mesh, 20, 5), 1);
  });

  test("the box can be read in another object's coordinates", () => {
    // What an element's quad actually is: a unit square scaled to its size, so
    // its own coordinates run 0..1 and the clip has to be read one level up.
    const frame = new THREE.Object3D();
    const mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
    mesh.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3),
    );
    mesh.geometry.setIndex([0, 1, 2, 2, 1, 3]);
    mesh.scale.set(100, 40, 1);
    frame.add(mesh);
    frame.updateMatrixWorld(true);

    clipRaycast(mesh, () => box(0, 10, 100, 40), frame);
    assert.equal(hitsAt(frame, 20, 20), 1);
    assert.equal(hitsAt(frame, 20, 5), 0);
  });

  test("the box can be read through a matrix, as the clip patch reads it", () => {
    // An SVG shape's vertices are in its user space and the box is in the
    // root's frame, and the matrix the material carries maps one to the
    // other. Here user space is drawn at twice the size, offset by 10px.
    const mesh = setup();
    const matrix = { value: new THREE.Matrix3().set(2, 0, 10, 0, 2, 10, 0, 0, 1) };
    clipRaycast(mesh, () => box(0, 0, 100, 50), mesh, matrix);
    // (20, 15) in user space is (50, 40) in the box's frame, inside it.
    assert.equal(hitsAt(mesh, 20, 15), 1);
    // (20, 25) is (50, 60), below the box, though inside it in user space.
    assert.equal(hitsAt(mesh, 20, 25), 0);

    // Read at every cast, so a matrix written later is the one that counts.
    matrix.value.identity();
    assert.equal(hitsAt(mesh, 20, 25), 1);
  });

  test("hits already in the list are left alone", () => {
    const mesh = setup();
    clipRaycast(mesh, () => box(0, 10, 100, 40));
    const intersects = [/** @type {any} */ ({ distance: 0, object: mesh })];
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(20, 5, 10),
      new THREE.Vector3(0, 0, -1),
    );
    mesh.raycast(raycaster, intersects);
    assert.equal(intersects.length, 1, "somebody else's hit is not this filter's business");
  });
});

describe("the clip patch", () => {
  /**
   * What three hands `onBeforeCompile`: the two chunks the patch looks for,
   * and an empty uniform table it fills in.
   *
   * @param {THREE.Material} material
   */
  function compile(material) {
    const shader = {
      uniforms: /** @type {Record<string, { value: unknown }>} */ ({}),
      vertexShader: "void main() {\n#include <begin_vertex>\n}",
      fragmentShader: "void main() {\n#include <alphatest_fragment>\n}",
    };
    material.onBeforeCompile(/** @type {never} */ (shader), /** @type {never} */ (null));
    return shader;
  }

  /**
   * Whether a vertex at (x, y) in the mesh's own coordinates lands inside
   * the clip box — the vertex shader's `clipMatrix * vec3(position.xy, 1)`
   * and the fragment shader's box test, read off the uniforms the patch
   * installed.
   *
   * @param {Record<string, { value: unknown }>} uniforms
   * @param {number} x
   * @param {number} y
   */
  function inside(uniforms, x, y) {
    const matrix = /** @type {THREE.Matrix3} */ (uniforms.clipMatrix.value);
    const box = /** @type {THREE.Vector4} */ (uniforms.clipBox.value);
    const at = new THREE.Vector3(x, y, 1).applyMatrix3(matrix);
    return at.x >= box.x && at.y >= box.y && at.x <= box.z && at.y <= box.w;
  }

  test("the position is taken through a matrix before it meets the box", () => {
    const material = new THREE.MeshBasicMaterial();
    applyClip(material, { value: new THREE.Vector4(0, 0, 10, 10) });
    const shader = compile(material);
    assert.match(shader.vertexShader, /uniform mat3 clipMatrix;/);
    assert.match(
      shader.vertexShader,
      /vClipPosition = \(clipMatrix \* vec3\(position\.xy, 1\.0\)\)\.xy;/,
    );
    assert.match(shader.fragmentShader, /uniform vec4 clipBox;/);
    assert.equal(material.customProgramCacheKey(), "freedom-clip-matrix");
  });

  test("left out, the matrix is the shared identity, and nothing moves", () => {
    const material = new THREE.MeshBasicMaterial();
    applyClip(material, { value: new THREE.Vector4(0, 0, 10, 10) });
    const { uniforms } = compile(material);
    assert.equal(uniforms.clipMatrix, IDENTITY_CLIP_MATRIX);
    assert.ok(IDENTITY_CLIP_MATRIX.value.equals(new THREE.Matrix3()));
    assert.equal(inside(uniforms, 5, 5), true);
    assert.equal(inside(uniforms, 15, 5), false);
  });

  test("a matrix of the caller's moves the clip edge through the mesh", () => {
    // A mesh drawn at twice its size, 20px in: its own x = 5 is the box's
    // x = 30, so a box ending at 25 cuts the mesh at its own x = 2.5.
    const matrix = { value: new THREE.Matrix3() };
    const box = { value: new THREE.Vector4(0, 0, 25, 100) };
    const material = new THREE.MeshBasicMaterial();
    applyClip(material, box, matrix);
    const { uniforms } = compile(material);
    assert.equal(uniforms.clipMatrix, matrix, "the caller's uniform, not a copy");
    assert.equal(inside(uniforms, 5, 0), true, "at the identity, 5 is well inside");

    matrix.value.set(2, 0, 20, 0, 2, 0, 0, 0, 1);
    assert.equal(inside(uniforms, 2, 0), true);
    assert.equal(inside(uniforms, 3, 0), false, "past the edge once the matrix moves it");

    // A rotation: a quarter turn takes the mesh's x axis onto the box's y.
    matrix.value.set(0, -1, 0, 1, 0, 0, 0, 0, 1);
    assert.equal(inside(uniforms, 50, 0), true, "(50, 0) lands at (0, 50)");
    assert.equal(inside(uniforms, 0, 50), false, "(0, 50) lands at (-50, 0)");
  });

  test("the reveal patch is the clip patch at the identity, plus its cut", () => {
    const material = new THREE.MeshBasicMaterial();
    const clip = { value: new THREE.Vector4(0, 0, 10, 10) };
    applyReveal(material, clip, { value: new THREE.Vector4() });
    const shader = compile(material);
    assert.equal(shader.uniforms.clipMatrix, IDENTITY_CLIP_MATRIX);
    assert.equal(shader.uniforms.clipBox, clip);
    assert.ok(shader.uniforms.revealCut);
    assert.equal(material.customProgramCacheKey(), "freedom-clip-matrix-reveal");
  });
});
