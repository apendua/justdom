import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MENDELEEV_YEAR } from "../data/elements";
import { YEAR_MAX, YEAR_MIN } from "../looks";
import { createPlayer, PAGE_PACE, SESSION_PACE, type Pace } from "./player";
import { createTableState } from "./TableState";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const { step: PLAY_STEP, tick: PLAY_TICK } = PAGE_PACE;

function discovery(year: number) {
  const state = createTableState();
  state.mode = "discovery";
  state.year = year;
  return state;
}

it("plays a step a tick", () => {
  const state = discovery(MENDELEEV_YEAR);
  createPlayer(state, () => PAGE_PACE).toggle();
  vi.advanceTimersByTime(10 * PLAY_TICK);
  expect(state.year).toBe(MENDELEEV_YEAR + 10 * PLAY_STEP);
});

it("keeps one timer through a pause and a play within one tick", () => {
  const state = discovery(MENDELEEV_YEAR);
  const player = createPlayer(state, () => PAGE_PACE);
  player.toggle();
  player.toggle();
  player.toggle();
  vi.advanceTimersByTime(10 * PLAY_TICK);
  expect(state.year).toBe(MENDELEEV_YEAR + 10 * PLAY_STEP);
});

it("stops at once, and stays stopped", () => {
  const state = discovery(MENDELEEV_YEAR);
  const player = createPlayer(state, () => PAGE_PACE);
  player.toggle();
  player.stop();
  vi.advanceTimersByTime(10 * PLAY_TICK);
  expect(state).toMatchObject({ year: MENDELEEV_YEAR, playing: false });
});

it("starts again from the beginning at the end, and stops at today", () => {
  const state = discovery(YEAR_MAX);
  createPlayer(state, () => PAGE_PACE).toggle();
  expect(state.year).toBe(YEAR_MIN);
  vi.advanceTimersByTime(((YEAR_MAX - YEAR_MIN) / PLAY_STEP + 5) * PLAY_TICK);
  expect(state).toMatchObject({ year: YEAR_MAX, playing: false });
});

it("stops when the view changes", () => {
  const state = discovery(MENDELEEV_YEAR);
  createPlayer(state, () => PAGE_PACE).toggle();
  state.mode = "category";
  vi.advanceTimersByTime(3 * PLAY_TICK);
  expect(state).toMatchObject({ year: MENDELEEV_YEAR, playing: false });
});

it("plays at the session's pace from the tick after a session starts", () => {
  const state = discovery(MENDELEEV_YEAR);
  let pace: Pace = PAGE_PACE;
  createPlayer(state, () => pace).toggle();
  vi.advanceTimersByTime(PLAY_TICK);
  expect(state.year).toBe(MENDELEEV_YEAR + PLAY_STEP);
  pace = SESSION_PACE;
  // The tick already set goes at the page's time, and takes the
  // session's step; the three after it go at the session's time.
  vi.advanceTimersByTime(PLAY_TICK + 3 * SESSION_PACE.tick);
  expect(state.year).toBe(MENDELEEV_YEAR + PLAY_STEP + 4 * SESSION_PACE.step);
  vi.advanceTimersByTime(SESSION_PACE.tick - 1);
  expect(state.year).toBe(MENDELEEV_YEAR + PLAY_STEP + 4 * SESSION_PACE.step);
});
