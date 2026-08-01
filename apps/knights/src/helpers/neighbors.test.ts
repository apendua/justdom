import { describe, expect, it } from "vitest";
import { createNeighborsGenerator, getDirection, isNeighbor } from "./neighbors";
import { generateFields } from "./map";
import type { FieldCoords } from "../types";

/**
 * The direction pointing the other way. It's the same flip an actor applies
 * when it turns to face the blow it is taking.
 */
function flip(direction: number): number {
  return direction > 0 ? direction - 4 : direction + 4;
}

describe("getDirection", () => {
  it("returns 0 for a field and itself", () => {
    expect(getDirection({ row: 3, column: 4 }, { row: 3, column: 4 })).toBe(0);
  });

  it("returns 0 for fields that are too far apart", () => {
    expect(getDirection({ row: 0, column: 0 }, { row: 0, column: 2 })).toBe(0);
    expect(getDirection({ row: 0, column: 0 }, { row: 2, column: 0 })).toBe(0);
  });

  it("returns 0 for the two diagonals that are not neighbors", () => {
    // On an even row the grid is shifted left, so the field up and to the
    // right is a whole hexagon away.
    expect(getDirection({ row: 2, column: 2 }, { row: 1, column: 3 })).toBe(0);
    // On an odd row it's the other way around.
    expect(getDirection({ row: 1, column: 2 }, { row: 0, column: 1 })).toBe(0);
  });

  it("walks east and west", () => {
    expect(getDirection({ row: 2, column: 2 }, { row: 2, column: 3 })).toBe(2);
    expect(getDirection({ row: 2, column: 2 }, { row: 2, column: 1 })).toBe(-2);
  });

  it("names the four diagonals of an even row", () => {
    expect(getDirection({ row: 2, column: 2 }, { row: 1, column: 2 })).toBe(1);
    expect(getDirection({ row: 2, column: 2 }, { row: 3, column: 2 })).toBe(3);
    expect(getDirection({ row: 2, column: 2 }, { row: 1, column: 1 })).toBe(-1);
    expect(getDirection({ row: 2, column: 2 }, { row: 3, column: 1 })).toBe(-3);
  });

  it("names the four diagonals of an odd row", () => {
    expect(getDirection({ row: 1, column: 2 }, { row: 0, column: 3 })).toBe(1);
    expect(getDirection({ row: 1, column: 2 }, { row: 2, column: 3 })).toBe(3);
    expect(getDirection({ row: 1, column: 2 }, { row: 0, column: 2 })).toBe(-1);
    expect(getDirection({ row: 1, column: 2 }, { row: 2, column: 2 })).toBe(-3);
  });

  it("points the other way when the fields are swapped", () => {
    const neighbors = createNeighborsGenerator();
    for (const field of generateFields(6, 6)) {
      for (const neighbor of neighbors(field)) {
        const direction = getDirection(field, neighbor);
        expect(direction).not.toBe(0);
        expect(getDirection(neighbor, field)).toBe(flip(direction));
      }
    }
  });
});

describe("createNeighborsGenerator", () => {
  it("gives every field six distinct neighbors", () => {
    const neighbors = createNeighborsGenerator();
    for (const field of generateFields(6, 6)) {
      const found = Array.from(neighbors(field));
      const keys = new Set(found.map(({ row, column }) => `${row},${column}`));
      expect(found).toHaveLength(6);
      expect(keys.size).toBe(6);
      expect(found.every((n) => isNeighbor(field, n))).toBe(true);
    }
  });

  it("is symmetric", () => {
    const neighbors = createNeighborsGenerator();
    const isAmong = (list: FieldCoords[], { row, column }: FieldCoords) =>
      list.some((f) => f.row === row && f.column === column);

    for (const field of generateFields(6, 6)) {
      for (const neighbor of neighbors(field)) {
        expect(isAmong(Array.from(neighbors(neighbor)), field)).toBe(true);
      }
    }
  });

  it("keeps neighbors inside the map when given its dimensions", () => {
    const neighbors = createNeighborsGenerator(4, 4);
    for (const field of generateFields(4, 4)) {
      for (const { row, column } of neighbors(field)) {
        expect(row).toBeGreaterThanOrEqual(0);
        expect(row).toBeLessThan(4);
        expect(column).toBeGreaterThanOrEqual(0);
        expect(column).toBeLessThan(4);
      }
    }
  });

  it("gives a field outside the map no neighbors at all", () => {
    const neighbors = createNeighborsGenerator(4, 4);
    expect(Array.from(neighbors({ row: -1, column: 0 }))).toHaveLength(0);
    expect(Array.from(neighbors({ row: 0, column: 4 }))).toHaveLength(0);
  });
});
