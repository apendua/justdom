import { createNeighborsGenerator, type FieldCoords, type NeighborsGenerator } from "./neighbors";

export type { FieldCoords };

/**
 * Return true if the given objects represent the same field.
 */
export function areTheSameField(
  { row: a, column: b }: FieldCoords,
  { row: c, column: d }: FieldCoords,
): boolean {
  return a === c && b === d;
}

/**
 * Safely get the value at the given map coordinates.
 */
export function getMapValue<T>({ row, column }: FieldCoords, map: T[][]): T | undefined {
  return map[row]?.[column];
}

/**
 * Safely set the value at the given map coordinates.
 */
export function setMapValue<T>({ row, column }: FieldCoords, map: T[][], value: T): void {
  const line = map[row];
  if (line && 0 <= column && column < line.length) {
    line[column] = value;
  }
}

/**
 * Create map of obstacles, i.e. a two dimensional array
 * that contains boolean values.
 */
export function createMapOfObstacles(
  nRows: number,
  nColumns: number,
  ...rest: Iterable<FieldCoords>[]
): boolean[][] {
  const map = createMap(nRows, nColumns, () => false);
  for (const obstacles of rest) {
    for (const o of obstacles) {
      setMapValue(o, map, true);
    }
  }
  return map;
}

/**
 * Create map of distances relative to the given field.
 */
export function createMapOfDistances(
  nRows: number,
  nColumns: number,
  { row, column }: FieldCoords,
  mapOfObstacles?: boolean[][],
): number[][] {
  const mapOfDistances = createMap(nRows, nColumns, ({ row: i, column: j }) => {
    return i === row && j === column ? 0 : Infinity;
  });

  const neighborsGenerator = createNeighborsGenerator(nRows, nColumns);

  let currentFields = Array.from(neighborsGenerator({ row, column }));
  let currentDistance = 1;

  while (currentFields.length > 0) {
    const fieldsToUpdate: FieldCoords[] = [];

    for (const field of currentFields) {
      const fieldDistance = getMapValue(field, mapOfDistances);
      const isObstacle = !!mapOfObstacles && getMapValue(field, mapOfObstacles);

      if (isObstacle || fieldDistance === undefined || fieldDistance <= currentDistance) {
        continue;
      }

      setMapValue(field, mapOfDistances, currentDistance);

      for (const neighbor of neighborsGenerator(field)) {
        fieldsToUpdate.push(neighbor);
      }
    }

    currentFields = fieldsToUpdate;
    currentDistance += 1;
  }
  return mapOfDistances;
}

/**
 * Create a two-dimensional array with the given number of rows and columns.
 */
export function createMap<T>(
  nRows: number,
  nColumns: number,
  generator: (field: FieldCoords) => T,
): T[][] {
  const map: T[][] = [];
  for (let row = 0; row < nRows; row += 1) {
    const data: T[] = [];
    for (let column = 0; column < nColumns; column += 1) {
      data.push(generator({ row, column }));
    }
    map.push(data);
  }
  return map;
}

/**
 * Create an iterator that traverses all fields of a rectangular board.
 */
export function* generateFields(nRows: number, nColumns: number): Generator<FieldCoords> {
  for (let row = 0; row < nRows; row += 1) {
    for (let column = 0; column < nColumns; column += 1) {
      yield { row, column };
    }
  }
}

/**
 * Find a path to the given field starting at
 * the field for which the map of distances was computed.
 */
export function findPathTo(
  { row, column }: FieldCoords,
  neighborsGenerator: NeighborsGenerator,
  mapOfDistances: number[][],
  pathSoFar: FieldCoords[] = [],
): FieldCoords[] {
  let currentDistance = getMapValue({ row, column }, mapOfDistances);

  if (currentDistance !== undefined && Number.isFinite(currentDistance)) {
    pathSoFar.unshift({ row, column });
  } else {
    return [];
  }
  if (currentDistance === 0) {
    // already there
    return pathSoFar;
  }
  let nextMove: FieldCoords | null = null;

  for (const move of neighborsGenerator({ row, column })) {
    const distance = getMapValue(move, mapOfDistances);
    if (distance !== undefined && distance < currentDistance) {
      currentDistance = distance;
      nextMove = move;
    }
  }
  if (!nextMove) {
    return [];
  }
  return findPathTo(nextMove, neighborsGenerator, mapOfDistances, pathSoFar);
}
