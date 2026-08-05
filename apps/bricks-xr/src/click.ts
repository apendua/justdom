/**
 * The click a brick makes when it lands, sounded where it landed.
 *
 * The waveform comes from `@apendua.dev/media` — a knock with a little ring in
 * it, the way two magnets sound when they meet — and everything here is about
 * putting it in the room: a handful of `PositionalAudio` voices parented to the
 * board, so a brick placed at the far corner is heard from the far corner.
 *
 * There are several voices because one is not enough. A single node cannot play
 * two clicks at once, and placing bricks quickly is exactly what the game is
 * for; the voices are used in turn, so a click only ever cuts off one that is
 * already three placements old.
 */
import * as THREE from "three";
import { createClickWaveform } from "@apendua.dev/media";

/** How many clicks may overlap before the oldest is cut short. */
const VOICES = 4;

/**
 * How far away the click starts getting quieter, in metres. The board is a
 * metre square on the far side of it, so this is roughly "the near edge": near
 * the middle the click is at full volume, and across the board it is clearly
 * further off without becoming inaudible.
 */
const REFERENCE_DISTANCE = 0.25;

/** Loud enough to be felt as contact, and no louder. */
const VOLUME = 0.35;

export interface Clicks {
  /**
   * Holds the voices. Add it to whichever object the positions passed to
   * `play` are measured from — the board, not the scene.
   */
  readonly object: THREE.Object3D;
  /** Sound a click at a point, in that object's own coordinates. */
  play(position: THREE.Vector3): void;
}

export function createClicks(listener: THREE.AudioListener): Clicks {
  const object = new THREE.Group();
  const { context } = listener;
  const waveform = createClickWaveform(context.sampleRate);
  const buffer = context.createBuffer(1, waveform.length, context.sampleRate);
  buffer.copyToChannel(waveform, 0);

  const voices = Array.from({ length: VOICES }, () => {
    const voice = new THREE.PositionalAudio(listener);
    voice.setBuffer(buffer);
    voice.setRefDistance(REFERENCE_DISTANCE);
    voice.setVolume(VOLUME);
    object.add(voice);
    return voice;
  });
  let next = 0;

  return {
    object,
    play(position) {
      // Audio is not allowed to start before the page has been interacted
      // with, and a context created too early stays suspended until it is
      // asked. Placing a brick is an interaction, so asking here is enough.
      if (context.state === "suspended") {
        void context.resume().catch(() => {});
      }
      const voice = voices[next];
      next = (next + 1) % voices.length;
      if (voice.isPlaying) {
        voice.stop();
      }
      voice.position.copy(position);
      voice.play();
      // The panner follows the object only while the sound is playing, and it
      // is read as the note starts. Moving the voice after `play` rather than
      // waiting for the next frame is what keeps the click at the brick
      // instead of wherever the last one landed.
      voice.updateMatrixWorld(true);
    },
  };
}
