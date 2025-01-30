import { stylesheet, text, html, set, append, on } from "@apendua.dev/dom";
import { RootContext } from "../store4/Root";
import { Fields, FieldsContext } from "@apendua.dev/minesweeper";
import { $observe, makeReactive } from "@apendua.dev/store4";
import Viewport, { ViewportContext } from "../store4/Viewport";
import { switchMap } from "rxjs";
import Minefield from "./Minefield";

const fullscreen = stylesheet`
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  right: 0;
`;

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

  ctx = ViewportContext.set(ctx, viewport);

  return $observe(state).game.pipe(
    switchMap((game) => {
      const newContext = FieldsContext.set(ctx, game);
      return html("div").pipe(
        set("className", fullscreen),
        append(
          html("button").pipe(
            on("click", () => {
              state.game = Fields.generate({});
            }),
            append(text`Restart`),
          ),
          html("span").pipe(
            append(
              text`width = ${screenWidth}, height = ${screenHeight}, mines = ${minesLeft}`,
            ),
          ),
        ),
        append(Minefield(newContext, game)),
      );
    }),
  );
};

export default Game;
