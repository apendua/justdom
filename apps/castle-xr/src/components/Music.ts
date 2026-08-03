import * as THREE from "three";
import { component, Derived, effectMap, effects, memoizeDerived, onCleanup } from "@apendua/signal";
import { $, session } from "@apendua/freedom";
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

const Music = component((ctx: WeakKey, listener: THREE.AudioListener) => {
  return $(new THREE.Audio(listener), [
    effectMap((audio) => {
      return session(ctx).pipe(
        switchMap((xrSession$) => {
          return xrSession$.pipe(
            effects(() => {
              audio.setBuffer(loadSound(glass_desk_habits));
              audio.setVolume(0.5);
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
});

export default Music;
