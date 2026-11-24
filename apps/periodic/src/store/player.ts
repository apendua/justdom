import { xrSession } from "justdom-xr/session";
import { YEAR_MAX, YEAR_MIN } from "../looks";
import type { TableState } from "./TableState";

/** Years the discovery view plays through each tick, and the tick, in ms. */
export interface Pace {
  step: number;
  tick: number;
}

/** On the page: 33 years a second, in small steps. */
export const PAGE_PACE: Pace = { step: 2, tick: 60 };

/**
 * In a session: 20 years a second, in four steps. Each step is new text
 * and new glows for the panel to draw, so a session takes fewer of them.
 */
export const SESSION_PACE: Pace = { step: 5, tick: 250 };

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
 *
 * Each tick sets the next, at the pace `pace` gives at the time, so a
 * session that starts or ends during playback changes the pace from the
 * next tick on.
 */
export function createPlayer(
  state: TableState,
  pace: () => Pace = () => (xrSession.get() ? SESSION_PACE : PAGE_PACE),
): Player {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    state.playing = false;
  };

  const tick = () => {
    if (state.mode !== "discovery") {
      stop();
      return;
    }
    const { step } = pace();
    state.year = Math.min(YEAR_MAX, state.year + step);
    if (state.year >= YEAR_MAX) {
      stop();
      return;
    }
    timer = setTimeout(tick, pace().tick);
  };

  const start = () => {
    stop();
    if (state.year >= YEAR_MAX) {
      state.year = YEAR_MIN;
    }
    state.playing = true;
    timer = setTimeout(tick, pace().tick);
  };

  return {
    toggle: () => (state.playing ? stop() : start()),
    stop,
  };
}
