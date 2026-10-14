import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createBoxBatch, DEPTH_RANK_EPSILON } from "./boxBatch.js";
import {
  batchedBoxMaterial,
  createRectMaterial,
  createRectUniforms,
  rectGeometry,
} from "./sdfRect.js";
import { rampUniforms } from "./gradient.js";
import { place } from "./place.js";
import { instanceVersions } from "../test/instanceVersions.js";

/**
 * A box as a portal builds one for a batch: the shared invisible material
 * every batched box wears, and a set of numbers of its own. The two are
 * handed to the batch together, since the material no longer carries them.
 *
 * @returns {{ mesh: THREE.Mesh, uniforms: Record<string, THREE.IUniform> }}
 */
function makeBox() {
  const uniforms = createRectUniforms();
  return { mesh: new THREE.Mesh(rectGeometry, batchedBoxMaterial()), uniforms };
}

/**
 * A panel with one box in it, batched.
 */
function panel() {
  const container = new THREE.Group();
  place(container, 0, 0, 0);

  const { mesh: box, uniforms } = makeBox();
  place(box, 0, 0, 0);
  container.add(box);

  const batch = createBoxBatch(container);
  batch.add(box, uniforms);
  batch.flush();

  return {
    container,
    box,
    uniforms,
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
    const { mesh: box, uniforms } = makeBox();
    place(box, i, 0, 0);
    container.add(box);
    batch.add(box, uniforms);
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
      const { mesh: box, uniforms } = makeBox();
      place(box, i, 1, 0);
      p.container.add(box);
      p.batch.add(box, uniforms);
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
      const { mesh: box, uniforms } = makeBox();
      place(box, i, 1, 0);
      p.container.add(box);
      p.batch.add(box, uniforms);
    }
    p.batch.flush();
    assert.equal(geometryDisposed, true);
    assert.equal(materialDisposed, false, "the panel is still drawing with this material");

    p.batch.dispose();
    assert.equal(materialDisposed, true);
  });
});

describe("box batch draw order", () => {
  test("a bucket draws half a step behind the boxes it holds, so text of that order goes first", () => {
    const container = new THREE.Group();
    place(container, 0, 0, 0);
    const batch = createBoxBatch(container);

    const { mesh: box, uniforms } = makeBox();
    place(box, 0, 0, 0);
    box.renderOrder = 7;
    container.add(box);
    batch.add(box, uniforms);
    batch.flush();

    const bucket = /** @type {THREE.InstancedMesh} */ (
      container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    assert.equal(bucket.renderOrder, 7.5);
    // Strictly inside its own level: after text at 7, before anything at 8.
    assert.ok(bucket.renderOrder > 7 && bucket.renderOrder < 8);
  });

  test("growing a bucket does not change where it draws", () => {
    const p = crowdedPanel(4);
    for (const box of p.boxes) {
      box.renderOrder = 7;
    }
    p.batch.flush();
    const before = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    assert.equal(before.renderOrder, 7.5);

    // Past the initial capacity of 16, which throws the mesh away and builds a
    // bigger one — the point at which sorting by object id used to reverse.
    for (let i = 0; i < 40; i++) {
      const { mesh: box, uniforms } = makeBox();
      place(box, i, 1, 0);
      box.renderOrder = 7;
      p.container.add(box);
      p.batch.add(box, uniforms);
    }
    p.batch.flush();

    const after = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    assert.notEqual(after.id, before.id, "expected the bucket to have been rebuilt");
    assert.equal(after.renderOrder, 7.5);
  });

  test("buckets of neighbouring orders never interleave", () => {
    const container = new THREE.Group();
    place(container, 0, 0, 0);
    const batch = createBoxBatch(container);
    for (const order of [7, 8]) {
      const { mesh: box, uniforms } = makeBox();
      place(box, 0, 0, 0);
      box.renderOrder = order;
      container.add(box);
      batch.add(box, uniforms);
    }
    batch.flush();

    const orders = container.children
      .filter((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
      .map((c) => c.renderOrder)
      .sort((a, b) => a - b);
    // Text of order 8 draws at 8, between these two.
    assert.deepEqual(orders, [7.5, 8.5]);
    assert.ok(orders[0] < 8 && orders[1] > 8);
  });
});

describe("the material a batched box wears", () => {
  test("is one material, shared, and out of the draw", () => {
    const p = panel();
    p.batch.flush();
    const material = /** @type {THREE.Material} */ (p.box.material);
    assert.equal(material.visible, false, "a batched box is drawn by the batch, not by itself");

    const other = makeBox();
    p.container.add(other.mesh);
    p.batch.add(other.mesh, other.uniforms);
    p.batch.flush();
    assert.equal(other.mesh.material, material, "and every batched box wears the same one");
  });

  test("removing one box does not put the others back into the draw", () => {
    // The hazard the sharing introduces, and the reason `remove` no longer
    // touches `visible`: clearing the flag on one box's teardown used to be
    // harmless because the material was that box's alone. On a shared one it
    // would put every other box on the page back into the render list.
    const p = panel();
    const other = makeBox();
    p.container.add(other.mesh);
    p.batch.add(other.mesh, other.uniforms);
    p.batch.flush();

    p.batch.remove(other.mesh);
    p.batch.flush();

    assert.equal(
      /** @type {THREE.Material} */ (p.box.material).visible,
      false,
      "the box still in the batch is still the batch's to draw",
    );
  });

  test("a box's numbers reach the bucket from its own record", () => {
    // They no longer live on the material, so this is the path that would
    // silently draw every box at the same size if the record were dropped.
    const p = panel();
    p.box.material = batchedBoxMaterial();
    p.uniforms.uSize.value.set(37, 11);
    p.batch.invalidate();
    p.batch.flush();

    const bucket = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find(
        (child) => /** @type {THREE.InstancedMesh} */ (child).isInstancedMesh,
      )
    );
    assert.ok(bucket);
    const sizes = /** @type {THREE.InstancedBufferAttribute} */ (
      bucket.geometry.getAttribute("aSize")
    ).array;
    assert.deepEqual([sizes[0], sizes[1]], [37, 11]);
  });

  test("a gradient rides in the size attribute's spare lanes and two of its own", () => {
    // Attribute slots are the limit, so the kind, flags and ramp row are one
    // packed number and the opacity the other spare lane; this is the
    // packing the vertex shader undoes.
    const p = panel();
    p.uniforms.uSize.value.set(20, 10);
    p.uniforms.uGradient.value.set(2, 1, 0, 1);
    p.uniforms.uGradientRamp.value.set(5, 0.5);
    p.uniforms.uGradientGeometry.value.set(1, 2, 3, 4);
    p.uniforms.uGradientTile.value.set(5, 6, 7, 8);
    p.batch.invalidate();
    p.batch.flush();

    const bucket = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find(
        (child) => /** @type {THREE.InstancedMesh} */ (child).isInstancedMesh,
      )
    );
    assert.ok(bucket);
    const read = (/** @type {string} */ name) =>
      Array.from(
        /** @type {THREE.InstancedBufferAttribute} */ (bucket.geometry.getAttribute(name)).array,
      ).slice(0, 4);
    // kind + 4 * repeating + 8 * repeat-x + 16 * repeat-y + 32 * row
    assert.deepEqual(read("aSize"), [20, 10, 2 + 4 + 16 + 32 * 5, 0.5]);
    assert.deepEqual(read("aGradientGeometry"), [1, 2, 3, 4]);
    assert.deepEqual(read("aGradientTile"), [5, 6, 7, 8]);
  });

  test("the batched material samples the page's ramp atlas", () => {
    const p = panel();
    const bucket = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find(
        (child) => /** @type {THREE.InstancedMesh} */ (child).isInstancedMesh,
      )
    );
    assert.ok(bucket);
    const material = /** @type {THREE.ShaderMaterial} */ (bucket.material);
    assert.equal(material.uniforms.uRamp, rampUniforms.uRamp);
    assert.equal(material.uniforms.uRampHeight, rampUniforms.uRampHeight);
  });

  test("a fragment with nothing to paint is discarded, so it writes no depth", () => {
    // What the draw order leans on (see `isOpaqueQuad` in elevation.js): a
    // box with no background and no border writes neither colour nor depth,
    // so stepped over a sibling it hides nothing of it, and its own marks
    // need it to draw after that sibling. Both materials a box can wear make
    // the same promise.
    const p = panel();
    const bucket = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find(
        (child) => /** @type {THREE.InstancedMesh} */ (child).isInstancedMesh,
      )
    );
    assert.ok(bucket);
    const discard = /if \(alpha < 0\.001\) \{\s*discard;\s*\}/;
    for (const material of [bucket.material, createRectMaterial()]) {
      const shader = /** @type {THREE.ShaderMaterial} */ (material);
      assert.equal(shader.depthWrite, true, "a box writes depth where it paints");
      assert.match(shader.fragmentShader, discard);
    }
  });

  test("a box's description stays within the attribute slots WebGL promises", () => {
    // Sixteen is the minimum MAX_VERTEX_ATTRIBS, and what a headset browser
    // gives. A vec4 or smaller takes one slot, a mat4 four.
    const p = panel();
    const bucket = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find(
        (child) => /** @type {THREE.InstancedMesh} */ (child).isInstancedMesh,
      )
    );
    assert.ok(bucket);
    const attributes = Object.keys(bucket.geometry.attributes).length;
    // Plus the instance matrix, which is not a geometry attribute.
    assert.ok(attributes + 4 <= 16, `${attributes} attributes and a matrix`);
  });
});

describe("box batch instance uploads", () => {
  test("a rebuild that changed nothing marks no buffer for upload", () => {
    const { container, batch } = crowdedPanel(3);
    batch.flush();
    const before = instanceVersions(container);
    assert.ok(Object.keys(before).length > 0, "expected a bucket");

    batch.invalidate();
    batch.flush();

    assert.deepEqual(instanceVersions(container), before);
  });

  test("a box that moved marks its matrices and nothing else", () => {
    const { container, batch, boxes } = crowdedPanel(3);
    batch.flush();
    const before = instanceVersions(container);

    place(boxes[1], 5, 0, 0);
    batch.invalidate();
    batch.flush();

    const after = instanceVersions(container);
    const changed = Object.keys(after).filter((key) => after[key] !== before[key]);
    assert.equal(changed.length, 1, `expected the matrices alone, got ${changed.join(", ")}`);
    assert.match(changed[0], /:instanceMatrix$/);
  });
});

describe("box batch depth bias", () => {
  /**
   * A batch of one box under `depthRank`, ranked 7, and its bucket.
   *
   * @param {import("./boxBatch.js").DepthRankBias} [depthRank]
   */
  function ranked(depthRank) {
    const container = new THREE.Group();
    const { mesh, uniforms } = makeBox();
    container.add(mesh);
    const batch = createBoxBatch(container, depthRank);
    batch.add(mesh, uniforms);
    batch.setRank(mesh, 7);
    batch.flush();
    const bucket = /** @type {THREE.InstancedMesh} */ (
      container.children.find((child) => child instanceof THREE.InstancedMesh)
    );
    assert.ok(bucket, "expected a bucket");
    return { batch, bucket, material: /** @type {THREE.ShaderMaterial} */ (bucket.material) };
  }

  test("a constant bias compiles the constant and no slope", () => {
    const { batch, bucket, material } = ranked("constant");
    assert.equal(material.defines.DEPTH_RANK, "");
    assert.equal(material.defines.DEPTH_RANK_SLOPE, undefined);
    assert.equal(Number(material.defines.DEPTH_RANK_EPSILON), DEPTH_RANK_EPSILON);
    // Packed with the box's opacity, 1.
    assert.equal(bucket.geometry.getAttribute("aSize").array[3], 2 * 7 + 1);
    batch.dispose();
  });

  test("a slope bias follows the viewport it is drawn into, and uploads it once", () => {
    const { batch, bucket, material } = ranked("slope");
    assert.equal(material.defines.DEPTH_RANK_SLOPE, "");
    const renderer = /** @type {THREE.WebGLRenderer} */ (
      /** @type {unknown} */ ({
        /** @param {THREE.Vector4} target */
        getCurrentViewport: (target) => target.set(1680, 0, 1680, 1760),
      })
    );
    const draw = () =>
      bucket.onBeforeRender(
        renderer,
        new THREE.Scene(),
        new THREE.PerspectiveCamera(),
        bucket.geometry,
        material,
        new THREE.Group(),
      );
    material.uniformsNeedUpdate = false;
    draw();
    assert.deepEqual(material.uniforms.uDepthRankViewport.value.toArray(), [1680, 1760]);
    assert.equal(material.uniformsNeedUpdate, true, "a new viewport is uploaded");
    material.uniformsNeedUpdate = false;
    draw();
    assert.equal(material.uniformsNeedUpdate, false, "the same viewport is not uploaded again");
    batch.dispose();
  });

  test("a batch without a bias ignores a rank", () => {
    const { batch, bucket, material } = ranked();
    assert.equal(bucket.geometry.getAttribute("aSize").array[3], 1, "the opacity alone");
    assert.equal(material.uniforms.uDepthRankViewport, undefined);
    batch.dispose();
  });

  test("a bias is one of the two the shader has", () => {
    // @ts-expect-error: there is no "linear" bias.
    createBoxBatch(new THREE.Group(), "linear").dispose();
  });
});

describe("box batch attribute budget", () => {
  test("the vertex shader declares no more attributes than ANGLE will link", () => {
    // ANGLE, under Chromium's WebGL, counts every declared attribute against
    // the sixteen, used or not. Three declares `position`, `normal` and `uv`
    // in front of a `ShaderMaterial`, and the instance matrix takes four.
    // Counted in the source, every `#ifdef` included, under the slope.
    const container = new THREE.Group();
    const { mesh, uniforms } = makeBox();
    container.add(mesh);
    const ranked = createBoxBatch(container, "slope");
    ranked.add(mesh, uniforms);
    ranked.flush();
    const bucket = /** @type {THREE.InstancedMesh} */ (
      container.children.find((child) => child instanceof THREE.InstancedMesh)
    );
    const source = /** @type {THREE.ShaderMaterial} */ (bucket.material).vertexShader;
    const own = source.match(/^\s*attribute\s+\w+\s+\w+;/gm)?.length ?? 0;
    assert.ok(3 + 4 + own <= 16, `${3 + 4 + own} attribute slots`);
    ranked.dispose();
  });
});
