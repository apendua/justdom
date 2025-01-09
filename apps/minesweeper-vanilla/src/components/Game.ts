import { css, list, text } from "@apendua.dev/dom";
import { html, svg } from "./primitives";
import { RootContext } from "../store4/Root";
import { Field, Fields, FieldsContext, getKey } from "@apendua.dev/minesweeper";
import { $observe, makeReactive } from "@apendua.dev/store4";
import Viewport, { ViewportContext } from "../store4/Viewport";
import { switchMap, tap } from "rxjs";
import Label from "./Label";
import FieldSet from "./FieldSet";

const fullscreen = css`
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  right: 0;
`;

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

const Game = (ctx: WeakKey) => {
  const dimensions = RootContext.get(ctx);
  const { screenWidth, screenHeight } = $observe(dimensions);

  const state = makeReactive({
    game: Fields.generate({}),
  });

  const minesLeft = $observe(state).game.pipe(
    switchMap((game) => {
      return $observe(game).minesLeft;
    }),
  );

  const viewport = new Viewport({
    get allFields() {
      return state.game.allFields;
    },
    get screenWidth() {
      return dimensions.screenWidth;
    },
    get screenHeight() {
      return dimensions.screenHeight;
    },
  });

  let svgRef: SVGSVGElement | undefined;

  const handleOnClick = (e: MouseEvent) => {
    const { clientX: x, clientY: y } = e;
    if (svgRef) {
      const ctm = svgRef.getScreenCTM();
      if (ctm) {
        const pt = svgRef.createSVGPoint();
        pt.x = x;
        pt.y = y;
        const { hex } = viewport.mapPixelsToHex(
          pt.matrixTransform(ctm.inverse()),
        );
        if (hex) {
          const key = getKey(hex);
          if (e.shiftKey) {
            state.game.getField(key)?.toggleFlag();
          } else {
            state.game.getField(key)?.uncover();
          }
        }
      }
    }
  };

  ctx = ViewportContext.set(ctx, viewport);

  return $observe(state).game.pipe(
    switchMap((game) => {
      const newContext = FieldsContext.set(ctx, game);
      return html("div")
        .set("className", fullscreen)
        .append(
          html("button")
            .on("click", () => {
              state.game = Fields.generate({});
            })
            .append(text`Restart`)
            .get(),
          html("span")
            .append(
              text`width = ${screenWidth}, height = ${screenHeight}, mines = ${minesLeft}`,
            )
            .get(),
          svg("svg")
            .setAttribute$("width", () => dimensions.screenWidth.toString())
            .setAttribute$("height", () => dimensions.screenHeight.toString())
            .setAttribute$(
              "viewbox",
              () => `0 0 ${dimensions.screenWidth} ${dimensions.screenHeight}`,
            )
            .on("click", handleOnClick)
            .append(
              FieldSet(newContext, {
                get fields() {
                  return game.coveredFields;
                },
                borderWidth: 5,
              }),
              FieldSet(newContext, {
                get fields() {
                  return game.allFields;
                },
                borderWidth: 5,
                cutHoles: true,
              }),
              list($observe(game).allFields, (field) =>
                FieldStatus(ctx, field),
              ),
            )
            .get()
            .pipe(
              tap((svg) => {
                svgRef = svg;
              }),
            ),
        )
        .get();
    }),
  );
};

export default Game;
