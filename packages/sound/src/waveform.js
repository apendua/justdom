/**
 * What every waveform written out in code needs, whatever it sounds like: a
 * check on the rate it is asked for, a noise that is the same every time,
 * and a last pass that makes its loudest sample exactly one. Then the sweep,
 * one frequency slide, which most noises that are not a click are made of.
 *
 * The click is built from these, and so is any app's own noise, so that a
 * sound which is not a click need not carry a copy of them.
 */

/** Any non-zero start for the noise. Fixed, so a sound never changes. */
const SEED = 0x9e3779b9;

/**
 * Refuse a rate a waveform cannot be written at.
 *
 * @param {number} sampleRate
 * @returns {void}
 */
export function checkSampleRate(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`Sample rate must be a positive number, got ${sampleRate}`);
  }
}

/**
 * White noise in [-1, 1), from xorshift32: cheap, and the same grain every
 * time, so a sound made with it can be asserted on.
 *
 * @returns {() => number}
 */
export function createNoise() {
  let state = SEED | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state / 0x80000000;
  };
}

/**
 * Scale a waveform in place so its loudest sample is exactly one, and return
 * it: loudness belongs to whoever plays it, not to the waveform. A silent
 * one is left as it is.
 *
 * @template {Float32Array} T
 * @param {T} samples
 * @returns {T}
 */
export function normalize(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  if (peak > 0) {
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] /= peak;
    }
  }
  return samples;
}

/**
 * Fades at either end of a sweep, in seconds, so no step ever reaches the
 * speaker as a pop.
 */
const ATTACK = 0.002;
const RELEASE = 0.01;

/**
 * @typedef {object} Sweep
 * @property {number} from Where the slide starts, in Hz.
 * @property {number} to Where it ends, in Hz.
 * @property {number} duration How long it takes, in seconds.
 * @property {number} decay How fast the sound dies under the slide; bigger
 *   is shorter.
 * @property {number} edge How much second harmonic rides on the
 *   fundamental.
 * @property {number} noise How much noise sits on the onset, gone within a
 *   few milliseconds: the contact that starts the note.
 */

/**
 * One frequency slide, mono, loudest sample exactly one: a pluck rising, a
 * thump sinking, a note falling away. The slide is exponential, which is how
 * a pitch change reads as one gesture rather than as a siren.
 *
 * @param {number} sampleRate samples per second, e.g. `audioContext.sampleRate`
 * @param {Sweep} sweep
 * @returns {Float32Array<ArrayBuffer>}
 */
export function createSweepWaveform(sampleRate, { from, to, duration, decay, edge, noise }) {
  checkSampleRate(sampleRate);
  const length = Math.max(1, Math.round(duration * sampleRate));
  const samples = new Float32Array(length);
  const hiss = createNoise();
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const frequency = from * Math.pow(to / from, t / duration);
    phase += (2 * Math.PI * frequency) / sampleRate;
    let value = Math.sin(phase) + edge * Math.sin(2 * phase);
    value *= Math.exp(-decay * t);
    value += noise * Math.exp(-400 * t) * hiss();
    value *= Math.min(1, t / ATTACK, (duration - t) / RELEASE);
    samples[i] = value;
  }
  return normalize(samples);
}
