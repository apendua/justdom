import { list, $$, children, attr, on, className } from "@apendua.dev/dom";
import { Field, Fields, getKey } from "@apendua.dev/minesweeper";
import { observe } from "@apendua.dev/signal";
import { RootContext } from "../store4/Root";
import { ViewportContext } from "../store4/Viewport";
import { tap } from "rxjs";
import Label from "./Label";
import FieldSet from "./FieldSet";
import { component } from "@apendua.dev/signal";

const FieldStatus = (ctx: WeakKey, field: Field) => {
  return Label(ctx, {
    get x() {
      return field.x;
    },
    get y() {
      return field.y;
    },
    get z() {
      return field.z;
    },
    get text() {
      return field.statusText;
    },
  });
};

const noSelect = className`
  user-select: none;
`;

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
        borderWidth: 2,
      }),
      FieldSet(ctx, {
        get fields() {
          return game.allFields;
        },
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
