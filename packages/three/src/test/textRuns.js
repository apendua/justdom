import * as THREE from "three";
import { place } from "../elements/place.js";
import { PaintBatch } from "../elements/paintBatch.js";

/** @import {LayerOrder} from "../elements/layerOrder.js"; */

/**
 * A rasterized run, as the batch reads one: a mask in the material's alpha
 * map, and a quad whose position attribute carries the run's size.
 *
 * The canvas is a stand-in. The batch asks it for its size and for a 2d
 * context to copy pixels out of, and `SizeClass.write` is written to do
 * nothing when there is no context — which is what jsdom offers, and enough
 * for everything about layers and draws.
 *
 * @param {number} width
 * @param {number} height
 */
export function run(width, height) {
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
 * A panel's one batch over `container`, with an order that cuts no layer,
 * as a panel's is when nothing in it crosses another layer's plane.
 *
 * @param {THREE.Object3D} container
 * @returns {PaintBatch}
 */
export function paintBatch(container) {
  const batch = new PaintBatch(container);
  batch.orderBy(/** @type {LayerOrder} */ (/** @type {unknown} */ ({ isCut: () => false })));
  return batch;
}

/**
 * A panel of `count` runs, all the same size and render order, so they share
 * one size class and one draw. `draws` is the panel's one batch, and `batch`
 * the text batch in it.
 *
 * @param {number} count
 */
export function panel(count) {
  const container = new THREE.Group();
  place(container, 0, 0, 0);

  const draws = paintBatch(container);
  const batch = draws.runs;
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

  return { container, draws, batch, meshes, watch, grow };
}
