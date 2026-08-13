import * as THREE from "three";
import { createProperty } from "@apendua/signal";
import { rectGeometry, SDF_GLSL } from "./sdfRect.js";

/**
 * @import {Object3D} from 'three';
 */

/**
 * Drawing a panel's boxes together instead of one at a time.
 *
 * A box costs almost nothing to describe — a size, four radii, four border
 * widths, two colours and a clip window — and almost nothing to draw, since
 * every one of them is the same unit quad and the same distance field. What
 * it costs is being asked for: a draw call apiece, each one binding a
 * material, uploading its uniforms and issuing its own command. On a panel of
 * a few hundred elements that submission is the frame.
 *
 * So the description moves from uniforms to per-instance attributes and the
 * boxes go out as instances. What that trades away is the thing a draw call
 * per box was quietly buying — an order. Which is why this is not one batch:
 *
 *   - **One bucket per `renderOrder`.** Boxes and text interleave by nesting
 *     depth, not merely by layer: a box draws, then its own text, then the box
 *     of anything nested inside it. Text is still one mesh apiece and still
 *     sorted by three, so the batches have to slot into that sequence rather
 *     than sit in front of or behind all of it. A bucket carrying exactly the
 *     boxes of one `renderOrder`, and carrying that `renderOrder` itself,
 *     takes the place its boxes held. Depth is what makes the count small —
 *     a panel nests a handful deep, so a few hundred draws become a few.
 *
 *     Getting this wrong is not subtle in the one case that matters. An
 *     overlay drawn before the text it covers is hidden by the depth buffer
 *     while it is opaque and blends wrongly the moment it is not, which is
 *     exactly when a menu or a modal is most likely to be translucent.
 *
 *   - **A picture is not batched.** An `<img>` binds a texture, and a texture
 *     is per-draw. Those boxes keep drawing themselves, which costs a call
 *     each and is what an atlas would one day fix.
 *
 * Nothing else about a box changes. Its mesh stays where it was, so the ray
 * still finds it, `clipRaycast` still trims its hits and `visible` still
 * prunes it and its subtree; only `material.visible` goes false, which is the
 * one flag three consults before putting a mesh in the render list and the
 * one it does not consult when raycasting. The material stays as the thing
 * that holds the element's numbers — `div` writes them exactly as it did, and
 * this reads them back out.
 */

/**
 * The batch a portal's boxes belong to. Set by `createPortal` on the context
 * it builds its elements with, so each portal batches its own and a panel
 * built without one — a test standing in for a portal — simply draws its
 * boxes one at a time, as it always did.
 */
export const BoxBatchContext = createProperty(
  /**
   * @returns {BoxBatch | null}
   */
  () => null,
);

const instancedVertex = /* glsl */ `
attribute vec2 aSize;
attribute vec4 aRadii;
attribute vec4 aBorder;
attribute vec4 aFillColor;
attribute vec4 aBorderColor;
attribute vec4 aClip;
attribute vec4 aClipRadii;
varying vec2 vUnit;
varying vec2 vSize;
varying vec4 vRadii;
varying vec4 vBorder;
varying vec4 vFillColor;
varying vec4 vBorderColor;
varying vec4 vClip;
varying vec4 vClipRadii;
void main() {
  vUnit = position.xy;
  vSize = aSize;
  vRadii = aRadii;
  vBorder = aBorder;
  vFillColor = aFillColor;
  vBorderColor = aBorderColor;
  vClip = aClip;
  vClipRadii = aClipRadii;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const instancedFragment = /* glsl */ `
varying vec2 vUnit;
varying vec2 vSize;
varying vec4 vRadii;
varying vec4 vBorder;
varying vec4 vFillColor;
varying vec4 vBorderColor;
varying vec4 vClip;
varying vec4 vClipRadii;
${SDF_GLSL}
void main() {
  vec2 coverages = sdfCoverages(vUnit, vSize, vRadii, vBorder, vClip, vClipRadii);
  float fillCoverage = coverages.x;
  float borderCoverage = coverages.y;
  float alpha = vFillColor.a * fillCoverage + vBorderColor.a * borderCoverage;
  if (alpha < 0.001) {
    discard;
  }
  vec3 color = (vFillColor.rgb * vFillColor.a * fillCoverage +
                vBorderColor.rgb * vBorderColor.a * borderCoverage) / alpha;
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Every bucket in every portal draws with this one. All of a box's numbers
 * are per-instance, so there is nothing left for a material to carry that
 * would make one bucket's differ from another's — which means one program,
 * compiled once, and no material state to change between buckets.
 *
 * @type {THREE.ShaderMaterial | null}
 */
let sharedMaterial = null;

/**
 * @returns {THREE.ShaderMaterial}
 */
function batchMaterial() {
  if (!sharedMaterial) {
    sharedMaterial = new THREE.ShaderMaterial({
      vertexShader: instancedVertex,
      fragmentShader: instancedFragment,
      transparent: true,
      // Two-sided and single-pass for the reasons `sdfRect` gives at length:
      // the container's flip turns every plane away from the viewer, and the
      // back pass of a two-sided transparent material has nothing to order
      // for a quad.
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
  }
  return sharedMaterial;
}

/** How many instances a freshly grown bucket has room for. */
const MINIMUM_CAPACITY = 16;

/**
 * The per-instance description of a box, as the shader wants it. Kept as one
 * object per bucket rather than one per box: a rebuild walks the panel in
 * order and fills these straight through.
 */
class Bucket {
  /** @type {THREE.InstancedMesh | null} */
  mesh = null;
  capacity = 0;
  count = 0;
  /** @type {Record<string, Float32Array>} */
  data = {};

  /**
   * @param {number} renderOrder
   * @param {Object3D} parent
   */
  constructor(renderOrder, parent) {
    this.renderOrder = renderOrder;
    this.parent = parent;
  }

  /**
   * @param {number} needed
   * @returns {void}
   */
  reserve(needed) {
    if (needed <= this.capacity) {
      return;
    }
    let capacity = Math.max(MINIMUM_CAPACITY, this.capacity || 0);
    while (capacity < needed) {
      capacity *= 2;
    }
    this.dispose();
    this.capacity = capacity;
    const geometry = new THREE.InstancedBufferGeometry();
    // The quad itself is the one every box in every portal already shares;
    // only the per-instance arrays below belong to this bucket.
    geometry.setAttribute("position", rectGeometry.getAttribute("position"));
    geometry.setIndex(rectGeometry.getIndex());
    /** @type {[string, number][]} */
    const attributes = [
      ["aSize", 2],
      ["aRadii", 4],
      ["aBorder", 4],
      ["aFillColor", 4],
      ["aBorderColor", 4],
      ["aClip", 4],
      ["aClipRadii", 4],
    ];
    this.data = {};
    for (const [name, size] of attributes) {
      const array = new Float32Array(capacity * size);
      this.data[name] = array;
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size));
    }
    const mesh = new THREE.InstancedMesh(geometry, batchMaterial(), capacity);
    mesh.renderOrder = this.renderOrder;
    // The instances span the whole panel while the geometry is one unit quad,
    // so three's bounding sphere would describe none of it. A panel is a
    // single object to cull anyway, and its own container is what carries it
    // in and out of view.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    // Instance matrices are already expressed in the container's frame, which
    // is this mesh's frame too.
    mesh.matrix.identity();
    // And the world matrix has to be asked for once, which is easy to miss and
    // invisible when missed. Three recomputes a world matrix for an object
    // that either recomposed its own or was told to; this one does neither,
    // and a freshly built object starts out believing its world matrix is up
    // to date when it is still the identity. A bucket built while the panel
    // sat still — the size class that appears when a row scrolls into view —
    // would draw its instances at panel coordinates in world space, which is
    // to say somewhere off in the distance. The buckets built during the
    // panel's first layout were spared only because the container's own
    // placement forced an update through them, which is what made this show
    // up as text that scrolls into view being missing rather than as nothing
    // working at all.
    mesh.matrixWorldNeedsUpdate = true;
    this.mesh = mesh;
    this.parent.add(mesh);
  }

  /**
   * @param {number} index
   * @param {THREE.Mesh} box
   * @param {THREE.Matrix4} matrix
   * @returns {void}
   */
  write(index, box, matrix) {
    const mesh = this.mesh;
    if (!mesh) {
      return;
    }
    mesh.setMatrixAt(index, matrix);
    const uniforms = /** @type {THREE.ShaderMaterial} */ (box.material).uniforms;
    const { uSize, uRadii, uBorder, uFillColor, uBorderColor, uClip, uClipRadii } = uniforms;
    this.data.aSize[index * 2] = uSize.value.x;
    this.data.aSize[index * 2 + 1] = uSize.value.y;
    writeVec4(this.data.aRadii, index, uRadii.value);
    writeVec4(this.data.aBorder, index, uBorder.value);
    writeVec4(this.data.aFillColor, index, uFillColor.value);
    writeVec4(this.data.aBorderColor, index, uBorderColor.value);
    writeVec4(this.data.aClip, index, uClip.value);
    writeVec4(this.data.aClipRadii, index, uClipRadii.value);
  }

  /**
   * @param {number} count
   * @returns {void}
   */
  finish(count) {
    this.count = count;
    const mesh = this.mesh;
    if (!mesh) {
      return;
    }
    mesh.count = count;
    mesh.visible = count > 0;
    mesh.instanceMatrix.needsUpdate = true;
    for (const name of Object.keys(this.data)) {
      /** @type {THREE.InstancedBufferAttribute} */ (mesh.geometry.getAttribute(name)).needsUpdate =
        true;
    }
  }

  /**
   * @returns {void}
   */
  dispose() {
    if (!this.mesh) {
      return;
    }
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh = null;
    this.capacity = 0;
  }
}

/**
 * @param {Float32Array} array
 * @param {number} index
 * @param {THREE.Vector4} value
 * @returns {void}
 */
function writeVec4(array, index, value) {
  const at = index * 4;
  array[at] = value.x;
  array[at + 1] = value.y;
  array[at + 2] = value.z;
  array[at + 3] = value.w;
}

/**
 * Matrices to accumulate down the tree with, one per level, grown as the tree
 * turns out to be deep. A rebuild is the hottest thing here and allocating a
 * matrix per node would be most of it.
 *
 * @type {THREE.Matrix4[]}
 */
const matrixStack = [new THREE.Matrix4()];

/**
 * @param {number} depth
 * @returns {THREE.Matrix4}
 */
function stackAt(depth) {
  while (matrixStack.length <= depth) {
    matrixStack.push(new THREE.Matrix4());
  }
  return matrixStack[depth];
}

export class BoxBatch {
  /**
   * The meshes that have given up drawing themselves, and are drawn from a
   * bucket instead.
   *
   * @type {Set<THREE.Mesh>}
   */
  #members = new Set();

  /** @type {Map<number, Bucket>} */
  #buckets = new Map();

  /** @type {Object3D} */
  #container;

  #dirty = false;
  #disposed = false;

  /**
   * Collected during a rebuild: the boxes to draw, in the order the walk met
   * them, with the matrix each is to be drawn at. Kept between rebuilds so a
   * settled panel re-uses the arrays rather than allocating a pair per frame.
   *
   * @type {THREE.Mesh[]}
   */
  #found = [];
  /** @type {THREE.Matrix4[]} */
  #matrices = [];

  /**
   * @param {Object3D} container The portal's container object. Buckets hang
   *   off it, so instance matrices are in its frame and it carries the whole
   *   panel as one.
   */
  constructor(container) {
    this.#container = container;
  }

  /**
   * Take this box into the batch: it stops drawing itself, and the batch
   * starts drawing it. Idempotent.
   *
   * @param {THREE.Mesh} mesh
   * @returns {void}
   */
  add(mesh) {
    if (this.#members.has(mesh)) {
      return;
    }
    this.#members.add(mesh);
    // The one flag that takes a mesh out of the render list without taking it
    // out of anything else — the ray still finds it, and `visible` still means
    // what it meant.
    /** @type {THREE.Material} */ (mesh.material).visible = false;
    // A mesh that will not be drawn has no business being tested against the
    // frustum for it. Three asks that question — a bounding-sphere transform
    // per mesh per frame — before it looks at whether the material is visible,
    // so this is the difference between a box that is not drawn and a box that
    // costs nothing. It is safe by the same token: nothing consults the answer.
    // (What remains is three's per-mesh geometry bookkeeping, which only
    // dropping the mesh from the render traversal altogether would avoid.)
    mesh.frustumCulled = false;
    this.invalidate();
  }

  /**
   * @param {THREE.Mesh} mesh
   * @returns {void}
   */
  remove(mesh) {
    if (!this.#members.delete(mesh)) {
      return;
    }
    if (mesh.material) {
      /** @type {THREE.Material} */ (mesh.material).visible = true;
    }
    mesh.frustumCulled = true;
    this.invalidate();
  }

  /**
   * Something about the panel that the batch has copied down has changed: a
   * box moved, was restyled, scrolled, appeared or went away.
   *
   * Coalesced to one rebuild, because a single mutation reaches a great many
   * of these — every box in a re-laid-out panel writes its uniforms — and the
   * rebuild is a walk of the whole panel either way. A microtask is the right
   * grain for it: signal effects run in batches, so this lands once after the
   * graph has settled and before anything can be drawn.
   *
   * Deliberately not tied to a frame. What a rebuild reads are local matrices,
   * which `place` keeps current at the moment of the write, and uniform values,
   * which are written the same way — never anything the renderer computes — so
   * it neither needs a frame nor has to hold one open to stay correct.
   *
   * @returns {void}
   */
  invalidate() {
    if (this.#dirty || this.#disposed) {
      return;
    }
    this.#dirty = true;
    queueMicrotask(() => {
      this.#dirty = false;
      if (!this.#disposed) {
        this.rebuild();
      }
    });
  }

  /**
   * Walk the panel and lay its boxes out into buckets.
   *
   * The walk rather than the membership set is what decides both order and
   * visibility, and it has to be: the boxes have to be met in the order they
   * would have been drawn in, and a box inside something hidden is hidden
   * however visible it believes itself to be. It is the same walk three's
   * renderer makes, over the same flag, which is what keeps a batched panel
   * agreeing with an unbatched one.
   *
   * @returns {void}
   */
  rebuild() {
    if (this.#disposed) {
      return;
    }
    const found = this.#found;
    const matrices = this.#matrices;
    found.length = 0;
    let count = 0;

    /**
     * @param {Object3D} object
     * @param {THREE.Matrix4} parentMatrix
     * @param {number} depth
     */
    const walk = (object, parentMatrix, depth) => {
      if (!object.visible) {
        return;
      }
      const matrix = stackAt(depth).multiplyMatrices(parentMatrix, object.matrix);
      if (this.#members.has(/** @type {THREE.Mesh} */ (object))) {
        found.push(/** @type {THREE.Mesh} */ (object));
        if (!matrices[count]) {
          matrices[count] = new THREE.Matrix4();
        }
        matrices[count].copy(matrix);
        count += 1;
      }
      const children = object.children;
      for (let i = 0; i < children.length; i++) {
        walk(children[i], matrix, depth + 1);
      }
    };

    const root = stackAt(0).identity();
    const children = this.#container.children;
    for (let i = 0; i < children.length; i++) {
      // A bucket is a child of the container too, and describes no box.
      if (this.#isBucket(children[i])) {
        continue;
      }
      walk(children[i], root, 1);
    }

    // How many of each render order there are, so every bucket is sized once
    // rather than grown as it fills.
    /** @type {Map<number, number>} */
    const wanted = new Map();
    for (let i = 0; i < count; i++) {
      const order = found[i].renderOrder;
      wanted.set(order, (wanted.get(order) ?? 0) + 1);
    }
    for (const [order, needed] of wanted) {
      let bucket = this.#buckets.get(order);
      if (!bucket) {
        bucket = new Bucket(order, this.#container);
        this.#buckets.set(order, bucket);
      }
      bucket.reserve(needed);
      bucket.count = 0;
    }
    for (const [order, bucket] of this.#buckets) {
      if (!wanted.has(order)) {
        bucket.count = 0;
      }
    }
    // Filled in the order the walk met them, which is the order they would
    // have been drawn in among themselves.
    for (let i = 0; i < count; i++) {
      const box = found[i];
      const bucket = this.#buckets.get(box.renderOrder);
      if (bucket) {
        bucket.write(bucket.count, box, matrices[i]);
        bucket.count += 1;
      }
    }
    for (const bucket of this.#buckets.values()) {
      bucket.finish(bucket.count);
    }
  }

  /**
   * @param {Object3D} object
   * @returns {boolean}
   */
  #isBucket(object) {
    for (const bucket of this.#buckets.values()) {
      if (bucket.mesh === object) {
        return true;
      }
    }
    return false;
  }

  /**
   * @returns {void}
   */
  dispose() {
    this.#disposed = true;
    for (const bucket of this.#buckets.values()) {
      bucket.dispose();
    }
    this.#buckets.clear();
    this.#members.clear();
  }
}

/**
 * @param {Object3D} container
 * @returns {BoxBatch}
 */
export function createBoxBatch(container) {
  return new BoxBatch(container);
}
