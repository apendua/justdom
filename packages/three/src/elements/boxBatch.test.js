import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createBoxBatch } from "./boxBatch.js";
import { createRectMaterial, rectGeometry } from "./sdfRect.js";
import { place } from "./place.js";

/**
 * A panel with one box in it, batched.
 */
function panel() {
  const container = new THREE.Group();
  place(container, 0, 0, 0);

  const box = new THREE.Mesh(rectGeometry, createRectMaterial());
  place(box, 0, 0, 0);
  container.add(box);

  const batch = createBoxBatch(container);
  batch.add(box);
  batch.flush();

  return {
    container,
    box,
    batch,
    /** Where the batch believes the box is, in container space. */
    drawnX() {
      const bucket = container.children.find(
        (child) => /** @type {THREE.InstancedMesh} */ (child).isInstancedMesh,
      );
      assert.ok(bucket, "expected the batch to have made a bucket");
      const matrix = new THREE.Matrix4();
      /** @type {THREE.InstancedMesh} */ (bucket).getMatrixAt(0, matrix);
      return matrix.elements[12];
    },
  };
}

/**
 * A panel of `count` boxes, all of one render order, so they share a bucket
 * and the bucket has to grow to hold them.
 *
 * @param {number} count
 */
function crowdedPanel(count) {
  const container = new THREE.Group();
  place(container, 0, 0, 0);

  const batch = createBoxBatch(container);
  const boxes = [];
  for (let i = 0; i < count; i++) {
    const box = new THREE.Mesh(rectGeometry, createRectMaterial());
    place(box, i, 0, 0);
    container.add(box);
    batch.add(box);
    boxes.push(box);
  }

  /**
   * Every instanced mesh the batch has ever made, and whether three was told
   * it was going. The `dispose` event is what frees an instance buffer, so
   * this is the thing worth asserting rather than any call in particular.
   *
   * @type {Map<THREE.InstancedMesh, boolean>}
   */
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

  return { container, batch, boxes, meshes, watch };
}

/** Let queued microtasks run. */
const microtasks = () => Promise.resolve();

describe("box batch rebuild scheduling", () => {
  test("a flush before the draw shows a box where this frame put it, not where the last one did", async () => {
    const p = panel();
    assert.equal(p.drawnX(), 0);

    // What a sampled CSS animation does from inside the frame callback: move
    // the box, say so, and carry on with the frame.
    place(p.box, 7, 0, 0);
    p.batch.invalidate();

    // The microtask this queued cannot have run — the frame callback has not
    // returned — so without a flush the draw at the end of it would still be
    // reading the previous frame's number.
    assert.equal(p.drawnX(), 0);

    p.batch.flush();
    assert.equal(p.drawnX(), 7);
  });

  test("the microtask does not rebuild again over a flush that already ran", async () => {
    const p = panel();
    let rebuilds = 0;
    const rebuild = p.batch.rebuild.bind(p.batch);
    p.batch.rebuild = () => {
      rebuilds += 1;
      rebuild();
    };

    place(p.box, 7, 0, 0);
    p.batch.invalidate();
    p.batch.flush();
    assert.equal(rebuilds, 1);

    await microtasks();
    assert.equal(rebuilds, 1);
    assert.equal(p.drawnX(), 7);
  });

  test("many invalidations in one frame are still one rebuild", async () => {
    const p = panel();
    let rebuilds = 0;
    const rebuild = p.batch.rebuild.bind(p.batch);
    p.batch.rebuild = () => {
      rebuilds += 1;
      rebuild();
    };

    for (let i = 1; i <= 20; i++) {
      place(p.box, i, 0, 0);
      p.batch.invalidate();
    }
    p.batch.flush();

    assert.equal(rebuilds, 1);
    assert.equal(p.drawnX(), 20);
  });

  test("a flush with nothing owing does nothing", async () => {
    const p = panel();
    let rebuilds = 0;
    const rebuild = p.batch.rebuild.bind(p.batch);
    p.batch.rebuild = () => {
      rebuilds += 1;
      rebuild();
    };

    p.batch.flush();
    p.batch.flush();
    assert.equal(rebuilds, 0);
  });

  test("the microtask still settles a panel with no frames to flush in", async () => {
    const p = panel();

    place(p.box, 7, 0, 0);
    p.batch.invalidate();
    assert.equal(p.drawnX(), 0);

    await microtasks();
    assert.equal(p.drawnX(), 7);
  });

  test("a disposed batch neither flushes nor rebuilds on its way out", async () => {
    const p = panel();
    let rebuilds = 0;
    const rebuild = p.batch.rebuild.bind(p.batch);
    p.batch.rebuild = () => {
      rebuilds += 1;
      rebuild();
    };

    place(p.box, 7, 0, 0);
    p.batch.invalidate();
    p.batch.dispose();

    p.batch.flush();
    await microtasks();
    assert.equal(rebuilds, 0);
  });
});

describe("box batch teardown", () => {
  test("every mesh a growing bucket leaves behind is told it is going", () => {
    // The bucket starts with room for 16 and doubles from there.
    const p = crowdedPanel(40);
    p.batch.flush();
    p.watch();
    assert.equal(p.meshes.size, 1);

    for (let i = 0; i < 40; i++) {
      const box = new THREE.Mesh(rectGeometry, createRectMaterial());
      place(box, i, 1, 0);
      p.container.add(box);
      p.batch.add(box);
    }
    p.batch.flush();
    p.watch();
    assert.equal(p.meshes.size, 2, "expected the bucket to have been rebuilt bigger");

    // The one it grew out of is gone, the one it is drawing with is not.
    const [outgrown, current] = [...p.meshes.keys()];
    assert.equal(p.meshes.get(outgrown), true);
    assert.equal(p.meshes.get(current), false);
    assert.equal(outgrown.parent, null);
    assert.equal(current.parent, p.container);
  });

  test("disposing the batch tells three about the mesh it was still drawing with", () => {
    const p = crowdedPanel(4);
    p.batch.flush();
    p.watch();
    assert.equal(p.meshes.size, 1);

    p.batch.dispose();
    assert.deepEqual([...p.meshes.values()], [true]);
    assert.equal(
      p.container.children.filter((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
        .length,
      0,
    );
  });

  test("a bucket's geometry goes with it, and the panel's material only at the end", () => {
    const p = crowdedPanel(4);
    p.batch.flush();
    const bucket = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    const material = /** @type {THREE.Material} */ (bucket.material);

    let geometryDisposed = false;
    let materialDisposed = false;
    bucket.geometry.addEventListener("dispose", () => {
      geometryDisposed = true;
    });
    material.addEventListener("dispose", () => {
      materialDisposed = true;
    });

    // Grow it: the geometry is this mesh's, the material is the panel's and is
    // shared with every other bucket in it.
    for (let i = 0; i < 40; i++) {
      const box = new THREE.Mesh(rectGeometry, createRectMaterial());
      place(box, i, 1, 0);
      p.container.add(box);
      p.batch.add(box);
    }
    p.batch.flush();
    assert.equal(geometryDisposed, true);
    assert.equal(materialDisposed, false, "the panel is still drawing with this material");

    p.batch.dispose();
    assert.equal(materialDisposed, true);
  });
});
