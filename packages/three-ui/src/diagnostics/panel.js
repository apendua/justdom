/**
 * What the readout looks like: a number, a minute of history under it, and as
 * little else as the thing can be made of.
 */
import * as THREE from "three";
import { component, effects } from "@apendua/signal";
import { $, children, set, style, text } from "@apendua/justdom";
import { dom, useFrame } from "@apendua/freedom";
import { SAMPLE_COUNT, SAMPLE_MS } from "./frameMeter.js";
import { bar, caption, chart, hudCard, reading, readingRow, unit, UI_SCALE } from "./styles.js";

/**
 * @import {Observable} from 'rxjs';
 * @import {Mountable} from '@apendua/justdom';
 * @import {Component} from '@apendua/freedom';
 * @import {DiagnosticsControls} from './diagnostics.js';
 */

/**
 * Where the panel hangs, in the camera's own coordinates: up and to the left,
 * a metre out. Fourteen degrees across and ten up — off the middle of the view,
 * where the game is, and inside the arc an eye covers on its own. Twenty-odd
 * degrees, which is where this started, is past that: it is a glance the neck
 * ends up helping with, which is not what a reading you take every few seconds
 * should cost.
 *
 * A metre because a head-locked panel is read with both eyes and they have to
 * agree on where it is: much closer and it is a panel the player is going
 * cross-eyed at, much further and it is a panel behind the game.
 */
const PLACEMENT = new THREE.Vector3(-0.24, 0.17, -0.95);

/**
 * Turned to face the eye rather than left facing straight ahead, which even at
 * this angle would show the player more of the panel's edge than of its face.
 */
const FACING = new THREE.Euler(0.17, 0.25, 0);

/**
 * Where the panel is drawn in the frame's order: after everything a scene is
 * likely to have asked for, and far enough clear of it that the panel's own
 * ordering — which `freedom` writes as small numbers, one per layer of nesting
 * — survives being shifted up by this.
 */
const HUD_RENDER_ORDER = 100000;

/**
 * Draw the panel over the scene rather than in it.
 *
 * A metre out is where the *panel* is; it is not where the game is. Something
 * closer than that in the same direction — a card at arm's length, a board
 * carried up to the face — is in front of it and hides it, which is the honest
 * answer for a thing in the room and the wrong one for an instrument. So the
 * subtree stops testing itself against the depth buffer and is ordered after
 * everything else: whatever the scene is doing, the reading is legible.
 *
 * Only depth *testing* goes. The order the panel draws itself in — background,
 * then border, then glyphs — is `renderOrder` rather than depth, and shifting
 * the whole subtree by a constant leaves it exactly as it was.
 *
 * This runs every frame, and the shift is written as "raise anything that is
 * not already raised" rather than as an addition, for two reasons. Meshes keep
 * arriving as the portal mirrors the DOM into the scene; and the portal owns
 * `renderOrder` — it writes each element's own back whenever that element's
 * nesting is worked out again, which puts the panel's glyphs behind the scene
 * a frame later and is exactly what this looked like when it was done once.
 * Idempotent, it survives that. It is a walk of some forty objects and a
 * comparison each, in a tool whose whole business is not showing up in its own
 * reading.
 *
 * @param {THREE.Object3D} root
 * @returns {() => void}
 */
function drawOnTop(root) {
  return () => {
    root.traverse((object) => {
      if (object.renderOrder < HUD_RENDER_ORDER) {
        object.renderOrder += HUD_RENDER_ORDER;
      }
      const mesh = /** @type {THREE.Mesh} */ (object);
      if (!mesh.material) {
        return;
      }
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material.depthTest) {
          material.depthTest = false;
        }
      }
    });
  };
}

/** How much of the last minute one bar stands for, in seconds. */
const WINDOW_SECONDS = Math.round((SAMPLE_MS * SAMPLE_COUNT) / 1000);

/**
 * Green while the display is keeping up, amber where it is missing some of the
 * frames it asked for, red where the scene has stopped being a scene and
 * started being a slideshow. The bands are fractions of the display's own rate
 * rather than absolute figures, because 72 fps is perfect on one headset and a
 * quarter of the frames dropped on another.
 */
const HEALTH = /** @type {const} */ ([
  { from: 0.9, rgb: "126, 231, 168" },
  { from: 0.6, rgb: "247, 208, 96" },
  { from: 0, rgb: "255, 138, 128" },
]);

/**
 * @param {number} ratio Frame rate as a fraction of what the display can do.
 * @param {number} alpha
 * @returns {string}
 */
function healthColour(ratio, alpha) {
  const band = HEALTH.find(({ from }) => ratio >= from) ?? HEALTH[HEALTH.length - 1];
  return `rgba(${band.rgb}, ${alpha})`;
}

/**
 * The reading for one bar, or null for a slot the session has not been running
 * long enough to have filled. The newest sample is the rightmost bar, so a
 * short history is padded on the left and the chart fills the way it is read.
 *
 * @param {readonly number[]} history
 * @param {number} index
 * @returns {number | null}
 */
export function sampleAt(history, index) {
  const offset = SAMPLE_COUNT - history.length;
  return index >= offset ? history[index - offset] : null;
}

/**
 * @param {DiagnosticsControls} controls
 * @param {number} index
 * @returns {Observable<Mountable>}
 */
function chartBar(controls, index) {
  /** @returns {number | null} */
  const ratio = () => {
    const value = sampleAt(controls.history.get(), index);
    return value === null ? null : Math.min(1, Math.max(0, value / controls.ceiling.get()));
  };
  return $("div", [
    set("className", bar),
    // Both of these are the cheap tier: a transform is a matrix write on the
    // bar's own object and a colour is a uniform, so a chart shifting along by
    // one bar every two seconds costs the panel no layout at all.
    style("transform", () => `scaleY(${ratio() ?? 0})`),
    style("backgroundColor", () => {
      const value = ratio();
      return value === null ? "" : healthColour(value, 0.72);
    }),
  ]);
}

/**
 * The panel, as a component to be added to whatever should carry it — which is
 * the camera; see `Diagnostics`.
 *
 * It is projected through a portal that lets rays through. Nothing on it can be
 * pressed, and it sits between the player and the whole scene: a panel that
 * stopped rays here would be a pane of glass the player's own pointer kept
 * landing on, a foot in front of the game.
 *
 * @type {(ctx: WeakKey, controls: DiagnosticsControls) => Observable<Component>}
 */
export const Panel = component(
  /**
   * @param {WeakKey} ctx
   * @param {DiagnosticsControls} controls
   */
  (ctx, controls) => {
    return dom(
      ctx,
      $("div", [
        set("className", hudCard),
        children(
          $("div", [
            set("className", readingRow),
            children(
              $("div", [
                set("className", reading),
                style("color", () => {
                  const fps = controls.fps.get();
                  return fps === null ? "" : healthColour(fps / controls.ceiling.get(), 0.92);
                }),
                children(
                  text`${() => {
                    const fps = controls.fps.get();
                    // Half a second in, before there is anything to say. An
                    // eager zero would read as a hung scene.
                    return fps === null ? "--" : `${Math.round(fps)}`;
                  }}`,
                ),
              ]),
              $("div", [set("className", unit), children(text`fps`)]),
            ),
          ]),
          $("div", [
            set("className", chart),
            children(...Array.from({ length: SAMPLE_COUNT }, (_, i) => chartBar(controls, i))),
          ]),
          $("div", [
            set("className", caption),
            children(
              text`${() => `${WINDOW_SECONDS} s · full height ${controls.ceiling.get()} fps`}`,
            ),
          ]),
        ),
      ]),
      [
        effects((obj) => {
          obj.position.copy(PLACEMENT);
          obj.rotation.copy(FACING);
          obj.scale.setScalar(UI_SCALE);
        }),
        effects((obj) => {
          useFrame(ctx, drawOnTop(obj));
        }),
      ],
      { opaqueToRays: false },
    );
  },
);
