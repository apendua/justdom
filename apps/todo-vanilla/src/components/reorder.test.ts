import { describe, expect, test } from "vitest";
import { slotBefore } from "./reorder.js";

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
