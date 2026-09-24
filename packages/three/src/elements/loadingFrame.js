import * as THREE from "three";
import { createRectMaterial, rectGeometry } from "./sdfRect.js";
import { placeAndScale } from "./place.js";

/**
 * @typedef {object} LoadingFrameOptions
 * @property {string} [color] The border and the dots: anything `THREE.Color`
 *   reads — a name, a hex string, an `rgb()`. Black by default.
 * @property {string} [fill] What the frame is filled with, on the same terms.
 *   White by default, and mostly see-through — see `fillOpacity`.
 * @property {number} [fillOpacity] How much of the scene the fill lets
 *   through, 0 to 1. 0.2 by default: enough to say "a panel goes here"
 *   without being a panel.
 * @property {number} [borderWidth] The border's width in the panel's px. 2.
 * @property {number} [radius] The corners' radius in the panel's px. 12.
 * @property {number} [minimumTime] The least time the frame stays up once
 *   shown, in milliseconds. A mount that finishes sooner waits for it: a
 *   frame that flashed for three frames and was gone reads as a glitch,
 *   not as a panel arriving. 1000 by default; 0 lets the panel land the
 *   moment it is built. A frame that was never shown — the mount finished
 *   in its first frame — holds nothing.
 */

/** How many dots the indicator has. */
const DOT_COUNT = 3;

/** A dot's diameter, in the panel's px. */
const DOT_SIZE = 6;

/** From one dot's centre to the next, in the panel's px. */
const DOT_SPACING = 14;

/** One breath of a dot, in milliseconds. */
const PERIOD = 1200;

/**
 * How long the dots take to fade in, in milliseconds. A mount usually takes
 * less than a second, and an indicator that arrived at full strength for a
 * mount that took four frames would be the most visible thing about it. The
 * frame itself does not fade: the point of it is to be there at once.
 */
const FADE_IN = 300;

/** The least and the most a dot is ever drawn at, once faded in. */
const DOT_ALPHA_MIN = 0.2;
const DOT_ALPHA_MAX = 0.85;

/**
 * Where the dots' wave is, at `elapsed` milliseconds, for the dot at `index`:
 * a slow sine, each dot a third of a cycle behind the one before it, so the
 * three breathe in turn rather than in step.
 *
 * @param {number} elapsed
 * @param {number} index
 * @returns {number} 0 to 1
 */
function wave(elapsed, index) {
  const phase = (2 * Math.PI * elapsed) / PERIOD - (index * 2 * Math.PI) / DOT_COUNT;
  return 0.5 + 0.5 * Math.sin(phase);
}

/**
 * What the player sees where a panel is going to be, while the panel is
 * still being built: a translucent rounded rectangle the panel's size, with
 * a border, and three dots in the middle that brighten in turn.
 *
 * Drawn with the same distance-field material as every box in the panel —
 * a frame is a box with a border and no content, and a dot is a box whose
 * radius is half its size — so it costs no program the scene did not
 * already have. The dots are the only thing here that moves, and they move
 * on a clock the caller feeds, which is what makes them testable.
 *
 * Nothing here is a ray target. A panel that is not there yet cannot be
 * pressed, and the portal registers its blocker only once it is.
 *
 * @param {LoadingFrameOptions} [options]
 */
export function createLoadingFrame({
  color = "black",
  fill = "white",
  fillOpacity = 0.2,
  borderWidth = 2,
  radius = 12,
  minimumTime = 1000,
} = {}) {
  const group = new THREE.Group();
  group.name = "loading-frame";
  // Everything under a portal's container keeps its own matrices; this
  // group never moves, so an identity composed once is its matrix for good.
  group.matrixAutoUpdate = false;
  group.updateMatrix();

  const lineColor = new THREE.Color(color);
  const fillColor = new THREE.Color(fill);

  const frameMaterial = createRectMaterial();
  {
    const { uRadii, uBorder, uFillColor, uBorderColor } = frameMaterial.uniforms;
    uRadii.value.set(radius, radius, radius, radius);
    uBorder.value.set(borderWidth, borderWidth, borderWidth, borderWidth);
    uFillColor.value.set(fillColor.r, fillColor.g, fillColor.b, fillOpacity);
    uBorderColor.value.set(lineColor.r, lineColor.g, lineColor.b, 1);
  }
  const frame = new THREE.Mesh(rectGeometry, frameMaterial);
  group.add(frame);

  /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[]} */
  const dots = [];
  for (let index = 0; index < DOT_COUNT; index += 1) {
    const material = createRectMaterial();
    const { uSize, uRadii, uFillColor } = material.uniforms;
    uSize.value.set(DOT_SIZE, DOT_SIZE);
    uRadii.value.set(DOT_SIZE / 2, DOT_SIZE / 2, DOT_SIZE / 2, DOT_SIZE / 2);
    // Faded out until the first tick says otherwise.
    uFillColor.value.set(lineColor.r, lineColor.g, lineColor.b, 0);
    const dot = new THREE.Mesh(rectGeometry, material);
    // After the frame, whose fill it composites over.
    dot.renderOrder = 1;
    dots.push(dot);
    group.add(dot);
  }

  let width = -1;
  let height = -1;
  /**
   * When the frame was shown, on the caller's clock — and whether it has
   * been: a frame that was never shown holds nothing and draws nothing.
   *
   * @type {number | null}
   */
  let startedAt = null;

  return {
    /** The thing to put in the scene, in the panel's own frame of reference. */
    object: group,

    /**
     * Start the frame's clock: it is in the scene from `now`, its dots fade
     * in from `now`, and its minimum time counts from `now`. The caller
     * puts `object` in the scene alongside; this only says when.
     *
     * @param {number} now milliseconds
     * @returns {void}
     */
    show(now) {
      if (startedAt === null) {
        startedAt = now;
      }
    },

    /**
     * Whether `show` has been called.
     *
     * @returns {boolean}
     */
    isShown() {
      return startedAt !== null;
    },

    /**
     * Size the frame to the panel and centre the dots in it. In the panel's
     * px, top-left origin, y down — the convention every box in a portal is
     * placed in. A no-op when nothing changed, so a tick can call it freely.
     *
     * @param {number} nextWidth
     * @param {number} nextHeight
     * @returns {void}
     */
    layout(nextWidth, nextHeight) {
      if (nextWidth === width && nextHeight === height) {
        return;
      }
      width = nextWidth;
      height = nextHeight;
      frameMaterial.uniforms.uSize.value.set(width, height);
      // A quad scaled to nothing has no surface to draw, and a zero scale is
      // not invertible; an empty panel is better described as very small —
      // the convention the blocker and every box follow.
      placeAndScale(frame, 0, 0, 0, Math.max(width, 1e-6), Math.max(height, 1e-6), 1);
      const left = width / 2 - ((DOT_COUNT - 1) * DOT_SPACING) / 2 - DOT_SIZE / 2;
      const top = height / 2 - DOT_SIZE / 2;
      dots.forEach((dot, index) => {
        // One px toward the viewer, which after the container's flip is
        // negative local z — the same side of the frame the panel's own
        // content will be on.
        placeAndScale(dot, left + index * DOT_SPACING, top, -1, DOT_SIZE, DOT_SIZE, 1);
      });
    },

    /**
     * Move the dots along. `now` is whatever clock the caller keeps; only
     * differences in it matter, and `show` is where the clock starts —
     * before that there is nothing to move.
     *
     * @param {number} now milliseconds
     * @returns {void}
     */
    tick(now) {
      if (startedAt === null) {
        return;
      }
      const elapsed = now - startedAt;
      const fade = Math.min(elapsed / FADE_IN, 1);
      dots.forEach((dot, index) => {
        const breath = DOT_ALPHA_MIN + (DOT_ALPHA_MAX - DOT_ALPHA_MIN) * wave(elapsed, index);
        dot.material.uniforms.uFillColor.value.w = fade * breath;
      });
    },

    /**
     * Whether the panel may take the frame's place: the frame has been up
     * for its minimum time, or was never shown at all. A frame nobody saw
     * has nothing to hold the panel for — which is what lets a mount that
     * finished in its first frame land in that frame.
     *
     * @param {number} now milliseconds
     * @returns {boolean}
     */
    isDue(now) {
      if (startedAt === null || minimumTime <= 0) {
        return true;
      }
      return now - startedAt >= minimumTime;
    },

    /**
     * Take the frame out of the scene and let go of what it drew with. The
     * geometry is the one every box shares and is not this frame's to
     * dispose.
     *
     * @returns {void}
     */
    dispose() {
      group.removeFromParent();
      frameMaterial.dispose();
      for (const dot of dots) {
        dot.material.dispose();
      }
    },
  };
}
