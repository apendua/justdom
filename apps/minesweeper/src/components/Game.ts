import { flatMap, observe, store } from "@apendua/signal";
import { Fields, FieldsContext } from "../store/Fields";
import { RootContext } from "../store/Root";
import Viewport, { ViewportContext } from "../store/Viewport";
import Minefield from "./Minefield";
import Menu, { SizePreset } from "./Menu";

export const SIZE_PRESETS: SizePreset[] = [
  { id: "small", label: "Small", nRows: 9, nColumns: 9, minesRatio: 0.12 },
  { id: "medium", label: "Medium", nRows: 15, nColumns: 15, minesRatio: 0.16 },
  { id: "large", label: "Large", nRows: 21, nColumns: 21, minesRatio: 0.2 },
];

const DEFAULT_PRESET = SIZE_PRESETS.find((preset) => preset.id === "medium") ?? SIZE_PRESETS[0];

/**
 * The game, as two trees over one state: the board and the menu. They are
 * mounted in two places on the page, because a headset session mirrors each
 * into a panel of its own, and a panel is the element it is mounted in.
 *
 * The board is rebuilt whole when a new game starts. The menu is built once
 * and follows the game through its props, so the panel it is mirrored into
 * keeps its place and its size across a restart.
 */
const Game = (ctx: WeakKey) => {
  const dimensions = RootContext.get(ctx);

  const state = store({
    sizeId: DEFAULT_PRESET.id,
    game: Fields.generate(DEFAULT_PRESET),
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

  return {
    // `flatMap` runs its callback inside a derivation, so it reads nothing but
    // the board it is handed: the rebuild belongs to `game` alone.
    board: flatMap((game: Fields) => Minefield(FieldsContext.set(ctx, game), game))(
      observe(state).game,
    ),
    menu: Menu(ctx, {
      presets: SIZE_PRESETS,
      get selectedId() {
        return state.sizeId;
      },
      get game() {
        return state.game;
      },
      onSelect: startGame,
      onRestart: () => {
        const preset = SIZE_PRESETS.find((p) => p.id === state.sizeId) ?? SIZE_PRESETS[0];
        startGame(preset);
      },
    }),
  };
};

export default Game;
