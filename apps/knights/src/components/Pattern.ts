import { $$, attr, children } from "justdom";

interface PatternProps {
  name: string;
  size: number;
}

/**
 * The diagonal hatching used to fill impassable fields.
 */
export default function Pattern({ name, size }: PatternProps) {
  const x = size / 4;

  const line = (x1: number, y1: number, x2: number, y2: number) =>
    $$("line", [
      attr({
        x1,
        y1,
        x2,
        y2,
        stroke: "black",
        "stroke-width": x / 2,
        "stroke-linecap": "square",
      }),
    ]);

  return $$("pattern", [
    attr({
      id: name,
      width: size,
      height: size,
      patternUnits: "userSpaceOnUse",
    }),
    children(
      line(0 * x, 1 * x, 1 * x, 0 * x),
      line(0 * x, 3 * x, 3 * x, 0 * x),
      line(1 * x, 4 * x, 4 * x, 1 * x),
      line(3 * x, 4 * x, 4 * x, 3 * x),
    ),
  ]);
}
