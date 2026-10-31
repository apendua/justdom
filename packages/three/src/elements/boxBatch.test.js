import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { BOX_BUCKET_BIAS, UNBATCHED_BOX_BIAS } from "./boxBatch.js";
import { batchedBoxMaterial, createRectUniforms, rectGeometry } from "./sdfRect.js";
import { rampUniforms } from "./gradient.js";
import { CARET_ORDER_BIAS } from "./textInput.js";
import { place } from "./place.js";
import { instanceVersions } from "../test/instanceVersions.js";
import { paintBatch } from "../test/textRuns.js";

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
 * A panel with one box in it, batched. `draws` is the panel's one batch,
 * and `batch` the box batch in it.
 */
function panel() {
  const container = new THREE.Group();
  place(container, 0, 0, 0);

  const { mesh: box, uniforms } = makeBox();
  place(box, 0, 0, 0);
  container.add(box);

  const draws = paintBatch(container);
  const batch = draws.boxes;
  batch.add(box, uniforms);
  draws.flush();

  return {
    container,
    box,
    uniforms,
    draws,
    batch,
    /** Where the batch believes the box is, in container space. */
    drawnX() {
      const draw = container.children.find(
        (child) => /** @type {THREE.InstancedMesh} */ (child).isInstancedMesh,
      );
      assert.ok(draw, "expected the batch to have made a draw");
      const matrix = new THREE.Matrix4();
      /** @type {THREE.InstancedMesh} */ (draw).getMatrixAt(0, matrix);
      return matrix.elements[12];
    },
  };
}

/**
 * A panel of `count` boxes, all of one render order, so they share a draw
 * and the draw has to grow to hold them.
 *
 * @param {number} count
 */
function crowdedPanel(count) {
  const container = new THREE.Group();
  place(container, 0, 0, 0);

  const draws = paintBatch(container);
  const batch = draws.boxes;
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

  return { container, draws, batch, boxes, meshes, watch };
}

/** Let queued microtasks run. */
const microtasks = () => Promise.resolve();

describe("the draw order within one level", () => {
  test("keeps the rungs of the table at BOX_BUCKET_BIAS in order, under the next level", () => {
    // Text at 0, then the caret, a picture's box, the batched boxes, and the
    // next level's text at 1.
    const rungs = [0, CARET_ORDER_BIAS, UNBATCHED_BOX_BIAS, BOX_BUCKET_BIAS, 1];
    assert.deepEqual(
      [...rungs].sort((a, b) => a - b),
      rungs,
      `in order: ${rungs.join(", ")}`,
    );
    assert.equal(new Set(rungs).size, rungs.length, "no two rungs share a place");
  });
});

describe("the one batch's rebuild scheduling", () => {
  test("a flush before the draw shows a box where this frame put it, not where the last one did", async () => {
    const p = panel();
    assert.equal(p.drawnX(), 0);

    // What a sampled CSS animation does from inside the frame callback: move
    // the box, say so, and carry on with the frame.
    place(p.box, 7, 0, 0);
    p.draws.invalidate();

    // The microtask this queued cannot have run — the frame callback has not
    // returned — so without a flush the draw at the end of it would still be
    // reading the previous frame's number.
    assert.equal(p.drawnX(), 0);

    p.draws.flush();
    assert.equal(p.drawnX(), 7);
  });

  test("the microtask does not rebuild again over a flush that already ran", async () => {
    const p = panel();
    let rebuilds = 0;
    const rebuild = p.draws.rebuild.bind(p.draws);
    p.draws.rebuild = () => {
      rebuilds += 1;
      rebuild();
    };

    place(p.box, 7, 0, 0);
    p.draws.invalidate();
    p.draws.flush();
    assert.equal(rebuilds, 1);

    await microtasks();
    assert.equal(rebuilds, 1);
    assert.equal(p.drawnX(), 7);
  });

  test("many invalidations in one frame are still one rebuild", async () => {
    const p = panel();
    let rebuilds = 0;
    const rebuild = p.draws.rebuild.bind(p.draws);
    p.draws.rebuild = () => {
      rebuilds += 1;
      rebuild();
    };

    for (let i = 1; i <= 20; i++) {
      place(p.box, i, 0, 0);
      p.draws.invalidate();
    }
    p.draws.flush();

    assert.equal(rebuilds, 1);
    assert.equal(p.drawnX(), 20);
  });

  test("a flush with nothing owing does nothing", async () => {
    const p = panel();
    let rebuilds = 0;
    const rebuild = p.draws.rebuild.bind(p.draws);
    p.draws.rebuild = () => {
      rebuilds += 1;
      rebuild();
    };

    p.draws.flush();
    p.draws.flush();
    assert.equal(rebuilds, 0);
  });

  test("the microtask still settles a panel with no frames to flush in", async () => {
    const p = panel();

    place(p.box, 7, 0, 0);
    p.draws.invalidate();
    assert.equal(p.drawnX(), 0);

    await microtasks();
    assert.equal(p.drawnX(), 7);
  });

  test("a disposed batch neither flushes nor rebuilds on its way out", async () => {
    const p = panel();
    let rebuilds = 0;
    const rebuild = p.draws.rebuild.bind(p.draws);
    p.draws.rebuild = () => {
      rebuilds += 1;
      rebuild();
    };

    place(p.box, 7, 0, 0);
    p.draws.invalidate();
    p.draws.dispose();

    p.draws.flush();
    await microtasks();
    assert.equal(rebuilds, 0);
  });
});

describe("box batch teardown", () => {
  test("every mesh a growing draw leaves behind is told it is going", () => {
    // A draw starts with room for 16 and doubles from there.
    const p = crowdedPanel(40);
    p.draws.flush();
    p.watch();
    assert.equal(p.meshes.size, 1);

    for (let i = 0; i < 40; i++) {
      const { mesh: box, uniforms } = makeBox();
      place(box, i, 1, 0);
      p.container.add(box);
      p.batch.add(box, uniforms);
    }
    p.draws.flush();
    p.watch();
    assert.equal(p.meshes.size, 2, "expected the draw to have been rebuilt bigger");

    // The one it grew out of is gone, the one it is drawing with is not.
    const [outgrown, current] = [...p.meshes.keys()];
    assert.equal(p.meshes.get(outgrown), true);
    assert.equal(p.meshes.get(current), false);
    assert.equal(outgrown.parent, null);
    assert.equal(current.parent, p.container);
  });

  test("disposing the batch tells three about the mesh it was still drawing with", () => {
    const p = crowdedPanel(4);
    p.draws.flush();
    p.watch();
    assert.equal(p.meshes.size, 1);

    p.draws.dispose();
    assert.deepEqual([...p.meshes.values()], [true]);
    assert.equal(
      p.container.children.filter((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
        .length,
      0,
    );
  });

  test("a draw's geometry goes with its mesh, and its material only at the end", () => {
    const p = crowdedPanel(4);
    p.draws.flush();
    const draw = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    const material = /** @type {THREE.Material} */ (draw.material);

    let geometryDisposed = false;
    let materialDisposed = false;
    draw.geometry.addEventListener("dispose", () => {
      geometryDisposed = true;
    });
    material.addEventListener("dispose", () => {
      materialDisposed = true;
    });

    // Grow it: the geometry is this mesh's, and the material is the draw's,
    // kept across a growth.
    for (let i = 0; i < 40; i++) {
      const { mesh: box, uniforms } = makeBox();
      place(box, i, 1, 0);
      p.container.add(box);
      p.batch.add(box, uniforms);
    }
    p.draws.flush();
    assert.equal(geometryDisposed, true);
    assert.equal(materialDisposed, false, "the panel is still drawing with this material");

    p.draws.dispose();
    assert.equal(materialDisposed, true);
  });
});

describe("box batch draw order", () => {
  test("a draw of boxes draws half a step behind them, so text of that order goes first", () => {
    const container = new THREE.Group();
    place(container, 0, 0, 0);
    const draws = paintBatch(container);

    const { mesh: box, uniforms } = makeBox();
    place(box, 0, 0, 0);
    box.renderOrder = 7;
    container.add(box);
    draws.boxes.add(box, uniforms);
    draws.flush();

    const draw = /** @type {THREE.InstancedMesh} */ (
      container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    assert.equal(draw.renderOrder, 7.5);
    // Strictly inside its own level: after text at 7, before anything at 8.
    assert.ok(draw.renderOrder > 7 && draw.renderOrder < 8);
  });

  test("growing a draw does not change where it draws", () => {
    const p = crowdedPanel(4);
    for (const box of p.boxes) {
      box.renderOrder = 7;
    }
    p.draws.flush();
    const before = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    assert.equal(before.renderOrder, 7.5);

    // Past the initial capacity of 16, which throws the mesh away and builds a
    // bigger one.
    for (let i = 0; i < 40; i++) {
      const { mesh: box, uniforms } = makeBox();
      place(box, i, 1, 0);
      box.renderOrder = 7;
      p.container.add(box);
      p.batch.add(box, uniforms);
    }
    p.draws.flush();

    const after = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    assert.notEqual(after.id, before.id, "expected the draw to have been rebuilt");
    assert.equal(after.renderOrder, 7.5);
  });

  test("boxes of neighbouring orders are laid in their order, whatever order they joined in", () => {
    const container = new THREE.Group();
    place(container, 0, 0, 0);
    const draws = paintBatch(container);
    for (const order of [8, 7]) {
      const { mesh: box, uniforms } = makeBox();
      place(box, order, 0, 0);
      box.renderOrder = order;
      container.add(box);
      draws.boxes.add(box, uniforms);
    }
    draws.flush();

    const draw = /** @type {THREE.InstancedMesh} */ (
      container.children.find((c) => /** @type {THREE.InstancedMesh} */ (c).isInstancedMesh)
    );
    const matrix = new THREE.Matrix4();
    const laid = [0, 1].map((i) => {
      draw.getMatrixAt(i, matrix);
      return matrix.elements[12];
    });
    assert.deepEqual(laid, [7, 8]);
  });
});

describe("the material a batched box wears", () => {
  test("is one material, shared, and out of the draw", () => {
    const p = panel();
    p.draws.flush();
    const material = /** @type {THREE.Material} */ (p.box.material);
    assert.equal(material.visible, false, "a batched box is drawn by the batch, not by itself");

    const other = makeBox();
    p.container.add(other.mesh);
    p.batch.add(other.mesh, other.uniforms);
    p.draws.flush();
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
    p.draws.flush();

    p.batch.remove(other.mesh);
    p.draws.flush();

    assert.equal(
      /** @type {THREE.Material} */ (p.box.material).visible,
      false,
      "the box still in the batch is still the batch's to draw",
    );
  });

  test("a box's numbers reach the draw from its own record", () => {
    // They no longer live on the material, so this is the path that would
    // silently draw every box at the same size if the record were dropped.
    const p = panel();
    p.box.material = batchedBoxMaterial();
    p.uniforms.uSize.value.set(37, 11);
    p.batch.invalidate();
    p.draws.flush();

    const draw = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find(
        (child) => /** @type {THREE.InstancedMesh} */ (child).isInstancedMesh,
      )
    );
    assert.ok(draw);
    const sizes = /** @type {THREE.InstancedBufferAttribute} */ (
      draw.geometry.getAttribute("aSize")
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
    p.draws.flush();

    const draw = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find(
        (child) => /** @type {THREE.InstancedMesh} */ (child).isInstancedMesh,
      )
    );
    assert.ok(draw);
    const read = (/** @type {string} */ name) =>
      Array.from(
        /** @type {THREE.InstancedBufferAttribute} */ (draw.geometry.getAttribute(name)).array,
      ).slice(0, 4);
    // kind + 4 * repeating + 8 * repeat-x + 16 * repeat-y + 32 * row
    assert.deepEqual(read("aSize"), [20, 10, 2 + 4 + 16 + 32 * 5, 0.5]);
    assert.deepEqual(read("aGradientGeometry"), [1, 2, 3, 4]);
    assert.deepEqual(read("aGradientTile"), [5, 6, 7, 8]);
  });

  test("the batched material samples the page's ramp atlas", () => {
    const p = panel();
    const draw = /** @type {THREE.InstancedMesh} */ (
      p.container.children.find(
        (child) => /** @type {THREE.InstancedMesh} */ (child).isInstancedMesh,
      )
    );
    assert.ok(draw);
    const material = /** @type {THREE.ShaderMaterial} */ (draw.material);
    assert.equal(material.uniforms.uRamp, rampUniforms.uRamp);
    assert.equal(material.uniforms.uRampHeight, rampUniforms.uRampHeight);
  });
});

describe("box batch instance uploads", () => {
  test("a rebuild that changed nothing marks no buffer for upload", () => {
    const { container, draws } = crowdedPanel(3);
    draws.flush();
    const before = instanceVersions(container);
    assert.ok(Object.keys(before).length > 0, "expected a draw");

    draws.invalidate();
    draws.flush();

    assert.deepEqual(instanceVersions(container), before);
  });

  test("a box that moved marks its matrices and nothing else", () => {
    const { container, draws, boxes } = crowdedPanel(3);
    draws.flush();
    const before = instanceVersions(container);

    place(boxes[1], 5, 0, 0);
    draws.invalidate();
    draws.flush();

    const after = instanceVersions(container);
    const changed = Object.keys(after).filter((key) => after[key] !== before[key]);
    assert.equal(changed.length, 1, `expected the matrices alone, got ${changed.join(", ")}`);
    assert.match(changed[0], /:instanceMatrix$/);
  });
});
