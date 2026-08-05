/**
 * Clicks, sounded where they happen.
 *
 * `createClickWaveform` says what the click sounds like; this says where it
 * comes from. A handful of `PositionalAudio` voices are parented to one object —
 * the board a brick lands on — so a click asked for at a point in that object's
 * own coordinates is heard from that point in the room.
 *
 * There are several voices because one is not enough. A single node cannot play
 * two clicks at once, and placing bricks quickly is exactly what these apps are
 * for; the voices are used in turn, so a click only ever cuts off one that is
 * already several placements old.
 */
import * as THREE from "three";
import { createClickWaveform } from "./click.js";

export interface ClicksOptions {
  /** How many clicks may overlap before the oldest is cut short. */
  voices?: number;
  /**
   * How far away the click starts getting quieter, in metres. The boards in
   * these apps are about a metre square on the far side of arm's length, so
   * the default is roughly "the near edge": near the middle a click is at full
   * volume, and across the board it is clearly further off without becoming
   * inaudible.
   */
  refDistance?: number;
  /** Loud enough to be felt as contact, quiet enough to sit under the music. */
  volume?: number;
}

export interface Clicks {
  /**
   * Holds the voices. Add it to whichever object the positions passed to
   * `play` are measured from — the board, not the scene.
   */
  readonly object: THREE.Object3D;
  /** Sound a click at a point, in that object's own coordinates. */
  play(position: THREE.Vector3): void;
}

const defaults = {
  voices: 4,
  refDistance: 0.25,
  volume: 0.35,
} satisfies Required<ClicksOptions>;

export function createClicks(listener: THREE.AudioListener, options: ClicksOptions = {}): Clicks {
  const { voices: count, refDistance, volume } = { ...defaults, ...options };
  const object = new THREE.Group();
  const { context } = listener;
  const waveform = createClickWaveform(context.sampleRate);
  const buffer = context.createBuffer(1, waveform.length, context.sampleRate);
  buffer.copyToChannel(waveform, 0);

  const voices = Array.from({ length: count }, () => {
    const voice = new THREE.PositionalAudio(listener);
    voice.setBuffer(buffer);
    voice.setRefDistance(refDistance);
    voice.setVolume(volume);
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
