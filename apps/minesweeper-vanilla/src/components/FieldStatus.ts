import { $$, attr, children, text } from "@apendua/justdom";
import { Field } from "@apendua.dev/minesweeper";
import { component, observable } from "@apendua/signal";
import { switchMap } from "rxjs";
import { ViewportContext } from "../store/Viewport";

type FieldKind = "empty" | "flag" | "mine" | number;

function getKind(field: Field): FieldKind {
  if (!field.uncovered) {
    return field.flag ? "flag" : "empty";
  }
  if (field.mine) {
    return "mine";
  }
  return field.nMines > 0 ? field.nMines : "empty";
}

const NUMBER_COLORS: Record<number, string> = {
  1: "#1971c2",
  2: "#2f9e44",
  3: "#e03131",
  4: "#1c3f95",
  5: "#862e2e",
  6: "#0c8599",
  7: "#212529",
  8: "#495057",
};

const MINE_SPIKE_ANGLES = Array.from({ length: 8 }, (_, i) => (Math.PI / 4) * i);

export default component((ctx: WeakKey, field: Field) => {
  const viewport = ViewportContext.get(ctx);

  const transform = () => {
    const { x, y } = viewport.mapHexToPixels(field);
    return `translate(${x.toFixed(2)},${y.toFixed(2)}) scale(${viewport.fieldHeight.toFixed(2)})`;
  };

  return observable(() => getKind(field)).pipe(
    switchMap((kind) => {
      if (kind === "empty") {
        return $$("g", []);
      }

      if (kind === "flag") {
        return $$("g", [
          attr("transform", transform),
          children(
            $$("line", [
              attr({
                x1: -0.02,
                y1: 0.32,
                x2: -0.02,
                y2: -0.34,
                stroke: "#2b2b2b",
                "stroke-width": 0.05,
                "stroke-linecap": "round",
              }),
            ]),
            $$("polygon", [
              attr({
                points: "-0.02,-0.34 0.32,-0.2 -0.02,-0.06",
                fill: "#e8590c",
                stroke: "#a83200",
                "stroke-width": 0.02,
                "stroke-linejoin": "round",
              }),
            ]),
            $$("ellipse", [
              attr({
                cx: 0,
                cy: 0.34,
                rx: 0.16,
                ry: 0.045,
                fill: "#2b2b2b",
                "fill-opacity": 0.45,
              }),
            ]),
          ),
        ]);
      }

      if (kind === "mine") {
        return $$("g", [
          attr("transform", transform),
          children(
            $$("circle", [attr({ r: 0.42, fill: "#e03131", "fill-opacity": 0.28 })]),
            ...MINE_SPIKE_ANGLES.map((angle) =>
              $$("line", [
                attr({
                  x1: Math.cos(angle) * 0.27,
                  y1: Math.sin(angle) * 0.27,
                  x2: Math.cos(angle) * 0.4,
                  y2: Math.sin(angle) * 0.4,
                  stroke: "#1a1a1a",
                  "stroke-width": 0.05,
                  "stroke-linecap": "round",
                }),
              ]),
            ),
            $$("circle", [attr({ r: 0.26, fill: "#1a1a1a" })]),
            $$("circle", [
              attr({ cx: -0.09, cy: -0.09, r: 0.065, fill: "#ffffff", "fill-opacity": 0.75 }),
            ]),
          ),
        ]);
      }

      const count = kind;
      return $$("text", [
        attr("transform", transform),
        attr({
          x: 0,
          y: 0.18,
          "font-size": 0.62,
          "font-family": "'Trebuchet MS', 'Segoe UI', Arial, sans-serif",
          "font-weight": "700",
          fill: NUMBER_COLORS[count] ?? "#212529",
          "text-anchor": "middle",
        }),
        children(text`${count}`),
      ]);
    }),
  );
});
