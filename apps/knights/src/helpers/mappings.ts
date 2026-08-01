import type { FieldCoords } from "./neighbors";
import type { Point } from "./vector";

export interface MappingOptions {
  fieldWidth?: number;
  fieldHeight?: number;
  offsetX?: number;
  offsetY?: number;
}

/**
 * Create a function that will be evaluating field coordinates
 * when given the (row, column) pair.
 */
export function createMapping({
  fieldWidth = 1,
  fieldHeight = 1,
  offsetX = 0,
  offsetY = 0,
}: MappingOptions = {}): (field: FieldCoords) => Point {
  const w = fieldWidth / 2;
  const h = fieldHeight / 4;
  const h3 = h * 3;

  /**
   * Compute the coordinates of upper-left corner of the given field.
   */
  return function map({ row, column }: FieldCoords): Point {
    const x = offsetX + column * fieldWidth + (row % 2 === 1 ? w : 0);
    const y = offsetY + row * h3;
    return { x, y };
  };
}

/**
 * Return a function that given a field and direction
 * returns the corresponding edge.
 */
export function createEdgeMapping({
  fieldWidth = 1,
  fieldHeight = 1,
  offsetX = 0,
  offsetY = 0,
}: MappingOptions = {}): (field: FieldCoords, direction: number) => Point[] {
  const w = fieldWidth / 2;
  const h = fieldHeight / 4;
  const h3 = h * 3;
  const w2 = w * 2;
  const h4 = h * 4;

  /**
   * Return a pair of vertexes representing the edge of the given field
   * at the given direction.
   */
  return function map({ row, column }: FieldCoords, direction: number): Point[] {
    const x = offsetX + column * fieldWidth + (row % 2 === 1 ? w : 0);
    const y = offsetY + row * h3;

    switch (direction) {
      case 1:
        return [
          { x: x + w2, y: y + h },
          { x: x + w, y: y },
        ];
      case 2:
        return [
          { x: x + w2, y: y + h3 },
          { x: x + w2, y: y + h },
        ];
      case 3:
        return [
          { x: x + w, y: y + h4 },
          { x: x + w2, y: y + h3 },
        ];
      case -1:
        return [
          { x: x + w, y: y },
          { x, y: y + h },
        ];
      case -2:
        return [
          { x, y: y + h },
          { x, y: y + h3 },
        ];
      case -3:
        return [
          { x, y: y + h3 },
          { x: x + w, y: y + h4 },
        ];
      default:
        return [];
    }
  };
}

export interface InverseMappingResult extends FieldCoords {
  nRow: number;
  nColumn: number;
}

export interface InverseMappingOptions extends MappingOptions {
  findNeighbor?: boolean;
}

/**
 * Return a function that will be evaluating column and row
 * when given the (x,y) coordinates (e.g. mouse cursor position).
 */
export function createInverseMapping({
  fieldWidth = 1,
  fieldHeight = 1,
  offsetX = 0,
  offsetY = 0,
}: InverseMappingOptions = {}): (point: Point) => InverseMappingResult {
  const w = fieldWidth / 2;
  const h = fieldHeight / 4;

  /**
   * Compute the row and column of the field that covers the given point,
   * along with the neighbor closest to the direction pointed at by the cursor.
   */
  return function map({ x, y }: Point): InverseMappingResult {
    x -= offsetX;
    y -= offsetY;

    let i = Math.floor(y / h);
    let j = Math.floor(x / w);
    const r = i % 6;

    if (r === 0) {
      if (j % 2 === 0) {
        if (x / w + y / h < 1 + i + j) {
          i -= 1;
          j -= 1;
        }
      } else {
        if (y / h - i < x / w - j) {
          i -= 1;
        }
      }
    } else if (r === 3) {
      if (j % 2 === 0) {
        if (y / h - i < x / w - j) {
          i -= 1;
        } else {
          j -= 1;
        }
      } else {
        if (x / w + y / h < 1 + i + j) {
          i -= 1;
        } else {
          j -= 1;
        }
      }
    } else if (r === 4 || r === 5) {
      j -= 1;
    }

    const row = Math.floor(i / 3);
    const column = Math.floor(j / 2);

    const { row: nRow, column: nColumn } = findTheClosestNeighbor(x, y, row, column, w, h);

    return { row, column, nRow, nColumn };
  };
}

/**
 * Given the cursor coordinates return the neighbor field that is
 * closest to the direction pointed out by cursor.
 *
 * @param x - cursor x
 * @param y - cursor y
 * @param r - row under cursor
 * @param c - column under cursor
 * @param w - half of the field width
 * @param h - quarter of the field height
 */
function findTheClosestNeighbor(
  x: number,
  y: number,
  r: number,
  c: number,
  w: number,
  h: number,
): FieldCoords {
  // NOTE: Find out coordinates of the center of the hexagon.
  const ox = c * 2 * w + (r % 2 ? 2 * w : w);
  const oy = r * 3 * h + 2 * h;

  let row: number;
  let column: number;

  if (x >= ox) {
    if (w * (y - oy) >= h * (x - ox)) {
      row = r + 1;
      column = r % 2 ? c + 1 : c;
    } else if (w * (y - oy) < -h * (x - ox)) {
      row = r - 1;
      column = r % 2 ? c + 1 : c;
    } else {
      row = r;
      column = c + 1;
    }
  } else {
    if (w * (y - oy) <= h * (x - ox)) {
      row = r - 1;
      column = r % 2 ? c : c - 1;
    } else if (w * (y - oy) > -h * (x - ox)) {
      row = r + 1;
      column = r % 2 ? c : c - 1;
    } else {
      row = r;
      column = c - 1;
    }
  }
  return { row, column };
}
