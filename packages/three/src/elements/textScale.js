import * as THREE from "three";
import { createProperty, Signal } from "@apendua/signal";
import { MAX_TEXT_SCALE } from "./textHelpers.js";

/**
 * @import {Object3D, Camera, PerspectiveCamera, WebGLRenderer} from 'three';
 */

/**
 * How many device pixels a panel is actually painting for each of its CSS
 * pixels, and therefore how finely its text is worth rasterizing.
 *
 * A run used to be drawn at `window.devicePixelRatio`, which is the page's
 * answer to a question nobody in a scene is asking. What decides whether a
 * glyph looks sharp is how much of the screen the panel covers, and that is
 * the portal's world scale, the projection and the distance between the two —
 * three numbers the page's ratio knows nothing about. In an immersive session
 * it knows less than nothing: a headset browser reports 1 while the eye buffer
 * paints two or three pixels across every CSS pixel of a panel at arm's
 * length, so every label was being magnified and there was no mip level in the
 * world that could put back what level 0 never had.
 *
 * Set by `createPortal` on the context its elements are built with, so each
 * panel measures its own. Text built without one — a portal on a plain page,
 * a test standing in for a scene — falls back to the page's ratio, which is
 * the right answer when the panel *is* the page.
 */
export const TextScaleContext = createProperty(
  /**
   * @returns {(() => number) | null}
   */
  () => null,
);

/**
 * The nearest a panel is measured as being.
 *
 * A player can walk into a panel, and a panel around their ears is as much
 * behind them as in front; the measurement below divides by this, so past
 * some point it has to stop meaning anything. Five centimetres is well
 * inside any distance a panel is read from.
 */
const MIN_DISTANCE = 0.05;

/**
 * How far below a step the measurement has to fall before a panel is
 * rasterized smaller again.
 *
 * Steps are powers of two, rounded up, so a step of 2 covers everything over
 * 1 and up to 2 — and a panel sitting exactly on a boundary would re-draw
 * every label it has, twice, every time the player's head drifted a
 * centimetre. Coarsening is held back to a fifth under the boundary instead,
 * which is a gap no amount of standing still can cross. Sharpening is not:
 * going up is the direction somebody is looking at the panel to do, and a
 * frame of soft text on the way in is what the delay would cost.
 */
const COARSEN_AT = 0.4;

const scratchScale = new THREE.Vector3();
const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchSize = new THREE.Vector2();
const scratchViewer = new THREE.Vector3();
const scratchCentre = new THREE.Vector3();

/**
 * The step a measurement belongs to: the power of two at or above it, inside
 * what a run is allowed to be drawn at.
 *
 * Powers of two rather than the number itself, because the number moves with
 * the player's head and every change of it re-rasterizes the whole panel.
 * Three steps is enough — a panel is read from about one distance, and the
 * one below is never more than half as sharp as it could be.
 *
 * @param {number} measured
 * @returns {number}
 */
function stepFor(measured) {
  if (!Number.isFinite(measured) || measured <= 1) {
    return 1;
  }
  return Math.min(MAX_TEXT_SCALE, 2 ** Math.ceil(Math.log2(measured)));
}

/**
 * How many device pixels a world unit covers one metre from the eye, which is
 * everything about the view that the measurement needs.
 *
 * Element 5 of a perspective projection is `1 / tan(fovY / 2)`, so half the
 * viewport's height times that is the pixels a unit-tall thing one unit away
 * projects to. Taken off the *eye* in an immersive session rather than off
 * the camera the scene was built with: three leaves that one where it was and
 * renders through an `ArrayCamera` whose sub-cameras carry the session's own
 * projection and the viewport of the eye buffer, which is the framebuffer the
 * panel is really being painted into. A headset's own ratio never enters into
 * it.
 *
 * @param {WebGLRenderer} renderer
 * @param {Camera} camera
 * @returns {number} Zero when there is no perspective to measure — an
 *   orthographic scene, or an immersive session whose first frame has not
 *   been drawn yet.
 */
function pixelsPerUnitAtUnitDistance(renderer, camera) {
  let view = camera;
  let height = 0;
  if (renderer.xr.isPresenting) {
    const xrCamera = renderer.xr.getCamera();
    const eye = xrCamera.cameras[0];
    if (eye) {
      view = eye;
      height = eye.viewport ? eye.viewport.w : 0;
    }
  }
  if (!height) {
    height = renderer.getDrawingBufferSize(scratchSize).y;
  }
  if (!height || !(/** @type {PerspectiveCamera} */ (view).isPerspectiveCamera)) {
    return 0;
  }
  return 0.5 * height * view.projectionMatrix.elements[5];
}

/**
 * The panel's own answer to "how sharp should this text be", remeasured once
 * a frame and published as a step the runs can be rasterized at.
 *
 * @param {Object3D} container The portal's container. Its world matrix
 *   carries the scale that turns a CSS pixel into metres, whatever the scene
 *   above it does about its own; its local frame is where the panel's centre
 *   is known.
 * @param {WebGLRenderer} renderer
 * @param {Camera} camera The camera the scene renders through, which is only
 *   the viewer's outside an immersive session — see above.
 */
export function createTextScale(container, renderer, camera) {
  const published = Signal.of(1);
  /** Read back without tracking anything, which a frame callback must not. */
  let step = 1;
  /** The panel's middle, in the container's own pixels. */
  const centre = new THREE.Vector3();

  return {
    /**
     * What a run should be rasterized at. A tracked read: the step changing
     * is what re-draws the panel's text at the new size.
     *
     * @returns {number}
     */
    read: () => published.get(),

    /**
     * Where the middle of the panel is, which is what its distance is
     * measured to. Told by the portal's own resize, because a corner is not
     * the panel: half a metre of panel between the two is most of a step at
     * the distance one is read from.
     *
     * @param {number} width
     * @param {number} height
     * @returns {void}
     */
    setPanelSize(width, height) {
      centre.set(width / 2, height / 2, 0);
    },

    /**
     * Take the measurement and publish it if it has moved a step.
     *
     * @returns {void}
     */
    measure() {
      const pixelsPerUnit = pixelsPerUnitAtUnitDistance(renderer, camera);
      if (!pixelsPerUnit) {
        return;
      }
      // Brought up to date first, and not taken on trust. This runs in the
      // late phase, before three walks the scene, so the world matrix on hand
      // is the one the *last* frame drew with — and on the first frame there
      // is no last frame, only the identity a fresh object starts with. A
      // panel measured against that comes out a thousand times too sharp, and
      // the hold below would then keep it there. Parents but not children:
      // the ancestors are what this object's own placement hangs off, and the
      // subtree under it is opted out of exactly this kind of walk.
      container.updateWorldMatrix(true, false);
      container.matrixWorld.decompose(scratchPosition, scratchQuaternion, scratchScale);
      const metresPerPixel = Math.max(scratchScale.x, scratchScale.y);
      if (!metresPerPixel) {
        return;
      }
      const viewer = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
      const middle = scratchCentre.copy(centre).applyMatrix4(container.matrixWorld);
      const distance = Math.max(
        MIN_DISTANCE,
        middle.distanceTo(scratchViewer.setFromMatrixPosition(viewer.matrixWorld)),
      );
      const measured = (metresPerPixel * pixelsPerUnit) / distance;
      const wanted = stepFor(measured);
      // Up at once, down only once the measurement is clear of the boundary.
      if (wanted > step || (wanted < step && measured <= step * COARSEN_AT)) {
        step = wanted;
        published.set(wanted);
      }
    },
  };
}
