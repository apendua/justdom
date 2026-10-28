import * as THREE from "three";
import { GRADIENT_GLSL, rectGeometry, SDF_GLSL } from "./sdfRect.js";
import { rampUniforms } from "./gradient.js";
import { markChanged } from "./instanceUploads.js";
import { keepProgram } from "./programKeeper.js";
import { bandBase } from "./elevation.js";
import {
  createHalfPlaneUniforms,
  HALF_PLANES_FRAGMENT_GLSL,
  HALF_PLANES_VERTEX_GLSL,
  passHalfPlaneWorld,
} from "./halfPlanes.js";
import { BOX_BUCKET_BIAS, BoxBatch, writeBoxInstance } from "./boxBatch.js";
import { TextBatch } from "./textBatch.js";
import { isProxy } from "./layerOrder.js";
import { disposeInstancedMesh, grownCapacity, stackAt } from "./instancing.js";

/**
 * @import {Object3D} from 'three';
 * @import {ProgramKind} from './programKeeper.js';
 * @import {Member, Slot} from './textBatch.js';
 * @import {LayerOrder} from './layerOrder.js';
 */

/*
 * The one batch of a panel drawn in paint order (`paintOrder` in
 * `portal.js`): its boxes and its runs of text in one stream of instances,
 * drawn with one shader (`docs/freedom-paint-order.md`, _The batch_).
 *
 * The box batch and the text batch still take their members in and keep
 * what they know of them: a box's numbers, a run's layers in the arrays of
 * its size. What they no longer do on such a panel is draw. Each rebuild
 * walks the panel once, takes every box and run it meets from its batch, in
 * the order of their render orders, and lays them into draws:
 *
 * - A draw is a stretch of that order, so what a draw holds draws in the
 *   order the page paints it, and nothing writes depth to undo it: a
 *   layer's whole content, and the layers after it, coplanar or not, in
 *   one draw while nothing below breaks the stretch.
 * - A mesh that draws itself in the middle of the stretch breaks it: a
 *   picture, an `<svg>`'s shape, a caret, a run the text batch declines.
 *   The draw before it keeps the order up to it, the draw after the rest,
 *   and each draw takes the render order of its first instance, so three
 *   sorts the mesh between them.
 * - A layer the walk cuts in pieces (`LayerOrder.isCut`) is drawn by draws
 *   of its own. A further piece is a proxy of each of them, at the piece's
 *   place, and a proxy copies a whole draw. The walk asks for a rebuild
 *   when the layers it cuts change, since a layer can be cut or not with
 *   nothing it draws changing.
 * - A draw samples at most `ARRAYS_PER_DRAW` arrays of runs: the run that
 *   would need one more starts the next draw.
 *
 * The draws are kept from rebuild to rebuild, the first for the first
 * stretch and so on, each growing as a box bucket does; the ones a rebuild
 * does not use go.
 */

/**
 * How many arrays of runs one draw samples. A fragment shader has 16
 * texture units on every WebGL2 device, which is the guarantee, and the
 * gradient ramp (`gradient.js`) takes one.
 */
export const ARRAYS_PER_DRAW = 15;

/** How many instances a freshly grown draw has room for. */
const MINIMUM_CAPACITY = 16;

/**
 * Which array a run samples rides in `aSize.z`, as `-1 - slot`, where a
 * box has its gradient header, a whole number from 0 up; the sign tells the
 * two apart. A box's `aSize.w` is its opacity, a run's colour and alpha are
 * in `aFillColor`, and its layer in its array in `aGradientGeometry.x`. So
 * the attributes are the box batch's nine, and the slots three, four and
 * nine, sixteen (`instancedVertex` in `boxBatch.js`).
 */
const vertexShader = /* glsl */ `
${HALF_PLANES_VERTEX_GLSL}
attribute vec4 aSize;
attribute vec4 aRadii;
attribute vec4 aBorder;
attribute vec4 aFillColor;
attribute vec4 aBorderColor;
attribute vec4 aClip;
attribute vec4 aClipRadii;
attribute vec4 aGradientGeometry;
attribute vec4 aGradientTile;
flat varying int vSlot;
flat varying float vLayer;
varying vec2 vUnit;
varying vec2 vLocal;
varying vec2 vSize;
varying vec4 vRadii;
varying vec4 vBorder;
varying vec4 vFillColor;
varying vec4 vBorderColor;
varying vec4 vClip;
varying vec4 vClipRadii;
varying vec4 vGradient;
varying vec4 vGradientGeometry;
varying vec4 vGradientTile;
varying vec2 vGradientRamp;
void main() {
  vUnit = position.xy;
  vSize = aSize.xy;
  vRadii = aRadii;
  vBorder = aBorder;
  vFillColor = aFillColor;
  vBorderColor = aBorderColor;
  vClip = aClip;
  vClipRadii = aClipRadii;
  vGradientGeometry = aGradientGeometry;
  vGradientTile = aGradientTile;
  vLayer = aGradientGeometry.x;
  vec2 local = position.xy;
  if (aSize.z < -0.5) {
    vSlot = int(floor(-aSize.z - 0.5));
    // A run's quad is the unit one scaled to the run, where a box's
    // instance matrix carries its size.
    local = position.xy * aSize.xy;
    vGradient = vec4(0.0);
    vGradientRamp = vec2(0.0);
  } else {
    vSlot = -1;
    float header = floor(aSize.z + 0.5);
    float flags = floor(header / 4.0);
    vGradient = vec4(
      mod(header, 4.0),
      mod(flags, 2.0),
      mod(floor(flags / 2.0), 2.0),
      mod(floor(flags / 4.0), 2.0)
    );
    vGradientRamp = vec2(floor(flags / 8.0), aSize.w);
  }
  vLocal = local;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(local, 0.0, 1.0);
  ${passHalfPlaneWorld("modelMatrix * instanceMatrix * vec4(local, 0.0, 1.0)")}
}
`;

/**
 * A run samples its array with `textureGrad`, from derivatives taken before
 * anything branches, so the mipmapped read is defined whichever kind a
 * neighbouring fragment draws. An array of samplers is indexed only by a
 * constant, hence the `switch`.
 */
const sampleRuns = Array.from(
  { length: ARRAYS_PER_DRAW },
  (_, i) => `    case ${i}: coverage = textureGrad(uRuns[${i}], at, dx, dy).g; break;`,
).join("\n");

const fragmentShader = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uRuns[${ARRAYS_PER_DRAW}];
flat varying int vSlot;
flat varying float vLayer;
varying vec2 vUnit;
varying vec2 vLocal;
varying vec2 vSize;
varying vec4 vRadii;
varying vec4 vBorder;
varying vec4 vFillColor;
varying vec4 vBorderColor;
varying vec4 vClip;
varying vec4 vClipRadii;
varying vec4 vGradient;
varying vec4 vGradientGeometry;
varying vec4 vGradientTile;
varying vec2 vGradientRamp;
${HALF_PLANES_FRAGMENT_GLSL}
${SDF_GLSL}
${GRADIENT_GLSL}
void main() {
  vec2 dx = dFdx(vUnit);
  vec2 dy = dFdy(vUnit);
  clipHalfPlanes();
  if (vSlot >= 0) {
    vec3 at = vec3(vUnit, vLayer);
    float coverage = 0.0;
    switch (vSlot) {
${sampleRuns}
    }
    float alpha = vFillColor.a * coverage;
    if (alpha < 0.001) {
      discard;
    }
    // The trim the text batch applies, in the run's own px.
    vec2 clipHalf = 0.5 * (vClip.zw - vClip.xy);
    vec2 clipD = abs(vLocal - 0.5 * (vClip.xy + vClip.zw)) - clipHalf;
    float clipDist = max(clipD.x, clipD.y);
    alpha *= 1.0 - smoothstep(-fwidth(clipDist), fwidth(clipDist), clipDist);
    if (alpha < 0.001) {
      discard;
    }
    gl_FragColor = vec4(vFillColor.rgb, alpha);
  } else {
    vec2 coverages = sdfCoverages(vUnit, vSize, vRadii, vBorder, vClip, vClipRadii);
    float fillCoverage = coverages.x;
    float borderCoverage = coverages.y;
    vec4 fill = withGradient(
      vFillColor, vUnit * vSize, vGradient, vGradientGeometry, vGradientTile, vGradientRamp
    );
    float alpha = fill.a * fillCoverage + vBorderColor.a * borderCoverage;
    if (alpha < 0.001) {
      discard;
    }
    vec3 color = (fill.rgb * fill.a * fillCoverage +
                  vBorderColor.rgb * vBorderColor.a * borderCoverage) / alpha;
    gl_FragColor = vec4(color, alpha);
  }
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * A draw's material: its own, as a box bucket's is, since it carries the
 * arrays the draw samples and the half-planes of the piece it draws.
 *
 * @returns {THREE.ShaderMaterial}
 */
function paintMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    // Depth is the root's quad's to write (`createDepthQuad`).
    depthWrite: false,
    // Two-sided and single-pass, as every mark on a panel is.
    side: THREE.DoubleSide,
    forceSinglePass: true,
    uniforms: {
      uRamp: rampUniforms.uRamp,
      uRampHeight: rampUniforms.uRampHeight,
      uRuns: { value: new Array(ARRAYS_PER_DRAW).fill(null) },
      ...createHalfPlaneUniforms(),
    },
  });
}

/** @type {ProgramKind<THREE.ShaderMaterial>} */
const PAINT_PROGRAM = { name: "freedom-paint-batch", create: () => paintMaterial() };

/**
 * The attributes of an instance, and their widths.
 *
 * @type {[string, number][]}
 */
const ATTRIBUTES = [
  ["aSize", 4],
  ["aRadii", 4],
  ["aBorder", 4],
  ["aFillColor", 4],
  ["aBorderColor", 4],
  ["aClip", 4],
  ["aClipRadii", 4],
  ["aGradientGeometry", 4],
  ["aGradientTile", 4],
];

/** One draw: a stretch of the panel's instances, and the arrays it samples. */
class Draw {
  /** @type {THREE.InstancedMesh | null} */
  mesh = null;
  capacity = 0;
  /** @type {Record<string, Float32Array>} */
  data = {};
  /**
   * The size classes of the runs it draws, by the slot each samples.
   *
   * @type {Slot["sizeClass"][]}
   */
  classes = [];

  /** @param {Object3D} parent */
  constructor(parent) {
    this.parent = parent;
    // Kept across a growth, as a text bucket's is, and kept linked after the
    // last draw goes (`programKeeper.js`).
    this.material = keepProgram(paintMaterial(), PAINT_PROGRAM);
  }

  /**
   * @param {number} needed
   * @returns {void}
   */
  reserve(needed) {
    if (needed <= this.capacity) {
      return;
    }
    const capacity = grownCapacity(this.capacity, needed, MINIMUM_CAPACITY);
    this.#disposeMesh();
    this.capacity = capacity;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", rectGeometry.getAttribute("position"));
    geometry.setIndex(rectGeometry.getIndex());
    this.data = {};
    for (const [name, size] of ATTRIBUTES) {
      const array = new Float32Array(capacity * size);
      this.data[name] = array;
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size));
    }
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    // As a box bucket's: its instances span the panel, in the container's
    // frame, and its world matrix has to be asked for once (`Bucket.reserve`
    // in `boxBatch.js`).
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.identity();
    mesh.matrixWorldNeedsUpdate = true;
    this.mesh = mesh;
    this.parent.add(mesh);
  }

  /**
   * Sample the arrays of `classes` now, by slot: the classes' textures may
   * have been built again since the last rebuild.
   *
   * @returns {void}
   */
  bind() {
    const textures = this.material.uniforms.uRuns.value;
    for (let slot = 0; slot < ARRAYS_PER_DRAW; slot += 1) {
      textures[slot] = this.classes[slot]?.texture ?? null;
    }
  }

  /**
   * @param {number} index
   * @param {Member} run
   * @param {number} slot The array it samples, among the draw's.
   * @returns {void}
   */
  writeRun(index, run, slot) {
    const material = /** @type {THREE.MeshBasicMaterial} */ (run.mesh.material);
    const { color, opacity } = material;
    const clip = run.clip.value;
    const layer = /** @type {Slot} */ (run.shown).layer;
    const at = index * 4;
    const { data } = this;
    setVec4(data.aSize, at, run.width, run.height, -1 - slot, 1);
    setVec4(data.aFillColor, at, color.r, color.g, color.b, opacity);
    setVec4(data.aClip, at, clip.x, clip.y, clip.z, clip.w);
    setVec4(data.aGradientGeometry, at, layer, 0, 0, 0);
    setVec4(data.aRadii, at, 0, 0, 0, 0);
    setVec4(data.aBorder, at, 0, 0, 0, 0);
    setVec4(data.aBorderColor, at, 0, 0, 0, 0);
    setVec4(data.aClipRadii, at, 0, 0, 0, 0);
    setVec4(data.aGradientTile, at, 0, 0, 0, 0);
  }

  /**
   * @param {number} count
   * @param {number} renderOrder
   * @returns {void}
   */
  finish(count, renderOrder) {
    const mesh = /** @type {THREE.InstancedMesh} */ (this.mesh);
    mesh.count = count;
    mesh.visible = count > 0;
    mesh.renderOrder = renderOrder;
    markChanged(mesh.instanceMatrix, count);
    for (const [name] of ATTRIBUTES) {
      markChanged(
        /** @type {THREE.InstancedBufferAttribute} */ (mesh.geometry.getAttribute(name)),
        count,
      );
    }
    this.bind();
  }

  /** @returns {void} */
  #disposeMesh() {
    if (!this.mesh) {
      return;
    }
    disposeInstancedMesh(this.mesh);
    this.mesh = null;
    this.capacity = 0;
  }

  /** The draw is going for good: its mesh, and its material too. */
  release() {
    this.#disposeMesh();
    this.material.dispose();
  }
}

/**
 * @param {Float32Array} array
 * @param {number} at
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} w
 */
function setVec4(array, at, x, y, z, w) {
  array[at] = x;
  array[at + 1] = y;
  array[at + 2] = z;
  array[at + 3] = w;
}

/**
 * Whether `object` draws itself: a mesh or a line with a material that
 * draws. Nothing on a panel draws points.
 *
 * @param {Object3D} object
 * @returns {boolean}
 */
function drawsItself(object) {
  const drawable = /** @type {THREE.Mesh} */ (object);
  if (!drawable.isMesh && !(/** @type {THREE.Line} */ (object).isLine)) {
    return false;
  }
  const material = /** @type {THREE.Material | THREE.Material[]} */ (drawable.material);
  return Array.isArray(material) ? material.some((each) => each.visible) : material.visible;
}

export class PaintBatch {
  /** @type {Object3D} */
  #container;
  /** @type {Draw[]} */
  #draws = [];
  /** The draws' meshes, which the walk steps over. @type {Set<Object3D>} */
  #drawMeshes = new Set();
  #dirty = false;
  #disposed = false;

  /**
   * What a rebuild met, in the order of the walk: the order each box or run
   * draws at, the numbers of a box or the run itself, and its matrix in the
   * container's frame. Kept between rebuilds, as is every scratch below,
   * since a rebuild runs in the frame whenever something moves.
   *
   * @type {number[]}
   */
  #orders = [];
  /** @type {(Record<string, THREE.IUniform> | null)[]} */
  #boxes = [];
  /** @type {(Member | null)[]} */
  #runs = [];
  /** @type {THREE.Matrix4[]} */
  #matrices = [];
  /** The indices into the above, in the order they draw. @type {number[]} */
  #sorted = [];
  /** The orders of the meshes that draw themselves. @type {number[]} */
  #breaks = [];
  /**
   * Where each draw starts in `#sorted`, and one past the last.
   *
   * @type {number[]}
   */
  #starts = [];
  /**
   * The size classes of the draw `#split` is laying out.
   *
   * @type {Slot["sizeClass"][]}
   */
  #classes = [];
  #byOrder = (/** @type {number} */ a, /** @type {number} */ b) =>
    this.#orders[a] - this.#orders[b] || a - b;

  /**
   * The order the panel's layers draw in, which says what this batch keeps
   * apart and cuts what it lays out. Its own constructor hands it here
   * (`orderBy`), before any rebuild can run: a rebuild runs in a microtask
   * or a frame, and the portal makes the order in the same task as this.
   *
   * @type {LayerOrder | null}
   */
  #order = null;

  /**
   * @param {Object3D} container The portal's container, which the draws
   *   hang off.
   */
  constructor(container) {
    this.#container = container;
    /** The panel's boxes, which this batch draws. */
    this.boxes = new BoxBatch(container, { draw: this });
    /** And its runs. */
    this.runs = new TextBatch(container, { draw: this });
  }

  /**
   * The panel's order, made for this batch, says which layers it cuts.
   *
   * @param {LayerOrder} order
   */
  orderBy(order) {
    this.#order = order;
  }

  /**
   * Whether `object` is one of the meshes the batch draws with.
   *
   * @param {THREE.Object3D} object
   * @returns {boolean}
   */
  isDraw(object) {
    for (const draw of this.#draws) {
      if (draw.mesh === object) {
        return true;
      }
    }
    return false;
  }

  /**
   * Put the meshes the batch draws with in `out`, for the panel's order to
   * find the ones of a layer it cuts in pieces.
   *
   * @param {THREE.Mesh[]} out
   */
  collectMeshes(out) {
    for (const draw of this.#draws) {
      if (draw.mesh) {
        out.push(draw.mesh);
      }
    }
  }

  /**
   * Something either batch copied down changed, or the layers the order
   * cuts did. Coalesced and collected as the box batch's is
   * (`BoxBatch.invalidate`).
   *
   * @returns {void}
   */
  invalidate() {
    if (this.#dirty || this.#disposed) {
      return;
    }
    this.#dirty = true;
    queueMicrotask(() => {
      this.flush();
    });
  }

  /** @returns {void} */
  flush() {
    if (!this.#dirty || this.#disposed) {
      return;
    }
    this.#dirty = false;
    this.rebuild();
  }

  /**
   * A size class built its texture again outside a rebuild (`commitStaged`
   * in `textBatch.js`): the draws that sample it sample the new one.
   *
   * @param {Slot["sizeClass"]} sizeClass
   */
  rebind(sizeClass) {
    for (const draw of this.#draws) {
      if (draw.classes.includes(sizeClass)) {
        draw.bind();
      }
    }
  }

  /**
   * Walk the panel, take its boxes and runs from their batches, and lay
   * them into draws, as the file's header says.
   *
   * @returns {void}
   */
  rebuild() {
    if (this.#disposed) {
      return;
    }
    this.#drawMeshes.clear();
    for (const draw of this.#draws) {
      if (draw.mesh) {
        this.#drawMeshes.add(draw.mesh);
      }
    }
    this.#orders.length = 0;
    this.#boxes.length = 0;
    this.#runs.length = 0;
    this.#breaks.length = 0;
    this.boxes.beginWalk();
    this.runs.beginWalk();
    const root = stackAt(0).identity();
    const children = this.#container.children;
    for (let i = 0; i < children.length; i++) {
      this.#walk(children[i], root, 1);
    }
    // Every run is settled, so every class that changed builds its texture
    // now, before a draw binds it.
    this.runs.commitClasses();

    const sorted = this.#sorted;
    sorted.length = this.#orders.length;
    for (let i = 0; i < sorted.length; i++) {
      sorted[i] = i;
    }
    sorted.sort(this.#byOrder);
    this.#breaks.sort(ascending);
    this.#split();

    const draws = this.#draws;
    const starts = this.#starts;
    const count = starts.length - 1;
    while (draws.length < count) {
      draws.push(new Draw(this.#container));
    }
    while (draws.length > count) {
      /** @type {Draw} */ (draws.pop()).release();
    }
    for (let d = 0; d < count; d++) {
      this.#lay(draws[d], starts[d], starts[d + 1]);
    }
    this.runs.releaseEmptyClasses();
  }

  /**
   * Take what `object` and its subtree draw, as the other batches' walks
   * do, over the same `visible` flag.
   *
   * @param {Object3D} object
   * @param {THREE.Matrix4} parentMatrix
   * @param {number} depth
   */
  #walk(object, parentMatrix, depth) {
    if (!object.visible || this.#drawMeshes.has(object) || isProxy(object)) {
      return;
    }
    const matrix = stackAt(depth).multiplyMatrices(parentMatrix, object.matrix);
    const mesh = /** @type {THREE.Mesh} */ (object);
    const box = this.boxes.take(mesh);
    const run = box ? null : this.runs.take(mesh);
    if (box || run) {
      const index = this.#orders.length;
      this.#orders.push(box ? mesh.renderOrder + BOX_BUCKET_BIAS : mesh.renderOrder);
      this.#boxes.push(box);
      this.#runs.push(run);
      if (!this.#matrices[index]) {
        this.#matrices[index] = new THREE.Matrix4();
      }
      this.#matrices[index].copy(matrix);
    } else if (drawsItself(object)) {
      this.#breaks.push(object.renderOrder);
    }
    const children = object.children;
    for (let i = 0; i < children.length; i++) {
      this.#walk(children[i], matrix, depth + 1);
    }
  }

  /**
   * Write the instances `#sorted` holds from `start` up to `end` into
   * `draw`.
   *
   * @param {Draw} draw
   * @param {number} start
   * @param {number} end
   */
  #lay(draw, start, end) {
    const sorted = this.#sorted;
    draw.reserve(end - start);
    const mesh = /** @type {THREE.InstancedMesh} */ (draw.mesh);
    draw.classes.length = 0;
    for (let at = start; at < end; at++) {
      const i = sorted[at];
      const index = at - start;
      mesh.setMatrixAt(index, this.#matrices[i]);
      const run = this.#runs[i];
      if (run) {
        const sizeClass = /** @type {Slot} */ (run.shown).sizeClass;
        let slot = draw.classes.indexOf(sizeClass);
        if (slot < 0) {
          slot = draw.classes.push(sizeClass) - 1;
        }
        draw.writeRun(index, run, slot);
      } else {
        // No paint rank: the bias is for a panel the lift orders.
        writeBoxInstance(
          draw.data,
          index,
          /** @type {Record<string, THREE.IUniform>} */ (this.#boxes[i]),
          0,
        );
      }
    }
    draw.finish(end - start, this.#orders[sorted[start]]);
  }

  /**
   * Where each draw starts in `#sorted`, into `#starts`: a draw ends before
   * an instance that a mesh drawing itself comes before, one that crosses
   * into or out of the band of a cut layer, and a run whose array would be
   * one more than a draw samples.
   *
   * @returns {void}
   */
  #split() {
    const sorted = this.#sorted;
    const orders = this.#orders;
    const breaks = this.#breaks;
    const starts = this.#starts;
    const classes = this.#classes;
    const layers = /** @type {LayerOrder} */ (this.#order);
    starts.length = 0;
    classes.length = 0;
    let first = 0;
    let previous = 0;
    let next = 0;
    for (let at = 0; at < sorted.length; at++) {
      const order = orders[sorted[at]];
      const run = this.#runs[sorted[at]];
      // A run the walk took has its layer settled (`take`).
      const sizeClass = run ? /** @type {Slot} */ (run.shown).sizeClass : undefined;
      let starting = at === 0;
      if (!starting) {
        starting =
          (next < breaks.length && breaks[next] < order) ||
          (bandBase(order) !== bandBase(previous) &&
            (layers.isCut(order) || layers.isCut(previous))) ||
          (sizeClass !== undefined &&
            classes.length === ARRAYS_PER_DRAW &&
            !classes.includes(sizeClass));
      }
      if (starting) {
        starts.push(at);
        first = order;
        classes.length = 0;
        // The first mesh drawing itself after the draw's first order: one at
        // that order sorts against the draw by id, as a run that draws
        // itself and the text batch's of one order always have.
        while (next < breaks.length && breaks[next] <= first) {
          next += 1;
        }
      }
      if (sizeClass && !classes.includes(sizeClass)) {
        classes.push(sizeClass);
      }
      previous = order;
    }
    starts.push(sorted.length);
  }

  /** @returns {void} */
  dispose() {
    this.#disposed = true;
    for (const draw of this.#draws) {
      draw.release();
    }
    this.#draws.length = 0;
    this.#drawMeshes.clear();
  }
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function ascending(a, b) {
  return a - b;
}
