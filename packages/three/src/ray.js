import * as THREE from "three";
import { RAY_RENDER_ORDER } from "./drawOrder.js";

/**
 * How far from the hand the beam has faded out completely, in metres. A panel
 * or a table at arm's length gets most of it; something across the room gets
 * none, and the cursor is what says where the ray landed there.
 */
export const RAY_REACH = 1.5;

/**
 * How far from the hand the beam takes to come up to full strength, in metres,
 * so that it starts out of the controller's tip as a glow rather than as the
 * square end of a band.
 */
export const RAY_FADE_IN = 0.05;

/** How wide the beam is where it leaves the hand, in metres. */
export const RAY_WIDTH_NEAR = 0.005;

/**
 * How wide the beam is at `RAY_REACH`, in metres. Wider than at the hand, so
 * that the beam reads as spreading out as it dissolves rather than as a line
 * drawn thinner by the perspective.
 */
export const RAY_WIDTH_FAR = 0.015;

/** How opaque the beam is at its brightest: along its middle, at the hand. */
export const RAY_OPACITY = 0.6;

const vertexShader = /* glsl */ `
uniform float widthNear;
uniform float widthFar;
uniform float reach;
varying float vAcross;
varying float vMetres;

void main() {
  // The beam is the object's own segment from its origin down -z to z = -1,
  // stretched to the ray's length by the object's scale, so the two ends are
  // read off the world matrix rather than passed in.
  vec3 start = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 axis = (modelMatrix * vec4(0.0, 0.0, -1.0, 1.0)).xyz - start;
  float along = -position.z;
  vec3 centre = start + axis * along;
  float metres = length(axis) * along;
  // Turned about its own axis to face the eye, as a cylinder would look, so
  // the beam has the same width seen from any side for two triangles.
  vec3 side = cross(axis, cameraPosition - centre);
  float sideLength = length(side);
  side = sideLength > 1e-9 ? side / sideLength : vec3(0.0);
  float width = mix(widthNear, widthFar, clamp(metres / reach, 0.0, 1.0));
  vAcross = position.x;
  vMetres = metres;
  gl_Position = projectionMatrix * viewMatrix * vec4(centre + side * position.x * width * 0.5, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 color;
uniform float opacity;
uniform float reach;
uniform float fadeIn;
varying float vAcross;
varying float vMetres;

void main() {
  // Soft across, brightest along the middle and nothing at the edges; coming
  // up out of the hand, and fading with the distance from it until it is gone
  // at the reach.
  float across = 1.0 - vAcross * vAcross;
  float rise = smoothstep(0.0, fadeIn, vMetres);
  float fade = 1.0 - clamp(vMetres / reach, 0.0, 1.0);
  gl_FragColor = vec4(color, opacity * across * rise * fade * fade);
  #include <colorspace_fragment>
}
`;

/**
 * The beam a controller points with: a soft band that leaves the hand bright
 * and dissolves with distance, rather than a hairline drawn the full length of
 * the ray.
 *
 * It is one quad, from the object's origin down -z to z = -1, so the ray's
 * length is the object's `scale.z`, as it was for the line it replaces
 * (`fitRayToHit` sets it). The vertex shader turns the quad to face the eye
 * and widens it, and the fragment shader fades it, both from the world matrix
 * and the camera three already hands every material, so a frame sets no
 * uniform and allocates nothing. `clone()` shares the geometry and the
 * material, so every hand's beam is drawn from one of each.
 *
 * It draws at `RAY_RENDER_ORDER`, after the world's panels: transparent and
 * writing no depth, it would otherwise be painted over by any panel drawn
 * after it, which is the stretch just before the hit.
 *
 * The bounding sphere is a sphere round the quad, x from -1 to 1, scaled by
 * the ray's length, so it holds the narrowed beam with room to spare, and it
 * is computed here rather than on the first frame it is culled. The beam is
 * never a ray target: the interaction manager only casts at the objects that
 * are registered with it, and the mesh answers no other caster either, since
 * to a raycaster it would be a sheet two metres wide.
 *
 * @param {THREE.ColorRepresentation} [color]
 * @returns {THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>}
 */
export function createRay(color = 0xffffff) {
  const geometry = new THREE.BufferGeometry();
  // x is the side of the beam, -1 or 1, and z how far along it, 0 to -1.
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 0, -1, 1, 0, -1], 3),
  );
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  geometry.computeBoundingSphere();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(color) },
      opacity: { value: RAY_OPACITY },
      reach: { value: RAY_REACH },
      fadeIn: { value: RAY_FADE_IN },
      widthNear: { value: RAY_WIDTH_NEAR },
      widthFar: { value: RAY_WIDTH_FAR },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    // Faced to the eye in the shader, so which way the quad was wound says
    // nothing about which side is in front.
    side: THREE.DoubleSide,
  });
  const ray = new THREE.Mesh(geometry, material);
  ray.name = "ray";
  ray.renderOrder = RAY_RENDER_ORDER;
  ray.raycast = () => {};
  return ray;
}
