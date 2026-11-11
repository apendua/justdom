import { describe, expect, test } from "vitest";
import { dividerAbove, LIST_TOP, slotBefore } from "./reorder.js";

/** Three 40 px rows with a 4 px gap after each, as the list lays them out. */
function rows(): HTMLElement[] {
  return ["1", "2", "3"].map((id, index) => {
    const row = document.createElement("li");
    row.dataset.id = id;
    const top = index * 44;
    row.getBoundingClientRect = () =>
      ({ top, bottom: top + 40, height: 40, left: 0, right: 100, width: 100 }) as DOMRect;
    return row;
  });
}

describe("slotBefore", () => {
  test("over a row, before it in its upper half and after it in its lower", () => {
    expect(slotBefore(rows(), 50)).toBe("2");
    expect(slotBefore(rows(), 70)).toBe("3");
  });

  test("in the gap between two rows, before the lower one", () => {
    // A drop here lands on the list, not on a row, and used to go last.
    expect(slotBefore(rows(), 42)).toBe("2");
  });

  test("below every row, last", () => {
    expect(slotBefore(rows(), 200)).toBe(null);
  });
});

describe("which divider marks a slot", () => {
  const ids = ["1", "2", "3"];

  test("before the first row, the list's own top border", () => {
    expect(dividerAbove(ids, "1")).toBe(LIST_TOP);
  });

  test("before any other row, the row above it", () => {
    expect(dividerAbove(ids, "2")).toBe("1");
    expect(dividerAbove(ids, "3")).toBe("2");
  });

  test("last, the last row", () => {
    expect(dividerAbove(ids, null)).toBe("3");
  });

  test("last in an empty list, the list's top border", () => {
    expect(dividerAbove([], null)).toBe(LIST_TOP);
  });

  test("before a row that has gone, as last", () => {
    expect(dividerAbove(ids, "9")).toBe("3");
  });
});
