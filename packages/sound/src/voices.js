/**
 * A waveform, sounded where it happens.
 *
 * A waveform says what a sound is; this says where it comes from. A handful
 * of `PositionalAudio` voices playing it are parented to one object, such as
 * the board a brick lands on or the table a ball rolls across, so a sound
 * asked for at a point in that object's own coordinates is heard from that
 * point in the room.
 *
 * There are several voices because one is not enough. A single node cannot
 * play two notes at once, and the events these sounds answer come quickly;
 * the voices are used in turn, so a note only ever cuts off one that is
 * already several notes old.
 */
import * as THREE from "three";

/**
 * @typedef {object} VoicesOptions
 * @property {number} [voices] How many notes may overlap before the oldest
 *   is cut short.
 * @property {number} [refDistance] How far away the sound starts getting
 *   quieter, in metres. The boards in these apps are about a metre square on
 *   the far side of arm's length, so the default is roughly "the near edge":
 *   near the middle a sound is at full volume, and across the board it is
 *   clearly further off without becoming inaudible.
 * @property {number} [volume] Loud enough to be felt as contact, quiet enough
 *   to sit under the music.
 * @property {() => number} [gain] A multiplier over `volume`, read as each
 *   note is played rather than held as a number — so an app whose player can
 *   turn its noises down gets the new setting on the next note without
 *   rebuilding the voices. One is `volume` as given; zero is silence.
 */

/**
 * @typedef {object} Voices
 * @property {THREE.Object3D} object Holds the voices. Add it to whichever
 *   object the positions passed to `play` are measured from — the board, not
 *   the scene.
 * @property {(position: THREE.Vector3, loudness?: number) => void} play Sound
 *   the waveform at a point, in that object's own coordinates. `loudness`
 *   scales this one note, from 0 to 1, for a sound that is harder or softer
 *   with what made it; 1 when left out.
 */

/** @type {Required<VoicesOptions>} */
const defaults = {
  voices: 4,
  refDistance: 0.25,
  volume: 0.35,
  gain: () => 1,
};

/**
 * A multiplier as a volume can take it: nothing for one that is not a
 * number, and nothing below silence.
 *
 * @param {number} value
 * @returns {number}
 */
function level(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * @param {THREE.AudioListener} listener
 * @param {Float32Array<ArrayBuffer>} samples mono, at the listener's context's
 *   sample rate
 * @param {VoicesOptions} [options]
 * @returns {Voices}
 */
export function createVoices(listener, samples, options = {}) {
  const { voices: count, refDistance, volume, gain } = { ...defaults, ...options };
  const object = new THREE.Group();
  const { context } = listener;
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);

  const voices = Array.from({ length: count }, () => {
    const voice = new THREE.PositionalAudio(listener);
    voice.setBuffer(buffer);
    voice.setRefDistance(refDistance);
    // The volume is set as the note is played and not here: what `gain`
    // answers may have changed since the voice was made.
    object.add(voice);
    return voice;
  });
  let next = 0;

  return {
    object,
    play(position, loudness = 1) {
      // Audio is not allowed to start before the page has been interacted
      // with, and a context created too early stays suspended until it is
      // asked. Every sound here answers something the player did, so asking
      // here is enough.
      if (context.state === "suspended") {
        void context.resume().catch(() => {});
      }
      const voice = voices[next];
      next = (next + 1) % voices.length;
      if (voice.isPlaying) {
        voice.stop();
      }
      voice.setVolume(volume * level(gain()) * level(loudness));
      voice.position.copy(position);
      voice.play();
      // The panner follows the object only while the sound is playing, and it
      // is read as the note starts. Moving the voice after `play` rather than
      // waiting for the next frame is what keeps the note where it was asked
      // for instead of wherever the last one sounded.
      voice.updateMatrixWorld(true);
    },
  };
}
