import * as THREE from "three";

/**
 * @import VisualProperties from './VisualProperties.js';
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
const vertexShader = /* glsl */ `
varying vec2 vUnit;
void main() {
  vUnit = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
varying vec2 vUnit;
uniform vec2 uSize;
uniform vec4 uRadii;
uniform vec4 uBorder;
uniform vec4 uFillColor;
uniform vec4 uBorderColor;
float sdRoundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
}
void main() {
  vec2 halfSize = 0.5 * uSize;
  vec2 p = vUnit * uSize - halfSize;
  float radius = p.x < 0.0
    ? (p.y < 0.0 ? uRadii.x : uRadii.w)
    : (p.y < 0.0 ? uRadii.y : uRadii.z);
  radius = min(radius, min(halfSize.x, halfSize.y));
  float outer = sdRoundedBox(p, halfSize, radius);
  vec2 innerHalf = halfSize - 0.5 * vec2(uBorder.w + uBorder.y, uBorder.x + uBorder.z);
  vec2 innerCenter = 0.5 * vec2(uBorder.w - uBorder.y, uBorder.x - uBorder.z);
  float innerRadius = max(radius - max(
    p.x < 0.0 ? uBorder.w : uBorder.y,
    p.y < 0.0 ? uBorder.x : uBorder.z
  ), 0.0);
  float inner = sdRoundedBox(p - innerCenter, max(innerHalf, vec2(0.0)), innerRadius);
  float coverage = 1.0 - smoothstep(-fwidth(outer), fwidth(outer), outer);
  float fillness = 1.0 - smoothstep(-fwidth(inner), fwidth(inner), inner);
  float fillCoverage = min(fillness, coverage);
  float borderCoverage = max(coverage - fillness, 0.0);
  float alpha = uFillColor.a * fillCoverage + uBorderColor.a * borderCoverage;
  if (alpha < 0.001) {
    discard;
  }
  vec3 color = (uFillColor.rgb * uFillColor.a * fillCoverage +
                uBorderColor.rgb * uBorderColor.a * borderCoverage) / alpha;
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * The material drawing one element's box. Per-mesh — its uniforms are the
 * element's own — but the program behind it is compiled once and shared by
 * every box in the scene.
 *
 * @returns {THREE.ShaderMaterial}
 */
export function createRectMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    // Two-sided for the same reason every plane in a portal is: the
    // container's flip turns them away from the viewer.
    side: THREE.DoubleSide,
    uniforms: {
      uSize: { value: new THREE.Vector2(1, 1) },
      uRadii: { value: new THREE.Vector4(0, 0, 0, 0) },
      uBorder: { value: new THREE.Vector4(0, 0, 0, 0) },
      uFillColor: { value: new THREE.Vector4(0, 0, 0, 0) },
      uBorderColor: { value: new THREE.Vector4(0, 0, 0, 0) },
    },
  });
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
 * @param {THREE.ShaderMaterial} material
 * @param {VisualProperties} properties
 * @returns {void}
 */
export function writeRectUniforms(material, properties) {
  const { uSize, uRadii, uBorder, uFillColor, uBorderColor } = material.uniforms;
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
