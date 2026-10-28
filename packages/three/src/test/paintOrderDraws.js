import * as THREE from "three";
import { getPanel } from "../elements/dragAndDrop.js";
import { isProxy } from "../elements/layerOrder.js";
import { panelName } from "./paintOrderCount.js";

/**
 * Phase 4 of `docs/freedom-paint-order-plan.md`: the draw calls a frame
 * actually makes, in a page running a session, by the panel that made them.
 *
 * Every WebGL draw call is counted where the context makes it, so a batch
 * that breaks where the count says it does not shows. Each is put down to
 * the object three drew last: three calls an object's `onBeforeRender`
 * just before the draws of each of its render items, so the draws after
 * it are that object's until the next. An object in a panel puts its draws
 * down to the panel's root element (`getPanel`); any other, the room, the
 * hands and the frame rate readout among them, to the scene. A panel's
 * draws with a material that writes no colour are counted apart: its
 * blockers (`blocker.js`), which stop rays and draw nothing, and its depth
 * quad. The rest are its content, what the count counts.
 *
 * A mesh of instances is re-packed in a frame its buffers changed in: its
 * instance matrices, or an instanced attribute of its geometry, marked for
 * upload since the frame before (`markChanged` in `instanceUploads.js`
 * marks only what changed). It counts the instances it draws, once a
 * frame, to its panel. A proxy of a layer cut in pieces (`layerOrder.js`)
 * shares its mesh's buffers and is not counted again, nor is a spare taken
 * back onto another mesh's, which uploads nothing. That is the figure the
 * plan's moving transform row reads: a clock whose hands move re-packs the
 * draw the hands share with the dial.
 *
 * One eye is the camera that drew the most. In a session three draws each
 * eye from a camera of its own, and both draw the same; a page can draw
 * from others too, as the showcase does one item a frame.
 *
 * Installed once in the page; a measure counts the frames between its
 * start and its end.
 */

/**
 * @typedef {object} DrawCount
 * @property {number} frames The frames the renderer drew.
 * @property {number} total Draw calls a frame, from every camera.
 * @property {[string, number][]} panels Each panel's draw calls a frame
 *   of its content from one eye, by its root's id or its place among the
 *   page's panels.
 * @property {[string, number][]} blank Each panel's draw calls a frame
 *   from one eye that write no colour, in the same order.
 * @property {number} scene Draw calls a frame from one eye of everything
 *   else.
 * @property {[string, number][]} repacked Each panel's instances re-packed
 *   a frame, in the same order as `panels`.
 */

/**
 * @typedef {object} Counter
 * @property {HTMLElement | null} panel Whose the next draw is.
 * @property {boolean} blank Whether it writes no colour.
 * @property {THREE.Camera | null} camera What it is drawn from.
 * @property {Map<THREE.Camera, View>} views
 * @property {number} total
 * @property {THREE.WebGLRenderer | null} renderer
 * @property {Map<HTMLElement, number>} repacked
 * @property {WeakMap<THREE.Object3D, { version: number, frame: number }>} seen
 *   Each mesh of instances' buffers' versions when it was last drawn, and
 *   the frame.
 */

/**
 * @typedef {object} View One camera's draws.
 * @property {Map<HTMLElement, number>} panels
 * @property {Map<HTMLElement, number>} blank
 * @property {number} scene
 * @property {number} total
 */

/** @type {Counter | null} */
let counter = null;

const DRAWS = /** @type {const} */ ([
  "drawArrays",
  "drawElements",
  "drawArraysInstanced",
  "drawElementsInstanced",
  "drawRangeElements",
]);

/** @returns {Counter} */
function install() {
  if (counter) {
    return counter;
  }
  /** @type {Counter} */
  const state = {
    panel: null,
    blank: false,
    camera: null,
    views: new Map(),
    total: 0,
    renderer: null,
    repacked: new Map(),
    seen: new WeakMap(),
  };
  const proto = THREE.Object3D.prototype;
  const previous = proto.onBeforeRender;
  proto.onBeforeRender = function (renderer, scene, camera, geometry, material, ...rest) {
    state.renderer = renderer;
    state.camera = camera;
    // A scene's own hook is called with its render target where a mesh's
    // has its material.
    state.blank = material?.colorWrite === false;
    state.panel = getPanel(this)?.element ?? null;
    if (state.panel && this instanceof THREE.InstancedMesh && !isProxy(this)) {
      countRepack(state, this, renderer.info.render.frame);
    }
    previous.call(this, renderer, scene, camera, geometry, material, ...rest);
  };
  const gl = /** @type {Record<string, Function>} */ (
    /** @type {unknown} */ (WebGL2RenderingContext.prototype)
  );
  for (const name of DRAWS) {
    const original = gl[name];
    gl[name] = function (/** @type {unknown[]} */ ...args) {
      state.total += 1;
      if (state.camera) {
        let view = state.views.get(state.camera);
        if (!view) {
          view = { panels: new Map(), blank: new Map(), scene: 0, total: 0 };
          state.views.set(state.camera, view);
        }
        view.total += 1;
        if (state.panel) {
          const tally = state.blank ? view.blank : view.panels;
          tally.set(state.panel, (tally.get(state.panel) ?? 0) + 1);
        } else {
          view.scene += 1;
        }
      }
      return original.apply(this, args);
    };
  }
  counter = state;
  return state;
}

/**
 * The draw calls of the next `count` frames the page's renderer draws.
 *
 * @param {number} count
 * @returns {Promise<DrawCount>}
 */
export async function measureDraws(count) {
  const state = install();
  // One frame for the hooks to see the renderer, if this is the first.
  await nextFrame();
  if (!state.renderer) {
    throw new Error("no renderer drew a frame");
  }
  const renderer = state.renderer;
  state.views.clear();
  state.total = 0;
  state.repacked.clear();
  const first = renderer.info.render.frame;
  for (let i = 0; i < count; i += 1) {
    await nextFrame();
  }
  const frames = renderer.info.render.frame - first;
  if (frames === 0) {
    throw new Error("the renderer drew no frame while it was measured");
  }
  /** @type {View} */
  let eye = { panels: new Map(), blank: new Map(), scene: 0, total: 0 };
  for (const view of state.views.values()) {
    if (view.total > eye.total) {
      eye = view;
    }
  }
  /** @type {DrawCount} */
  const result = {
    frames,
    total: state.total / frames,
    panels: [],
    blank: [],
    scene: eye.scene / frames,
    repacked: [],
  };
  const roots = document.querySelectorAll("[data-xr-portal]");
  roots.forEach((root, index) => {
    const name = panelName(root, index);
    const element = /** @type {HTMLElement} */ (root);
    result.panels.push([name, (eye.panels.get(element) ?? 0) / frames]);
    result.blank.push([name, (eye.blank.get(element) ?? 0) / frames]);
    result.repacked.push([name, (state.repacked.get(element) ?? 0) / frames]);
  });
  return result;
}

/**
 * Count `mesh`'s instances to its panel if its buffers changed since it was
 * last drawn, once in `frame`.
 *
 * @param {Counter} state
 * @param {THREE.InstancedMesh} mesh
 * @param {number} frame
 */
function countRepack(state, mesh, frame) {
  let version = mesh.instanceMatrix.version;
  const attributes = mesh.geometry.attributes;
  for (const name in attributes) {
    const attribute = /** @type {THREE.BufferAttribute} */ (attributes[name]);
    if (/** @type {THREE.InstancedBufferAttribute} */ (attribute).isInstancedBufferAttribute) {
      version += attribute.version;
    }
  }
  const last = state.seen.get(mesh);
  if (!last) {
    state.seen.set(mesh, { version, frame });
    return;
  }
  if (last.frame === frame) {
    return;
  }
  last.frame = frame;
  if (last.version !== version) {
    last.version = version;
    const panel = /** @type {HTMLElement} */ (state.panel);
    state.repacked.set(panel, (state.repacked.get(panel) ?? 0) + mesh.count);
  }
}

/** @returns {Promise<void>} */
function nextFrame() {
  return new Promise((done) => requestAnimationFrame(() => done()));
}
