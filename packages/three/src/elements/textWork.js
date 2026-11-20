import { sceneService } from "../sceneServices.js";

/**
 * The longest the prepare pumps of a scene's panels went without looking at
 * the frame's deadline, which is the longest one piece of their work took.
 * A pump stops between pieces when the frame's time is up and cannot stop
 * inside one, so a piece is what a frame can lose to preparing a step
 * (`createTextPreparer`). How much a pump did in a frame is not here: that
 * is about what the frame had left, whatever the pieces cost.
 *
 * The two are the two kinds of piece. Drawing is all a worker could take
 * off the frame. Uploading has to stay on the thread that owns the GL
 * context.
 *
 * Each is a maximum since it was last set to zero, and the pumps only raise
 * it. Whoever reads the account sets it back, so it has one reader: with
 * two, each would miss what the other cleared.
 *
 * @typedef {object} TextWork
 * @property {number} longestDrawMs Milliseconds the longest `prepare` of
 *   one run took: its text drawn on a 2D canvas and copied into its layer.
 * @property {number} longestUploadMs Milliseconds the longest upload took:
 *   one texture a run handed back, or one frame's share of the staged
 *   arrays, built and sent up. It is the time the calls took to return on
 *   this thread. What the GPU process then does with the pixels, the copy
 *   and the mipmaps, is not in it and can land in a later frame, so a small
 *   reading does not say that uploads are cheap.
 */

/** @returns {TextWork} */
const createTextWork = () => ({ longestDrawMs: 0, longestUploadMs: 0 });

/**
 * The account of the scene `ctx` is under, and null outside a scene, where
 * a panel's pump keeps none.
 *
 * @param {WeakKey} ctx
 * @returns {TextWork | null}
 */
export function textWork(ctx) {
  return sceneService(ctx, createTextWork);
}
