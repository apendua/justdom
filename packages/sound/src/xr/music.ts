/**
 * The soundtrack: one looping track, tied to the life of an XR session.
 *
 * Every headset app in the repo had written this out for itself, and the six
 * copies had drifted only in the track they loaded and the volume they started
 * at — so those are what this asks for, and the rest lives here.
 */
import * as THREE from "three";
import {
  component,
  Derived,
  effectMap,
  effects,
  memoizeDerived,
  onCleanup,
  Signal,
} from "@apendua/signal";
import { $, session, type Component } from "@apendua/freedom";
import { Observable, switchMap } from "rxjs";
import {
  audioOutputSelection,
  setAudioOutput,
  type AudioOutputSelection,
} from "../audioOutputs.js";

/**
 * One decoded track per URL, however many components ask for it. Memoized on
 * the path rather than fetched per player: a track swapped back and forth is a
 * common enough thing for it to be worth not decoding twice.
 */
const loadSound = memoizeDerived((path: string) => {
  return Derived.from(
    new Observable<AudioBuffer>((subscriber) => {
      const loader = new THREE.AudioLoader();
      loader.load(
        path,
        (buffer) => {
          subscriber.next(buffer);
        },
        () => {},
        (error) => {
          subscriber.error(error);
        },
      );
      return () => {};
    }),
  );
});

/** Where the volume starts when an app does not say. */
export const DEFAULT_MUSIC_VOLUME = 0.5;

export interface MusicOptions {
  /**
   * The track to loop, as a URL — an asset import out of `@apendua.dev/media`
   * in every app here, but anything the `AudioLoader` can fetch will do.
   */
  track: string;
  /**
   * Where the volume starts, from 0 for silence to 1 for as loud as the track
   * was recorded. Apps that have their own noises to be heard over generally
   * want less than the default.
   */
  volume?: number;
}

/**
 * How the soundtrack is set, held apart from the component that plays it: the
 * music starts wherever the scene is built, while the panel that turns it down
 * is usually several routes away, and both reach it through this.
 */
export interface MusicControls {
  /** From 0 for silence to 1 for as loud as the track was recorded. */
  volume: Signal<number>;
  /** Which device the soundtrack comes out of. */
  output: AudioOutputSelection;
  /** Moves the volume by a number of tenths, stopping at silence and at full. */
  step: (steps: number) => void;
  /** The track being looped, which is what `Music` goes and fetches. */
  readonly track: string;
}

export function createMusicControls({
  track,
  volume: initial = DEFAULT_MUSIC_VOLUME,
}: MusicOptions): MusicControls {
  const volume = Signal.of(initial);
  const output = audioOutputSelection();
  return {
    volume,
    output,
    track,
    // Tenths, rounded, so the readout stays on round numbers however many
    // presses in the player is.
    step: (steps) => {
      volume.setFn((current) => {
        return Math.min(10, Math.max(0, Math.round(current * 10) + steps)) / 10;
      });
    },
  };
}

/**
 * Background music, started when an XR session begins and stopped when it ends.
 * Tying it to the session rather than to page load keeps it out of the way of
 * autoplay policy, and means the browser tab stays silent until the headset
 * goes on.
 */
export const Music: (
  ctx: WeakKey,
  listener: THREE.AudioListener,
  controls: MusicControls,
) => Observable<Component> = component(
  (ctx: WeakKey, listener: THREE.AudioListener, controls: MusicControls) => {
    return $(new THREE.Audio(listener), [
      // Volume is kept out of the session effect below, so turning it down
      // takes the gain of the track that is playing rather than starting it
      // over from the top.
      effects((audio) => {
        audio.setVolume(controls.volume.get());
      }),
      // Which devices are around is only worth following while there is music
      // that could come out of them.
      effectMap(() => controls.output.updates),
      effects(() => {
        const deviceId = controls.output.deviceId.get();
        if (deviceId) {
          void setAudioOutput(listener.context, deviceId);
        }
      }),
      effectMap((audio) => {
        return session(ctx).pipe(
          switchMap((xrSession$) => {
            return xrSession$.pipe(
              effects(() => {
                audio.setBuffer(loadSound(controls.track));
                audio.setLoop(true);
                audio.play();
                onCleanup(() => {
                  audio.stop();
                });
              }),
            );
          }),
        );
      }),
    ]);
  },
);
