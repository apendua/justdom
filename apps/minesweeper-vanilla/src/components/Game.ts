import { set, children, $, className } from "@apendua.dev/dom";
import { Fields, FieldsContext } from "@apendua.dev/minesweeper";
import { store, observe } from "@apendua.dev/signal";
import { RootContext } from "../store4/Root";
import Viewport, { ViewportContext } from "../store4/Viewport";
import { switchMap } from "rxjs";
import Minefield from "./Minefield";
import Menu, { SizePreset } from "./Menu";

const fullscreen = className`
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  right: 0;
`;

export const SIZE_PRESETS: SizePreset[] = [
  { id: "small", label: "Small", nRows: 9, nColumns: 9, minesRatio: 0.12 },
  { id: "medium", label: "Medium", nRows: 15, nColumns: 15, minesRatio: 0.16 },
  { id: "large", label: "Large", nRows: 21, nColumns: 21, minesRatio: 0.2 },
];

const Game = (ctx: WeakKey) => {
  const dimensions = RootContext.get(ctx);

  const state = store({
    sizeId: SIZE_PRESETS[0].id,
    game: Fields.generate(SIZE_PRESETS[0]),
  });

  const startGame = (preset: SizePreset) => {
    state.sizeId = preset.id;
    state.game = Fields.generate(preset);
  };

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

  return observe(state).game.pipe(
    switchMap((game) => {
      const newContext = FieldsContext.set(ctx, game);
      const selectedId = state.sizeId;
      return $("div", [
        set("className", fullscreen),
        children(
          Minefield(newContext, game),
          Menu(newContext, {
            presets: SIZE_PRESETS,
            selectedId,
            game,
            onSelect: startGame,
            onRestart: () => {
              const preset = SIZE_PRESETS.find((p) => p.id === selectedId) ?? SIZE_PRESETS[0];
              startGame(preset);
            },
          }),
        ),
      ]);
    }),
  );
};

export default Game;
