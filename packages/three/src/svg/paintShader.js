import * as THREE from "three";
import { RAMP_WIDTH, rampKeyOf, rampUniforms } from "../elements/paint/gradient.js";
import { GRADIENT_GLSL } from "../elements/paint/sdfRect.js";
import { IDENTITY, invert, multiply } from "./geometry.js";
import { SPREAD_PAD } from "./paintServer.js";

/**
 * Drawing a gradient or a pattern on an SVG shape's mesh: a patch on its
 * material that evaluates the paint per pixel, from the shape's own user
 * space.
 *
 * The fill and stroke geometry are built in user space (`buildFillGeometry`,
 * `buildStrokeGeometry`), so a vertex's position is the point the gradient
 * is evaluated at. One matrix takes it into gradient space, folding in the
 * bounding box for `objectBoundingBox` and the inverse `gradientTransform`.
 * There the fragment finds how far along the gradient it is, carries that
 * past the ends by the spread method, and reads the colour from the ramp
 * atlas the CSS boxes bake their stops into (`rampUniforms`). A pattern's
 * matrix takes the position into tile space instead, where one tile spans
 * 0 to 1, and the fragment samples the tile's picture there
 * (`svg/patternTile.js`).
 *
 * Only a region painted by a server carries the patch. A region in a flat
 * colour has a plain clipped material, and a paint that crosses between a
 * flat colour and a server remounts the region's mesh with a new material
 * (`paintRoute` in `svg/shape.js`), which compiles the other program. A
 * flat colour still goes through the patch in two places, a pattern
 * drawing its fallback colour and a server that draws nothing on the
 * shape (`writePaint`), and there the fragment skips the patch on one
 * uniform.
 */

/** @typedef {import('./geometry.js').Matrix2D} Matrix2D */
/** @typedef {import('./paintServer.js').GradientServer} GradientServer */
/** @typedef {import('../elements/paint/gradient.js').RampSlot} RampSlot */

const PAINT_FLAT = 0;
const PAINT_LINEAR = 1;
const PAINT_RADIAL = 2;
const PAINT_PATTERN = 3;

/**
 * What one region draws, as the shape has worked it out: a flat colour, a
 * gradient through the matrix into its space (`toGradientSpace`), or a
 * pattern's tile through the matrix into tile space (`patternLayout`).
 *
 * @typedef {{ kind: "color", paint: import('./style.js').Paint }
 *   | { kind: "gradient", gradient: GradientServer, matrix: Matrix2D }
 *   | { kind: "pattern", texture: THREE.Texture, matrix: Matrix2D }} PaintDraw
 */

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
 *   paintTile: { value: THREE.Texture | null },
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
    // A pattern's tile. Null, which three binds as its empty texture, for
    // any other paint.
    paintTile: { value: null },
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
uniform sampler2D paintTile;
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
  if (paintKind > 2.5) {
    // One tile spans 0 to 1. Wrapped here rather than by the texture, which
    // the image cache shares and clamps; the derivatives of the unwrapped
    // position pick the mip level, so the seam does not jump to the
    // smallest one. The picture is uploaded flipped, its top row at v = 1.
    vec2 tile = fract(g);
    return textureGrad(paintTile, vec2(tile.x, 1.0 - tile.y), dFdx(g), dFdy(g));
  }
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
 * Write a mesh's paint uniforms for what it draws: a gradient or a pattern
 * through its matrix, or the flat colour the material carries for anything
 * else. A gradient holds its ramp row through `slot`; anything else gives
 * the row back.
 *
 * @param {PaintUniforms} uniforms
 * @param {PaintDraw | null} draw
 * @param {RampSlot} slot The mesh's hold on its ramp row.
 * @returns {void}
 */
export function writePaint(uniforms, draw, slot) {
  if (draw?.kind !== "pattern") {
    uniforms.paintTile.value = null;
  }
  if (draw?.kind !== "gradient") {
    slot.release();
  }
  if (!draw || draw.kind === "color") {
    uniforms.paintKind.value = PAINT_FLAT;
    return;
  }
  const [a, b, c, d, e, f] = draw.matrix;
  uniforms.paintMatrix.value.set(a, c, e, b, d, f, 0, 0, 1);
  if (draw.kind === "pattern") {
    uniforms.paintKind.value = PAINT_PATTERN;
    uniforms.paintTile.value = draw.texture;
    return;
  }
  const { gradient } = draw;
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
