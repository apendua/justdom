/**
 * The click a brick makes when it lands: a knock with a little ring left in it,
 * the way two magnets sound when they meet.
 *
 * It is written out sample by sample rather than shipped as a file. Fifty
 * milliseconds of audio would still cost a request and a decode, and the shape
 * of a knock is easy enough to say out loud: a scrape of contact noise on the
 * leading edge, two partials ringing under it, and the whole thing gone before
 * the hand that placed the brick has moved on.
 *
 * Nothing here touches the Web Audio API — a rate goes in and samples come out —
 * so the sound can be tested in Node, and whoever plays it decides how loud it
 * is and where it comes from.
 */

/** How long the click lasts, in seconds. Much longer and it reads as a thud. */
const DURATION = 0.05;

/**
 * What the knock rings at: a frequency in Hz, how loud that partial starts, and
 * how fast it dies away (bigger decays are shorter). Two of them, a little over
 * an octave apart and deliberately not in a whole-number ratio, so the result
 * sounds like something solid being struck rather than like a beep.
 */
const PARTIALS = [
  { frequency: 1650, gain: 1, decay: 150 },
  { frequency: 2780, gain: 0.55, decay: 320 },
];

/**
 * The noise of two surfaces touching. It is what makes the click read as
 * contact rather than as a note, and it is over almost immediately — by five
 * milliseconds there is nothing left of it.
 */
const NOISE_GAIN = 0.45;
const NOISE_DECAY = 900;

/**
 * Fades at either end, in seconds. A waveform that starts or stops away from
 * zero is a step, and a step through a speaker is a pop on top of the click.
 * The attack is short enough that the knock still sounds sudden.
 */
const ATTACK = 0.001;
const RELEASE = 0.006;

/** Any non-zero start for the noise. Fixed, so the click never changes. */
const SEED = 0x9e3779b9;

/**
 * One click, mono, at the given sample rate, scaled so its loudest sample is
 * exactly one — loudness belongs to whoever plays it, not to the waveform.
 *
 * The noise comes from a seeded generator rather than `Math.random`, so every
 * placement in every session makes the same sound, and the sound can be
 * asserted on.
 *
 * @param {number} sampleRate samples per second, e.g. `audioContext.sampleRate`
 * @returns {Float32Array<ArrayBuffer>} samples in [-1, 1], ready for
 *   `AudioBuffer.copyToChannel`
 */
export function createClickWaveform(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`Sample rate must be a positive number, got ${sampleRate}`);
  }
  const length = Math.max(1, Math.round(DURATION * sampleRate));
  const samples = new Float32Array(length);
  let noise = SEED | 0;
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    let value = 0;
    for (const partial of PARTIALS) {
      value +=
        partial.gain * Math.exp(-partial.decay * t) * Math.sin(2 * Math.PI * partial.frequency * t);
    }
    // xorshift32: cheap, and the same grain of noise every time.
    noise ^= noise << 13;
    noise ^= noise >>> 17;
    noise ^= noise << 5;
    value += NOISE_GAIN * Math.exp(-NOISE_DECAY * t) * (noise / 0x80000000);
    value *= Math.min(1, t / ATTACK, (DURATION - t) / RELEASE);
    samples[i] = value;
    peak = Math.max(peak, Math.abs(value));
  }
  if (peak > 0) {
    for (let i = 0; i < length; i += 1) {
      samples[i] /= peak;
    }
  }
  return samples;
}
