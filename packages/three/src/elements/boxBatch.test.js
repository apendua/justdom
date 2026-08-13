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
