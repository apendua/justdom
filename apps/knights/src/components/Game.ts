import { $, $$, CLASS_NAME, attr, children, set, stylesheet, text } from "@apendua/justdom";
import { component, makeNonReactive, store } from "@apendua/signal";
import { ASSETS_PREFIX, SVG_HEIGHT, SVG_WIDTH } from "../constants";
import { RootContext } from "../store/Root";
import Board from "./Board";
import MenuModal from "./MenuModal";
import Pattern from "./Pattern";
import Toolbar from "./Toolbar";
import branch from "./branch";
import type { Dimensions } from "./types";

const BLOCKED_FIELD_PATTERN = "blockedFieldPattern";

/**
 * The hexagons are drawn slightly taller than they are wide, which is what
 * gives the board its shallow, looking-down-at-it perspective.
 */
const FIELD_ASPECT_RATIO = 22 / 30;

const container = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background-image: url('${ASSETS_PREFIX}/assets/background_01_2048.jpg');
    background-size: cover;
    background-position: 50% 50%;
  }

  .${CLASS_NAME} svg {
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
`;

const panel = stylesheet`
  .${CLASS_NAME} {
    flex-shrink: 1;
  }
`;

const fillingPanel = stylesheet`
  .${CLASS_NAME} {
    flex-shrink: 1;
    flex-grow: 1;
  }
`;

/**
 * Fit the hex grid into the fixed svg canvas, leaving room for the sprites,
 * which stand a good deal taller than the field they occupy.
 */
function getDimensions(nRows: number, nColumns: number, margin = 10): Dimensions {
  const virtualColumns = nColumns + 0.5;
  const virtualRows = 0.75 * (nRows + 2) + 0.25;

  let fieldWidth = (SVG_WIDTH - 2 * margin) / virtualColumns;
  let fieldHeight = (SVG_HEIGHT - 2 * margin) / virtualRows;

  if (fieldWidth * FIELD_ASPECT_RATIO < fieldHeight) {
    fieldHeight = fieldWidth * FIELD_ASPECT_RATIO;
  } else {
    fieldWidth = fieldHeight / FIELD_ASPECT_RATIO;
  }

  const offsetX = (SVG_WIDTH - virtualColumns * fieldWidth) / 2;
  const offsetY = (SVG_HEIGHT - virtualRows * fieldHeight) / 2 + 0.75 * 2 * fieldHeight;

  return { fieldWidth, fieldHeight, offsetX, offsetY };
}

/**
 * The whole thing: the board in the middle, the toolbar underneath, and the two
 * modals on top.
 */
const Game = component((ctx: WeakKey) => {
  const root = RootContext.get(ctx);
  const state = store({ isMenuVisible: false });

  const setMenuVisible = makeNonReactive((isMenuVisible: boolean) => {
    state.isMenuVisible = isMenuVisible;
  });

  // The board is rebuilt from scratch for every new game, so it reads the game
  // it belongs to once, outside of any computation, and holds on to it.
  const getGame = makeNonReactive(() => root.game);

  return $("div", [
    set("className", container),
    children(
      $("div", [set("className", fillingPanel)]),
      $$("svg", [
        attr("class", panel),
        attr({ viewBox: `0 0 ${SVG_WIDTH} ${SVG_HEIGHT}` }),
        children(
          $$("defs", [children(Pattern({ name: BLOCKED_FIELD_PATTERN, size: 16 }))]),
          branch(
            () => root.game?.gameId ?? "",
            (gameId) => {
              const game = getGame();
              if (!gameId || !game) {
                return text``;
              }
              return Board(ctx, {
                game,
                dimensions: getDimensions(game.nRows, game.nColumns),
                obstaclePattern: BLOCKED_FIELD_PATTERN,
                get isActive() {
                  return game.isActive;
                },
              });
            },
          ),
        ),
      ]),
      $("div", [set("className", fillingPanel)]),
      $("div", [
        set("className", panel),
        children(
          Toolbar(ctx, {
            get game() {
              return root.game;
            },
            get mode() {
              return root.mode;
            },
            onMenuOpen: () => setMenuVisible(true),
            onCreateNewGame: () => root.createNewGame(),
          }),
        ),
      ]),
      MenuModal(ctx, {
        get isVisible() {
          return state.isMenuVisible;
        },
        onClose: () => setMenuVisible(false),
        onCreateNewGame: (mode) => root.createNewGame(mode),
      }),
    ),
  ]);
});

export default Game;
