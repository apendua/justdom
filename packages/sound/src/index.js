export { audioOutputs, audioOutputSelection, setAudioOutput } from "./audioOutputs.js";
export { createClickWaveform } from "./click.js";
export { createClicks } from "./clicks.js";
export { createVoices } from "./voices.js";
export { checkSampleRate, createNoise, createSweepWaveform, normalize } from "./waveform.js";

/**
 * @typedef {import('./audioOutputs.js').AudioOutput} AudioOutput
 */

/**
 * @typedef {import('./audioOutputs.js').AudioOutputSelection} AudioOutputSelection
 */

/**
 * @typedef {import('./clicks.js').Clicks} Clicks
 */

/**
 * @typedef {import('./clicks.js').ClicksOptions} ClicksOptions
 */

/**
 * @typedef {import('./voices.js').Voices} Voices
 */

/**
 * @typedef {import('./voices.js').VoicesOptions} VoicesOptions
 */

/**
 * @typedef {import('./waveform.js').Sweep} Sweep
 */
