import { $$, attr } from "@apendua/justdom";
import { component } from "@apendua/signal";
import { createMapping } from "../helpers/mappings";
import type { Dimensions } from "./types";

interface FieldProps extends Dimensions {
  row: number;
  column: number;
  fill?: string;
  opacity?: number;
}

/**
 * A single hexagon.
 */
const Field = component((_: WeakKey, props: FieldProps) => {
  const points = () => {
    if (props.column < 0 || props.row < 0) {
      // Nothing to point at — the board renders this while there is no current
      // stack, so the highlight simply has no shape.
      return "";
    }
    const { x, y } = createMapping(props)(props);
    const w = props.fieldWidth;
    const h = props.fieldHeight;

    const x1 = x;
    const x2 = x + w / 2;
    const x3 = x + w;
    const y1 = y;
    const y2 = y + h / 4;
    const y3 = y + (3 * h) / 4;
    const y4 = y + h;

    return `${x1},${y2},${x2},${y1},${x3},${y2},${x3},${y3},${x2},${y4},${x1},${y3}`;
  };

  return $$("polygon", [
    attr("points", points),
    attr("fill", () => props.fill ?? "black"),
    attr("fill-opacity", () => props.opacity ?? 0.5),
  ]);
});

export default Field;
