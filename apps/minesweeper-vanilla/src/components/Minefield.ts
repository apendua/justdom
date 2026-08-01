import { list, $$, children, attr, on, className } from "@apendua.dev/dom";
import { Fields, getKey } from "@apendua.dev/minesweeper";
import { observe } from "@apendua.dev/signal";
import { RootContext } from "../store4/Root";
import { ViewportContext } from "../store4/Viewport";
import { tap } from "rxjs";
import FieldSet from "./FieldSet";
import FieldStatus from "./FieldStatus";
import { component } from "@apendua.dev/signal";

const noSelect = className`
  position: absolute;
  top: 0;
  left: 0;
  user-select: none;
`;

const COVERED_FILL = "#5c8a58";
const UNCOVERED_FILL = "#ede4d3";
const GRID_STROKE = "#2f3b2a";

const Minefield = component((ctx: WeakKey, game: Fields) => {
  const dimensions = RootContext.get(ctx);
  const viewport = ViewportContext.get(ctx);

  let svgRef: SVGSVGElement | undefined;

  const handleOnClick = (e: MouseEvent) => {
    const { clientX: x, clientY: y } = e;
    if (svgRef) {
      const ctm = svgRef.getScreenCTM();
      if (ctm) {
        const pt = svgRef.createSVGPoint();
        pt.x = x;
        pt.y = y;
        const { hex } = viewport.mapPixelsToHex(pt.matrixTransform(ctm.inverse()));
        if (hex) {
          const key = getKey(hex);
          if (e.shiftKey) {
            game.getField(key)?.toggleFlag();
          } else {
            game.getField(key)?.uncover();
          }
        }
      }
    }
  };

  return $$("svg", [
    attr("class", noSelect),
    attr("width", () => dimensions.screenWidth.toString()),
    attr("height", () => dimensions.screenHeight.toString()),
    attr("viewbox", () => `0 0 ${dimensions.screenWidth} ${dimensions.screenHeight}`),
    on("click", handleOnClick),
    children(
      FieldSet(ctx, {
        get fields() {
          return game.coveredFields;
        },
        fill: COVERED_FILL,
        opacity: 1,
        get cursor() {
          return game.isGameOver ? "default" : "pointer";
        },
        borderWidth: 2,
      }),
      FieldSet(ctx, {
        get fields() {
          return game.uncoveredFields;
        },
        fill: UNCOVERED_FILL,
        opacity: 1,
        cursor: "default",
        borderWidth: 2,
      }),
      FieldSet(ctx, {
        get fields() {
          return game.allFields;
        },
        fill: GRID_STROKE,
        opacity: 0.85,
        cursor: "default",
        borderWidth: 2,
        cutHoles: true,
      }),
      list(observe(game).allFields, (field) => FieldStatus(ctx, field)),
    ),
    tap((svg) => {
      svgRef = svg;
    }),
  ]);
});

export default Minefield;
