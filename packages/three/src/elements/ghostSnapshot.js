import * as THREE from "three";

/**
 * A picture of what is being dragged, for the ghost to carry.
 *
 * A browser's drag image is a picture of the element taken when the drag
 * starts, and so is this: the panel is rendered once, at `dragstart`, into
 * a render target, through a camera framed on the element's box. Nothing
 * is rendered again while the drag goes on, so it costs one pass per drag
 * and nothing per frame.
 *
 * The element cannot be drawn on its own. A panel draws its boxes as
 * instances of one batch and its text as another, and the element's own
 * meshes are bookkeeping those batches read, never drawn themselves. So
 * the picture is of the panel, cropped to the element's box: whatever is
 * drawn behind the element inside its box, a card it sits on, is in it as
 * well, where a browser's drag image has the element and its descendants
 * alone.
 */

/** How many texels a px of the panel gets, for a picture that stays sharp. */
const TEXELS_PER_PX = 2;

/** The longest side a picture is allowed, in texels. */
const MAX_TEXELS = 1024;

/**
 * How far in front of the element the camera stands, in its px, and so how
 * much of what a panel stacks in front of its boxes, overlays included, is
 * inside the picture.
 */
const DEPTH = 500;

/** The half turn that points a camera along an element's +z, up its -y. */
const FACING = new THREE.Matrix4().makeRotationX(Math.PI);

const clearColor = new THREE.Color();

/**
 * @typedef {object} Box
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * The camera that sees `box` of `frame` and nothing around it.
 *
 * An element's object is its border box in px, top-left origin, y down,
 * with the viewer on its -z side (see the portal's half turn). The camera
 * stands `DEPTH` px in front of the box's centre, looks along +z, and has
 * -y as its up, so the picture comes out the way round the panel shows it.
 * Its matrix carries the frame's world matrix, but three takes the scale
 * back out of a camera's view matrix, so its view space is in world units
 * and the frustum is the box times the frame's world scale.
 *
 * @param {THREE.Object3D} frame
 * @param {Box} box
 * @returns {THREE.OrthographicCamera}
 */
export function cameraFor(frame, { x, y, width, height }) {
  frame.updateWorldMatrix(true, false);
  const scale = new THREE.Vector3().setFromMatrixScale(frame.matrixWorld).x;
  const camera = new THREE.OrthographicCamera(
    (-width / 2) * scale,
    (width / 2) * scale,
    (height / 2) * scale,
    (-height / 2) * scale,
    0,
    DEPTH * 2 * scale,
  );
  camera.matrixAutoUpdate = false;
  camera.matrix
    .copy(frame.matrixWorld)
    .multiply(new THREE.Matrix4().makeTranslation(x + width / 2, y + height / 2, -DEPTH))
    .multiply(FACING);
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * Render `panel` once into a new render target, through a camera framed on
 * `box` of `frame`, and put the renderer back as it was: its render target,
 * its clear colour and alpha, and `xr.enabled`, which has to be off for the
 * one pass, or a renderer presenting a session would draw the headset's
 * eyes into the target instead.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Object3D} panel The panel's container object, which holds
 *   its batches; rendered on its own, without the rest of the scene.
 * @param {THREE.Object3D} frame
 * @param {Box} box
 * @returns {THREE.WebGLRenderTarget | null} The caller's to dispose. Null for
 *   a box with nothing in it.
 */
export function takeSnapshot(renderer, panel, frame, box) {
  if (box.width <= 0 || box.height <= 0) {
    return null;
  }
  const fit = Math.min(1, MAX_TEXELS / (Math.max(box.width, box.height) * TEXELS_PER_PX));
  const target = new THREE.WebGLRenderTarget(
    Math.max(1, Math.round(box.width * TEXELS_PER_PX * fit)),
    Math.max(1, Math.round(box.height * TEXELS_PER_PX * fit)),
  );
  const camera = cameraFor(frame, box);

  const previousTarget = renderer.getRenderTarget();
  const previousXr = renderer.xr.enabled;
  renderer.getClearColor(clearColor);
  const previousAlpha = renderer.getClearAlpha();
  try {
    renderer.xr.enabled = false;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(panel, camera);
  } finally {
    renderer.setClearColor(clearColor, previousAlpha);
    renderer.setRenderTarget(previousTarget);
    renderer.xr.enabled = previousXr;
  }
  return target;
}

/**
 * A unit quad like `rectGeometry`, top-left origin and y down, with the
 * texture coordinates that put a snapshot's top row at its top edge.
 */
export const snapshotGeometry = new THREE.BufferGeometry();
snapshotGeometry.setAttribute(
  "position",
  new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3),
);
snapshotGeometry.setAttribute(
  "uv",
  new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), 2),
);
snapshotGeometry.setIndex([0, 1, 2, 2, 1, 3]);
