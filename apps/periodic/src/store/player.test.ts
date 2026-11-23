import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MENDELEEV_YEAR } from "../data/elements";
import { YEAR_MAX, YEAR_MIN } from "../looks";
import { createPlayer, PLAY_STEP, PLAY_TICK } from "./player";
import { createTableState } from "./TableState";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function discovery(year: number) {
  const state = createTableState();
  state.mode = "discovery";
  state.year = year;
  return state;
}

it("plays a step a tick", () => {
  const state = discovery(MENDELEEV_YEAR);
  createPlayer(state).toggle();
  vi.advanceTimersByTime(10 * PLAY_TICK);
  expect(state.year).toBe(MENDELEEV_YEAR + 10 * PLAY_STEP);
});

it("keeps one timer through a pause and a play within one tick", () => {
  const state = discovery(MENDELEEV_YEAR);
  const player = createPlayer(state);
  player.toggle();
  player.toggle();
  player.toggle();
  vi.advanceTimersByTime(10 * PLAY_TICK);
  expect(state.year).toBe(MENDELEEV_YEAR + 10 * PLAY_STEP);
});

it("stops at once, and stays stopped", () => {
  const state = discovery(MENDELEEV_YEAR);
  const player = createPlayer(state);
  player.toggle();
  player.stop();
  vi.advanceTimersByTime(10 * PLAY_TICK);
  expect(state).toMatchObject({ year: MENDELEEV_YEAR, playing: false });
});

it("starts again from the beginning at the end, and stops at today", () => {
  const state = discovery(YEAR_MAX);
  createPlayer(state).toggle();
  expect(state.year).toBe(YEAR_MIN);
  vi.advanceTimersByTime(((YEAR_MAX - YEAR_MIN) / PLAY_STEP + 5) * PLAY_TICK);
  expect(state).toMatchObject({ year: YEAR_MAX, playing: false });
});

it("stops when the view changes", () => {
  const state = discovery(MENDELEEV_YEAR);
  createPlayer(state).toggle();
  state.mode = "category";
  vi.advanceTimersByTime(3 * PLAY_TICK);
  expect(state).toMatchObject({ year: MENDELEEV_YEAR, playing: false });
});
