import { YEAR_MAX, YEAR_MIN } from "../looks";
import type { TableState } from "./TableState";

/** Years the discovery view plays through each tick, and the tick, in ms. */
export const PLAY_STEP = 2;
export const PLAY_TICK = 60;

export interface Player {
  /** Plays from the year shown, or from 1600 at the end; pauses if playing. */
  toggle(): void;
  /** Pauses, and takes the timer down with it. */
  stop(): void;
}

/**
 * Plays the discovery view's years from 1600 to today, on one timer. A
 * timer, not `requestAnimationFrame`, since the page's animation frames
 * stop while a headset session has the display.
 *
 * The handle is kept here, so that a pause takes the timer down at once.
 * A pause that only cleared `playing` left the timer to notice on its next
 * tick, and a play within that tick started a second timer beside it.
 */
export function createPlayer(state: TableState): Player {
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    state.playing = false;
  };

  const start = () => {
    stop();
    if (state.year >= YEAR_MAX) {
      state.year = YEAR_MIN;
    }
    state.playing = true;
    timer = setInterval(() => {
      if (state.mode !== "discovery") {
        stop();
        return;
      }
      state.year = Math.min(YEAR_MAX, state.year + PLAY_STEP);
      if (state.year >= YEAR_MAX) {
        stop();
      }
    }, PLAY_TICK);
  };

  return {
    toggle: () => (state.playing ? stop() : start()),
    stop,
  };
}
