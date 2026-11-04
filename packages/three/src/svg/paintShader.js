import * as THREE from "three";
import { RAMP_WIDTH, rampKeyOf, rampUniforms } from "../elements/gradient.js";
import { GRADIENT_GLSL } from "../elements/sdfRect.js";
import { IDENTITY, invert, multiply } from "./geometry.js";
import { SPREAD_PAD } from "./paintServer.js";

/**
 * Drawing a gradient on an SVG shape's mesh: a patch on its material that
 * evaluates the gradient per pixel, from the shape's own user space.
 *
 * The fill and stroke geometry are built in user space (`buildFillGeometry`,
 * `buildStrokeGeometry`), so a vertex's position is the point the gradient
 * is evaluated at. One matrix takes it into gradient space, folding in the
 * bounding box for `objectBoundingBox` and the inverse `gradientTransform`.
 * There the fragment finds how far along the gradient it is, carries that
 * past the ends by the spread method, and reads the colour from the ramp
 * atlas the CSS boxes bake their stops into (`rampUniforms`).
 *
 * Every shape mesh carries the patch, a flat colour as much as a gradient,
 * so that a paint that changes between the two writes uniforms and never
 * compiles a second program. For a flat colour the fragment skips the
 * patch on one uniform.
 */

/** @typedef {import('./geometry.js').Matrix2D} Matrix2D */
/** @typedef {import('./paintServer.js').GradientServer} GradientServer */
/** @typedef {import('../elements/gradient.js').RampSlot} RampSlot */

const PAINT_FLAT = 0;
const PAINT_LINEAR = 1;
const PAINT_RADIAL = 2;

/**
 * A box as the shape's fill bounding box is given: a corner and a size, in
 * user units.
 *
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 */

/**
 * The uniforms of one mesh's paint.
 *
 * @typedef {ReturnType<typeof createPaintUniforms>} PaintUniforms
 */

/**
 * @returns {{
 *   paintKind: { value: number },
 *   paintSpread: { value: number },
 *   paintMatrix: { value: THREE.Matrix3 },
 *   paintGeometry: { value: THREE.Vector4 },
 *   paintFocus: { value: THREE.Vector4 },
 *   paintRamp: { value: number },
 * }}
 */
export function createPaintUniforms() {
  return {
    paintKind: { value: PAINT_FLAT },
    paintSpread: { value: SPREAD_PAD },
    paintMatrix: { value: new THREE.Matrix3() },
    // Linear: x1, y1, x2, y2. Radial: cx, cy, r, unused.
    paintGeometry: { value: new THREE.Vector4() },
    // Radial: fx, fy, fr, unused.
    paintFocus: { value: new THREE.Vector4() },
    paintRamp: { value: 0 },
  };
}

/** The program cache key a patched material adds to its own. */
const CACHE_KEY = "svg-paint";

/**
 * Install the patch on a material that already carries its clip patch
 * (`applyClip`), after it, so both run.
 *
 * @param {THREE.Material} material
 * @param {PaintUniforms} uniforms
 * @returns {void}
 */
export function applyPaint(material, uniforms) {
  const clip = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  /**
   * @this {THREE.Material}
   * @param {import('three').WebGLProgramParametersWithUniforms} shader
   * @param {THREE.WebGLRenderer} renderer
   */
  material.onBeforeCompile = function (shader, renderer) {
    clip.call(this, shader, renderer);
    patchPaint(shader, uniforms);
  };
  material.customProgramCacheKey = () => `${key}+${CACHE_KEY}`;
}

/**
 * @param {import('three').WebGLProgramParametersWithUniforms} shader
 * @param {PaintUniforms} uniforms
 * @returns {void}
 */
function patchPaint(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms, rampUniforms);
  shader.vertexShader = shader.vertexShader
    .replace("void main() {", "varying vec2 vPaintPosition;\nvoid main() {")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvPaintPosition = position.xy;");
  shader.fragmentShader = shader.fragmentShader
    .replace("void main() {", `${GRADIENT_GLSL}\n${PAINT_GLSL}\nvoid main() {`)
    .replace(
      "#include <color_fragment>",
      "#include <color_fragment>\n\tif (paintKind > 0.5) diffuseColor *= paintColor(vPaintPosition);",
    );
}

const PAINT_GLSL = /* glsl */ `
uniform float paintKind;
uniform float paintSpread;
uniform mat3 paintMatrix;
uniform vec4 paintGeometry;
uniform vec4 paintFocus;
uniform float paintRamp;
varying vec2 vPaintPosition;
// How far along the gradient a point of gradient space is, or a negative
// number where a radial gradient's cone does not reach.
float paintOffset(vec2 g) {
  if (paintKind < 1.5) {
    vec2 d = paintGeometry.zw - paintGeometry.xy;
    return dot(g - paintGeometry.xy, d) / max(dot(d, d), 1e-12);
  }
  // The two-circle cone from the focal circle (f, fr) to the end circle
  // (c, r): the largest s whose circle passes through g with a radius that
  // is not negative.
  vec2 f = paintFocus.xy;
  float fr = paintFocus.z;
  vec2 cd = paintGeometry.xy - f;
  float dr = paintGeometry.z - fr;
  vec2 pd = g - f;
  float a = dot(cd, cd) - dr * dr;
  float b = dot(pd, cd) + fr * dr;
  float c = dot(pd, pd) - fr * fr;
  if (abs(a) < 1e-9) {
    if (abs(b) < 1e-12) {
      return -1e9;
    }
    float s = c / (2.0 * b);
    return fr + s * dr >= 0.0 ? s : -1e9;
  }
  float disc = b * b - a * c;
  if (disc < 0.0) {
    return -1e9;
  }
  float root = sqrt(disc);
  float s1 = (b + root) / a;
  float s2 = (b - root) / a;
  float hi = max(s1, s2);
  float lo = min(s1, s2);
  if (fr + hi * dr >= 0.0) {
    return hi;
  }
  return fr + lo * dr >= 0.0 ? lo : -1e9;
}
vec4 paintColor(vec2 position) {
  vec2 g = (paintMatrix * vec3(position, 1.0)).xy;
  float t = paintOffset(g);
  if (t < -1e8) {
    return vec4(0.0);
  }
  if (paintSpread > 1.5) {
    t = fract(t);
  } else if (paintSpread > 0.5) {
    t = 1.0 - abs(mod(t, 2.0) - 1.0);
  } else {
    t = clamp(t, 0.0, 1.0);
  }
  vec2 uv = vec2(
    (t * ${(RAMP_WIDTH - 1).toFixed(1)} + 0.5) / ${RAMP_WIDTH.toFixed(1)},
    (paintRamp + 0.5) / uRampHeight
  );
  vec4 texel = textureLod(uRamp, uv, 0.0);
  return vec4(gradientDecode(texel.rgb), texel.a);
}
`;

/**
 * The matrix from the shape's user space to `gradient`'s own space, or null
 * for a gradient that draws nothing on this shape: an `objectBoundingBox`
 * one over a box with no width or no height, as SVG says, or one whose
 * `gradientTransform` cannot be inverted.
 *
 * @param {GradientServer} gradient
 * @param {() => Box | null} box The shape's fill bounding box, read only
 *   for an `objectBoundingBox` gradient.
 * @returns {Matrix2D | null}
 */
export function toGradientSpace(gradient, box) {
  /** @type {Matrix2D} */
  let matrix = IDENTITY;
  if (gradient.objectBox) {
    const bounds = box();
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) {
      return null;
    }
    const { x, y, width, height } = bounds;
    matrix = [1 / width, 0, 0, 1 / height, -x / width, -y / height];
  }
  if (gradient.transform) {
    const inverse = invert(gradient.transform);
    if (!inverse) {
      return null;
    }
    matrix = multiply(inverse, matrix);
  }
  return matrix;
}

/**
 * Write a mesh's paint uniforms: `gradient` through `matrix`, the one
 * `toGradientSpace` gave for this shape, or a flat colour when either is
 * null.
 *
 * @param {PaintUniforms} uniforms
 * @param {GradientServer | null} gradient
 * @param {Matrix2D | null} matrix
 * @param {RampSlot} slot The mesh's hold on its ramp row.
 * @returns {void}
 */
export function writePaint(uniforms, gradient, matrix, slot) {
  if (!gradient || !matrix) {
    uniforms.paintKind.value = PAINT_FLAT;
    slot.release();
    return;
  }
  const [a, b, c, d, e, f] = matrix;
  uniforms.paintMatrix.value.set(a, c, e, b, d, f, 0, 0, 1);
  uniforms.paintKind.value = gradient.kind === "linear" ? PAINT_LINEAR : PAINT_RADIAL;
  uniforms.paintSpread.value = gradient.spread;
  const coords = gradient.coords;
  if (gradient.kind === "linear") {
    uniforms.paintGeometry.value.set(coords[0], coords[1], coords[2], coords[3]);
  } else {
    uniforms.paintGeometry.value.set(coords[0], coords[1], coords[2], 0);
    uniforms.paintFocus.value.set(coords[3], coords[4], coords[5], 0);
  }
  uniforms.paintRamp.value = slot.set({ rampKey: rampKeyOf(gradient.ramp), ramp: gradient.ramp });
}
