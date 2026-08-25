/**
 * The frame rate readout, tied to the head rather than to the room.
 *
 * Every app here already had a `stats.js` panel pinned to the corner of the
 * page, which is exactly the wrong place for it: the moment the headset takes
 * the display, the page stops being drawn and the one reading that matters —
 * what the frame rate is *in the session* — is the one nobody can see. This is
 * the same reading, in the room, where it can be read while playing.
 */
import { component, effects, Signal, use } from "justdom-signal";
import { animate, camera, children, Nothing } from "justdom-three";
import { chartCeiling, createFrameMeter } from "./frameMeter.js";
import { Panel } from "./panel.js";

/**
 * @import * as THREE from 'three';
 * @import {Observable} from 'rxjs';
 */

/**
 * How the panel is switched and what it is reading, held apart from the
 * component that draws it: the readings are taken wherever the scene is built,
 * while the button that hides the panel is usually several routes away, and
 * both reach it through this.
 *
 * @typedef {object} DiagnosticsControls
 * @property {Signal<boolean>} visible Whether the panel is being drawn. The
 *   readings are taken either way, so a panel switched back on has the last
 *   minute to show rather than an empty chart.
 * @property {Signal<number | null>} fps The current frame rate, or null until
 *   there has been enough of a session to measure one.
 * @property {Signal<readonly number[]>} history The chart, oldest first.
 * @property {Signal<number>} ceiling What full height on the chart means, in
 *   frames per second: the display's own rate, as far as it can be told from
 *   what it has managed so far.
 * @property {() => void} toggle Shows the panel, or hides it.
 */

/**
 * @typedef {object} DiagnosticsOptions
 * @property {boolean} [visible] Whether the panel starts out shown. It does.
 */

/**
 * @param {DiagnosticsOptions} [options]
 * @returns {DiagnosticsControls}
 */
export function createDiagnostics({ visible: initial = true } = {}) {
  const visible = Signal.of(initial);
  return {
    visible,
    fps: Signal.of(/** @type {number | null} */ (null)),
    history: Signal.of(/** @type {readonly number[]} */ ([])),
    // The lowest rate anything runs at, until a reading says otherwise. Wrong
    // in the safe direction: a chart that starts too short grows once, where
    // one that starts too tall spends the first seconds saying the scene is
    // struggling when it is not.
    ceiling: Signal.of(chartCeiling(0)),
    toggle: () => {
      visible.setFn((shown) => !shown);
    },
  };
}

/**
 * The readout, as something to put in a scene.
 *
 * It adds itself to the camera rather than to wherever it was used, which is
 * what makes it a HUD: the panel keeps its place in the corner of the view
 * however the player turns, and the coordinates it is placed at are the ones
 * measured from the eye. Use it the way the soundtrack's ears are used —
 * `use(Diagnostics(ctx, diagnostics))` from an effect on the scene — because
 * what comes back is the camera, and the camera is already in the scene.
 *
 * The meter runs for as long as the scene does, whether or not the panel is
 * being drawn. Counting frames is a `+= 1` in a callback the renderer was
 * making anyway; it is drawing the panel that costs anything, and that is what
 * the switch turns off.
 *
 * @type {(ctx: WeakKey, controls: DiagnosticsControls) => Observable<THREE.Camera>}
 */
export const Diagnostics = component(
  /**
   * @param {WeakKey} ctx
   * @param {DiagnosticsControls} controls
   */
  (ctx, controls) => {
    return camera(ctx).pipe(
      effects(() => {
        const meter = createFrameMeter({
          onReadout: (fps) => {
            controls.fps.set(fps);
            // Only ever upwards. The scale a chart is read against has to hold
            // still, and a display that has once managed 90 is a 90 Hz display
            // for the rest of the session however badly the next minute goes.
            controls.ceiling.setFn((current) => Math.max(current, chartCeiling(fps)));
          },
          onSample: (history) => {
            controls.history.set(history);
          },
        });
        use(animate(ctx, (time) => meter.frame(time)));
      }),
      children(component(() => (controls.visible.get() ? Panel(ctx, controls) : Nothing()))()),
    );
  },
);
