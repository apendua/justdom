import * as THREE from "three";

/**
 * @import {Raycaster, Intersection, Object3D} from 'three';
 */

/**
 * The region content is confined to by the ancestors that hide their
 * overflow: a rectangle with a corner radius each, in the same axis-aligned,
 * y-down pixel space everything else inside a portal is expressed in. Which
 * space a particular box is in depends on where it came from — the mirror
 * answers in the element's own frame (`getLocalClipBox`) or the clip owner's
 * (`getInteriorClipBox`), and `toLocalClipBox` moves one between frames.
 *
 * @typedef {object} ClipBox
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 * @property {number} topLeft Corner radius, as the padding box of whichever
 *   ancestor binds that corner rounds it.
 * @property {number} topRight
 * @property {number} bottomRight
 * @property {number} bottomLeft
 */

/**
 * Far enough outside any conceivable panel to mean "not clipped at all", and
 * still an ordinary number. `Infinity` would read better, but this ends up in
 * a float uniform, and a driver storing it as mediump is free to turn it into
 * something that no longer compares the way it should.
 */
export const UNBOUNDED = 1e6;

/** @type {ClipBox} */
export const UNCLIPPED = {
  left: -UNBOUNDED,
  top: -UNBOUNDED,
  right: UNBOUNDED,
  bottom: UNBOUNDED,
  topLeft: 0,
  topRight: 0,
  bottomRight: 0,
  bottomLeft: 0,
};

/**
 * The region two clip boxes both allow.
 *
 * Edges are the easy half: everything in a portal is axis aligned, so the
 * intersection of two clip rectangles is another one, and nesting a scroller
 * inside a clipped panel costs nothing — the shader still sees a single box.
 *
 * Corners are the interesting half. A corner is only round if one box binds
 * *both* of the edges meeting there; where the two boxes each bind one edge,
 * they cross, and the corner they leave behind is square. Two rounded
 * rectangles can of course overlap in a shape no rounded rectangle describes,
 * and this is where that is approximated — always by rounding less, never by
 * drawing outside both boxes.
 *
 * @param {ClipBox} a
 * @param {ClipBox} b
 * @returns {ClipBox}
 */
export function intersectClipBoxes(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  /**
   * @param {"left" | "right"} x
   * @param {"top" | "bottom"} y
   * @param {number} edgeX
   * @param {number} edgeY
   * @param {"topLeft" | "topRight" | "bottomRight" | "bottomLeft"} corner
   * @returns {number}
   */
  const radius = (x, y, edgeX, edgeY, corner) => {
    const bindsA = a[x] === edgeX && a[y] === edgeY;
    const bindsB = b[x] === edgeX && b[y] === edgeY;
    if (bindsA && bindsB) {
      return Math.max(a[corner], b[corner]);
    }
    if (bindsA) {
      return a[corner];
    }
    if (bindsB) {
      return b[corner];
    }
    return 0;
  };
  return {
    left,
    top,
    right,
    bottom,
    topLeft: radius("left", "top", left, top, "topLeft"),
    topRight: radius("right", "top", right, top, "topRight"),
    bottomRight: radius("right", "bottom", right, bottom, "bottomRight"),
    bottomLeft: radius("left", "bottom", left, bottom, "bottomLeft"),
  };
}

/**
 * The same box, read in the coordinates of something whose origin sits at
 * (x, y).
 *
 * @param {ClipBox} box
 * @param {number} x
 * @param {number} y
 * @returns {ClipBox}
 */
export function toLocalClipBox(box, x, y) {
  return {
    ...box,
    left: box.left - x,
    top: box.top - y,
    right: box.right - x,
    bottom: box.bottom - y,
  };
}

/**
 * @param {ClipBox} box
 * @returns {boolean}
 */
export function isEmptyClipBox(box) {
  return box.right <= box.left || box.bottom <= box.top;
}

/**
 * Whether anything of a box of this size, placed at the origin, survives the
 * clip. This is the question behind both hiding an object and taking it out of
 * the raycast set, so it is asked in the element's own coordinates.
 *
 * Corners are ignored: an element overlapping nothing but the rounded-away
 * sliver of a corner is not worth a second geometric opinion, and answering
 * "shown" there costs one draw of nothing.
 *
 * @param {ClipBox} box
 * @param {number} width
 * @param {number} height
 * @returns {boolean}
 */
export function clipBoxShows(box, width, height) {
  return !(box.right <= 0 || box.bottom <= 0 || box.left >= width || box.top >= height);
}

/**
 * @param {ClipBox} a
 * @param {ClipBox} b
 * @returns {boolean}
 */
export function clipBoxEqual(a, b) {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.topLeft === b.topLeft &&
    a.topRight === b.topRight &&
    a.bottomRight === b.bottomRight &&
    a.bottomLeft === b.bottomLeft
  );
}

/**
 * The clip matrix for a mesh whose vertices are already in the frame its clip
 * box is given in — every box, text run and tick a portal draws. Shared by
 * all of them and never written: a mesh that needs another matrix brings a
 * uniform of its own.
 *
 * @type {{ readonly value: THREE.Matrix3 }}
 */
export const IDENTITY_CLIP_MATRIX = Object.freeze({ value: new THREE.Matrix3() });

/**
 * Teach an ordinary three material to stop drawing outside a box.
 *
 * The boxes an element draws have a shader of their own and take the clip as
 * uniforms; this is for the things in a portal that do not — a text quad,
 * which is a `MeshBasicMaterial` carrying a rasterized mask, a checkbox's
 * tick, an SVG shape. The patch fades coverage across the edge rather than
 * cutting it, so a line of text crossing the top of a scroller is trimmed as
 * cleanly as the box around it.
 *
 * The box is given in some frame of its own, and `matrix` takes the mesh's
 * local coordinates into it, in the vertex shader, so the fragment compares
 * like with like. For almost everything that frame is the mesh's own and the
 * matrix is the identity; an SVG shape keeps its geometry in its user space
 * and its object carries the transforms, so its matrix is the one from that
 * user space to the `<svg>` root the box is measured against. The clip edge
 * stays axis-aligned in the box's frame whatever the matrix does — which is
 * what CSS does to content under a transform, too.
 *
 * @param {THREE.Material} material
 * @param {{ value: THREE.Vector4 }} uniform Shared with the caller, which
 *   writes the current box into it as the layout changes.
 * @param {{ value: THREE.Matrix3 }} [matrix] Mesh-local to clip frame, also
 *   written by the caller; the identity when left out.
 * @returns {void}
 */
export function applyClip(material, uniform, matrix = IDENTITY_CLIP_MATRIX) {
  material.onBeforeCompile = (shader) => {
    patchClip(shader, uniform, matrix);
  };
  // Programs are cached by material type and defines, neither of which the
  // patch above changes. Without a distinct key a clipped material can be
  // handed the unpatched program compiled for an identical unclipped one.
  material.customProgramCacheKey = () => "freedom-clip-matrix";
}

/**
 * The clip patch itself, without the material it is installed on: `applyClip`
 * is the whole of it, and `applyReveal` is it plus a second term.
 *
 * @param {import('three').WebGLProgramParametersWithUniforms} shader
 * @param {{ value: THREE.Vector4 }} uniform
 * @param {{ value: THREE.Matrix3 }} matrix
 * @returns {void}
 */
function patchClip(shader, uniform, matrix) {
  shader.uniforms.clipBox = uniform;
  shader.uniforms.clipMatrix = matrix;
  shader.vertexShader = shader.vertexShader
    .replace(
      "void main() {",
      "uniform mat3 clipMatrix;\nvarying vec2 vClipPosition;\nvoid main() {",
    )
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n\tvClipPosition = (clipMatrix * vec3(position.xy, 1.0)).xy;",
    );
  shader.fragmentShader = shader.fragmentShader
    .replace("void main() {", "uniform vec4 clipBox;\nvarying vec2 vClipPosition;\nvoid main() {")
    .replace(
      "#include <alphatest_fragment>",
      "#include <alphatest_fragment>\n" +
        "\tvec2 clipHalf = 0.5 * (clipBox.zw - clipBox.xy);\n" +
        "\tvec2 clipD = abs(vClipPosition - 0.5 * (clipBox.xy + clipBox.zw)) - clipHalf;\n" +
        "\tfloat clipDist = max(clipD.x, clipD.y);\n" +
        "\tdiffuseColor.a *= 1.0 - smoothstep(-fwidth(clipDist), fwidth(clipDist), clipDist);\n" +
        "\tif (diffuseColor.a < 0.001) discard;",
    );
}

/**
 * The same material, clipped *and* cut short at a character.
 *
 * Where the clip is a box the text slides through, the cut is a point in the
 * text itself: lines above it are drawn whole, the line it falls on is drawn
 * up to it, and everything after it is not drawn at all. Both terms are
 * written against the same `vClipPosition` — the run's own layout frame, y
 * down, the frame `toLocalClipBox` already answers in — so a revealed run
 * inside a scroller is clipped and cut, and there is no second convention to
 * keep straight.
 *
 * The x edge is antialiased, because it falls between two glyphs and a hard
 * step there crawls as the cut advances. The y steps are not: a line boundary
 * falls in the leading, where there is nothing to alias.
 *
 * @param {THREE.Material} material
 * @param {{ value: THREE.Vector4 }} clip
 * @param {{ value: THREE.Vector4 }} cut Shared with the caller: x is where the
 *   cut line is cut, y the bottom of the last line drawn whole, z the bottom
 *   of the cut line, and w which side of x is drawn — `+1` on a line read
 *   left to right, `-1` on one read right to left. Push the three positions
 *   far out of range for a run that is drawn entirely, or entirely not — see
 *   `solveCut`.
 * @returns {void}
 */
export function applyReveal(material, clip, cut) {
  material.onBeforeCompile = (shader) => {
    patchClip(shader, clip, IDENTITY_CLIP_MATRIX);
    shader.uniforms.revealCut = cut;
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform vec4 revealCut;\nvoid main() {")
      .replace(
        "#include <alphatest_fragment>",
        "#include <alphatest_fragment>\n" +
          "\tfloat revealWhole = step(vClipPosition.y, revealCut.y);\n" +
          "\tfloat revealEdge = fwidth(vClipPosition.x);\n" +
          // How far past the cut this fragment is, measured in the direction
          // the line reads, so the same smoothstep keeps the near side of a
          // left-to-right line and the far side of a right-to-left one. For
          // w = 1 it is what the unsigned form said: smoothstep(a - e, a + e,
          // x) is smoothstep(-e, e, x - a).
          "\tfloat revealPast = (vClipPosition.x - revealCut.x) * revealCut.w;\n" +
          "\tfloat revealOn = step(vClipPosition.y, revealCut.z) *\n" +
          "\t\t(1.0 - smoothstep(-revealEdge, revealEdge, revealPast));\n" +
          "\tdiffuseColor.a *= clamp(revealWhole + revealOn, 0.0, 1.0);",
      );
  };
  // A reveal material handed the clip-only program would draw uncut, and
  // silently: nothing about the patch above reaches the cache key on its own.
  material.customProgramCacheKey = () => "freedom-clip-matrix-reveal";
}

const localPoint = new THREE.Vector3();

/**
 * Trim a mesh's hits to the part of it that is actually drawn.
 *
 * Nothing about clipping reaches the raycaster on its own: `Raycaster`
 * consults neither a fragment discard, nor material clipping planes, nor even
 * `object.visible`. Left alone, the half of a button that has scrolled out
 * from under its scroller would still be clickable — the bug that makes a
 * scrolling list feel broken rather than unfinished.
 *
 * The box is read in the frame the clip patch reads it in. The hit goes
 * into `frame`'s local coordinates and then through `matrix`. For an SVG
 * shape that is the `clipMatrix` its material carries, so a ray meets
 * exactly what is drawn.
 *
 * @param {Object3D} mesh
 * @param {() => ClipBox} getClipBox
 * @param {Object3D} [frame] Whose coordinates the box is given in, before
 *   `matrix`. Defaults to the mesh; a box drawn as a scaled unit quad, or a
 *   blocker covering an element, has to name the element instead.
 * @param {{ value: THREE.Matrix3 }} [matrix] From `frame`'s coordinates to
 *   the box's, read at every cast; the identity when left out.
 * @returns {void}
 */
export function clipRaycast(mesh, getClipBox, frame = mesh, matrix = IDENTITY_CLIP_MATRIX) {
  const inherited = mesh.raycast.bind(mesh);
  /**
   * @param {Raycaster} raycaster
   * @param {Intersection[]} intersects
   */
  mesh.raycast = (raycaster, intersects) => {
    const first = intersects.length;
    inherited(raycaster, intersects);
    if (intersects.length === first) {
      return;
    }
    const box = getClipBox();
    for (let index = intersects.length - 1; index >= first; index--) {
      localPoint.copy(intersects[index].point);
      frame.worldToLocal(localPoint);
      localPoint.z = 1;
      localPoint.applyMatrix3(matrix.value);
      if (
        localPoint.x < box.left ||
        localPoint.y < box.top ||
        localPoint.x > box.right ||
        localPoint.y > box.bottom
      ) {
        intersects.splice(index, 1);
      }
    }
  };
}
