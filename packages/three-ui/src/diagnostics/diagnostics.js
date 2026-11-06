/**
 * The frame rate readout, tied to the head rather than to the room.
 *
 * Every app here already had a `stats.js` panel pinned to the corner of the
 * page, which is exactly the wrong place for it: the moment the headset takes
 * the display, the page stops being drawn and the one reading that matters —
 * what the frame rate is *in the session* — is the one nobody can see. This is
 * the same reading, in the room, where it can be read while playing.
 */
import { Signal, useEffect, useEffects } from "justdom-signal";
import { children, getCamera, useFrame } from "justdom-three";
import { chartCeiling, createFrameMeter } from "./frameMeter.js";
import { Panel } from "./panel.js";

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
 * The readout, as something a scene switches on.
 *
 * An effect rather than a component, because none of what it does is a thing
 * to hand back. It counts frames on the renderer's own loop, and it hangs the
 * panel off the *camera* rather than off wherever it was called — which is
 * what makes it a HUD: the panel keeps its place in the corner of the view
 * however the player turns, and the coordinates it is placed at are the ones
 * measured from the eye. The camera is already in the scene, so there has
 * never been anything for a caller to mount.
 *
 * It used to say that by being a component whose value was the camera, handed
 * to `use()` so the value could be dropped again. Call it from any effect
 * instead, the way `useFrame` is called, and the surrounding computation owns
 * everything below:
 *
 * ```js
 * effects(() => {
 *   useDiagnostics(ctx, diagnostics);
 * });
 * ```
 *
 * The meter runs for as long as that computation does, whether or not the
 * panel is being drawn. Counting frames is a `+= 1` in a callback the renderer
 * was making anyway; it is drawing the panel that costs anything, and that is
 * what the switch turns off.
 *
 * @param {WeakKey} ctx
 * @param {DiagnosticsControls} controls
 * @returns {void}
 */
export function useDiagnostics(ctx, controls) {
  const meter = createFrameMeter({
    onReadout: (fps) => {
      controls.fps.set(fps);
      // Only ever upwards. The scale a chart is read against has to hold
      // still, and a display that has once managed 90 is a 90 Hz display for
      // the rest of the session however badly the next minute goes.
      controls.ceiling.setFn((current) => Math.max(current, chartCeiling(fps)));
    },
    onSample: (history) => {
      controls.history.set(history);
    },
  });
  useFrame(ctx, (time) => meter.frame(time));

  // The switch, as the guard on an effect of its own: the panel is built by a
  // run that read `visible` as true and taken down by the run that reads it
  // false, which is the whole of what the old `Nothing()` branch was for. Its
  // own effect rather than the caller's, so that hiding the panel rebuilds
  // nothing else — the meter above included, which would otherwise lose the
  // minute of history a panel switched back on is there to show.
  useEffect(
    () => {
      if (!controls.visible.get()) {
        return;
      }
      useEffects(getCamera(ctx), [children(Panel(ctx, controls))]);
    },
    { name: "diagnostics" },
  );
}
