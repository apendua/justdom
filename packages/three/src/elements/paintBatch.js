import * as THREE from "three";
import { GRADIENT_GLSL, rectGeometry, SDF_GLSL } from "./sdfRect.js";
import { rampUniforms } from "./gradient.js";
import { markChanged } from "./instanceUploads.js";
import { keepProgram } from "./programKeeper.js";
import { bandBase, PIECE_BAND } from "./elevation.js";
import {
  createHalfPlaneUniforms,
  HALF_PLANES_FRAGMENT_GLSL,
  HALF_PLANES_VERTEX_GLSL,
  passHalfPlaneWorld,
} from "./halfPlanes.js";
import {
  BOX_BUCKET_BIAS,
  BoxBatch,
  DECORATION_INSET_SHADOW,
  DECORATION_OUTER_SHADOW,
  DECORATION_RING,
  hasOutline,
  INSET_SHADOW_BIAS,
  isInsetShadow,
  OUTER_SHADOW_BIAS,
  setLanes,
  shadowCount,
  writeBoxInstance,
  writeOutlineInstance,
  writeShadowInstance,
} from "./boxBatch.js";
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
 * The one batch of a panel: its boxes and its runs of text in one stream of
 * instances, drawn with one shader (`docs/freedom-paint-order.md`, _The
 * batch_).
 *
 * The box batch and the text batch take their members in and keep what
 * they know of them: a box's numbers, a run's layers in the arrays of its
 * size. They draw nothing themselves. Each rebuild
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
 * stretch and so on, each growing to the next power of two it needs
 * (`grownCapacity`); the ones a rebuild does not use go.
 *
 * A rebuild is the whole walk, the sort and every instance written again.
 * Most changes need less: a box whose numbers changed, or that moved, is
 * drawn at the same place in the same draw, and only its instances have to
 * be written. So a change is one of three kinds, and the batch is told
 * which.
 *
 * - Structural (`invalidate`): anything that can change which instances
 *   there are or where they sit in the order. A member added or removed, a
 *   `renderOrder` or a `visible` changed, a run changing its size class, a
 *   layer becoming cut or uncut, a layer's base moving. A site that has not
 *   said which kind its change is calls this, and stays correct.
 * - A move (`moved(object)`): an object's matrix changed, which moves every
 *   box and run under it. A scroll is one, of the content group that
 *   carries what scrolls. Order is by render order, not by place, so a move
 *   changes no draw.
 * - A patch (`changed(mesh)`): a box's numbers changed, or a run's colour,
 *   opacity or clip. A box gaining or losing a shadow layer or an outline,
 *   or a shadow layer turning inset or outer, arrives this way too, since
 *   `BoxNumbers` sees only numbers: the check against the record below is
 *   what makes it a rebuild. A run's raster, and so its size and its layer
 *   in an array, changes only by `invalidate`.
 *
 * What a rebuild leaves behind is a record: for each box and run it took,
 * where its instance and each of a box's decorations went, by draw and
 * index. The record holds until the next rebuild, which makes it again.
 *
 * A flush runs a rebuild when anything structural is pending. Otherwise it
 * checks every box marked changed against the record before it writes any.
 * A box with no record is passed over: with nothing structural pending, the
 * last walk did not reach it, so nothing draws it, and it is drawn again
 * only after an `invalidate` (shown, added, an ancestor shown), whose
 * rebuild reads its numbers then. A box with a record has to have the
 * decorations the record has, in the same order and of the same kinds. If
 * any box fails, the flush runs a rebuild instead, so the patch path never
 * guesses. If all pass, it writes those boxes' instances where the record
 * says, and marks the draws they are in for upload. A rebuild, run for any
 * reason, drops what was marked changed or moved, since it writes
 * everything.
 *
 * A move walks the moved object's subtree as a rebuild walks the panel,
 * from its parent's matrix in the container's frame, and writes the matrix
 * of each box and run it meets to every slot the record has for it. An
 * object under a hidden ancestor, or outside the container, is passed over,
 * since nothing under it is drawn, and so is one under another moved
 * object, which writes it. A box the walk meets with no record is a box the
 * last rebuild did not draw and now would: the flush runs a rebuild. A run
 * with no record draws itself, and is passed over too.
 *
 * The check also asks that the box is still a member with the same numbers,
 * is visible, and draws at the order the record has. Every writer of those
 * calls `invalidate` today (`BoxNumbers.show` and `order`, `BoxBatch.add`
 * and `remove`, `LayerOrder` rebasing a mesh), so these checks fail only
 * for a writer that forgot to: a second guard, which turns that writer's
 * mistake into a rebuild rather than a box drawn as it was.
 *
 * A run marked changed is checked and passed over the same way: it has to
 * be visible, still a member, and at its recorded order (`textRun.js`
 * invalidates when its visibility or order changes). With nothing
 * structural pending its raster is the one the record holds, so writing it
 * is `writeRun` at its recorded index, in the array slot its draw gave its
 * size class.
 */

/**
 * How many arrays of runs one draw samples. A fragment shader has 16
 * texture units on every WebGL2 device, which is the guarantee, and the
 * gradient ramp (`gradient.js`) takes one.
 */
export const ARRAYS_PER_DRAW = 15;

/**
 * Where in its layer's band an outline's ring draws: after every level of
 * the layer and everything at it, a quarter step short of the next band, so
 * that a layer's rings draw over all of the layer and under the layers
 * after it. In the order the walk met them among themselves, which is tree
 * order.
 */
export const RING_PLACE = PIECE_BAND - BOX_BUCKET_BIAS / 2;

/** How many instances a freshly grown draw has room for. */
const MINIMUM_CAPACITY = 16;

/**
 * Which array a run samples rides in `aSize.z`, as `-1 - slot`, where a
 * box has its gradient header, a whole number from 0 up; the sign tells the
 * two apart. A box's `aSize.w` is its opacity, a run's colour and alpha are
 * in `aFillColor`, and its layer in its array in `aGradientGeometry.x`.
 *
 * Attribute slots are the budget here, not bytes. WebGL promises sixteen and
 * a headset browser gives exactly that; the quad's position takes one and
 * the instance matrix four, which leaves eleven for an instance. Chromium's
 * WebGL runs on ANGLE, and ANGLE counts every attribute a shader declares,
 * used or not, against the sixteen, while three declares `normal` and `uv`
 * in front of every `ShaderMaterial`'s vertex shader. So the nine named here
 * are all there is room for: the slots are three, four and nine, sixteen.
 * The gradient's small numbers ride in the two lanes `aSize` would otherwise
 * leave empty: `z` is a header packing the kind, three flags and the ramp
 * row into one integer-valued float (exact far past any row count a page
 * reaches), and `w` the box's opacity (`writeBoxInstance` in `boxBatch.js`).
 *
 * An outline and each layer of a `box-shadow` are instances of their own,
 * decorations of their box, and no lane more: `aSize.w` below 0, an opacity
 * no box has, says so, and which decoration it is (`DECORATION_RING` and
 * the rest in `boxBatch.js`). A ring's width and offset ride in `aBorder`
 * (`writeOutlineInstance`), and so do a shadow's offsets, blur and spread
 * (`writeShadowInstance`). The quad is the unit one grown by what the
 * decoration reaches past its box on every side, in the box's own unit
 * coordinates, since the box's matrix carries its size: a ring's offset
 * and width, an outer shadow's offset, spread and three sigmas of blur, and
 * nothing for an inset shadow, which stays inside its box.
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
  if (aSize.w < -0.5) {
    // A decoration: -2 in the slot for a ring, -3 for an outer shadow and
    // -4 for an inset one, which no run or box has.
    float kind = floor(-aSize.w + 0.5);
    vSlot = -1 - int(kind);
    float reach = kind < 1.5
      ? max(aBorder.x + aBorder.y, 0.0)
      : kind < 2.5
        ? max(abs(aBorder.x), abs(aBorder.y)) + max(aBorder.w, 0.0) + 1.5 * aBorder.z
        : 0.0;
    vec2 size = max(aSize.xy, vec2(1e-6));
    local = (position.xy * (size + 2.0 * reach) - reach) / size;
    vUnit = local;
    vGradient = vec4(0.0);
    vGradientRamp = vec2(0.0);
  } else if (aSize.z < -0.5) {
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
  } else if (vSlot == -2) {
    float alpha = vBorderColor.a *
      ringCoverage(vUnit, vSize, vRadii, vBorder.x, vBorder.y, vClip, vClipRadii);
    if (alpha < 0.001) {
      discard;
    }
    gl_FragColor = vec4(vBorderColor.rgb, alpha);
  } else if (vSlot < -2) {
    float coverage = vSlot == -3
      ? outerShadowCoverage(vUnit, vSize, vRadii, vBorder, vClip, vClipRadii)
      : insetShadowCoverage(vUnit, vSize, vRadii, vGradientGeometry, vBorder, vClip, vClipRadii);
    float alpha = vFillColor.a * coverage;
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
 * A draw's material: its own, since it carries the arrays the draw samples
 * and the half-planes of the piece it draws.
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
    // Kept across a growth, since a material made again for it is a program
    // three may link again, and kept linked after the last draw goes
    // (`programKeeper.js`).
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
    // The instances span the whole panel while the geometry is one unit
    // quad, so three's bounding sphere would describe none of it. A panel is
    // a single object to cull anyway, and its own container is what carries
    // it in and out of view.
    mesh.frustumCulled = false;
    // Instance matrices are already in the container's frame, which is this
    // mesh's frame too.
    mesh.matrixAutoUpdate = false;
    mesh.matrix.identity();
    // And the world matrix has to be asked for once. Three recomputes a world
    // matrix for an object that either recomposed its own or was told to;
    // this one does neither, and a freshly built object starts out believing
    // its world matrix is up to date when it is still the identity. A draw
    // built while the panel sat still, the run of a size that appears when a
    // row scrolls into view, would draw its instances at panel coordinates in
    // world space, somewhere off in the distance.
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
    setLanes(data.aSize, at, run.width, run.height, -1 - slot, 1);
    setLanes(data.aFillColor, at, color.r, color.g, color.b, opacity);
    setLanes(data.aClip, at, clip.x, clip.y, clip.z, clip.w);
    setLanes(data.aGradientGeometry, at, layer, 0, 0, 0);
    setLanes(data.aRadii, at, 0, 0, 0, 0);
    setLanes(data.aBorder, at, 0, 0, 0, 0);
    setLanes(data.aBorderColor, at, 0, 0, 0, 0);
    setLanes(data.aClipRadii, at, 0, 0, 0, 0);
    setLanes(data.aGradientTile, at, 0, 0, 0, 0);
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
    this.markAttributes();
    this.bind();
  }

  /**
   * Mark for upload each buffer whose drawn instances changed since it was
   * last marked (`markChanged`).
   *
   * @param {boolean} [matrices] Whether the instance matrices may have
   *   changed too.
   * @returns {void}
   */
  markAttributes(matrices = true) {
    const mesh = /** @type {THREE.InstancedMesh} */ (this.mesh);
    if (matrices) {
      markChanged(mesh.instanceMatrix, mesh.count);
    }
    for (const [name] of ATTRIBUTES) {
      markChanged(
        /** @type {THREE.InstancedBufferAttribute} */ (mesh.geometry.getAttribute(name)),
        mesh.count,
      );
    }
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
  /** A flush is queued. */
  #dirty = false;
  /** Something structural is pending, so the flush rebuilds. */
  #structural = false;
  /**
   * The boxes whose numbers changed since the last flush, and nothing else
   * about them: each once, in a list walked by index, since a hover or a
   * colour animation patches every frame.
   *
   * @type {Object3D[]}
   */
  #changed = [];
  /** @type {Set<Object3D>} */
  #changedSet = new Set();
  /**
   * The objects whose matrix changed since the last flush, and nothing
   * else about them, each once.
   *
   * @type {Object3D[]}
   */
  #moved = [];
  /** @type {Set<Object3D>} */
  #movedSet = new Set();
  /** The ancestors of a moved object, nearest first. @type {Object3D[]} */
  #ancestors = [];
  #disposed = false;

  /**
   * The record of the last rebuild: each box and run it took, by its mesh,
   * against the index of its own instance in the walk's arrays below. A
   * box's decorations follow it there.
   *
   * @type {Map<Object3D, number>}
   */
  #slots = new Map();
  /**
   * And where each instance of the walk went: the draw, and the index in
   * it.
   *
   * @type {number[]}
   */
  #drawAt = [];
  /** @type {number[]} */
  #indexAt = [];
  /** The draws a patch writes to, to mark for upload. @type {Draw[]} */
  #touched = [];

  /**
   * How many instances the last flush wrote, a rebuild's or a patch's. For
   * tests.
   */
  written = 0;

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
  /**
   * Which decoration of its box the box at an index is drawn as, 0 for the
   * box itself (`DECORATION_RING` and the rest in `boxBatch.js`).
   *
   * @type {number[]}
   */
  #decorations = [];
  /** Which layer of its box's `box-shadow` a shadow is. @type {number[]} */
  #shadowLayers = [];
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
    this.boxes = new BoxBatch(this);
    /** And its runs. */
    this.runs = new TextBatch(this);
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
   * Something either batch copied down changed in a way that needs a
   * rebuild (see the file's header), or the layers the order cuts did: a
   * box moved, scrolled, appeared or went away, a run did the same.
   *
   * Coalesced to one rebuild, because a single mutation reaches a great many
   * of these — every box in a re-laid-out panel writes its uniforms — and the
   * rebuild is a walk of the whole panel either way.
   *
   * Two things collect the debt, and a panel needs both. A microtask is the
   * right grain for anything that arrives as its own task, which is what a
   * mutation is: signal effects run in batches, so a microtask lands once
   * after the graph has settled and before the next frame can draw. It is
   * the wrong grain for anything that arrives from inside a frame callback,
   * because a microtask queued there does not run until that callback, and
   * the `renderer.render` at the end of it, has returned. Two sources do
   * exactly that: the animation clock, which samples a running CSS animation
   * at the top of each frame, and a scroll drag in an immersive session,
   * whose synthetic `scroll` event is dispatched from the same tick. Left to
   * the microtask, a batched box under an animation draws where it was last
   * frame while its unbatched neighbours, an `<img>` or a checkbox tick,
   * draw where it is now, which is the panel shearing along the line between
   * them. So `flush` runs late in the frame too (`portal.js`), and this stays
   * as the backstop for portals that have no frames to run late in.
   *
   * What a rebuild reads are local matrices, which `place` keeps current at
   * the moment of the write, and uniform values, written the same way, never
   * anything the renderer computes. So it is correct whenever it runs, and
   * only its timing decides whether it is also current.
   *
   * @returns {void}
   */
  invalidate() {
    this.#structural = true;
    this.#schedule();
  }

  /**
   * A box's numbers changed, and nothing else about it: the next flush
   * writes its instances where the last rebuild put them, unless anything
   * structural is pending or the box no longer matches what the rebuild
   * recorded (see the file's header).
   *
   * @param {Object3D} mesh A member of `boxes` or of `runs`.
   * @returns {void}
   */
  changed(mesh) {
    if (!this.#changedSet.has(mesh)) {
      this.#changedSet.add(mesh);
      this.#changed.push(mesh);
    }
    this.#schedule();
  }

  /**
   * An object's matrix changed, and nothing else about it: the next flush
   * writes the matrix of every box and run under it where the last rebuild
   * put them, unless anything structural is pending or the subtree no
   * longer matches what the rebuild recorded (see the file's header). A
   * scroll is this, of the content group that carries what scrolls.
   *
   * @param {Object3D} object
   * @returns {void}
   */
  moved(object) {
    if (!this.#movedSet.has(object)) {
      this.#movedSet.add(object);
      this.#moved.push(object);
    }
    this.#schedule();
  }

  /** @returns {void} */
  #schedule() {
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
    if (this.#structural || !this.#patch()) {
      this.rebuild();
    }
    this.#clearChanged();
  }

  /** @returns {void} */
  #clearChanged() {
    this.#changed.length = 0;
    this.#changedSet.clear();
    this.#moved.length = 0;
    this.#movedSet.clear();
  }

  /**
   * Write the matrices under the objects marked moved and the instances of
   * the boxes marked changed where the last rebuild put them, if every one
   * of them still matches the record; say whether it did. A move that does
   * not match leaves matrices written, which the rebuild that follows
   * writes again.
   *
   * @returns {boolean}
   */
  #patch() {
    const changed = this.#changed;
    for (let k = 0; k < changed.length; k++) {
      if (this.#slots.has(changed[k]) && !this.#matches(changed[k])) {
        return false;
      }
    }
    const touched = this.#touched;
    this.written = 0;
    const moved = this.#moved;
    for (let k = 0; k < moved.length; k++) {
      if (!this.#move(moved[k])) {
        touched.length = 0;
        return false;
      }
    }
    let written = this.written;
    for (let k = 0; k < changed.length; k++) {
      const first = this.#slots.get(changed[k]);
      if (first === undefined) {
        continue;
      }
      const run = this.#runs[first];
      if (run) {
        const draw = this.#draws[this.#drawAt[first]];
        const sizeClass = /** @type {Slot} */ (run.shown).sizeClass;
        draw.writeRun(this.#indexAt[first], run, draw.classes.indexOf(sizeClass));
        if (!touched.includes(draw)) {
          touched.push(draw);
        }
        written += 1;
        continue;
      }
      const box = this.#boxes[first];
      for (let i = first; i < this.#boxes.length && this.#boxes[i] === box; i++) {
        const draw = this.#draws[this.#drawAt[i]];
        this.#writeBox(draw, this.#indexAt[i], i);
        if (!touched.includes(draw)) {
          touched.push(draw);
        }
        written += 1;
      }
    }
    // A patch with no move writes no matrix, so the matrices are not
    // compared.
    for (let k = 0; k < touched.length; k++) {
      touched[k].markAttributes(moved.length > 0);
    }
    touched.length = 0;
    this.written = written;
    return true;
  }

  /**
   * Write the matrices of what `object` and its subtree draw where the last
   * rebuild put them, from the matrix of its parent in the container's
   * frame; say whether the subtree matched the record. An object the last
   * walk could not reach, under a hidden ancestor or outside the container,
   * draws nothing, and one under another moved object is written with it.
   *
   * @param {Object3D} object
   * @returns {boolean}
   */
  #move(object) {
    const ancestors = this.#ancestors;
    ancestors.length = 0;
    let parent = object.parent;
    while (parent !== this.#container) {
      if (
        parent === null ||
        !parent.visible ||
        this.#movedSet.has(parent) ||
        this.#drawMeshes.has(parent) ||
        isProxy(parent)
      ) {
        return true;
      }
      ancestors.push(parent);
      parent = parent.parent;
    }
    const depth = ancestors.length;
    let matrix = stackAt(0).identity();
    for (let k = depth - 1; k >= 0; k--) {
      matrix = stackAt(depth - k).multiplyMatrices(matrix, ancestors[k].matrix);
    }
    ancestors.length = 0;
    return this.#place(object, matrix, depth + 1);
  }

  /**
   * The walk of `#walk`, over one subtree, writing each matrix to the
   * record's slots rather than taking anything; false when it meets a box
   * the record does not have.
   *
   * @param {Object3D} object
   * @param {THREE.Matrix4} parentMatrix
   * @param {number} depth
   * @returns {boolean}
   */
  #place(object, parentMatrix, depth) {
    if (!object.visible || this.#drawMeshes.has(object) || isProxy(object)) {
      return true;
    }
    const matrix = stackAt(depth).multiplyMatrices(parentMatrix, object.matrix);
    const first = this.#slots.get(object);
    if (first !== undefined) {
      const box = this.#boxes[first];
      const end = box ? this.#boxes.length : first + 1;
      for (let i = first; i < end && (i === first || this.#boxes[i] === box); i++) {
        const draw = this.#draws[this.#drawAt[i]];
        /** @type {THREE.InstancedMesh} */ (draw.mesh).setMatrixAt(this.#indexAt[i], matrix);
        if (!this.#touched.includes(draw)) {
          this.#touched.push(draw);
        }
        this.written += 1;
      }
    } else if (this.boxes.numbersOf(/** @type {THREE.Mesh} */ (object))) {
      return false;
    }
    const children = object.children;
    for (let i = 0; i < children.length; i++) {
      if (!this.#place(children[i], matrix, depth + 1)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether a box the last rebuild recorded is drawn where and as it
   * recorded it, so that writing its numbers there draws what a rebuild
   * would.
   *
   * @param {Object3D} object
   * @returns {boolean}
   */
  #matches(object) {
    const first = /** @type {number} */ (this.#slots.get(object));
    const mesh = /** @type {THREE.Mesh} */ (object);
    const run = this.#runs[first];
    if (run) {
      // A run's numbers are its colour, opacity and clip. Its size and its
      // layer in an array come with its raster, which only a rebuild
      // settles, so they are as the record has them. The rest is the same
      // second guard as a box's, below.
      return (
        mesh.visible && this.runs.memberOf(mesh) === run && this.#orders[first] === mesh.renderOrder
      );
    }
    const box = this.#boxes[first];
    if (
      !box ||
      !mesh.visible ||
      this.boxes.numbersOf(mesh) !== box ||
      this.#orders[first] !== mesh.renderOrder + BOX_BUCKET_BIAS
    ) {
      return false;
    }
    // The decorations `#decorate` would take now, against those it took.
    let at = first + 1;
    for (let layer = shadowCount(box) - 1; layer >= 0; layer--) {
      const kind = isInsetShadow(box, layer) ? DECORATION_INSET_SHADOW : DECORATION_OUTER_SHADOW;
      if (this.#boxes[at] !== box || this.#decorations[at] !== kind) {
        return false;
      }
      at += 1;
    }
    if (hasOutline(box)) {
      if (this.#boxes[at] !== box || this.#decorations[at] !== DECORATION_RING) {
        return false;
      }
      at += 1;
    }
    return this.#boxes[at] !== box;
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
    this.#structural = false;
    this.#clearChanged();
    this.#slots.clear();
    this.written = 0;
    this.#orders.length = 0;
    this.#boxes.length = 0;
    this.#runs.length = 0;
    this.#decorations.length = 0;
    this.#shadowLayers.length = 0;
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
      this.#lay(d, starts[d], starts[d + 1]);
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
      this.#slots.set(mesh, this.#orders.length);
      const order = box ? mesh.renderOrder + BOX_BUCKET_BIAS : mesh.renderOrder;
      this.#take(order, box, run, 0, 0, matrix);
      if (box) {
        this.#decorate(order, mesh.renderOrder, box, matrix);
      }
    } else if (drawsItself(object)) {
      this.#breaks.push(object.renderOrder);
    }
    const children = object.children;
    for (let i = 0; i < children.length; i++) {
      this.#walk(children[i], matrix, depth + 1);
    }
  }

  /**
   * Note the decorations of a box the walk met: its shadows, the bottom
   * layer first so that the topmost draws last, and its outline.
   *
   * @param {number} order The box's own, bias and all.
   * @param {number} level Its render order, the level it is at.
   * @param {Record<string, THREE.IUniform>} box
   * @param {THREE.Matrix4} matrix
   */
  #decorate(order, level, box, matrix) {
    for (let layer = shadowCount(box) - 1; layer >= 0; layer--) {
      if (isInsetShadow(box, layer)) {
        // Over the box's background, under its content.
        this.#take(level + INSET_SHADOW_BIAS, box, null, DECORATION_INSET_SHADOW, layer, matrix);
      } else {
        // Under the box, and under every box at its level.
        this.#take(level + OUTER_SHADOW_BIAS, box, null, DECORATION_OUTER_SHADOW, layer, matrix);
      }
    }
    if (hasOutline(box)) {
      // Over everything else in the box's layer, as a page paints an
      // outline last in its stacking context.
      this.#take(bandBase(order) + RING_PLACE, box, null, DECORATION_RING, 0, matrix);
    }
  }

  /**
   * Note an instance the walk met.
   *
   * @param {number} order
   * @param {Record<string, THREE.IUniform> | null} box
   * @param {Member | null} run
   * @param {number} decoration Which decoration of `box` it is, 0 for none.
   * @param {number} shadowLayer Which layer of the box's shadow, for one.
   * @param {THREE.Matrix4} matrix
   */
  #take(order, box, run, decoration, shadowLayer, matrix) {
    const index = this.#orders.length;
    this.#orders.push(order);
    this.#boxes.push(box);
    this.#runs.push(run);
    this.#decorations.push(decoration);
    this.#shadowLayers.push(shadowLayer);
    if (!this.#matrices[index]) {
      this.#matrices[index] = new THREE.Matrix4();
    }
    this.#matrices[index].copy(matrix);
  }

  /**
   * Write the instances `#sorted` holds from `start` up to `end` into the
   * draw at `d`, and record where each went.
   *
   * @param {number} d
   * @param {number} start
   * @param {number} end
   */
  #lay(d, start, end) {
    const draw = this.#draws[d];
    const sorted = this.#sorted;
    draw.reserve(end - start);
    const mesh = /** @type {THREE.InstancedMesh} */ (draw.mesh);
    draw.classes.length = 0;
    for (let at = start; at < end; at++) {
      const i = sorted[at];
      const index = at - start;
      this.#drawAt[i] = d;
      this.#indexAt[i] = index;
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
        this.#writeBox(draw, index, i);
      }
    }
    this.written += end - start;
    draw.finish(end - start, this.#orders[sorted[start]]);
  }

  /**
   * Write the box, or the decoration of one, that the walk took at `i` into
   * `draw` at `index`.
   *
   * @param {Draw} draw
   * @param {number} index
   * @param {number} i
   */
  #writeBox(draw, index, i) {
    const box = /** @type {Record<string, THREE.IUniform>} */ (this.#boxes[i]);
    const decoration = this.#decorations[i];
    if (decoration === DECORATION_RING) {
      writeOutlineInstance(draw.data, index, box);
    } else if (decoration !== 0) {
      writeShadowInstance(draw.data, index, box, this.#shadowLayers[i]);
    } else {
      writeBoxInstance(draw.data, index, box);
    }
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
