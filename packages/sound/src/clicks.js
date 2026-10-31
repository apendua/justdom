/**
 * Clicks, sounded where they happen: `createClickWaveform` played through
 * `createVoices`, so a click asked for at a point on the board a brick lands
 * on is heard from that point in the room.
 */
import { createClickWaveform } from "./click.js";
import { createVoices } from "./voices.js";

/**
 * @typedef {import('./voices.js').VoicesOptions} ClicksOptions
 */

/**
 * @typedef {import('./voices.js').Voices} Clicks
 */

/**
 * @param {import('three').AudioListener} listener
 * @param {ClicksOptions} [options]
 * @returns {Clicks}
 */
export function createClicks(listener, options = {}) {
  return createVoices(listener, createClickWaveform(listener.context.sampleRate), options);
}
