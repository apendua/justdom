import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { RendererContext } from "../render.js";
import { countingManager } from "../test/portalHarness.js";
import { stubGlRenderer } from "../test/stubGl.js";
import { panel } from "../test/textRuns.js";
import { createDepthQuad } from "./blocker.js";
import { createBoxBatch } from "./boxBatch.js";
import { applyClip, applyReveal } from "./clip.js";
import { createLoadingFrame } from "./loadingFrame.js";
import { createPanelHandles } from "./panelHandles.js";
import { place } from "./place.js";
import {
  batchedBoxMaterial,
  createRectMaterial,
  createRectUniforms,
  rectGeometry,
} from "./sdfRect.js";
import { createMarkMaterial } from "./textHelpers.js";

/**
 * A scene drawn by three's own renderer over a context that counts what it
 * links, frees and draws.
 */
function stage() {
  const { renderer, counts, restoreContext } = stubGlRenderer();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const target = new THREE.WebGLRenderTarget(4, 4);
  return {
    scene,
    counts,
    restoreContext,
    draw: () => renderer.render(scene, camera),
    /** Draw the scene into a render target, as `ghostSnapshot.js` does. */
    drawToTarget: () => {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
    },
  };
}

/**
 * A mark as a run of text draws itself: the clip patch, and a mask in the
 * alpha map.
 *
 * @param {(material: THREE.MeshBasicMaterial) => void} [patch]
 */
function mark(patch = (material) => applyClip(material, { value: new THREE.Vector4() })) {
  const material = createMarkMaterial();
  patch(material);
  material.alphaMap = new THREE.Texture();
  return new THREE.Mesh(rectGeometry, material);
}

/**
 * A panel's batch of text, `count` runs of one size, settled.
 *
 * @param {number} count
 */
function textPanel(count) {
  const p = panel(count);
  p.batch.flush();
  return p;
}

/**
 * A panel's batch of boxes, with one box in it.
 *
 * @param {import("./boxBatch.js").DepthRankBias} [depthRank]
 */
function boxPanel(depthRank) {
  const container = new THREE.Group();
  place(container, 0, 0, 0);
  const box = new THREE.Mesh(rectGeometry, batchedBoxMaterial());
  place(box, 0, 0, 0);
  container.add(box);
  const batch = createBoxBatch(container, depthRank);
  batch.add(box, createRectUniforms());
  batch.flush();
  return { container, batch };
}

describe("programKeeper", () => {
  test("a loading frame after the last one went links nothing", () => {
    const { scene, counts, draw } = stage();
    const first = createLoadingFrame();
    first.layout(200, 100);
    scene.add(first.object);
    draw();
    assert.equal(counts.programs, 1, "the frame and its dots are one program");

    first.dispose();
    draw();
    const second = createLoadingFrame();
    second.layout(200, 100);
    scene.add(second.object);
    draw();
    assert.deepEqual([counts.programs, counts.programsFreed], [1, 0]);
  });

  test("a box panel with a depth bias, after the last one closed, links nothing", () => {
    for (const depthRank of /** @type {const} */ (["constant", "slope", "max"])) {
      const { scene, counts, draw } = stage();
      const first = boxPanel(depthRank);
      scene.add(first.container);
      draw();
      assert.equal(counts.programs, 1, `${depthRank}: the keeper is the panel's own program`);

      first.batch.dispose();
      scene.remove(first.container);
      draw();
      const second = boxPanel(depthRank);
      scene.add(second.container);
      draw();
      assert.deepEqual([counts.programs, counts.programsFreed], [1, 0], depthRank);
    }
  });

  test("box panels of every bias, after the last ones closed, link nothing", () => {
    const { scene, counts, draw } = stage();
    const biases = /** @type {const} */ ([undefined, "constant", "slope", "max"]);
    const open = () =>
      biases.map((depthRank) => {
        const p = boxPanel(depthRank);
        scene.add(p.container);
        return p;
      });
    const first = open();
    draw();
    assert.equal(counts.programs, biases.length, "a program for each bias, and one for none");

    for (const p of first) {
      p.batch.dispose();
      scene.remove(p.container);
    }
    draw();
    open();
    draw();
    assert.deepEqual([counts.programs, counts.programsFreed], [biases.length, 0]);
  });

  test("a text bucket that grows links nothing", () => {
    const { scene, counts, draw } = stage();
    const p = textPanel(6);
    scene.add(p.container);
    draw();
    const linked = counts.programs;

    // A bucket starts with room for 8 runs, so this rebuilds it at 16.
    p.grow(6);
    p.batch.flush();
    draw();
    assert.deepEqual([counts.programs, counts.programsFreed], [linked, 0]);
  });

  test("a panel's text and boxes, after the last panel closed, link nothing", () => {
    const { scene, counts, draw } = stage();
    const text = textPanel(2);
    const boxes = boxPanel();
    scene.add(text.container, boxes.container);
    draw();
    const linked = counts.programs;

    text.batch.dispose();
    boxes.batch.dispose();
    scene.remove(text.container, boxes.container);
    draw();
    const again = [textPanel(2).container, boxPanel().container];
    scene.add(...again);
    draw();
    assert.deepEqual([counts.programs, counts.programsFreed], [linked, 0]);
  });

  test("a panel's depth quad, after the last one went, links nothing", () => {
    const { scene, counts, draw } = stage();
    const first = createDepthQuad();
    scene.add(first);
    draw();
    assert.equal(counts.programs, 1);

    first.removeFromParent();
    first.material.dispose();
    draw();
    scene.add(createDepthQuad());
    draw();
    assert.deepEqual([counts.programs, counts.programsFreed], [1, 0]);
  });

  test("a box drawn by itself, after the last one went, links nothing", () => {
    const { scene, counts, draw } = stage();
    const first = new THREE.Mesh(rectGeometry, createRectMaterial());
    scene.add(first);
    draw();

    first.material.dispose();
    first.material = createRectMaterial();
    draw();
    assert.deepEqual([counts.programs, counts.programsFreed], [1, 0]);
  });

  test("each of a mark's programs is kept, as it is drawn", () => {
    const { scene, counts, draw } = stage();
    const reveal = (/** @type {THREE.MeshBasicMaterial} */ material) =>
      applyReveal(material, { value: new THREE.Vector4() }, { value: new THREE.Vector4() });
    const pictured = (/** @type {THREE.MeshBasicMaterial} */ material) => {
      applyClip(material, { value: new THREE.Vector4() });
      material.map = new THREE.Texture();
    };
    const marks = [mark(), mark(reveal), mark(pictured)];
    scene.add(...marks);
    draw();
    assert.equal(counts.programs, 3);

    for (const old of marks) {
      old.removeFromParent();
      old.material.dispose();
    }
    draw();
    scene.add(mark(), mark(reveal), mark(pictured));
    draw();
    assert.deepEqual([counts.programs, counts.programsFreed], [3, 0]);
  });

  test("a mark whose mask becomes a picture keeps that program too", () => {
    const { scene, counts, draw } = stage();
    const run = mark();
    scene.add(run);
    draw();
    // What `textRun` does when a run's tint stops being a mask.
    run.material.map = run.material.alphaMap;
    run.material.alphaMap = null;
    run.material.needsUpdate = true;
    draw();
    assert.equal(counts.programs, 2);

    run.material.dispose();
    const pictured = mark();
    pictured.material.map = pictured.material.alphaMap;
    pictured.material.alphaMap = null;
    scene.add(pictured);
    draw();
    assert.deepEqual([counts.programs, counts.programsFreed], [2, 0]);
  });

  test("a panel's handle bars, after the last panel's went, link nothing", () => {
    const { scene, counts, draw } = stage();
    const ctx = RendererContext.set(countingManager().ctx, /** @type {any} */ ({}));
    const show = () => {
      const handles = createPanelHandles(ctx);
      handles.layout(200, 100, 0.01);
      handles.setShown(true);
      handles.frame.traverse((object) => {
        // What a hand coming near does.
        object.visible = true;
      });
      scene.add(handles.frame);
      return handles;
    };
    const first = show();
    draw();
    const linked = counts.programs;

    first.dispose();
    draw();
    show();
    draw();
    assert.deepEqual([counts.programs, counts.programsFreed], [linked, 0]);
  });

  test("a box drawn into a render target, after the last one there went, links nothing", () => {
    const { scene, counts, draw, drawToTarget } = stage();
    const box = new THREE.Mesh(rectGeometry, createRectMaterial());
    scene.add(box);
    draw();
    drawToTarget();
    assert.equal(counts.programs, 2, "a target is compiled for apart from the screen");

    box.material.dispose();
    box.material = createRectMaterial();
    drawToTarget();
    draw();
    assert.deepEqual([counts.programs, counts.programsFreed], [2, 0]);
  });

  test("a box after a lost context came back, and the last box went, links nothing more", () => {
    const { scene, counts, draw, restoreContext } = stage();
    const box = new THREE.Mesh(rectGeometry, createRectMaterial());
    scene.add(box);
    draw();
    restoreContext();
    draw();
    assert.equal(counts.programs, 2, "a restored context links what it draws again");

    box.material.dispose();
    box.material = createRectMaterial();
    draw();
    assert.deepEqual([counts.programs, counts.programsFreed], [2, 0]);
  });

  test("a keeper is drawn once, with the first of its kind, and writes nothing", () => {
    const { scene, counts, draw } = stage();
    const box = new THREE.Mesh(rectGeometry, createRectMaterial());
    scene.add(box);
    draw();
    assert.deepEqual([counts.draws, counts.unseenDraws], [2, 1], "the box and its keeper");
    draw();
    assert.deepEqual([counts.draws, counts.unseenDraws], [3, 1], "the box alone");

    // A second box of the kind has its keeper already.
    scene.add(new THREE.Mesh(rectGeometry, createRectMaterial()));
    draw();
    assert.deepEqual([counts.draws, counts.unseenDraws], [5, 1]);
  });
});
