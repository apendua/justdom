import { $, set } from "justdom";
import { component, effects, onCleanup } from "justdom-signal";
import stepsToTheThrone from "../assets/steps_to_the_throne.mp3";

const MUSIC_VOLUME = 0.4;

/**
 * The battle theme, looped quietly in the background for as long as the game is
 * mounted. Browsers refuse to play audio with sound until the page has seen a
 * user gesture, so playback is attempted right away and, if the browser turned
 * it down, retried on the first click or keypress.
 */
const Music = component((_ctx: WeakKey) => {
  return $("audio", [
    set({ loop: true, volume: MUSIC_VOLUME, src: stepsToTheThrone }),
    effects((audio) => {
      const stopWaiting = () => {
        document.removeEventListener("pointerdown", resume);
        document.removeEventListener("keydown", resume);
      };
      const resume = () => {
        audio
          .play()
          .then(stopWaiting)
          .catch(() => {});
      };
      audio
        .play()
        .then(stopWaiting)
        .catch(() => {
          document.addEventListener("pointerdown", resume);
          document.addEventListener("keydown", resume);
        });
      onCleanup(() => {
        stopWaiting();
        audio.pause();
      });
    }),
  ]);
});

export default Music;
