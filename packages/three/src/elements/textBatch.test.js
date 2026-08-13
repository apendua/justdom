import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createTextBatch } from "./textBatch.js";
import { place } from "./place.js";

/**
 * A rasterized run, as the batch reads one: a mask in the material's alpha
 * map, and a quad whose position attribute carries the run's size.
 *
 * The canvas is a stand-in. The batch asks it for its size and for a 2d
 * context to copy pixels out of, and `SizeClass.write` is written to do
 * nothing when there is no context — which is what jsdom offers, and enough
 * for everything about layers and buckets.
 *
 * @param {number} width
 * @param {number} height
 */
function run(width, height) {
  const canvas = /** @type {HTMLCanvasElement} */ (
    /** @type {unknown} */ ({ width, height, getContext: () => null })
  );
  const texture = new THREE.Texture(canvas);
  const material = new THREE.MeshBasicMaterial({ alphaMap: texture });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([0, 0, 0, width, 0, 0, 0, height, 0, width, height, 0]),
      3,
    ),
  );
  const mesh = new THREE.Mesh(geometry, material);
  place(mesh, 0, 0, 0);
  return mesh;
}

/**
 * A panel of `count` runs, all the same size and render order, so they share
 * one size class and one bucket.
 *
 * @param {number} count
 */
function panel(count) {
  const container = new THREE.Group();
  place(container, 0, 0, 0);

  const batch = createTextBatch(container);
  for (let i = 0; i < count; i++) {
    const mesh = run(24, 12);
    container.add(mesh);
    batch.add(mesh, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });
  }

  /** @type {Map<THREE.InstancedMesh, boolean>} */
  const meshes = new Map();
  const watch = () => {
    for (const child of container.children) {
      const mesh = /** @type {THREE.InstancedMesh} */ (child);
      if (mesh.isInstancedMesh && !meshes.has(mesh)) {
        meshes.set(mesh, false);
        mesh.addEventListener("dispose", () => {
          meshes.set(mesh, true);
        });
      }
    }
  };

  /** @param {number} more */
  const grow = (more) => {
    for (let i = 0; i < more; i++) {
      const mesh = run(24, 12);
      container.add(mesh);
      batch.add(mesh, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });
    }
  };

  return { container, batch, meshes, watch, grow };
}

describe("text batch teardown", () => {
  test("the runs of a size share one bucket, and it holds them all", () => {
    const p = panel(4);
    p.batch.flush();
    const buckets = p.container.children.filter(
      (child) => /** @type {THREE.InstancedMesh} */ (child).isInstancedMesh,
    );
    assert.equal(buckets.length, 1);
    assert.equal(/** @type {THREE.InstancedMesh} */ (buckets[0]).count, 4);
  });

  test("every mesh a growing bucket leaves behind is told it is going", () => {
    // A bucket starts with room for 8 layers and doubles from there.
    const p = panel(6);
    p.batch.flush();
    p.watch();
    assert.equal(p.meshes.size, 1);

    p.grow(6);
    p.batch.flush();
    p.watch();
    assert.equal(p.meshes.size, 2, "expected the bucket to have been rebuilt bigger");

    const [outgrown, current] = [...p.meshes.keys()];
    assert.equal(p.meshes.get(outgrown), true);
    assert.equal(p.meshes.get(current), false);
    assert.equal(outgrown.parent, null);
    assert.equal(current.parent, p.container);
    assert.equal(current.count, 12);
  });

  test("disposing the batch tells three about the mesh it was still drawing with", () => {
    const p = panel(4);
    p.batch.flush();
    p.watch();

    p.batch.dispose();
    assert.deepEqual([...p.meshes.values()], [true]);
    assert.equal(
      p.container.children.filter((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
        .length,
      0,
    );
  });

  test("the walk steps over the bucket a growth made, not the one it replaced", () => {
    const p = panel(6);
    p.batch.flush();
    p.grow(6);
    p.batch.flush();

    // The set of meshes the walk skips is derived from the live buckets on
    // every rebuild, so what it holds is exactly what is parented. Assert the
    // consequence: a further rebuild finds every run, none of them lost behind
    // a mesh that is no longer there.
    p.batch.flush();
    p.batch.invalidate();
    p.batch.flush();
    const bucket = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    assert.equal(bucket.count, 12);
  });
});
