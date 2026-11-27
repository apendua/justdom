import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPointer, SETTLE_MS } from "./pointer";
import { createTableState, FIRST_PINNED, shownElement } from "./TableState";

const IRON = 26;
const COBALT = 27;
const NICKEL = 28;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("shows the hovered element at once on the page", () => {
  const state = createTableState();
  const pointer = createPointer(state, () => false);
  pointer.enter(IRON);
  expect(state).toMatchObject({ hovered: IRON, inspected: IRON });
  pointer.leave(IRON);
  expect(state).toMatchObject({ hovered: null, inspected: null });
  expect(shownElement(state).number).toBe(FIRST_PINNED);
});

it("in a session, shows only where a sweep comes to rest", () => {
  const state = createTableState();
  const pointer = createPointer(state, () => true);
  const seen: number[] = [];
  for (const number of [IRON, COBALT, NICKEL]) {
    pointer.leave(number - 1);
    pointer.enter(number);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    seen.push(shownElement(state).number);
  }
  expect(state.hovered).toBe(NICKEL);
  expect(seen).toEqual([FIRST_PINNED, FIRST_PINNED, FIRST_PINNED]);
  vi.advanceTimersByTime(1);
  expect(shownElement(state).number).toBe(NICKEL);
});

it("in a session, goes back to the pinned element once the ray has left", () => {
  const state = createTableState();
  const pointer = createPointer(state, () => true);
  pointer.enter(IRON);
  vi.advanceTimersByTime(SETTLE_MS);
  pointer.leave(IRON);
  vi.advanceTimersByTime(SETTLE_MS - 1);
  expect(shownElement(state).number).toBe(IRON);
  vi.advanceTimersByTime(1);
  expect(shownElement(state).number).toBe(FIRST_PINNED);
});

it("in a session, a pin before the ray settles shows the pinned element at once", () => {
  const state = createTableState();
  const pointer = createPointer(state, () => true);
  pointer.enter(IRON);
  pointer.pin(IRON);
  expect(state).toMatchObject({ pinned: IRON, inspected: IRON });
});
