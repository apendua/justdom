import * as THREE from "three";
import {
  component,
  Derived,
  effectMap,
  effects,
  memoizeDerived,
  onCleanup,
  Op,
  store,
} from "@apendua/signal";
import { $, session } from "@apendua/freedom";
import { AudioOutputSelection, setAudioOutput } from "@apendua.dev/sound";
import { Observable, switchMap } from "rxjs";
import glass_desk_habits from "@apendua.dev/media/glass_desk_habits.mp3";

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

export interface MusicProps {
  /** From 0 for silence to 1 for as loud as the track was recorded. */
  volume: number;
}

export const DEFAULT_VOLUME = 0.5;

const defaults: MusicProps = { volume: DEFAULT_VOLUME };

const Music = component(
  (
    ctx: WeakKey,
    listener: THREE.AudioListener,
    output: AudioOutputSelection,
    operators: Op<MusicProps>,
  ) => {
    const props = store<MusicProps>(defaults, operators);
    return $(new THREE.Audio(listener), [
      // Volume is kept out of the session effect below, so turning it down
      // takes the gain of the track that is playing rather than starting it
      // over from the top.
      effects((audio) => {
        audio.setVolume(props.volume);
      }),
      // Which devices are around is only worth following while there is music
      // that could come out of them.
      effectMap(() => output.updates),
      effects(() => {
        const deviceId = output.deviceId.get();
        if (deviceId) {
          void setAudioOutput(listener.context, deviceId);
        }
      }),
      effectMap((audio) => {
        return session(ctx).pipe(
          switchMap((xrSession$) => {
            return xrSession$.pipe(
              effects(() => {
                audio.setBuffer(loadSound(glass_desk_habits));
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

export default Music;
