import { $$, attr } from "@apendua.dev/dom";
import { component, memo } from "@apendua.dev/signal";
import { Complex } from "../helpers/complex";
import { generateFields } from "../helpers/map";
import { createEdgeMapping } from "../helpers/mappings";
import { grow, type Point } from "../helpers/vector";
import type { FieldCoords } from "../types";
import type { Dimensions } from "./types";

interface FieldSetProps extends Dimensions {
  /**
   * The fields to outline. When omitted, the whole `nRows` by `nColumns`
   * rectangle is used, which is how the grid itself gets drawn.
   */
  fields?: FieldCoords[];
  nRows?: number;
  nColumns?: number;
  /**
   * Also trace every field on its own, so that the shape is drawn as an outline
   * with the fields punched out of it rather than as a solid blob.
   */
  cutHoles?: boolean;
  borderWidth?: number;
  fill?: string;
  opacity?: number;
}

function makePoint({ x, y }: Point): string {
  return `${x.toFixed(2)},${y.toFixed(2)}`;
}

function makePathString(points: Iterable<Point>): string {
  let first: Point | null = null;
  let string = "M";
  for (const point of points) {
    if (!first) {
      first = point;
    }
    string += makePoint(point);
    string += " L";
  }
  if (first) {
    string += makePoint(first);
  }
  return string;
}

class FieldSetStore {
  #props: FieldSetProps;

  public constructor(props: FieldSetProps) {
    this.#props = props;
  }

  /**
   * The outline of the field set, as a single svg path.
   *
   * Every field contributes all six of its edges to a complex; edges shared by
   * two neighboring fields cancel out, so only the boundary of the whole shape
   * is left to trace.
   */
  @memo()
  public get d(): string {
    const { offsetX, offsetY, fieldWidth, fieldHeight } = this.#props;
    const { fields, nRows = 0, nColumns = 0, cutHoles = false, borderWidth = 0 } = this.#props;

    const w = fieldWidth / 2;
    const h = fieldHeight / 4;

    const getEdge = createEdgeMapping({ fieldWidth: 2, fieldHeight: 4 });
    const mapPoint = ({ x, y }: Point): Point => ({ x: offsetX + w * x, y: offsetY + h * y });
    const complex = new Complex();

    const loops: { nodes: Point[] }[] = [];

    for (const { row, column } of fields ?? generateFields(nRows, nColumns)) {
      const edges = [
        getEdge({ row, column }, 1),
        getEdge({ row, column }, 2),
        getEdge({ row, column }, 3),
        getEdge({ row, column }, -3),
        getEdge({ row, column }, -2),
        getEdge({ row, column }, -1),
      ];

      if (cutHoles) {
        loops.push({ nodes: edges.map((e) => e[0]) });
      }

      for (const [p1, p2] of edges) {
        complex.addEdge(p1, p2);
      }
    }

    return loops
      .concat(complex.findAllLoops())
      .map((loop) => makePathString(grow(loop.nodes.map(mapPoint), borderWidth / 2)))
      .join(" ");
  }
}

/**
 * Draws the outline of a set of fields — the reachable area, the walls, the
 * route to the cursor, the grid itself.
 */
const FieldSet = component((_: WeakKey, props: FieldSetProps) => {
  const fieldSet = new FieldSetStore(props);
  return $$("path", [
    attr("d", () => fieldSet.d),
    attr("fill-opacity", () => props.opacity ?? 0.5),
    attr("fill", () => props.fill ?? "black"),
  ]);
});

export default FieldSet;
