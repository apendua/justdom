import { createProperty } from "justdom-signal";

/**
 * @import {PortalPump, PortalScheduler} from './portal/portalScheduler.js';
 * @import {Texture} from 'three';
 * @import {TextBatch} from './paint/textBatch.js';
 * @import {TextWork} from './textWork.js';
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
 * @property {(step: number) => boolean} ready Whether `step` is the step
 *   being prepared and the pump has nothing left to do for it: every run
 *   the panel had is drawn at it, and every array they were staged into is
 *   uploaded. What `createTextScale().measure` waits for before it shows a
 *   step. A run added or changed since is not ready until the pump has
 *   been round again.
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
 * in the frame, and then uploads the arrays those runs were staged into.
 * The panel shows the step once the pump says it is `ready`. The rules it
 * follows are section 5.1 of `docs/freedom-text-step-cache.md`.
 *
 * @param {{
 *   scheduler: PortalScheduler,
 *   batch: TextBatch,
 *   holds: (step: number) => boolean,
 *   upload: (texture: Texture) => void,
 *   work?: TextWork | null,
 *   now?: () => number,
 * }} options `holds` is the panel's `TextScale.holds`, asked about the step
 *   a retarget moves away from. `upload` is `renderer.initTexture`, which
 *   sends the arrays up before the step that draws from them is shown.
 *   `work` is the scene's account of what its pumps spend (`textWork`),
 *   which this one adds its drawing and uploading to.
 * @returns {TextPreparer}
 */
export function createTextPreparer({
  scheduler,
  batch,
  holds,
  upload,
  work = null,
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
  /**
   * Whether the pump has drawn every queued run at `target` and uploaded
   * every array it staged them into. False from the moment a run is queued
   * until the tick that finds nothing left.
   */
  let complete = false;

  /** @type {PortalPump} */
  const pump = {
    priority: 0,
    idle: true,
    tick: (deadline) => {
      if (target === null) {
        return true;
      }
      // The clock is read once after each piece of work, and that reading
      // both ends the piece in the account and is checked against the
      // deadline before the next.
      let time = now();
      for (const run of queue) {
        if (time >= deadline) {
          return false;
        }
        queue.delete(run);
        const unstaged = run.prepare(target);
        const drawn = now();
        if (work) {
          work.drawMs += drawn - time;
          work.runs += 1;
        }
        time = drawn;
        if (unstaged) {
          upload(unstaged);
          time = now();
          if (work) {
            work.uploadMs += time - drawn;
          }
        }
      }
      if (time >= deadline) {
        return false;
      }
      complete = !batch.commitStaged(UPLOAD_BYTES_PER_FRAME, upload);
      if (work) {
        work.uploadMs += now() - time;
      }
      return complete;
    },
  };

  /** @param {PreparedRun} run */
  const enqueue = (run) => {
    if (target === null) {
      return;
    }
    queue.add(run);
    complete = false;
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
      complete = false;
      if (step === null) {
        // Nothing to prepare, so nothing to ask frames for.
        scheduler.remove(pump);
      } else {
        // Even with no run to queue: the tick that finds nothing to do is
        // what says the step is ready.
        scheduler.schedule(pump);
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
    ready: (step) => step === target && complete,
    dispose() {
      scheduler.remove(pump);
      queue.clear();
      runs.clear();
      target = null;
      complete = false;
    },
  };
}
