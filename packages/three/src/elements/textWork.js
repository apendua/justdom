import { sceneService } from "../sceneServices.js";

/**
 * What the prepare pumps of a scene's panels have spent, added up since the
 * scene began. The totals only grow, so a reader keeps the last value it saw
 * and takes the difference: once a frame for what that frame cost.
 *
 * The two times are the two halves of preparing a step
 * (`createTextPreparer`). Drawing is all a worker could take off the frame.
 * Uploading has to stay on the thread that owns the GL context.
 *
 * @typedef {object} TextWork
 * @property {number} drawMs Milliseconds spent in the runs' `prepare`: the
 *   text drawn on a 2D canvas and copied into its layer.
 * @property {number} uploadMs Milliseconds spent building the staged arrays
 *   and sending textures to the GPU.
 * @property {number} runs How many runs the pumps were through.
 */

/** @returns {TextWork} */
const createTextWork = () => ({ drawMs: 0, uploadMs: 0, runs: 0 });

/**
 * The totals for the scene `ctx` is under, and null outside a scene, where
 * a panel's pump keeps no account. The pumps add to the object returned;
 * anything else only reads it.
 *
 * @param {WeakKey} ctx
 * @returns {TextWork | null}
 */
export function textWork(ctx) {
  return sceneService(ctx, createTextWork);
}
