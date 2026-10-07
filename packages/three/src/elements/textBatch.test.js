import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createTextBatch } from "./textBatch.js";
import { TEXT_ANISOTROPY } from "./textHelpers.js";
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

describe("text batch sampling", () => {
  test("the array a bucket samples is mipmapped, and sampled across the foreshortening", () => {
    const p = panel(4);
    p.batch.flush();
    const bucket = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    const texture = /** @type {THREE.ShaderMaterial} */ (bucket.material).uniforms.uRuns.value;
    assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
    assert.equal(texture.magFilter, THREE.LinearFilter);
    assert.equal(texture.generateMipmaps, true);
    // Without this a panel turned away from the viewer is sampled at the
    // level its compressed axis asks for, and blurred by that much along the
    // axis that is not compressed.
    assert.equal(texture.anisotropy, TEXT_ANISOTROPY);
  });
});

describe("text batch draw order", () => {
  test("a bucket draws on the integer, so the boxes nested inside its element composite over it", () => {
    const container = new THREE.Group();
    place(container, 0, 0, 0);
    const batch = createTextBatch(container);

    const mesh = run(24, 12);
    mesh.renderOrder = 7;
    container.add(mesh);
    batch.add(mesh, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });
    batch.flush();

    const bucket = /** @type {THREE.InstancedMesh} */ (
      container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    // The boxes of that same order draw at 7.5 — see `BOX_BUCKET_BIAS`.
    assert.equal(bucket.renderOrder, 7);
  });

  test("growing a bucket does not change where it draws", () => {
    const p = panel(6);
    p.batch.flush();
    const before = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    assert.equal(before.renderOrder, 0);

    p.grow(6);
    p.batch.flush();
    const after = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    assert.notEqual(after.id, before.id, "expected the bucket to have been rebuilt");
    assert.equal(after.renderOrder, 0);
  });

  // A caption stepped over a box that holds boxes of its own draws after
  // them (`getDrawLevel`), so its run's order moves while its neighbours'
  // stay. The bucket it is drawn by has to move with it, or the boxes
  // behind it paint over its glyphs.

  test("a run whose order moves later is drawn by a bucket at that order", () => {
    const { container, batch, meshes } = ordered(3, 7);
    meshes[0].renderOrder = 9;
    batch.invalidate();
    batch.flush();

    assert.deepEqual(bucketCounts(container), [
      [7, 2],
      [9, 1],
    ]);
  });

  test("a run whose order comes back rejoins its neighbours' bucket", () => {
    const { container, batch, meshes } = ordered(3, 7);
    meshes[0].renderOrder = 9;
    batch.invalidate();
    batch.flush();
    meshes[0].renderOrder = 7;
    batch.invalidate();
    batch.flush();

    assert.deepEqual(bucketCounts(container), [[7, 3]]);
  });

  test("a run the batch declines draws itself at its own order", () => {
    // 256 runs fill the size class, and the 257th draws itself.
    const { container } = ordered(257, 9);
    const odd = declined(container);

    assert.equal(odd.length, 1);
    assert.equal(odd[0].renderOrder, 9);
  });
});

/**
 * A panel of `count` runs of one size, all at `order`, flushed.
 *
 * @param {number} count
 * @param {number} order
 */
function ordered(count, order) {
  const container = new THREE.Group();
  place(container, 0, 0, 0);
  const batch = createTextBatch(container);
  /** @type {THREE.Mesh[]} */
  const meshes = [];
  for (let i = 0; i < count; i++) {
    const mesh = run(24, 12);
    mesh.renderOrder = order;
    container.add(mesh);
    batch.add(mesh, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });
    meshes.push(mesh);
  }
  batch.flush();
  return { container, batch, meshes };
}

/**
 * The visible buckets of a container, as `[renderOrder, count]` pairs in
 * draw order.
 *
 * @param {THREE.Object3D} container
 * @returns {[number, number][]}
 */
function bucketCounts(container) {
  return /** @type {THREE.InstancedMesh[]} */ (container.children)
    .filter((c) => c.isInstancedMesh && c.visible && c.count > 0)
    .map((c) => /** @type {[number, number]} */ ([c.renderOrder, c.count]))
    .sort((a, b) => a[0] - b[0]);
}

/**
 * The array texture a bucket is currently drawing from.
 *
 * @param {THREE.Object3D} container
 */
function boundTexture(container) {
  const bucket = /** @type {THREE.InstancedMesh} */ (
    container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
  );
  return bucket ? /** @type {THREE.ShaderMaterial} */ (bucket.material).uniforms.uRuns.value : null;
}

/**
 * The runs a batch has declined, which are the ones drawing themselves.
 *
 * @param {THREE.Object3D} container
 */
function declined(container) {
  return container.children.filter(
    (c) =>
      /** @type {THREE.Mesh} */ (c).isMesh &&
      !(/** @type {THREE.InstancedMesh} */ (c).isInstancedMesh) &&
      /** @type {THREE.Material} */ (/** @type {THREE.Mesh} */ (c).material).visible,
  );
}

describe("text batch array limits", () => {
  test("runs past the layer cap draw themselves instead of failing to allocate", () => {
    // 256 is the cap; one more run of the same size than there are layers.
    const p = panel(257);
    p.batch.flush();

    const bucket = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    assert.equal(bucket.count, 256, "expected the batch to take exactly a full array");
    assert.equal(declined(p.container).length, 1, "expected the odd run to draw itself");

    const odd = /** @type {THREE.Mesh} */ (declined(p.container)[0]);
    assert.equal(odd.frustumCulled, true, "a run that draws itself is culled like any mesh");
  });

  test("a declined run joins the batch once a layer comes free", () => {
    const p = panel(257);
    p.batch.flush();
    const odd = /** @type {THREE.Mesh} */ (declined(p.container)[0]);

    // Any batched run leaving hands its layer back, and `remove` invalidates.
    const batched = /** @type {THREE.Mesh} */ (
      p.container.children.find(
        (c) =>
          /** @type {THREE.Mesh} */ (c).isMesh &&
          !(/** @type {THREE.InstancedMesh} */ (c).isInstancedMesh) &&
          !(/** @type {THREE.InstancedMesh} */ (c).isInstancedMesh) &&
          c !== odd &&
          !(/** @type {THREE.Material} */ (/** @type {THREE.Mesh} */ (c).material).visible),
      )
    );
    p.batch.remove(batched);
    p.container.remove(batched);
    p.batch.flush();

    assert.equal(
      /** @type {THREE.Material} */ (odd.material).visible,
      false,
      "expected the declined run to have been taken into the batch",
    );
    assert.equal(declined(p.container).length, 0);
  });

  test("the cap is per size, so another size still batches", () => {
    const p = panel(257);
    // A different exact size is a different array with its own 256.
    for (let i = 0; i < 4; i++) {
      const mesh = run(30, 14);
      p.container.add(mesh);
      p.batch.add(mesh, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });
    }
    p.batch.flush();

    const buckets = p.container.children.filter(
      (c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh,
    );
    assert.equal(buckets.length, 2);
    assert.deepEqual(
      buckets.map((b) => /** @type {THREE.InstancedMesh} */ (b).count).sort((a, b) => a - b),
      [4, 256],
    );
    assert.equal(declined(p.container).length, 1);
  });
});

describe("text batch storage release", () => {
  test("a size class nobody is in gives its array back", () => {
    const p = panel(6);
    p.batch.flush();

    const texture = boundTexture(p.container);
    assert.ok(texture, "expected the bucket to be bound to an array");
    let disposed = false;
    texture.addEventListener("dispose", () => {
      disposed = true;
    });

    for (const child of [...p.container.children]) {
      if (
        /** @type {THREE.Mesh} */ (child).isMesh &&
        !(/** @type {THREE.InstancedMesh} */ (child).isInstancedMesh)
      ) {
        p.batch.remove(/** @type {THREE.Mesh} */ (child));
        p.container.remove(child);
      }
    }
    p.batch.flush();

    assert.equal(disposed, true, "expected the emptied class to have dropped its texture");
  });

  test("runs of that size afterwards get a fresh array, and the bucket rebinds to it", () => {
    const p = panel(6);
    p.batch.flush();
    const first = boundTexture(p.container);

    for (const child of [...p.container.children]) {
      if (
        /** @type {THREE.Mesh} */ (child).isMesh &&
        !(/** @type {THREE.InstancedMesh} */ (child).isInstancedMesh)
      ) {
        p.batch.remove(/** @type {THREE.Mesh} */ (child));
        p.container.remove(child);
      }
    }
    p.batch.flush();

    p.grow(6);
    p.batch.flush();

    const second = boundTexture(p.container);
    assert.ok(second, "expected a bucket again");
    assert.notEqual(second, first, "expected the bucket to have rebound to the new array");
    assert.equal(second.image.depth, 8, "a fresh array starts at the minimum, not the old peak");
    const bucket = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    assert.equal(bucket.count, 6);
    assert.equal(declined(p.container).length, 0);
  });

  test("a class still holding runs keeps its array", () => {
    const p = panel(6);
    p.batch.flush();
    const texture = boundTexture(p.container);
    let disposed = false;
    texture.addEventListener("dispose", () => {
      disposed = true;
    });

    const one = /** @type {THREE.Mesh} */ (
      p.container.children.find(
        (c) =>
          /** @type {THREE.Mesh} */ (c).isMesh &&
          !(/** @type {THREE.InstancedMesh} */ (c).isInstancedMesh),
      )
    );
    p.batch.remove(one);
    p.container.remove(one);
    p.batch.flush();

    assert.equal(disposed, false);
    assert.equal(boundTexture(p.container), texture);
  });
});
