import * as THREE from "three";
import { createProperty } from "@apendua/signal";
import { GRADIENT_GLSL, rectGeometry, SDF_GLSL } from "./sdfRect.js";
import { rampUniforms } from "./gradient.js";
import { markChanged } from "./instanceUploads.js";
import { keepProgram } from "./programKeeper.js";

/**
 * @import {Object3D} from 'three';
 * @import {ProgramKind} from './programKeeper.js';
 */

/**
 * Drawing a panel's boxes together instead of one at a time.
 *
 * A box costs almost nothing to describe — a size, four radii, four border
 * widths, two colours, a clip window and perhaps a gradient — and almost nothing to draw, since
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
 *     The exception is a box that is not opaque stepped over a sibling,
 *     which draws after that sibling's subtree at a level of its own
 *     (`getDrawLevel`): a pile of cards that are not opaque is a bucket per
 *     card.
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

/**
 * Which depth bias a panel's boxes are drawn with, if any: a prototype of
 * the paint rank in item 10.2 of `docs/freedom-architecture-plan.md`, set by
 * the panel's `depthRank` option. Each box moves toward the viewer by its
 * rank (`getPaintRank` in `elevation.js`) times a step in NDC depth:
 *
 * - `"constant"`: `DEPTH_RANK_EPSILON` a rank, whatever the panel's angle.
 * - `"slope"`: `DEPTH_RANK_SLOPE_FACTOR` times how much NDC depth changes
 *   from one pixel to the next across the panel, plus `DEPTH_RANK_FLOOR`.
 * - `"max"`: the larger of `DEPTH_RANK_MAX_FLOOR` and `DEPTH_RANK_MAX_FACTOR`
 *   times the same slope.
 *
 * Each is on top of the geometric lift, which stays until item 10.3, and
 * moves only the batched boxes. Text and the other marks are not biased
 * yet, so a box can cover its own marks where its rank times the step
 * reaches the 1 px they stand in front of it. Nor is an `<img>`, which is
 * not batched (`div.js`), so a card can cover the picture on the card
 * under it once its rank's lead passes the `CONTENT_STEP` between them.
 *
 * @typedef {"constant" | "slope" | "max"} DepthRankBias
 */

/**
 * The step a rank under `"constant"`, in NDC depth: what item 10.1 found
 * the steepest panel needs on a Quest 3, a pile tipped 45° or more at 1 m.
 */
export const DEPTH_RANK_EPSILON = 2 ** -18;

/**
 * The step a rank under `"slope"` for a panel facing the viewer, where the
 * slope is nothing: what item 10.1 found every pile facing the viewer needs,
 * at 1, 5 and 10 m, in the emulator and on a Quest 3.
 */
export const DEPTH_RANK_FLOOR = 2 ** -22;

/**
 * `k` in `rank · (k · slope + floor)`: how many pixels' worth of the panel's
 * depth slope one rank takes. Set by the probe's sweep in item 10.2, in the
 * emulator, as the least power of two that left no pixel of any pile wrong;
 * the plan's Status row says whether the Quest has confirmed it.
 */
export const DEPTH_RANK_SLOPE_FACTOR = 2 ** -3;

/**
 * The least step a rank under `"max"`, in NDC depth: what the Quest 3's
 * sweep in item 10.2 found any pile needs that does not face the viewer.
 * One facing the viewer needs a quarter of it, and is given this.
 */
export const DEPTH_RANK_MAX_FLOOR = 2 ** -20;

/**
 * `k` in `rank · max(floor, k · slope)`: what the Quest 3's sweep in item
 * 10.2 found the steepest piles need, the keyboard and the memo among them.
 * Under the plain slope one `k` has to be set by the shallow piles, which
 * need four to sixteen times more of their slope; here the floor covers
 * them.
 */
export const DEPTH_RANK_MAX_FACTOR = 2 ** -8;

/**
 * The most one rank moves a box under `"slope"` or `"max"`, in NDC depth, so a panel
 * seen nearly edge on, whose slope runs to infinity, does not throw its
 * boxes past the near plane. The step item 10.1's steepest pile needed in
 * the emulator.
 */
export const DEPTH_RANK_STEP_LIMIT = 2 ** -12;

/**
 * The bias as GLSL, for the batch's vertex shader and for a probe that has
 * to draw with the same formula. Compiled only under `DEPTH_RANK`, and
 * under `DEPTH_RANK_SLOPE` or `DEPTH_RANK_MAX` for the two that read the
 * slope.
 *
 * The slope is taken from the plane rather than from the pixels, so it
 * costs a few operations a vertex, adds no draw and writes no
 * `gl_FragDepth`, which would turn the early depth test off. NDC depth is
 * affine in NDC x and y across a plane, under a perspective projection and
 * an orthographic one alike, so its gradient is one number for the whole
 * quad and every vertex computes the same one. It is found by moving the
 * vertex along the quad's two edges, `modelView`'s first two columns:
 * each move changes NDC x, y and z together, and the two moves give the
 * change in z per change in x and in y. A change of 2 in NDC is the eye's
 * viewport, `uDepthRankViewport` in device pixels, so dividing by it gives
 * the change from one pixel to the next; the larger of the two directions
 * is the slope, as `glPolygonOffset` takes it.
 */
export const DEPTH_RANK_GLSL = /* glsl */ `
#ifdef DEPTH_RANK
uniform vec2 uDepthRankViewport;
#if defined(DEPTH_RANK_SLOPE) || defined(DEPTH_RANK_MAX)
float depthRankSlope(mat4 modelView, vec4 clip) {
  vec4 along = projectionMatrix * vec4(modelView[0].xyz, 0.0);
  vec4 across = projectionMatrix * vec4(modelView[1].xyz, 0.0);
  // The change in NDC along each edge, times clip.w squared, which the
  // ratio below cancels.
  vec3 a = along.xyz * clip.w - clip.xyz * along.w;
  vec3 b = across.xyz * clip.w - clip.xyz * across.w;
  float det = a.x * b.y - a.y * b.x;
  // Seen edge on: a slope past any limit, which the step limit then holds.
  if (abs(det) < 1e-30) {
    return 1e30;
  }
  vec2 gradient = vec2(a.z * b.y - b.z * a.y, a.x * b.z - b.x * a.z) / det;
  vec2 perPixel = abs(gradient) * 2.0 / uDepthRankViewport;
  return max(perPixel.x, perPixel.y);
}
#endif
float depthRankStep(mat4 modelView, vec4 clip) {
  #if defined(DEPTH_RANK_SLOPE)
  float slope = depthRankSlope(modelView, clip);
  return min(DEPTH_RANK_SLOPE_FACTOR * slope + DEPTH_RANK_FLOOR, DEPTH_RANK_STEP_LIMIT);
  #elif defined(DEPTH_RANK_MAX)
  float slope = depthRankSlope(modelView, clip);
  return min(max(DEPTH_RANK_MAX_FLOOR, DEPTH_RANK_MAX_FACTOR * slope), DEPTH_RANK_STEP_LIMIT);
  #else
  return DEPTH_RANK_EPSILON;
  #endif
}
#endif
`;

/**
 * The defines that compile `DEPTH_RANK_GLSL` for a bias, with its constants.
 *
 * @param {DepthRankBias} bias
 * @returns {Record<string, string>}
 */
export function depthRankDefines(bias) {
  /** @type {Record<string, string>} */
  const defines = {
    DEPTH_RANK: "",
    DEPTH_RANK_EPSILON: glslFloat(DEPTH_RANK_EPSILON),
    DEPTH_RANK_FLOOR: glslFloat(DEPTH_RANK_FLOOR),
    DEPTH_RANK_SLOPE_FACTOR: glslFloat(DEPTH_RANK_SLOPE_FACTOR),
    DEPTH_RANK_MAX_FLOOR: glslFloat(DEPTH_RANK_MAX_FLOOR),
    DEPTH_RANK_MAX_FACTOR: glslFloat(DEPTH_RANK_MAX_FACTOR),
    DEPTH_RANK_STEP_LIMIT: glslFloat(DEPTH_RANK_STEP_LIMIT),
  };
  if (bias === "slope") {
    defines.DEPTH_RANK_SLOPE = "";
  } else if (bias === "max") {
    defines.DEPTH_RANK_MAX = "";
  }
  return defines;
}

/**
 * @param {number} value
 * @returns {string}
 */
function glslFloat(value) {
  return value.toExponential();
}

// Attribute slots are the budget here, not bytes. WebGL promises sixteen and
// a headset browser gives exactly that; the quad's position takes one and
// the instance matrix four, which leaves eleven for a box's description, and
// every one of them is a slot whether it carries two floats or four. So the
// gradient's small numbers ride in the two lanes `aSize` would otherwise
// leave empty: `z` is a header packing the kind, three flags and the ramp
// row into one integer-valued float (exact far past any row count a page
// reaches), and `w` the element's opacity. Unpacked here, once per vertex,
// rather than per fragment.
//
// None of the eleven is left, though nine are named here. Chromium's WebGL
// runs on ANGLE, and ANGLE counts every attribute a shader declares, used or
// not, against the sixteen, while three declares `normal` and `uv` in front
// of every `ShaderMaterial`'s vertex shader. A tenth fails to link. So a
// panel with a `depthRank` packs the box's rank into `aSize.w` as well,
// `2 * rank + opacity`: the rank is a whole number and the opacity runs
// from 0 to 1, so the floor of half of it is the rank, and what is left is
// the opacity, to about a ten-thousandth up to a rank of a thousand.
const instancedVertex = /* glsl */ `
${DEPTH_RANK_GLSL}
attribute vec4 aSize;
attribute vec4 aRadii;
attribute vec4 aBorder;
attribute vec4 aFillColor;
attribute vec4 aBorderColor;
attribute vec4 aClip;
attribute vec4 aClipRadii;
attribute vec4 aGradientGeometry;
attribute vec4 aGradientTile;
varying vec2 vUnit;
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
  float header = floor(aSize.z + 0.5);
  float flags = floor(header / 4.0);
  vGradient = vec4(
    mod(header, 4.0),
    mod(flags, 2.0),
    mod(floor(flags / 2.0), 2.0),
    mod(floor(flags / 4.0), 2.0)
  );
  #ifdef DEPTH_RANK
  float depthRank = floor(aSize.w * 0.5);
  vGradientRamp = vec2(floor(flags / 8.0), aSize.w - 2.0 * depthRank);
  #else
  vGradientRamp = vec2(floor(flags / 8.0), aSize.w);
  #endif
  vGradientGeometry = aGradientGeometry;
  vGradientTile = aGradientTile;
  mat4 modelView = modelViewMatrix * instanceMatrix;
  gl_Position = projectionMatrix * modelView * vec4(position, 1.0);
  #ifdef DEPTH_RANK
  gl_Position.z -= depthRank * depthRankStep(modelView, gl_Position) * gl_Position.w;
  #endif
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
varying vec4 vGradient;
varying vec4 vGradientGeometry;
varying vec4 vGradientTile;
varying vec2 vGradientRamp;
${SDF_GLSL}
${GRADIENT_GLSL}
void main() {
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
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * All of a box's numbers are per-instance, so there is nothing left for a
 * material to carry that would make one bucket's differ from another's — every
 * bucket of a panel draws with the one made here, and there is no material
 * state to change between them.
 *
 * One per panel rather than one for the whole app, though, and not as a
 * nicety. A material is how a panel is dressed, and code outside this file
 * dresses whole panels by walking them: the diagnostics HUD turns depth
 * testing off across its own subtree so its reading stays legible whatever the
 * scene puts in front of it. Reaching a material shared with every other panel,
 * that walk would take depth testing away from the entire app — which is one
 * HUD, and every panel in the scene drawing over the objects in front of it.
 * The program is cached by shader source, so panels still compile this once
 * between them; only the state a panel is allowed to own is per panel. And it
 * stays linked after the last panel closes (`programKeeper.js`), so the next
 * one to open does not link it again.
 *
 * A panel drawn with a depth bias compiles the program with its defines, so
 * a panel without one runs the shader it always did.
 *
 * @param {DepthRankBias | undefined} depthRank
 * @returns {THREE.ShaderMaterial}
 */
function batchMaterial(depthRank) {
  return new THREE.ShaderMaterial({
    defines: depthRank ? depthRankDefines(depthRank) : {},
    vertexShader: instancedVertex,
    fragmentShader: instancedFragment,
    transparent: true,
    // Two-sided and single-pass for the reasons `sdfRect` gives at length:
    // the container's flip turns every plane away from the viewer, and the
    // back pass of a two-sided transparent material has nothing to order
    // for a quad.
    side: THREE.DoubleSide,
    forceSinglePass: true,
    // The page's ramp atlas, by reference: the same two uniform objects every
    // box material holds, so an atlas that grows is seen by all of them.
    uniforms: {
      uRamp: rampUniforms.uRamp,
      uRampHeight: rampUniforms.uRampHeight,
      ...(readsSlope(depthRank) ? { uDepthRankViewport: { value: new THREE.Vector2(1, 1) } } : {}),
    },
  });
}

/**
 * The bias a batch material was made for, read back off its defines.
 *
 * @param {THREE.ShaderMaterial} material
 * @returns {DepthRankBias | undefined}
 */
function biasOf(material) {
  if ("DEPTH_RANK_SLOPE" in material.defines) {
    return "slope";
  }
  if ("DEPTH_RANK_MAX" in material.defines) {
    return "max";
  }
  return "DEPTH_RANK" in material.defines ? "constant" : undefined;
}

/**
 * Whether a bias reads the panel's slope, and so the eye's viewport.
 *
 * @param {DepthRankBias | undefined} bias
 * @returns {boolean}
 */
function readsSlope(bias) {
  return bias === "slope" || bias === "max";
}

/**
 * Each bias compiles a program of its own, so each is a variant with a
 * keeper of its own, made with the same bias.
 *
 * @type {ProgramKind<THREE.ShaderMaterial>}
 */
const BOX_PROGRAM = {
  name: "freedom-box-batch",
  create: (material) => batchMaterial(biasOf(material)),
  variant: (material) => biasOf(material) ?? "none",
};

/** Scratch for reading the viewport a bucket is drawn into. */
const viewport = new THREE.Vector4();

/**
 * Set `size`, a `uDepthRankViewport` value, to the viewport `renderer` is
 * drawing into now: the eye's, in a session, which three sets before each
 * eye's draws, or a render target's. Exported for a probe that draws with
 * `DEPTH_RANK_GLSL` outside a batch.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Vector2} size
 * @returns {boolean} Whether it changed.
 */
export function readDepthRankViewport(renderer, size) {
  renderer.getCurrentViewport(viewport);
  if (size.x === viewport.z && size.y === viewport.w) {
    return false;
  }
  size.set(viewport.z, viewport.w);
  return true;
}

/**
 * Keep the `uDepthRankViewport` of a material whose bias reads the slope at
 * the viewport it is
 * drawn into. Uploaded only when it changes, since the program keeps the
 * last value it was given: when a session starts or ends, and twice for
 * each drag ghost, whose snapshot (`takeSnapshot` in `ghostSnapshot.js`)
 * draws the panel into a target of the ghost's size and so with the slope
 * for that target's pixels.
 *
 * @this {THREE.Mesh}
 * @param {THREE.WebGLRenderer} renderer
 * @returns {void}
 */
function followViewport(renderer) {
  const material = /** @type {THREE.ShaderMaterial} */ (this.material);
  if (readDepthRankViewport(renderer, material.uniforms.uDepthRankViewport.value)) {
    material.uniformsNeedUpdate = true;
  }
}

/**
 * How far behind its integer a box bucket draws, so that text of the same
 * `renderOrder` draws first and the boxes composite over it.
 *
 * The scheme makes that collision structural rather than unlucky. An element's
 * box carries `elevation * ELEVATION_BAND + level`, its draw level from
 * elevation.js, and its text carries `getContentRenderOrder`, which is one
 * level more. That is the same integer as the box of anything nested one
 * level inside it. Drawing a
 * panel a mesh at a time, three broke the tie by view-space depth and got it
 * right for nothing: a nested box sits `CONTENT_STEP` toward the viewer of
 * its parent's content while a run of text sits level with it, so the text
 * was farther, drew first, and the box composited over it.
 *
 * A bucket has no such depth to offer. Every bucket of a panel hangs off the
 * container with an identity matrix, so box and text buckets of one order sort
 * at exactly the same distance and three falls through to comparing object
 * ids — which is creation order, and which changes under you: a bucket that
 * fills is rebuilt with a fresh id, so a panel could reverse the two mid
 * session, the first time a row arrived that made a bucket grow. With the box
 * material writing depth, that decides whether text under a translucent box
 * is there or not.
 *
 * So the order is written down instead. Half a step keeps a bucket strictly
 * between its own integer and the next one, which is what makes this safe:
 * text at R, boxes at R + 0.5, text at R + 1 — the levels never interleave.
 * An `<svg>`'s content counts as text here: `paintSlot` in `svg/shape.js`
 * keeps all of it between R and R + 0.5.
 *
 * What this does not fix, and is not meant to: a mesh that draws itself among
 * batched ones — an `<img>`'s box, a run of text whose colours are baked in —
 * sorts on its own origin, which is nearer than the container's, so it
 * composites over batched content of the same order. That one is at least
 * stable, being a property of where the mesh is rather than of when it was
 * made.
 */
export const BOX_BUCKET_BIAS = 0.5;

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
   * @param {THREE.ShaderMaterial} material The panel's, shared by its
   *   buckets, whose defines say whether the panel has a depth bias.
   */
  constructor(renderOrder, parent, material) {
    this.renderOrder = renderOrder;
    this.parent = parent;
    this.material = material;
    this.ranked = "DEPTH_RANK" in material.defines;
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
    this.data = {};
    for (const [name, size] of attributes) {
      const array = new Float32Array(capacity * size);
      this.data[name] = array;
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size));
    }
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    mesh.renderOrder = this.renderOrder + BOX_BUCKET_BIAS;
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
    if (readsSlope(biasOf(this.material))) {
      mesh.onBeforeRender = followViewport;
    }
    this.mesh = mesh;
    this.parent.add(mesh);
  }

  /**
   * @param {number} index
   * @param {THREE.Mesh} box
   * @param {THREE.Matrix4} matrix
   * @param {Record<string, THREE.IUniform>} uniforms The box's numbers. Handed
   *   in rather than read off `box.material`, because a batched box shares one
   *   invisible material with every other batched box on the page and keeps
   *   its numbers to itself.
   * @param {number} rank The box's paint rank, written only under a bias.
   * @returns {void}
   */
  write(index, box, matrix, uniforms, rank) {
    const mesh = this.mesh;
    if (!mesh) {
      return;
    }
    mesh.setMatrixAt(index, matrix);
    const { uSize, uRadii, uBorder, uFillColor, uBorderColor, uClip, uClipRadii } = uniforms;
    const { uGradient, uGradientGeometry, uGradientTile, uGradientRamp } = uniforms;
    const gradient = uGradient.value;
    const ramp = uGradientRamp.value;
    const size = this.data.aSize;
    size[index * 4] = uSize.value.x;
    size[index * 4 + 1] = uSize.value.y;
    // Unpacked by the vertex shader; see `instancedVertex`.
    size[index * 4 + 2] =
      gradient.x + 4 * gradient.y + 8 * gradient.z + 16 * gradient.w + 32 * ramp.x;
    // The opacity, and under a depth bias the rank with it; see
    // `instancedVertex`.
    size[index * 4 + 3] = this.ranked ? 2 * rank + ramp.y : ramp.y;
    writeVec4(this.data.aGradientGeometry, index, uGradientGeometry.value);
    writeVec4(this.data.aGradientTile, index, uGradientTile.value);
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
    markChanged(mesh.instanceMatrix, count);
    for (const name of Object.keys(this.data)) {
      markChanged(
        /** @type {THREE.InstancedBufferAttribute} */ (mesh.geometry.getAttribute(name)),
        count,
      );
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
    // An instanced mesh has one buffer that its geometry does not own.
    // `instanceMatrix` is not a geometry attribute — the renderer uploads it
    // separately and frees it only when the mesh says it is going, which is
    // what this dispatches. Without it the buffer is left allocated on the
    // device with nothing referring to it: the renderer's own record of it is
    // weakly keyed, so collecting the attribute drops the key and the
    // `deleteBuffer` that would have followed it. That is once per growth —
    // a bucket is rebuilt at double capacity every time it fills — and once
    // more per panel closed.
    //
    // The material is not disposed here. It belongs to the panel and is
    // shared by every bucket in it, so it goes when the batch does.
    this.mesh.dispose();
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
   * Each box against the numbers it is drawn from, which a batched box keeps
   * to itself rather than on the material it shares with every other one.
   *
   * @type {Map<THREE.Mesh, Record<string, THREE.IUniform>>}
   */
  #members = new Map();

  /** @type {Map<number, Bucket>} */
  #buckets = new Map();

  /** @type {Object3D} */
  #container;

  /**
   * The depth bias this panel's boxes are drawn with, if any.
   *
   * @readonly
   * @type {DepthRankBias | undefined}
   */
  depthRank;

  /**
   * This panel's, shared by its buckets. See `batchMaterial`.
   *
   * @type {THREE.ShaderMaterial}
   */
  #material;

  /**
   * Each box's paint rank, under a depth bias: written by the box from
   * `getPaintRank` and copied into the bucket at the next rebuild.
   *
   * @type {Map<THREE.Mesh, number>}
   */
  #ranks = new Map();

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
   * The boxes the last rebuild laid into buckets, so that a box leaving the
   * batch asks for a rebuild only when the buckets hold it. A box out of the
   * walk is in no bucket: the rows that left an open panel wait out of it
   * for their teardowns (`portalTeardown.js`), and each of those removals
   * would otherwise rebuild the batch to find what it already holds.
   *
   * @type {Set<THREE.Mesh>}
   */
  #drawn = new Set();

  /**
   * @param {Object3D} container The portal's container object. Buckets hang
   *   off it, so instance matrices are in its frame and it carries the whole
   *   panel as one.
   * @param {DepthRankBias} [depthRank] The panel's `depthRank` option.
   */
  constructor(container, depthRank) {
    this.#container = container;
    this.depthRank = depthRank;
    this.#material = keepProgram(batchMaterial(depthRank), BOX_PROGRAM);
  }

  /**
   * Take this box into the batch: it stops drawing itself, and the batch
   * starts drawing it. Idempotent.
   *
   * @param {THREE.Mesh} mesh
   * @param {Record<string, THREE.IUniform>} uniforms The numbers to draw it
   *   from — see `Bucket.write`.
   * @returns {void}
   */
  add(mesh, uniforms) {
    if (this.#members.has(mesh)) {
      return;
    }
    this.#members.set(mesh, uniforms);
    // Nothing to flip: a batched box wears `batchedBoxMaterial`, which is
    // invisible and shared, so it is already out of the render list without
    // being out of anything else — the ray still finds it, and `visible` still
    // means what it meant. This used to set the flag per mesh, which a shared
    // material cannot have: clearing it on one box's teardown would put every
    // other box on the page back into the draw.
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
    // No visibility to restore: the material was never this mesh's to hide.
    mesh.frustumCulled = true;
    this.#ranks.delete(mesh);
    if (this.#drawn.delete(mesh)) {
      this.invalidate();
    }
  }

  /**
   * Say where a box stands in the paint order, for the depth bias. Does
   * nothing for a panel drawn without one, which is why a box asks
   * `depthRank` before it reads its rank at all.
   *
   * @param {THREE.Mesh} mesh
   * @param {number} rank `getPaintRank` of the box's element.
   * @returns {void}
   */
  setRank(mesh, rank) {
    // A box not in the batch, or no longer, keeps no rank here: its rank
    // effect can run once more during a teardown, after `remove`.
    if (!this.depthRank || !this.#members.has(mesh) || this.#ranks.get(mesh) === rank) {
      return;
    }
    this.#ranks.set(mesh, rank);
    this.invalidate();
  }

  /**
   * Something about the panel that the batch has copied down has changed: a
   * box moved, was restyled, scrolled, appeared or went away.
   *
   * Coalesced to one rebuild, because a single mutation reaches a great many
   * of these — every box in a re-laid-out panel writes its uniforms — and the
   * rebuild is a walk of the whole panel either way.
   *
   * Two things collect the debt, and a panel needs both. A microtask is the
   * right grain for anything that arrives as its own task, which is what a
   * mutation is: signal effects run in batches, so a microtask lands once
   * after the graph has settled and before the next frame can draw. It is the
   * wrong grain for anything that arrives from *inside* a frame callback,
   * because a microtask queued there does not run until that callback — and
   * the `renderer.render` at the end of it — has returned. Two sources do
   * exactly that: the animation clock, which samples a running CSS animation
   * at the top of each frame, and a scroll drag in an immersive session, whose
   * synthetic `scroll` event is dispatched from the same tick. Left to the
   * microtask, a batched box under an animation draws where it was last frame
   * while its unbatched neighbours — an `<img>`, a checkbox tick — draw where
   * it is now, which is the panel shearing along the line between them.
   *
   * So `flush` below runs late in the frame, and this stays as the backstop
   * for portals that have no frames to run late in.
   *
   * Deliberately not tied to a frame beyond that. What a rebuild reads are
   * local matrices, which `place` keeps current at the moment of the write,
   * and uniform values, which are written the same way — never anything the
   * renderer computes — so it is correct whenever it runs, and only its
   * timing decides whether it is also current.
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

  /**
   * Pay off a pending rebuild now, if there is one.
   *
   * Whichever of the two callers gets here first does the work and the other
   * finds nothing to do, which is what keeps this to one rebuild per panel per
   * frame however many times the panel was invalidated.
   *
   * Clearing the flag before the walk rather than after is also what keeps a
   * rebuild out of its own way: an `invalidate()` raised from inside the walk
   * queues a microtask for the next one rather than re-entering this one.
   *
   * @returns {void}
   */
  flush() {
    if (!this.#dirty || this.#disposed) {
      return;
    }
    this.#dirty = false;
    this.rebuild();
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
    const drawn = this.#drawn;
    found.length = 0;
    drawn.clear();
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
        drawn.add(/** @type {THREE.Mesh} */ (object));
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
        bucket = new Bucket(order, this.#container, this.#material);
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
        bucket.write(
          bucket.count,
          box,
          matrices[i],
          /** @type {Record<string, THREE.IUniform>} */ (this.#members.get(box)),
          this.#ranks.get(box) ?? 0,
        );
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
    this.#drawn.clear();
    this.#ranks.clear();
    this.#material.dispose();
  }
}

/**
 * @param {Object3D} container
 * @param {DepthRankBias} [depthRank] The panel's `depthRank` option.
 * @returns {BoxBatch}
 */
export function createBoxBatch(container, depthRank) {
  return new BoxBatch(container, depthRank);
}
