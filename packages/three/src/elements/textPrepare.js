import { createProperty } from "@apendua/signal";

/**
 * @import {PortalPump, PortalScheduler} from './portalScheduler.js';
 * @import {Texture} from 'three';
 * @import {TextBatch} from './textBatch.js';
 */

/**
 * The most array bytes the prepare pump sends to the GPU in one frame, once
 * it has written every run. At least one class goes up whatever its size. A
 * guess until a headset trace says what an upload costs there.
 */
export const UPLOAD_BYTES_PER_FRAME = 512 * 1024;

/**
 * What the prepare pump asks of a run.
 *
 * @typedef {object} PreparedRun
 * @property {(step: number) => Texture | null} prepare Draw the run at
 *   `step` and keep it, if it has not already. Reads nothing reactive.
 *   Returns the texture it drew when the batch did not stage it, which is a
 *   run with its colours baked in or one the batch does not draw, for the
 *   pump to send up itself; null otherwise.
 * @property {(step: number) => void} release Let go of the run's raster at
 *   `step`, unless the run is showing it.
 */

/**
 * @typedef {object} TextPreparer
 * @property {(run: PreparedRun) => void} register A run on the panel, queued
 *   at once if a step is being prepared.
 * @property {(run: PreparedRun) => void} unregister
 * @property {(run: PreparedRun) => void} requeue What the run says changed,
 *   so whatever it prepared is gone (rule 7).
 * @property {(step: number | null) => void} retarget The step the panel is
 *   preparing now, as the panel's `createTextScale().prepared` says after
 *   each measurement.
 * @property {() => void} dispose
 */

/**
 * The prepare pump a panel's runs register with, for the steps the panel
 * prepares ahead of the measurement (`createTextScale().prepared`). Set by
 * `createPortal` beside `TextScaleContext`, and null wherever that is.
 */
export const TextPrepareContext = createProperty(
  /**
   * @returns {TextPreparer | null}
   */
  () => null,
);

/**
 * A panel's prepare pump: it draws every run at the step the panel is
 * preparing, a run at a time, in whatever time the panels' own pumps leave
 * in the frame, and then uploads the arrays those runs were staged into. The
 * rules it follows are section 5.1 of `docs/freedom-text-step-cache.md`.
 *
 * @param {{
 *   scheduler: PortalScheduler,
 *   batch: TextBatch,
 *   holds: (step: number) => boolean,
 *   upload: (texture: Texture) => void,
 *   now?: () => number,
 * }} options `holds` is the panel's `TextScale.holds`, asked about the step
 *   a retarget moves away from. `upload` is `renderer.initTexture`, which
 *   sends the arrays up before the step that draws from them is shown.
 * @returns {TextPreparer}
 */
export function createTextPreparer({
  scheduler,
  batch,
  holds,
  upload,
  now = () => performance.now(),
}) {
  /** @type {Set<PreparedRun>} */
  const runs = new Set();
  /**
   * The runs still to prepare at `target`, in the order they were queued. A
   * set, so a run queued twice is prepared once.
   *
   * @type {Set<PreparedRun>}
   */
  const queue = new Set();
  /** @type {number | null} */
  let target = null;

  /** @type {PortalPump} */
  const pump = {
    priority: 0,
    idle: true,
    tick: (deadline) => {
      if (target === null) {
        return true;
      }
      for (const run of queue) {
        if (now() >= deadline) {
          return false;
        }
        queue.delete(run);
        const unstaged = run.prepare(target);
        if (unstaged) {
          upload(unstaged);
        }
      }
      if (now() >= deadline) {
        return false;
      }
      return !batch.commitStaged(UPLOAD_BYTES_PER_FRAME, upload);
    },
  };

  /** @param {PreparedRun} run */
  const enqueue = (run) => {
    if (target === null) {
      return;
    }
    queue.add(run);
    scheduler.schedule(pump);
  };

  return {
    register(run) {
      runs.add(run);
      enqueue(run);
    },
    unregister(run) {
      runs.delete(run);
      queue.delete(run);
    },
    requeue: enqueue,
    retarget(step) {
      if (step === target) {
        return;
      }
      const previous = target;
      target = step;
      queue.clear();
      if (step === null) {
        // Nothing to prepare, so nothing to ask frames for.
        scheduler.remove(pump);
      }
      // Rules 3 and 4: what was made for a step the panel no longer holds
      // goes now. A run never lets go of the raster it is showing.
      if (previous !== null && !holds(previous)) {
        for (const run of runs) {
          run.release(previous);
        }
      }
      for (const run of runs) {
        enqueue(run);
      }
    },
    dispose() {
      scheduler.remove(pump);
      queue.clear();
      runs.clear();
      target = null;
    },
  };
}
