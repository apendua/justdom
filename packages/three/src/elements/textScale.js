import * as THREE from "three";
import { createProperty, Signal } from "justdom-signal";
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
   * @returns {TextScale | null}
   */
  () => null,
);

/**
 * What a run asks its panel: the step to draw at, and which steps are worth
 * keeping rasterized beside it.
 *
 * @typedef {object} TextScale
 * @property {() => number} read The step the panel shows. A tracked read.
 * @property {(step: number) => boolean} holds Whether the panel keeps a
 *   run's raster at this step once the run is showing another. Untracked:
 *   it is asked when a run lets go of rasters, which is not something that
 *   should re-run because the answer moved.
 */

/**
 * How finely a run is rasterized: what the panel it is on measures, or, for
 * a run with no panel to measure against — text projected onto a plain page,
 * or built under a test runner — what the page says a device pixel is worth.
 * Read inside the computation that draws the run, so a panel the player walks
 * up to re-draws its text at the step it has reached.
 *
 * @param {TextScale | null} textScale The run's `TextScaleContext`.
 * @returns {number}
 */
export function readTextScale(textScale) {
  if (textScale) {
    return textScale.read();
  }
  if (typeof window === "undefined") {
    return 1;
  }
  return window.devicePixelRatio || 1;
}

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
 * How many steps there are to a doubling: two, so each is root two sharper
 * than the one below it.
 *
 * Root two, not two. What a step costs is quadratic in it — a panel of forty
 * labels holds about 2 MB of canvas, mirror and array texture at one device
 * pixel to the CSS pixel, and sixteen times that at four — so the rounding up
 * is not free space, it is bought memory nobody asked for. A panel measuring
 * 2.3 gets 4 under powers of two, which is three quarters waste; under root
 * two it gets 2.83, which no eye has told the two apart from, at half the
 * memory and half of every upload the panel makes for the rest of its life.
 *
 * What it costs back is more boundaries to cross, and crossing up into a
 * step re-draws every run on the panel. That is the trade, and it is the
 * right way round: a crossing is a burst that the hold below already makes
 * rare, and the memory is paid the whole time the panel is open. Crossing
 * back down into the step below costs nothing to draw, since the panel holds
 * it (`holds`).
 *
 * Counted in steps to a doubling rather than kept as the ratio itself so
 * that the ladder comes out *exact* on the octaves. `Math.SQRT2 ** 2` is
 * 2.0000000000000004, and a run scaled by that is a pixel wider than a run
 * scaled by 2 — one wasted column on every label on the panel, for nothing.
 */
const STEPS_PER_DOUBLING = 2;

/**
 * How far under a step's own boundary the measurement has to fall before the
 * panel is rasterized smaller again.
 *
 * A step covers everything from the step below it up to itself, and a panel
 * sitting exactly on that boundary would re-draw every label it has, twice,
 * every time the player's head drifted a centimetre. Coarsening is held back
 * to a fifth under the boundary instead, which is a gap no amount of standing
 * still can cross. Sharpening is not held back at all: going up is the
 * direction somebody is walking towards the panel to do, and a frame of soft
 * text on the way in is what the delay would cost.
 */
const COARSEN_MARGIN = 0.8;

/**
 * How close to the shown step the measurement has to come before the panel
 * starts preparing the step above it.
 *
 * The step above is published the moment the measurement passes the shown
 * step, so this is a share of the shown step, not of the one above. At 0.85
 * a player leaning in at a steady pace gives the pump the last sixth of the
 * way, and one standing still at the hold below a step (`COARSEN_MARGIN`) is
 * well clear of it. A guess until a headset trace says otherwise.
 */
export const PREPARE_SHARE = 0.85;

/**
 * How long the measurement has to stay under `PREPARE_SHARE` of the shown
 * step before the panel stops preparing the step above and frees what it
 * made. Long enough that a head swaying on the threshold does not throw the
 * work away and start it again, short enough that a player who stepped back
 * does not leave a step's worth of memory behind for long.
 */
export const ABANDON_MS = 1000;

const scratchScale = new THREE.Vector3();
const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchSize = new THREE.Vector2();
const scratchViewer = new THREE.Vector3();
const scratchCentre = new THREE.Vector3();

/**
 * The step a measurement belongs to: the power of root two at or above it,
 * inside what this panel is allowed to be drawn at.
 *
 * Stepped at all rather than taken as it comes, because the measurement moves
 * with the player's head and every change of it re-rasterizes the whole
 * panel. A handful of steps is what makes the answer sit still.
 *
 * @param {number} measured
 * @param {number} max
 * @returns {number}
 */
function stepFor(measured, max) {
  if (!Number.isFinite(measured) || measured <= 1) {
    return 1;
  }
  const exponent = Math.ceil(Math.log2(measured) * STEPS_PER_DOUBLING);
  return Math.min(max, 2 ** (exponent / STEPS_PER_DOUBLING));
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
 * The step under `step` on the ladder, or null at the bottom of it.
 *
 * Found on the ladder rather than by dividing, so that it is the very number
 * `stepFor` hands out for that step and a run's raster kept under it is found
 * again. A step a panel's cap put off the ladder, 3 say, has the ladder step
 * under it, 2.83, as its own. The tolerance is for the steps between the
 * octaves, whose logarithm comes back a hair over the integer it is.
 *
 * @param {number} step
 * @returns {number | null}
 */
export function stepBelow(step) {
  const exponent = Math.ceil(Math.log2(step) * STEPS_PER_DOUBLING - 1e-9);
  if (exponent <= 0) {
    return null;
  }
  return 2 ** ((exponent - 1) / STEPS_PER_DOUBLING);
}

/**
 * The step a panel showing `step` publishes when the measurement passes it,
 * or null for a panel at its cap. Worked out as `stepFor` does, so that it is
 * the very number a run is later asked to draw at.
 *
 * @param {number} step
 * @param {number} max
 * @returns {number | null}
 */
export function stepAbove(step, max) {
  const exponent = Math.floor(Math.log2(step) * STEPS_PER_DOUBLING + 1e-9) + 1;
  const above = Math.min(max, 2 ** (exponent / STEPS_PER_DOUBLING));
  return above > step ? above : null;
}

/**
 * Whether a panel showing `shown` holds a run's raster at `held`: the shown
 * step, the one below it, and the one it is preparing. The one below is the
 * step a panel leaned into has just left, which is the one the player
 * leaning back out comes to first, and it costs half the shown step's memory.
 *
 * @param {number} shown
 * @param {number} held
 * @param {number | null} [prepared]
 * @returns {boolean}
 */
export function holdsStep(shown, held, prepared = null) {
  return held === shown || held === stepBelow(shown) || held === prepared;
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
 * @param {number} [maxScale] The most this panel is rasterized at, for a
 *   panel that would rather be soft than large — a long list, where the
 *   ceiling is reached by hundreds of runs at once rather than by one. Only
 *   ever lowers: `MAX_TEXT_SCALE` is what a run is allowed to cost at all,
 *   and nothing asked for here goes above it.
 * @param {{ now?: () => number }} [options] The clock `ABANDON_MS` is
 *   measured on, injectable so tests are deterministic.
 */
export function createTextScale(
  container,
  renderer,
  camera,
  maxScale = MAX_TEXT_SCALE,
  { now = () => performance.now() } = {},
) {
  const max = Math.min(
    MAX_TEXT_SCALE,
    Math.max(1, Number.isFinite(maxScale) ? maxScale : MAX_TEXT_SCALE),
  );
  const published = Signal.of(1);
  /** Read back without tracking anything, which a frame callback must not. */
  let step = 1;
  /**
   * The step being prepared ahead of the measurement reaching it, or null.
   * Always the step above `step` when set; the rules are in section 5.1 of
   * `docs/freedom-text-step-cache.md`.
   *
   * @type {number | null}
   */
  let prepared = null;
  /**
   * When the measurement last fell under `PREPARE_SHARE` of the shown step
   * while `prepared` was set, or null while it is above it.
   *
   * @type {number | null}
   */
  let fallingSince = null;
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
     * Whether a run keeps its raster at `held` while the panel shows the
     * step it does now (`holdsStep`). Any other step a run drew at is let go
     * of when the run next changes texture.
     *
     * @param {number} held
     * @returns {boolean}
     */
    holds: (held) => holdsStep(step, held, prepared),

    /**
     * The step being prepared ahead of the measurement, or null. Untracked,
     * like `holds`: it is read once a frame by whoever runs the preparing,
     * right after `measure`.
     *
     * @returns {number | null}
     */
    prepared: () => prepared,

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
      const wanted = stepFor(measured, max);
      // Up at once, down only once the measurement is clear of the boundary
      // this step sits on, which is a step's worth below the step itself.
      const boundary = step / 2 ** (1 / STEPS_PER_DOUBLING);
      if (wanted > step || (wanted < step && measured <= boundary * COARSEN_MARGIN)) {
        step = wanted;
        published.set(wanted);
        // Rule 3: the step above is a different step now. Whatever was
        // prepared is the shown step, the one below it, or let go of.
        prepared = null;
        fallingSince = null;
      }
      const above = stepAbove(step, max);
      if (above !== null && measured >= PREPARE_SHARE * step) {
        prepared = above;
        fallingSince = null;
      } else if (prepared !== null) {
        fallingSince ??= now();
        if (now() - fallingSince >= ABANDON_MS) {
          prepared = null;
          fallingSince = null;
        }
      }
    },
  };
}
