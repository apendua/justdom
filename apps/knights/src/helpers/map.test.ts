import { describe, expect, it } from "vitest";
import {
  areTheSameField,
  createMapOfDistances,
  createMapOfObstacles,
  findPathTo,
  generateFields,
  getMapValue,
} from "./map";
import { createNeighborsGenerator, isNeighbor } from "./neighbors";

describe("createMapOfObstacles", () => {
  it("marks the given fields and nothing else", () => {
    const map = createMapOfObstacles(3, 3, [
      { row: 0, column: 1 },
      { row: 2, column: 2 },
    ]);
    expect(getMapValue({ row: 0, column: 1 }, map)).toBe(true);
    expect(getMapValue({ row: 2, column: 2 }, map)).toBe(true);
    expect(getMapValue({ row: 1, column: 1 }, map)).toBe(false);
  });

  it("merges several sets of obstacles", () => {
    const map = createMapOfObstacles(3, 3, [{ row: 0, column: 0 }], [{ row: 1, column: 1 }]);
    expect(getMapValue({ row: 0, column: 0 }, map)).toBe(true);
    expect(getMapValue({ row: 1, column: 1 }, map)).toBe(true);
  });

  it("ignores fields that are off the map", () => {
    const map = createMapOfObstacles(2, 2, [
      { row: -1, column: -1 },
      { row: 5, column: 5 },
    ]);
    expect(map.flat().every((value) => value === false)).toBe(true);
  });
});

describe("createMapOfDistances", () => {
  it("puts the origin at distance zero and its neighbors at one", () => {
    const origin = { row: 2, column: 2 };
    const distances = createMapOfDistances(6, 6, origin);
    const neighbors = createNeighborsGenerator(6, 6);

    expect(getMapValue(origin, distances)).toBe(0);
    for (const neighbor of neighbors(origin)) {
      expect(getMapValue(neighbor, distances)).toBe(1);
    }
  });

  it("reaches every field of an open map", () => {
    const distances = createMapOfDistances(6, 6, { row: 0, column: 0 });
    for (const field of generateFields(6, 6)) {
      expect(Number.isFinite(getMapValue(field, distances))).toBe(true);
    }
  });

  it("never counts a step that isn't there", () => {
    const distances = createMapOfDistances(6, 6, { row: 3, column: 3 });
    const neighbors = createNeighborsGenerator(6, 6);

    for (const field of generateFields(6, 6)) {
      const distance = getMapValue(field, distances) ?? Infinity;
      if (distance === 0) {
        continue;
      }
      // Any field at distance n has to sit next to one at distance n - 1.
      const closest = Math.min(
        ...Array.from(neighbors(field), (n) => getMapValue(n, distances) ?? Infinity),
      );
      expect(distance).toBe(closest + 1);
    }
  });

  it("leaves fields walled off by obstacles unreachable", () => {
    const origin = { row: 2, column: 2 };
    const trapped = { row: 4, column: 4 };
    const neighbors = createNeighborsGenerator(6, 6);
    const wall = Array.from(neighbors(trapped));
    const distances = createMapOfDistances(6, 6, origin, createMapOfObstacles(6, 6, wall));

    expect(getMapValue(trapped, distances)).toBe(Infinity);
    for (const field of wall) {
      expect(getMapValue(field, distances)).toBe(Infinity);
    }
  });

  it("treats an obstacle on the origin as a field you can leave but not enter", () => {
    const origin = { row: 0, column: 0 };
    const distances = createMapOfDistances(3, 3, origin, createMapOfObstacles(3, 3, [origin]));
    expect(getMapValue(origin, distances)).toBe(0);
  });
});

describe("findPathTo", () => {
  it("walks from the origin to the target, one neighbor at a time", () => {
    const origin = { row: 0, column: 0 };
    const target = { row: 5, column: 4 };
    const neighbors = createNeighborsGenerator(6, 6);
    const distances = createMapOfDistances(6, 6, origin, createMapOfObstacles(6, 6, []));
    const path = findPathTo(target, neighbors, distances);

    expect(areTheSameField(path[0], origin)).toBe(true);
    expect(areTheSameField(path[path.length - 1], target)).toBe(true);
    expect(path).toHaveLength((getMapValue(target, distances) ?? -1) + 1);

    for (let i = 1; i < path.length; i += 1) {
      expect(isNeighbor(path[i - 1], path[i])).toBe(true);
    }
  });

  it("goes around obstacles", () => {
    const origin = { row: 0, column: 0 };
    const target = { row: 4, column: 0 };
    const obstacles = [
      { row: 2, column: 0 },
      { row: 2, column: 1 },
    ];
    const neighbors = createNeighborsGenerator(6, 6);
    const distances = createMapOfDistances(6, 6, origin, createMapOfObstacles(6, 6, obstacles));
    const path = findPathTo(target, neighbors, distances);

    expect(path.length).toBeGreaterThan(0);
    for (const field of path) {
      expect(obstacles.some((o) => areTheSameField(o, field))).toBe(false);
    }
  });

  it("returns nothing when the target cannot be reached", () => {
    const origin = { row: 2, column: 2 };
    const trapped = { row: 4, column: 4 };
    const neighbors = createNeighborsGenerator(6, 6);
    const wall = Array.from(neighbors(trapped));
    const distances = createMapOfDistances(6, 6, origin, createMapOfObstacles(6, 6, wall));

    expect(findPathTo(trapped, neighbors, distances)).toEqual([]);
  });

  it("returns a single field when the target is the origin", () => {
    const origin = { row: 1, column: 1 };
    const neighbors = createNeighborsGenerator(4, 4);
    const distances = createMapOfDistances(4, 4, origin);

    expect(findPathTo(origin, neighbors, distances)).toEqual([origin]);
  });
});
