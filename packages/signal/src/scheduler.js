import UpdateQueue from "./UpdateQueue.js";
import UpdateChannel from "./UpdateChannel.js";

/**
 * The channel everything schedules in unless an effect says otherwise.
 *
 * Its order is fixed at 0. Automatic order correction exists to sort out
 * channels somebody introduced and guessed the order of; the default channel
 * is not a guess, and quietly moving it would reorder every effect in a
 * program that never asked for channels at all.
 */
export const defaultChannel = new UpdateChannel({ name: "default", order: 0, fixedOrder: true });

/** The one queue every effect in the process schedules in. */
export const updateQueue = new UpdateQueue(defaultChannel);

/**
 * Run `fn`, holding every effect it invalidates until it returns.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function batch(fn) {
  return updateQueue.batch(fn);
}
