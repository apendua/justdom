import * as THREE from "three";
import { RAMP_WIDTH, rampUniforms } from "./gradient.js";
import { keepProgram } from "./programKeeper.js";

/**
 * @import VisualProperties from './VisualProperties.js';
 * @import {ContentImage} from './image.js';
 * @import {RampSlot} from './gradient.js';
 * @import {ProgramKind} from './programKeeper.js';
 */

/**
 * A CSS box as one quad and a signed-distance shader, replacing the pair of
 * triangulated meshes (border ring + background) an element used to carry.
 *
 * The point is what a change costs. Triangulated geometry had to be rebuilt —
 * retriangulated, re-uploaded — every time a size, radius or border moved,
 * which is exactly what a layout animation does every frame. Here the
 * geometry is a shared unit quad that never changes for anyone; a resize is
 * a scale write, and radii, borders and colors are uniform writes. The
 * fragment shader decides per pixel whether it is in the fill, on the border
 * ring, or outside, with a distance-based edge that antialiases at any
 * scale.
 *
 * Conventions match the portal throughout: local px, origin at the top-left
 * corner, y running down.
 */

/**
 * One unit quad for every box in every portal. Top-left origin, y down —
 * scaled to the element's size by the mesh, so it never changes and is never
 * disposed.
 */
export const rectGeometry = new THREE.BufferGeometry();
rectGeometry.setAttribute(
  "position",
  new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3),
);
rectGeometry.setIndex([0, 1, 2, 2, 1, 3]);
// Texture coordinates, which the rect shader does not read: for a quad that
// shows a picture, a drag's ghost, with the picture's top row at its top.
rectGeometry.setAttribute(
  "uv",
  new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), 2),
);

// Shader strings ship verbatim in bundles — comments and all — so the
// explanations live out here, in comments the minifier strips.
//
// Fragment walkthrough. Everything happens in centered px coords (y still
// down, so p.y < 0 is the top half). The corner radius is picked per
// quadrant — uRadii is (topLeft, topRight, bottomRight, bottomLeft) — and
// clamped so an oversized radius cannot fold the distance field over
// itself. `outer` is the box's rounded-rect SDF; `inner` is the border's
// inner edge: the box inset by each side's width (uBorder is top, right,
// bottom, left), its corners sharpened by the border they sit behind,
// degenerating to square when the border outgrows the radius — the way the
// triangulated ring did.
//
// Every edge in here turns into coverage the same way — `coverageOf`, a
// smoothstep one derivative wide about the zero crossing. The floor on that
// width is not a nicety. A distance to a box has a ridge down its middle
// where the nearest edge changes, and along that ridge `fwidth` reads zero;
// `smoothstep(0.0, 0.0, x)` divides by zero and the driver is entitled to
// answer anything. What it answers is a hairline hole through the middle of
// the box — invisible until something is big enough and square enough to the
// viewer to put a pixel row exactly on the ridge, which is what a picture in
// a panel facing you turned out to be. A floor of a ten-thousandth of a
// pixel is far below anything an edge can be and safely above zero.
//
// Coverage is then *partitioned* between fill and ring, not mixed: with no
// border the two edges coincide, and a mix would shade the antialiased
// fringe with the border color — an opaque currentcolor for "border:
// none" — drawing a hairline that is not there. Partitioning makes a
// zero-width ring exactly nothing. Where the combined alpha vanishes the
// fragment is discarded, writing neither color nor depth: a fully
// transparent fill is not an invisible hole punched through what it
// covers — the rule the material flags used to enforce. The tail includes
// are three's own output transforms, so colors match what the built-in
// materials produce.
//
// Clipping rides on the same machinery, which is the whole reason it lives
// here rather than in a second pass or a stack of clipping planes. What an
// element's overflow-hiding ancestors leave it is another rounded box —
// uClip is its edges in this element's own px, uClipRadii its corners — so
// it is one more call to the same distance function, and its coverage
// simply multiplies the box's. The edge that falls out is antialiased by
// the same fwidth, at any scale and under any transform, and a scroller
// with rounded corners clips its content to them.
//
// An `<img>`'s picture is a third layer on the same quad, for the same
// reason and with the same payoff. CSS paints replaced content over the
// background and under the descendants, which is exactly the slot between
// the two things this shader already draws; putting it here means an avatar
// in a circular box is rounded by the border's own distance field rather
// than by a second mesh trying to agree with it, and an image scrolled out
// of a list is trimmed by the clip box that was going to trim its box
// anyway. Two rectangles say where it goes — uImageRect, where the picture
// itself lands, and uImageClip, the content box that crops it, which are
// different rectangles whenever `object-fit` overflows. Both are in element
// px, both are `object-fit`'s arithmetic already done on the CPU, and the
// composite is ordinary source-over so a translucent PNG shows the
// background through it. uImageOpacity at zero is the whole feature
// switched off, which is what every element that is not an image carries.

// The gradient layer, which CSS paints between the background colour and
// the picture, and so does this. `gradient.js` has done everything that does
// not have to happen per pixel: what arrives is the tile one copy of the
// image fills, a kind, and a few numbers that turn a point in the tile into
// `t`, how far along the gradient it is — one period per unit for a
// repeating gradient, which `fract` then wraps. `t` looks up a row of the
// ramp atlas, which holds the stops already interpolated.
//
// Lanes: `gradient` is (kind, repeating, repeat-x, repeat-y), kind 0 being
// no gradient at all; `ramp` is (row, opacity). A non-repeating axis is
// trimmed to the tile with an edge antialiased the way every other edge here
// is — against the pixel footprint of `q`, taken once, outside any branch,
// because a derivative asked for inside one is undefined. The ramp is read
// with an explicit level for the same reason: a box's kind differs from its
// neighbour's along the seam between them, and it has no mipmaps to choose
// between anyway.
//
// The composite: the layer goes over the background colour, and the
// element's opacity goes over both. The fill colour arrives with the opacity
// already folded in, so it is divided back out first — otherwise a
// half-transparent element with an opaque gradient would show its background
// colour through it.
//
// And it happens in sRGB, not in the linear space the rest of this shader
// works in, because that is where CSS composites one background layer over
// another: a half-transparent blue over white is (127, 127, 255), and done in
// linear it comes out a washed-out (188, 188, 255). So the ramp's texels are
// read as the sRGB bytes they are — the atlas texture declares no colour
// space, and the sampler's filtering between texels is then sRGB
// interpolation too, which is what CSS asks of a gradient — the fill is
// encoded to meet them, and the result decoded back. Only a box with a
// gradient pays for the conversions.

/**
 * The gradient layer, as GLSL: `withGradient` takes the fill colour a box
 * would have drawn and returns it with the layer composited over. Shared by
 * the per-element material and the batched one for the reason `SDF_GLSL`
 * is, and included after it, since it antialiases with `coverageOf`.
 */
export const GRADIENT_GLSL = /* glsl */ `
uniform sampler2D uRamp;
uniform float uRampHeight;
vec3 gradientEncode(vec3 linear) {
  return mix(
    linear * 12.92,
    1.055 * pow(max(linear, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), linear)
  );
}
vec3 gradientDecode(vec3 srgb) {
  return mix(
    srgb / 12.92,
    pow((max(srgb, vec3(0.0)) + 0.055) / 1.055, vec3(2.4)),
    step(vec3(0.04045), srgb)
  );
}
float tileEdge(float q, float start, float size, float footprint) {
  float w = max(footprint, 1e-4);
  return 1.0 - smoothstep(-w, w, abs(q - start - 0.5 * size) - 0.5 * size);
}
vec4 withGradient(vec4 fill, vec2 q, vec4 gradient, vec4 geometry, vec4 tile, vec2 ramp) {
  vec2 footprint = fwidth(q);
  if (gradient.x < 0.5) {
    return fill;
  }
  vec2 size = max(tile.zw, vec2(1e-6));
  vec2 local = q - tile.xy;
  vec2 wrapped = local - size * floor(local / size);
  local = mix(local, wrapped, step(0.5, gradient.zw));
  float coverage =
    mix(tileEdge(q.x, tile.x, tile.z, footprint.x), 1.0, step(0.5, gradient.z)) *
    mix(tileEdge(q.y, tile.y, tile.w, footprint.y), 1.0, step(0.5, gradient.w));
  float t;
  if (gradient.x < 1.5) {
    t = dot(local, geometry.xy) + geometry.z;
  } else if (gradient.x < 2.5) {
    t = length((local - geometry.xy) / geometry.zw);
  } else {
    vec2 d = local - geometry.xy;
    t = fract(atan(d.x, -d.y) * 0.15915494 - geometry.z) * geometry.w;
  }
  t = gradient.y > 0.5 ? fract(t) : clamp(t, 0.0, 1.0);
  vec2 uv = vec2(
    (t * ${(RAMP_WIDTH - 1).toFixed(1)} + 0.5) / ${RAMP_WIDTH.toFixed(1)},
    (ramp.x + 0.5) / uRampHeight
  );
  vec4 layer = textureLod(uRamp, uv, 0.0);
  float over = layer.a * coverage;
  float opacity = ramp.y;
  float under = opacity > 0.0 ? min(fill.a / opacity, 1.0) : 0.0;
  float alpha = over + under * (1.0 - over);
  vec3 color = alpha > 0.0
    ? (layer.rgb * over + gradientEncode(fill.rgb) * under * (1.0 - over)) / alpha
    : vec3(0.0);
  return vec4(gradientDecode(color), alpha * opacity);
}
`;

const vertexShader = /* glsl */ `
varying vec2 vUnit;
void main() {
  vUnit = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * The distance-field maths every box in a portal is drawn with.
 *
 * It lives in a string of its own because there are two materials that have
 * to agree about it exactly: the per-element one below, whose numbers arrive
 * as uniforms, and the batched one in `boxBatch.js`, whose numbers arrive as
 * per-instance attributes. They differ in where the box's description comes
 * from and in nothing else, and a panel draws some of its boxes through each
 * — an `<img>` cannot join a batch, because a picture is a texture binding —
 * so the two must be the same shader with a different front door. Sharing
 * the source is what makes that true by construction rather than by
 * vigilance.
 *
 * `sdfCoverages` is the whole of it: given a box's description it answers how
 * much of this fragment is fill and how much is border ring, already clipped
 * by what the element's overflow-hiding ancestors leave of it. What a caller
 * does with those two numbers — an image composited into the fill, or not —
 * is the part that differs.
 */
export const SDF_GLSL = /* glsl */ `
float sdRoundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
}
float coverageOf(float dist) {
  float w = max(fwidth(dist), 1e-4);
  return 1.0 - smoothstep(-w, w, dist);
}
float boxCoverage(vec2 q, vec4 box) {
  vec2 halfBox = 0.5 * (box.zw - box.xy);
  vec2 d = abs(q - 0.5 * (box.xy + box.zw)) - halfBox;
  return coverageOf(max(d.x, d.y));
}
vec2 sdfCoverages(vec2 unit, vec2 size, vec4 radii, vec4 border, vec4 clip, vec4 clipRadii) {
  vec2 halfSize = 0.5 * size;
  vec2 p = unit * size - halfSize;
  float radius = p.x < 0.0
    ? (p.y < 0.0 ? radii.x : radii.w)
    : (p.y < 0.0 ? radii.y : radii.z);
  radius = min(radius, min(halfSize.x, halfSize.y));
  float outer = sdRoundedBox(p, halfSize, radius);
  vec2 innerHalf = halfSize - 0.5 * vec2(border.w + border.y, border.x + border.z);
  vec2 innerCenter = 0.5 * vec2(border.w - border.y, border.x - border.z);
  float innerRadius = max(radius - max(
    p.x < 0.0 ? border.w : border.y,
    p.y < 0.0 ? border.x : border.z
  ), 0.0);
  float inner = sdRoundedBox(p - innerCenter, max(innerHalf, vec2(0.0)), innerRadius);
  vec2 clipHalf = 0.5 * (clip.zw - clip.xy);
  vec2 clipCenter = 0.5 * (clip.xy + clip.zw) - halfSize;
  float clipRadius = p.x < clipCenter.x
    ? (p.y < clipCenter.y ? clipRadii.x : clipRadii.w)
    : (p.y < clipCenter.y ? clipRadii.y : clipRadii.z);
  clipRadius = min(clipRadius, min(clipHalf.x, clipHalf.y));
  float clipped = sdRoundedBox(p - clipCenter, max(clipHalf, vec2(0.0)), clipRadius);
  float clipCoverage = coverageOf(clipped);
  float coverage = coverageOf(outer) * clipCoverage;
  float fillness = coverageOf(inner) * clipCoverage;
  return vec2(min(fillness, coverage), max(coverage - fillness, 0.0));
}
`;

const fragmentShader = /* glsl */ `
varying vec2 vUnit;
uniform vec2 uSize;
uniform vec4 uRadii;
uniform vec4 uBorder;
uniform vec4 uFillColor;
uniform vec4 uBorderColor;
uniform vec4 uClip;
uniform vec4 uClipRadii;
uniform sampler2D uImage;
uniform vec4 uImageRect;
uniform vec4 uImageClip;
uniform float uImageOpacity;
uniform vec4 uGradient;
uniform vec4 uGradientGeometry;
uniform vec4 uGradientTile;
uniform vec2 uGradientRamp;
${SDF_GLSL}
${GRADIENT_GLSL}
void main() {
  vec2 coverages = sdfCoverages(vUnit, uSize, uRadii, uBorder, uClip, uClipRadii);
  float fillCoverage = coverages.x;
  float borderCoverage = coverages.y;
  vec4 fill = withGradient(
    uFillColor, vUnit * uSize, uGradient, uGradientGeometry, uGradientTile, uGradientRamp
  );
  if (uImageOpacity > 0.0) {
    vec2 q = vUnit * uSize;
    vec2 uv = (q - uImageRect.xy) / max(uImageRect.zw - uImageRect.xy, vec2(1e-6));
    // Textures are uploaded flipped, so v runs up while the portal's y runs
    // down; the clamp is what makes the wrap mode enough to keep a stray
    // fragment from sampling the far edge.
    vec4 texel = texture2D(uImage, clamp(vec2(uv.x, 1.0 - uv.y), 0.0, 1.0));
    float over = texel.a * uImageOpacity *
      boxCoverage(q, uImageRect) * boxCoverage(q, uImageClip);
    float under = fill.a * (1.0 - over);
    float composited = over + under;
    fill = vec4(
      composited > 0.0 ? (texel.rgb * over + fill.rgb * under) / composited : vec3(0.0),
      composited
    );
  }
  float alpha = fill.a * fillCoverage + uBorderColor.a * borderCoverage;
  if (alpha < 0.001) {
    discard;
  }
  vec3 color = (fill.rgb * fill.a * fillCoverage +
                uBorderColor.rgb * uBorderColor.a * borderCoverage) / alpha;
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * A box's numbers, in the shape a shader wants them.
 *
 * Split from the material below because most boxes have no use for a
 * material. Every box in a portal but an `<img>` is drawn by `boxBatch` as
 * one instance among many, and its own mesh is never put in the render list
 * — so what its material carries is these values and nothing else, while
 * what it costs is a `THREE.Material`: a uuid generated as a string, a place
 * in three's bookkeeping, and a `dispose()` at teardown, per box, for a
 * program that is never compiled.
 *
 * @returns {Record<string, THREE.IUniform>}
 */
export function createRectUniforms() {
  return {
    uSize: { value: new THREE.Vector2(1, 1) },
    uRadii: { value: new THREE.Vector4(0, 0, 0, 0) },
    uBorder: { value: new THREE.Vector4(0, 0, 0, 0) },
    uFillColor: { value: new THREE.Vector4(0, 0, 0, 0) },
    uBorderColor: { value: new THREE.Vector4(0, 0, 0, 0) },
    // Nothing clips this box until something says otherwise, and "nothing"
    // has to be a box the element sits well inside of.
    uClip: { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) },
    uClipRadii: { value: new THREE.Vector4(0, 0, 0, 0) },
    // No picture until something loads one. Three binds its own empty
    // texture for a null sampler, so the declaration costs an unused unit
    // and nothing else; the branch above is skipped for every box in the
    // panel at once, which is as coherent as a branch gets.
    uImage: { value: null },
    uImageRect: { value: new THREE.Vector4(0, 0, 0, 0) },
    uImageClip: { value: new THREE.Vector4(0, 0, 0, 0) },
    uImageOpacity: { value: 0 },
    // No gradient until something writes one: kind 0 in `uGradient.x` skips
    // the layer. The ramp texture and its height are the page's, shared by
    // reference with every other box — see `rampUniforms`.
    uGradient: { value: new THREE.Vector4(0, 0, 0, 0) },
    uGradientGeometry: { value: new THREE.Vector4(0, 0, 0, 0) },
    uGradientTile: { value: new THREE.Vector4(0, 0, 1, 1) },
    uGradientRamp: { value: new THREE.Vector2(0, 1) },
    uRamp: rampUniforms.uRamp,
    uRampHeight: rampUniforms.uRampHeight,
  };
}

/**
 * The material drawing one element's box. Per-mesh — its uniforms are the
 * element's own — but the program behind it is compiled once and shared by
 * every box in the scene, and kept linked after the last box of the page
 * goes (`programKeeper.js`). The frame a panel shows while it mounts is one
 * of these, and nothing else holds the program between two mounts.
 *
 * @param {Record<string, THREE.IUniform>} [uniforms]
 * @returns {THREE.ShaderMaterial}
 */
export function createRectMaterial(uniforms = createRectUniforms()) {
  return keepProgram(rectMaterial(uniforms), RECT_PROGRAM);
}

/** @type {ProgramKind<THREE.ShaderMaterial>} */
const RECT_PROGRAM = {
  name: "freedom-rect",
  create: () => rectMaterial(createRectUniforms()),
};

/**
 * @param {Record<string, THREE.IUniform>} uniforms
 * @returns {THREE.ShaderMaterial}
 */
function rectMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    // Two-sided for the same reason every plane in a portal is: the
    // container's flip turns them away from the viewer.
    side: THREE.DoubleSide,
    // And drawn in a single pass, which for a plane is the only pass that
    // means anything. A two-sided transparent material is otherwise drawn
    // twice — back faces, then front — so that a closed shape's far surface
    // composites under its near one. A quad has no far surface: both faces
    // are the same four vertices at the same depth, and the second pass
    // redraws exactly what the first did.
    //
    // What it does not redraw for free is the setup. Three flips
    // `material.needsUpdate` before each of the two passes, and that
    // invalidates the material's program — so every box in the panel
    // recomputes its program key and re-uploads its uniforms twice per
    // frame. In a static panel of 800 boxes that setup, not the duplicate
    // draw call, was the largest single cost in the frame: dropping both
    // took the render from 86ms to 25ms, pixel for pixel identical.
    forceSinglePass: true,
    uniforms,
  });
}

/**
 * The material a batched box wears.
 *
 * One for the page, invisible, and never drawn: `boxBatch` draws these boxes
 * as instances, so every one of them wants exactly the same thing from a
 * material — to be skipped. Three consults `visible` before it puts a mesh
 * in the render list and never compiles a program it does not draw with, so
 * the cost of sharing this is nothing at all, and the cost of not sharing it
 * was one material per box.
 *
 * Deliberately not disposed. It belongs to the module rather than to any
 * panel, and disposing it on one panel's teardown would take the material
 * out from under every other panel on the page.
 *
 * @type {THREE.ShaderMaterial | null}
 */
let batchedMaterial = null;

/**
 * @returns {THREE.ShaderMaterial}
 */
export function batchedBoxMaterial() {
  if (!batchedMaterial) {
    batchedMaterial = rectMaterial(createRectUniforms());
    batchedMaterial.visible = false;
  }
  return batchedMaterial;
}

/**
 * Write the region an element's overflow-hiding ancestors leave it into its
 * rect material, in the element's own px. Another uniform write, on the same
 * terms as the rest: a scroll moves this every frame it is moving.
 *
 * @param {Record<string, THREE.IUniform>} uniforms
 * @param {import('./clip.js').ClipBox} box
 * @returns {void}
 */
export function writeClipUniforms(uniforms, box) {
  const { uClip, uClipRadii } = uniforms;
  uClip.value.set(box.left, box.top, box.right, box.bottom);
  uClipRadii.value.set(box.topLeft, box.topRight, box.bottomRight, box.bottomLeft);
}

/**
 * Write an element's visual properties into its rect material. Values only —
 * nothing is allocated, nothing recompiled — which is what makes this safe
 * to run on every tick of an animation.
 *
 * The corner radii are read in horizontal units; a percentage radius on a
 * decidedly non-square element may differ from the elliptical corner CSS
 * would draw, circular being the one shape one number describes.
 *
 * @param {Record<string, THREE.IUniform>} uniforms
 * @param {VisualProperties} properties
 * @returns {void}
 */
export function writeRectUniforms(uniforms, properties) {
  const { uSize, uRadii, uBorder, uFillColor, uBorderColor } = uniforms;
  uSize.value.set(properties.totalWidth, properties.totalHeight);
  uRadii.value.set(
    properties.borderTopLeftRadius,
    properties.borderTopRightRadius,
    properties.borderBottomRightRadius,
    properties.borderBottomLeftRadius,
  );
  uBorder.value.set(
    properties.borderTopWidth,
    properties.borderRightWidth,
    properties.borderBottomWidth,
    properties.borderLeftWidth,
  );
  const fill = properties.backgroundColor;
  uFillColor.value.set(fill.r, fill.g, fill.b, properties.backgroundAlpha);
  const border = properties.borderColor;
  uBorderColor.value.set(border.r, border.g, border.b, properties.borderAlpha);
}

/**
 * Write the picture an element paints inside its box, or `null` to say it
 * paints none. Values only, like the rest of this file — a texture arriving,
 * a resize and an `object-position` transition all end up here, and none of
 * them recompiles anything.
 *
 * @param {Record<string, THREE.IUniform>} uniforms
 * @param {ContentImage | null} image
 * @returns {void}
 */
export function writeImageUniforms(uniforms, image) {
  const { uImage, uImageRect, uImageClip, uImageOpacity } = uniforms;
  if (!image) {
    // Dropping the reference matters as much as the switch: an element that
    // has let go of its picture must not be the reason its texture stays
    // uploaded.
    uImage.value = null;
    uImageOpacity.value = 0;
    return;
  }
  uImage.value = image.texture;
  uImageRect.value.set(image.left, image.top, image.right, image.bottom);
  const { content } = image;
  uImageClip.value.set(content.left, content.top, content.right, content.bottom);
  uImageOpacity.value = image.opacity;
}

/**
 * Write the gradient an element paints over its background colour, holding
 * the ramp row it needs through `slot`. Values only, like the rest of this
 * file; the one thing that can cost more is a ramp nobody has baked yet,
 * which is a row of texels and an upload of the atlas — once per distinct
 * gradient, not once per write.
 *
 * @param {Record<string, THREE.IUniform>} uniforms
 * @param {VisualProperties} properties
 * @param {RampSlot} slot The box's hold on its ramp row, which it keeps
 *   between writes and lets go of when it is torn down.
 * @returns {void}
 */
export function writeGradientUniforms(uniforms, properties, slot) {
  const { uGradient, uGradientGeometry, uGradientTile, uGradientRamp } = uniforms;
  const layout = properties.backgroundGradient;
  const row = slot.set(layout);
  if (!layout) {
    uGradient.value.set(0, 0, 0, 0);
    return;
  }
  uGradient.value.set(
    layout.kind,
    layout.repeating ? 1 : 0,
    layout.repeatX ? 1 : 0,
    layout.repeatY ? 1 : 0,
  );
  uGradientGeometry.value.fromArray(layout.geometry);
  uGradientTile.value.fromArray(layout.tile);
  uGradientRamp.value.set(row, properties.opacity);
}
