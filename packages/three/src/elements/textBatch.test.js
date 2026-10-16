import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { TEXT_ANISOTROPY } from "./textHelpers.js";
import { place } from "./place.js";
import { panel, run } from "../test/textRuns.js";
import { createTextBatch } from "./textBatch.js";

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

  test("a bucket that grows keeps its material, and disposing the batch lets it go", () => {
    const p = panel(6);
    p.batch.flush();
    p.watch();
    const [first] = p.meshes.keys();
    const material = first.material;
    let disposed = 0;
    /** @type {THREE.Material} */ (material).addEventListener("dispose", () => {
      disposed += 1;
    });

    p.grow(6);
    p.batch.flush();
    p.watch();
    const [, grown] = p.meshes.keys();
    assert.equal(grown.material, material);
    assert.equal(disposed, 0);

    p.batch.dispose();
    assert.equal(disposed, 1);
  });

  test("a bucket that grows with its class samples the class's new array", () => {
    const p = panel(6);
    p.batch.flush();
    const first = boundTexture(p.container);

    // Twelve runs outgrow both the bucket and the class's array of 8 layers,
    // in the one flush.
    p.grow(6);
    p.batch.flush();
    const grown = boundTexture(p.container);
    assert.notEqual(grown, first);
    assert.ok(grown.image.depth >= 12, `expected the grown array, got ${grown.image.depth} layers`);
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

/**
 * The runs a batch draws, which are the ones no longer drawing themselves.
 *
 * @param {THREE.Object3D} container
 */
function batched(container) {
  return container.children.filter(
    (c) =>
      /** @type {THREE.Mesh} */ (c).isMesh &&
      !(/** @type {THREE.InstancedMesh} */ (c).isInstancedMesh) &&
      !(/** @type {THREE.Material} */ (/** @type {THREE.Mesh} */ (c).material).visible),
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
    const leaving = /** @type {THREE.Mesh} */ (batched(p.container)[0]);
    p.batch.remove(leaving);
    p.container.remove(leaving);
    p.batch.flush();

    assert.equal(
      /** @type {THREE.Material} */ (odd.material).visible,
      false,
      "expected the declined run to have been taken into the batch",
    );
    assert.equal(declined(p.container).length, 0);
  });

  test("a declined run joins the batch once a run out of the walk gives its layer back", () => {
    // What a row that left an open panel does: out of the walk at the commit,
    // and only then, at its teardown, out of the batch.
    const p = panel(257);
    p.batch.flush();
    const odd = /** @type {THREE.Mesh} */ (declined(p.container)[0]);
    const leaving = /** @type {THREE.Mesh} */ (batched(p.container)[0]);
    p.container.remove(leaving);
    p.batch.invalidate();
    p.batch.flush();
    assert.equal(declined(p.container).length, 1, "still declined: the layer is still held");

    p.batch.remove(leaving);
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

/**
 * A canvas that counts the pixel reads the batch makes of it, which is what
 * copying it into a layer costs.
 *
 * @param {number} width
 * @param {number} height
 */
function countedCanvas(width, height) {
  const canvas = {
    width,
    height,
    reads: 0,
    getContext: () => ({
      getImageData: (
        /** @type {number} */ _x,
        /** @type {number} */ _y,
        /** @type {number} */ w,
        /** @type {number} */ h,
      ) => {
        canvas.reads += 1;
        return { data: new Uint8ClampedArray(w * h * 4) };
      },
    }),
  };
  return canvas;
}

/**
 * Show `canvas` on a run, as `textRun.js` does when its panel changes step:
 * a new texture in the alpha map, and a quad of the same CSS size.
 *
 * @param {THREE.Mesh} mesh
 * @param {ReturnType<typeof countedCanvas>} canvas
 */
function show(mesh, canvas) {
  /** @type {THREE.MeshBasicMaterial} */ (mesh.material).alphaMap = new THREE.Texture(
    /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (canvas)),
  );
}

/**
 * The array texture of every bucket with runs in it, by `renderOrder|size`.
 *
 * @param {THREE.Object3D} container
 */
function shownArrays(container) {
  return /** @type {THREE.InstancedMesh[]} */ (container.children)
    .filter((c) => c.isInstancedMesh && c.count > 0)
    .map((c) => /** @type {THREE.ShaderMaterial} */ (c.material).uniforms.uRuns.value);
}

describe("text batch held steps", () => {
  test("a run gone back to a raster the batch has copies nothing and builds no array", () => {
    const container = new THREE.Group();
    place(container, 0, 0, 0);
    const batch = createTextBatch(container);
    const mesh = run(24, 12);
    container.add(mesh);
    batch.add(mesh, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });

    // Step 1, then the step above it, then back: two canvases of two sizes.
    const coarse = countedCanvas(24, 12);
    const fine = countedCanvas(34, 17);
    show(mesh, coarse);
    batch.flush();
    const [coarseArray] = shownArrays(container);
    show(mesh, fine);
    batch.invalidate();
    batch.flush();
    const [fineArray] = shownArrays(container);
    assert.notEqual(fineArray, coarseArray);

    let disposed = false;
    coarseArray.addEventListener("dispose", () => {
      disposed = true;
    });
    show(mesh, coarse);
    batch.invalidate();
    batch.flush();

    assert.deepEqual(shownArrays(container), [coarseArray], "drawn from the array it was in");
    assert.equal(coarse.reads, 1, "its pixels were copied once, the first time it was shown");
    assert.equal(fine.reads, 1);
    assert.equal(disposed, false, "the array was neither disposed nor built again");
    assert.equal(/** @type {THREE.Material} */ (mesh.material).visible, false);
  });

  test("a raster the run lets go of gives its layer back, and an emptied class its array", () => {
    const container = new THREE.Group();
    place(container, 0, 0, 0);
    const batch = createTextBatch(container);
    const mesh = run(24, 12);
    container.add(mesh);
    batch.add(mesh, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });

    const coarse = countedCanvas(24, 12);
    const fine = countedCanvas(34, 17);
    show(mesh, coarse);
    batch.flush();
    const [coarseArray] = shownArrays(container);
    show(mesh, fine);
    batch.invalidate();
    batch.flush();

    let disposed = false;
    coarseArray.addEventListener("dispose", () => {
      disposed = true;
    });
    batch.flush();
    assert.equal(disposed, false, "a held raster keeps its class's array");

    batch.forget(mesh, /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (coarse)));
    batch.flush();
    assert.equal(disposed, true, "nobody is in the class any more");
    assert.equal(shownArrays(container).length, 1, "and the run is still drawn at its step");
  });

  test("a run that leaves gives back the layer of every raster it had", () => {
    const container = new THREE.Group();
    place(container, 0, 0, 0);
    const batch = createTextBatch(container);
    const mesh = run(24, 12);
    container.add(mesh);
    batch.add(mesh, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });

    show(mesh, countedCanvas(24, 12));
    batch.flush();
    const [coarseArray] = shownArrays(container);
    show(mesh, countedCanvas(34, 17));
    batch.invalidate();
    batch.flush();
    const [fineArray] = shownArrays(container);

    /** @type {THREE.Texture[]} */
    const disposed = [];
    for (const array of [coarseArray, fineArray]) {
      array.addEventListener("dispose", () => {
        disposed.push(array);
      });
    }
    batch.remove(mesh);
    container.remove(mesh);
    batch.flush();
    assert.equal(disposed.length, 2);
  });
});

describe("text batch prepared steps", () => {
  /**
   * A panel of one run at its shown size, flushed, with an `upload` that
   * records what it was given.
   */
  function prepared() {
    const container = new THREE.Group();
    place(container, 0, 0, 0);
    const batch = createTextBatch(container);
    const mesh = run(24, 12);
    container.add(mesh);
    batch.add(mesh, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });
    show(mesh, countedCanvas(24, 12));
    batch.flush();
    /** @type {THREE.Texture[]} */
    const uploaded = [];
    /** @param {THREE.Texture} texture */
    const upload = (texture) => {
      uploaded.push(texture);
    };
    return { container, batch, mesh, uploaded, upload };
  }

  test("a staged raster is copied, but no rebuild builds an array for it", () => {
    const p = prepared();
    const fine = countedCanvas(34, 17);
    p.batch.stage(p.mesh, /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (fine)));
    assert.equal(fine.reads, 1);

    p.batch.invalidate();
    p.batch.flush();
    assert.equal(p.uploaded.length, 0);
    assert.equal(p.batch.commitStaged(Infinity, p.upload), false);
    assert.equal(p.uploaded.length, 1, "built and sent up when the pump asks");
    assert.equal(/** @type {THREE.DataArrayTexture} */ (p.uploaded[0]).image.width, 34);
  });

  test("showing a staged raster after its array went up copies and builds nothing", () => {
    const p = prepared();
    const fine = countedCanvas(34, 17);
    p.batch.stage(p.mesh, /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (fine)));
    p.batch.commitStaged(Infinity, p.upload);
    const [array] = p.uploaded;
    let disposed = false;
    array.addEventListener("dispose", () => {
      disposed = true;
    });

    show(p.mesh, fine);
    p.batch.invalidate();
    p.batch.flush();
    assert.deepEqual(shownArrays(p.container), [array], "drawn from the array that went up");
    assert.equal(fine.reads, 1);
    assert.equal(disposed, false);
    assert.equal(p.batch.commitStaged(Infinity, p.upload), false);
    assert.equal(p.uploaded.length, 1, "nothing more to send");
  });

  test("a class a shown run changes is built by the rebuild, staged layers and all", () => {
    const p = prepared();
    // Staged at the shown size, so the shown run's class takes it.
    p.batch.stage(
      p.mesh,
      /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (countedCanvas(24, 12))),
    );
    const other = run(24, 12);
    p.container.add(other);
    p.batch.add(other, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });
    show(other, countedCanvas(24, 12));
    p.batch.flush();

    assert.equal(p.batch.commitStaged(Infinity, p.upload), false);
    assert.equal(p.uploaded.length, 0, "the rebuild's array already carries the staged layer");
  });

  test("a bucket drawing from a class is rebound when the pump builds it", () => {
    const p = prepared();
    const [before] = shownArrays(p.container);
    p.batch.stage(
      p.mesh,
      /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (countedCanvas(24, 12))),
    );
    p.batch.commitStaged(Infinity, p.upload);
    const [after] = shownArrays(p.container);
    assert.notEqual(after, before);
    assert.equal(after, p.uploaded[0], "the bucket samples the array that replaced the old one");
  });

  test("a staged raster shown before the pump built its class is built by the rebuild", () => {
    const p = prepared();
    const fine = countedCanvas(34, 17);
    p.batch.stage(p.mesh, /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (fine)));

    // The panel crossed before the pump's `commitStaged`.
    show(p.mesh, fine);
    p.batch.invalidate();
    p.batch.flush();
    const [array] = shownArrays(p.container);
    assert.ok(array, "the bucket samples an array, not nothing");
    assert.equal(array.image.width, 34);
    assert.equal(fine.reads, 1, "built from the copy the stage made");
    assert.equal(p.batch.commitStaged(Infinity, p.upload), false);
    assert.equal(p.uploaded.length, 0, "and nothing is left for the pump");
  });

  test("a staged layer let go of leaves its class nothing to send up", () => {
    const p = prepared();
    // At the shown size, so the class keeps a shown run after the release.
    const fine = /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (countedCanvas(24, 12)));
    p.batch.stage(p.mesh, fine);
    p.batch.forget(p.mesh, fine);
    p.batch.flush();

    assert.equal(p.batch.commitStaged(Infinity, p.upload), false);
    assert.equal(p.uploaded.length, 0);
  });

  test("the pump sends up a class at a time once past its bytes", () => {
    const p = prepared();
    for (const [width, height] of [
      [34, 17],
      [48, 24],
    ]) {
      p.batch.stage(
        p.mesh,
        /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (countedCanvas(width, height))),
      );
    }
    assert.equal(p.batch.commitStaged(1, p.upload), true, "one more class to go");
    assert.equal(p.uploaded.length, 1);
    assert.equal(p.batch.commitStaged(1, p.upload), false);
    assert.equal(p.uploaded.length, 2);
  });
});

describe("text batch upload budget", () => {
  test("a class that would take the frame past its bytes waits for the next call", () => {
    const container = new THREE.Group();
    place(container, 0, 0, 0);
    const batch = createTextBatch(container);
    const mesh = run(24, 12);
    container.add(mesh);
    batch.add(mesh, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });
    show(mesh, countedCanvas(24, 12));
    batch.flush();
    // Two classes of 8 layers each: 34 * 17 * 4 * 8 and 48 * 24 * 4 * 8 bytes.
    for (const [width, height] of [
      [34, 17],
      [48, 24],
    ]) {
      batch.stage(
        mesh,
        /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (countedCanvas(width, height))),
      );
    }
    let uploads = 0;
    const upload = () => {
      uploads += 1;
    };
    const first = 34 * 17 * 4 * 8;
    assert.equal(batch.commitStaged(first + 1, upload), true);
    assert.equal(uploads, 1, "the second class would have gone past the bytes");
  });
});
