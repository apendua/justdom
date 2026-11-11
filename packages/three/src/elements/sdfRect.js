import * as THREE from "three";
import {
  createHalfPlaneUniforms,
  HALF_PLANES_FRAGMENT_GLSL,
  HALF_PLANES_VERTEX_GLSL,
  passHalfPlaneWorld,
} from "./halfPlanes.js";
import { RAMP_WIDTH, rampUniforms } from "./gradient.js";
import { keepProgram } from "./programKeeper.js";
import { MAX_BOX_SHADOWS } from "./shadows.js";

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
// switched off, which is what every element without a picture carries.
//
// A box's `background-image: url()` is the same layer, laid out by the
// background's own properties: uImageRect is one tile, uImageClip the
// padding box, and uImageMode says which axes the tile repeats along (a
// repeating axis samples the picture's wrapped coordinate and is bounded by
// the clip alone) and whether the gradient is listed above the picture, in
// which case the picture goes under the gradient rather than over it.

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
// trimmed to the tile, whole up to its edge and faded outside it, as a
// picture is (`pictureCoverage`): the tile's edge is often the padding box's,
// which the fill's coverage already fades. The fade is measured against the
// pixel footprint of `q`, taken once, outside any branch, because a
// derivative asked for inside one is undefined. The ramp is read
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
  return 1.0 - smoothstep(0.0, 2.0 * w, abs(q - start - 0.5 * size) - 0.5 * size);
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
${HALF_PLANES_VERTEX_GLSL}
varying vec2 vUnit;
void main() {
  vUnit = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${passHalfPlaneWorld("modelMatrix * vec4(position, 1.0)")}
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
// How much of a fragment a picture covers, by the box it is cut to: whole up
// to the box's edge and faded outside it, rather than faded across it as an
// edge of the box itself is. The picture is cut to the content box, whose
// edge is often the inner edge of the border, and that edge is already faded
// once, by the fill's own coverage. Faded twice, the two half coverages there
// leave a quarter of the fragment to the page behind: a light line between a
// picture and its border.
float pictureCoverage(vec2 q, vec4 box) {
  vec2 halfBox = 0.5 * (box.zw - box.xy);
  vec2 d = abs(q - 0.5 * (box.xy + box.zw)) - halfBox;
  float dist = max(d.x, d.y);
  float w = max(fwidth(dist), 1e-4);
  return 1.0 - smoothstep(0.0, 2.0 * w, dist);
}
float clipCoverageOf(vec2 p, vec2 halfSize, vec4 clip, vec4 clipRadii) {
  vec2 clipHalf = 0.5 * (clip.zw - clip.xy);
  vec2 clipCenter = 0.5 * (clip.xy + clip.zw) - halfSize;
  float clipRadius = p.x < clipCenter.x
    ? (p.y < clipCenter.y ? clipRadii.x : clipRadii.w)
    : (p.y < clipCenter.y ? clipRadii.y : clipRadii.z);
  clipRadius = min(clipRadius, min(clipHalf.x, clipHalf.y));
  return coverageOf(sdRoundedBox(p - clipCenter, max(clipHalf, vec2(0.0)), clipRadius));
}
float cornerRadius(vec2 p, vec2 halfSize, vec4 radii) {
  float radius = p.x < 0.0
    ? (p.y < 0.0 ? radii.x : radii.w)
    : (p.y < 0.0 ? radii.y : radii.z);
  return min(radius, min(halfSize.x, halfSize.y));
}
// The radius of the padding box's corner nearest p: the border box's, less
// the wider of the two borders that meet there.
float paddingRadius(vec2 p, vec2 halfSize, vec4 radii, vec4 border) {
  return max(cornerRadius(p, halfSize, radii) - max(
    p.x < 0.0 ? border.w : border.y,
    p.y < 0.0 ? border.x : border.z
  ), 0.0);
}
// A radius grown or shrunk by d, as CSS grows a corner for an outline or a
// shadow's spread: a square corner stays square.
float grownRadius(float radius, float d, vec2 halfSize) {
  return radius > 0.0 ? clamp(radius + d, 0.0, min(halfSize.x, halfSize.y)) : 0.0;
}
vec2 shadowErf(vec2 x) {
  vec2 s = sign(x);
  vec2 a = abs(x);
  x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  x *= x;
  return s - s / (x * x);
}
// One row of a rounded box blurred by a Gaussian: exact across, through erf.
float blurredRow(float x, float y, float sigma, float corner, vec2 halfSize) {
  float delta = min(halfSize.y - corner - abs(y), 0.0);
  float curved = halfSize.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
  vec2 integral = 0.5 + 0.5 * shadowErf((x + vec2(-curved, curved)) * (0.70710678 / sigma));
  return integral.y - integral.x;
}
// How much of a rounded box centred on the origin covers p once blurred by a
// Gaussian of sigma: exact across, and sampled down at four rows within
// three sigmas. A sigma under a quarter of a pixel is no blur, and the box
// is as sharp as a border.
float blurredBox(vec2 p, vec2 halfSize, float corner, float sigma) {
  if (sigma < 0.25) {
    return coverageOf(sdRoundedBox(p, halfSize, corner));
  }
  float start = clamp(-3.0 * sigma, p.y - halfSize.y, p.y + halfSize.y);
  float end = clamp(3.0 * sigma, p.y - halfSize.y, p.y + halfSize.y);
  float step = (end - start) / 4.0;
  float y = start + 0.5 * step;
  float value = 0.0;
  for (int i = 0; i < 4; i++) {
    float weight = exp(-(y * y) / (2.0 * sigma * sigma)) / (2.5066283 * sigma);
    value += blurredRow(p.x, p.y - y, sigma, corner, halfSize) * weight * step;
    y += step;
  }
  return value;
}
// An outer shadow, shadow being (x, y, blur, spread): the border box moved
// by the offset, grown by the spread and blurred by half the blur as sigma,
// and cut out where the box itself is.
float outerShadowCoverage(vec2 unit, vec2 size, vec4 radii, vec4 shadow, vec4 clip, vec4 clipRadii) {
  vec2 halfSize = 0.5 * size;
  vec2 p = unit * size - halfSize;
  vec2 q = p - shadow.xy;
  vec2 shadowHalf = max(halfSize + shadow.w, vec2(0.0));
  float corner = grownRadius(cornerRadius(q, halfSize, radii), shadow.w, shadowHalf);
  float shape = blurredBox(q, shadowHalf, corner, 0.5 * shadow.z);
  float own = coverageOf(sdRoundedBox(p, halfSize, cornerRadius(p, halfSize, radii)));
  return shape * (1.0 - own) * clipCoverageOf(p, halfSize, clip, clipRadii);
}
// An inset shadow: the padding box, less the padding box moved by the
// offset, shrunk by the spread and blurred.
float insetShadowCoverage(
  vec2 unit, vec2 size, vec4 radii, vec4 border, vec4 shadow, vec4 clip, vec4 clipRadii
) {
  vec2 halfSize = 0.5 * size;
  vec2 p = unit * size - halfSize;
  vec2 paddingHalf = max(halfSize - 0.5 * vec2(border.w + border.y, border.x + border.z), vec2(0.0));
  vec2 paddingCenter = 0.5 * vec2(border.w - border.y, border.x - border.z);
  vec2 r = p - paddingCenter;
  float padding = coverageOf(sdRoundedBox(r, paddingHalf, paddingRadius(p, halfSize, radii, border)));
  vec2 q = r - shadow.xy;
  vec2 holeHalf = max(paddingHalf - shadow.w, vec2(0.0));
  float corner = grownRadius(paddingRadius(q, halfSize, radii, border), -shadow.w, holeHalf);
  float hole = blurredBox(q, holeHalf, corner, 0.5 * shadow.z);
  return padding * (1.0 - hole) * clipCoverageOf(p, halfSize, clip, clipRadii);
}
float ringCoverage(vec2 unit, vec2 size, vec4 radii, float width, float offset, vec4 clip, vec4 clipRadii) {
  vec2 halfSize = 0.5 * size;
  vec2 p = unit * size - halfSize;
  float radius = cornerRadius(p, halfSize, radii);
  vec2 innerHalf = max(halfSize + offset, vec2(0.0));
  vec2 outerHalf = max(halfSize + offset + width, vec2(0.0));
  float innerRadius = grownRadius(radius, offset, innerHalf);
  float outerRadius = grownRadius(radius, offset + width, outerHalf);
  float ring = coverageOf(sdRoundedBox(p, outerHalf, outerRadius)) *
               (1.0 - coverageOf(sdRoundedBox(p, innerHalf, innerRadius)));
  return ring * clipCoverageOf(p, halfSize, clip, clipRadii);
}
vec2 sdfCoverages(vec2 unit, vec2 size, vec4 radii, vec4 border, vec4 clip, vec4 clipRadii) {
  vec2 halfSize = 0.5 * size;
  vec2 p = unit * size - halfSize;
  float radius = cornerRadius(p, halfSize, radii);
  float outer = sdRoundedBox(p, halfSize, radius);
  vec2 innerHalf = halfSize - 0.5 * vec2(border.w + border.y, border.x + border.z);
  vec2 innerCenter = 0.5 * vec2(border.w - border.y, border.x - border.z);
  float innerRadius = paddingRadius(p, halfSize, radii, border);
  float inner = sdRoundedBox(p - innerCenter, max(innerHalf, vec2(0.0)), innerRadius);
  float clipCoverage = clipCoverageOf(p, halfSize, clip, clipRadii);
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
uniform vec3 uImageMode;
uniform vec4 uGradient;
uniform vec4 uGradientGeometry;
uniform vec4 uGradientTile;
uniform vec2 uGradientRamp;
${HALF_PLANES_FRAGMENT_GLSL}
${SDF_GLSL}
${GRADIENT_GLSL}
// \`qdx\` and \`qdy\` are the footprint of \`q\`, taken in \`main\`, outside the
// branches this is called from, since a derivative taken in a branch is
// undefined.
vec4 withPicture(vec4 fill, vec2 q, vec2 qdx, vec2 qdy) {
  // An axis that repeats tiles the clip box with copies of the picture, so it
  // is bounded by the clip box alone and samples the picture's own wrapped
  // coordinate; one that does not is bounded by where the picture lands.
  vec4 bounds = vec4(
    mix(uImageRect.xy, uImageClip.xy, uImageMode.xy),
    mix(uImageRect.zw, uImageClip.zw, uImageMode.xy)
  );
  vec2 imageSize = max(uImageRect.zw - uImageRect.xy, vec2(1e-6));
  vec2 unwrapped = (q - uImageRect.xy) / imageSize;
  vec2 uv = mix(unwrapped, fract(unwrapped), uImageMode.xy);
  // The level of detail is taken from the unwrapped coordinate. Where
  // \`fract\` wraps, the wrapped one jumps by a whole tile between two
  // neighbouring fragments, and a sampler that measured that jump would
  // read the picture's smallest mipmap there: a line of its average colour
  // along every seam between the tiles.
  vec2 dx = qdx / imageSize;
  vec2 dy = qdy / imageSize;
  // Textures are uploaded flipped, so v runs up while the portal's y runs
  // down; the clamp is what makes the wrap mode enough to keep a stray
  // fragment from sampling the far edge.
  vec4 texel = textureGrad(
    uImage,
    clamp(vec2(uv.x, 1.0 - uv.y), 0.0, 1.0),
    vec2(dx.x, -dx.y),
    vec2(dy.x, -dy.y)
  );
  float over = texel.a * uImageOpacity * pictureCoverage(q, bounds) * pictureCoverage(q, uImageClip);
  float under = fill.a * (1.0 - over);
  float composited = over + under;
  return vec4(
    composited > 0.0 ? (texel.rgb * over + fill.rgb * under) / composited : vec3(0.0),
    composited
  );
}
void main() {
  clipHalfPlanes();
  vec2 coverages = sdfCoverages(vUnit, uSize, uRadii, uBorder, uClip, uClipRadii);
  float fillCoverage = coverages.x;
  float borderCoverage = coverages.y;
  vec2 q = vUnit * uSize;
  vec2 qdx = dFdx(q);
  vec2 qdy = dFdy(q);
  // A background lists its picture under its gradient (uImageMode.z) or
  // over it; an <img>'s picture is always over both.
  bool pictureUnder = uImageOpacity > 0.0 && uImageMode.z > 0.5;
  vec4 fill = pictureUnder ? withPicture(uFillColor, q, qdx, qdy) : uFillColor;
  fill = withGradient(
    fill, q, uGradient, uGradientGeometry, uGradientTile, uGradientRamp
  );
  if (uImageOpacity > 0.0 && !pictureUnder) {
    fill = withPicture(fill, q, qdx, qdy);
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
    // The outline: its width and offset in px, and its colour with the
    // element's opacity in the alpha. Read by the panel's one batch alone,
    // which draws the ring as an instance of its own (`paintBatch.js`); a
    // box that draws itself draws none.
    uOutline: { value: new THREE.Vector2(0, 0) },
    uOutlineColor: { value: new THREE.Vector4(0, 0, 0, 0) },
    // The `box-shadow`, topmost layer first: how many layers there are, and
    // per layer its offsets, blur and spread in px, its colour with the
    // element's opacity in the alpha, and 1 for an inset one. Read by the
    // batch alone, as the outline is.
    uShadowCount: { value: 0 },
    uShadows: { value: Array.from({ length: MAX_BOX_SHADOWS }, () => new THREE.Vector4()) },
    uShadowColors: {
      value: Array.from({ length: MAX_BOX_SHADOWS }, () => new THREE.Vector4()),
    },
    uShadowInset: { value: new Array(MAX_BOX_SHADOWS).fill(0) },
    // No picture until something loads one. Three binds its own empty
    // texture for a null sampler, so the declaration costs an unused unit
    // and nothing else; the branch above is skipped for every box in the
    // panel at once, which is as coherent as a branch gets.
    uImage: { value: null },
    uImageRect: { value: new THREE.Vector4(0, 0, 0, 0) },
    uImageClip: { value: new THREE.Vector4(0, 0, 0, 0) },
    uImageOpacity: { value: 0 },
    // Repeat across, repeat down, and under the gradient: all off for an
    // `<img>`, whose picture lands once, over the background.
    uImageMode: { value: new THREE.Vector3(0, 0, 0) },
    // No gradient until something writes one: kind 0 in `uGradient.x` skips
    // the layer. The ramp texture and its height are the page's, shared by
    // reference with every other box — see `rampUniforms`.
    uGradient: { value: new THREE.Vector4(0, 0, 0, 0) },
    uGradientGeometry: { value: new THREE.Vector4(0, 0, 0, 0) },
    uGradientTile: { value: new THREE.Vector4(0, 0, 1, 1) },
    uGradientRamp: { value: new THREE.Vector2(0, 1) },
    uRamp: rampUniforms.uRamp,
    uRampHeight: rampUniforms.uRampHeight,
    // Which piece of its layer the box is drawn as, in a panel drawn in
    // paint order (`halfPlanes.js`).
    ...createHalfPlaneUniforms(),
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
 * Set a vector to these components, and say whether that changed it.
 *
 * @param {THREE.Vector2} v
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function set2(v, x, y) {
  if (v.x === x && v.y === y) {
    return false;
  }
  v.set(x, y);
  return true;
}

/**
 * @param {THREE.Vector3} v
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {boolean}
 */
function set3(v, x, y, z) {
  if (v.x === x && v.y === y && v.z === z) {
    return false;
  }
  v.set(x, y, z);
  return true;
}

/**
 * @param {THREE.Vector4} v
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} w
 * @returns {boolean}
 */
function set4(v, x, y, z, w) {
  if (v.x === x && v.y === y && v.z === z && v.w === w) {
    return false;
  }
  v.set(x, y, z, w);
  return true;
}

/**
 * Set a uniform's value, and say whether that changed it.
 *
 * @template T
 * @param {{ value: T }} uniform
 * @param {T} value
 * @returns {boolean}
 */
function setValue(uniform, value) {
  if (uniform.value === value) {
    return false;
  }
  uniform.value = value;
  return true;
}

/**
 * Write the region an element's overflow-hiding ancestors leave it into its
 * rect material, in the element's own px. Another uniform write, on the same
 * terms as the rest: a scroll moves this every frame it is moving.
 *
 * Like every writer here, it says whether it changed anything, so that a box
 * can tell the batch only then (`BoxNumbers`).
 *
 * @param {Record<string, THREE.IUniform>} uniforms
 * @param {import('./clip.js').ClipBox} box
 * @returns {boolean}
 */
export function writeClipUniforms(uniforms, box) {
  const { uClip, uClipRadii } = uniforms;
  const clip = set4(uClip.value, box.left, box.top, box.right, box.bottom);
  const radii = set4(uClipRadii.value, box.topLeft, box.topRight, box.bottomRight, box.bottomLeft);
  return clip || radii;
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
 * @returns {boolean} Whether any value changed.
 */
export function writeRectUniforms(uniforms, properties) {
  const { uSize, uRadii, uBorder, uFillColor, uBorderColor } = uniforms;
  let changed = set2(uSize.value, properties.totalWidth, properties.totalHeight);
  changed =
    set4(
      uRadii.value,
      properties.borderTopLeftRadius,
      properties.borderTopRightRadius,
      properties.borderBottomRightRadius,
      properties.borderBottomLeftRadius,
    ) || changed;
  changed =
    set4(
      uBorder.value,
      properties.borderTopWidth,
      properties.borderRightWidth,
      properties.borderBottomWidth,
      properties.borderLeftWidth,
    ) || changed;
  const fill = properties.backgroundColor;
  changed = set4(uFillColor.value, fill.r, fill.g, fill.b, properties.backgroundAlpha) || changed;
  const border = properties.borderColor;
  changed =
    set4(uBorderColor.value, border.r, border.g, border.b, properties.borderAlpha) || changed;
  const width = properties.outlineWidth;
  changed =
    set2(uniforms.uOutline.value, width, width > 0 ? properties.outlineOffset : 0) || changed;
  if (width > 0) {
    const outline = properties.outlineColor;
    changed =
      set4(
        uniforms.uOutlineColor.value,
        outline.r,
        outline.g,
        outline.b,
        properties.outlineAlpha,
      ) || changed;
  }
  const shadows = properties.boxShadows;
  changed = setValue(uniforms.uShadowCount, shadows.length) || changed;
  for (let i = 0; i < shadows.length; i++) {
    const { color, alpha, x, y, blur, spread, inset } = shadows[i];
    changed = set4(uniforms.uShadows.value[i], x, y, blur, spread) || changed;
    changed = set4(uniforms.uShadowColors.value[i], color.r, color.g, color.b, alpha) || changed;
    const flag = inset ? 1 : 0;
    if (uniforms.uShadowInset.value[i] !== flag) {
      uniforms.uShadowInset.value[i] = flag;
      changed = true;
    }
  }
  return changed;
}

/**
 * Write the picture an element paints inside its box, or `null` to say it
 * paints none. Values only, like the rest of this file — a texture arriving,
 * a resize and an `object-position` transition all end up here, and none of
 * them recompiles anything.
 *
 * @param {Record<string, THREE.IUniform>} uniforms
 * @param {ContentImage | null} image
 * @returns {boolean} Whether any value changed.
 */
export function writeImageUniforms(uniforms, image) {
  const { uImage, uImageRect, uImageClip, uImageOpacity } = uniforms;
  if (!image) {
    // Dropping the reference matters as much as the switch: an element that
    // has let go of its picture must not be the reason its texture stays
    // uploaded.
    const texture = setValue(uImage, null);
    return setValue(uImageOpacity, 0) || texture;
  }
  let changed = setValue(uImage, image.texture);
  changed = set4(uImageRect.value, image.left, image.top, image.right, image.bottom) || changed;
  const { content } = image;
  changed =
    set4(uImageClip.value, content.left, content.top, content.right, content.bottom) || changed;
  changed = setValue(uImageOpacity, image.opacity) || changed;
  changed =
    set3(
      uniforms.uImageMode.value,
      image.repeatX ? 1 : 0,
      image.repeatY ? 1 : 0,
      image.underGradient ? 1 : 0,
    ) || changed;
  return changed;
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
 * @returns {boolean} Whether any value changed.
 */
export function writeGradientUniforms(uniforms, properties, slot) {
  const { uGradient, uGradientGeometry, uGradientTile, uGradientRamp } = uniforms;
  const layout = properties.backgroundGradient;
  const row = slot.set(layout);
  if (!layout) {
    return set4(uGradient.value, 0, 0, 0, 0);
  }
  let changed = set4(
    uGradient.value,
    layout.kind,
    layout.repeating ? 1 : 0,
    layout.repeatX ? 1 : 0,
    layout.repeatY ? 1 : 0,
  );
  const { geometry, tile } = layout;
  changed =
    set4(uGradientGeometry.value, geometry[0], geometry[1], geometry[2], geometry[3]) || changed;
  changed = set4(uGradientTile.value, tile[0], tile[1], tile[2], tile[3]) || changed;
  changed = set2(uGradientRamp.value, row, properties.opacity) || changed;
  return changed;
}
