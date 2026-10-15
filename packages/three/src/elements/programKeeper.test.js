import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { RendererContext } from "../render.js";
import { countingManager } from "../test/portalHarness.js";
import { stubGlRenderer } from "../test/stubGl.js";
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
import { createTextBatch } from "./textBatch.js";
import { createMarkMaterial } from "./textHelpers.js";

/**
 * A scene drawn by three's own renderer over a context that counts what it
 * links, frees and draws.
 */
function stage() {
  const { renderer, counts } = stubGlRenderer();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  return {
    scene,
    counts,
    draw: () => renderer.render(scene, camera),
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
 * A panel's batch of text, `count` runs of one size.
 *
 * @param {number} count
 */
function textPanel(count) {
  const container = new THREE.Group();
  place(container, 0, 0, 0);
  const batch = createTextBatch(container);
  const grow = (/** @type {number} */ more) => {
    for (let i = 0; i < more; i++) {
      const canvas = /** @type {HTMLCanvasElement} */ (
        /** @type {unknown} */ ({ width: 24, height: 12, getContext: () => null })
      );
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array([0, 0, 0, 24, 0, 0, 0, 12, 0, 24, 12, 0]), 3),
      );
      const run = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ alphaMap: new THREE.Texture(canvas) }),
      );
      place(run, 0, 0, 0);
      container.add(run);
      batch.add(run, { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) });
    }
    batch.flush();
  };
  grow(count);
  return { container, batch, grow };
}

/** A panel's batch of boxes, with one box in it. */
function boxPanel() {
  const container = new THREE.Group();
  place(container, 0, 0, 0);
  const box = new THREE.Mesh(rectGeometry, batchedBoxMaterial());
  place(box, 0, 0, 0);
  container.add(box);
  const batch = createBoxBatch(container);
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

  test("a text bucket that grows links nothing", () => {
    const { scene, counts, draw } = stage();
    const panel = textPanel(6);
    scene.add(panel.container);
    draw();
    const linked = counts.programs;

    // A bucket starts with room for 8 runs, so this rebuilds it at 16.
    panel.grow(6);
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
