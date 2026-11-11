import { $, $$, CLASS_NAME, attr, children, set, stylesheet, text } from "justdom-core";
import { component, makeNonReactive, store } from "justdom-signal";
import { ASSETS_PREFIX, SVG_HEIGHT, SVG_WIDTH } from "../constants";
import { pageOnly } from "../headset";
import { RootContext } from "../store/Root";
import Board from "./Board";
import MenuModal from "./MenuModal";
import Music from "./Music";
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

/**
 * The whole page. It is a stacking context of its own, so that the backdrop,
 * a layer under the rest, stays inside it rather than going under the body.
 *
 * As tall as the screen shows, `100dvh`, as Euclid's page is. On a phone
 * `100vh` is the height with the browser's bars hidden, so the page ran
 * under them: the toolbar went below the bottom bar, and in a session the
 * canvas, which justdom-three sizes to `innerHeight`, left a strip of the
 * page showing beneath it. `100vh` stays for a browser without `dvh`.
 */
const container = stylesheet`
  .${CLASS_NAME} {
    position: relative;
    z-index: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
  }

  .${CLASS_NAME} svg {
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
`;

/**
 * The painted battlefield behind everything. An `<img>` rather than the
 * page's `background-image`, which would look the same on the page: a
 * headset panel draws an `<img>`, and of a background only its colour and
 * its gradients, so a `url()` background would leave the board's black
 * grid on the session's dark backdrop.
 */
const backdrop = stylesheet`
  .${CLASS_NAME} {
    position: absolute;
    inset: 0;
    z-index: -1;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: 50% 50%;
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

  const setMenuVisible = (isMenuVisible: boolean) => {
    state.isMenuVisible = isMenuVisible;
  };

  // The board is rebuilt from scratch for every new game, so it reads the game
  // it belongs to once, outside of any computation, and holds on to it.
  const getGame = makeNonReactive(() => root.game);

  return $("div", [
    set("className", container),
    children(
      // On a page that can open a headset the music is the session's, and
      // the scene plays it.
      branch(
        () => (pageOnly.get() ? "page" : "session"),
        (where) => (where === "page" ? Music(ctx) : text``),
      ),
      $("img", [
        set("className", backdrop),
        set({ src: `${ASSETS_PREFIX}/assets/background_01_2048.jpg`, alt: "" }),
      ]),
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
        get mode() {
          return root.mode;
        },
        onClose: () => setMenuVisible(false),
        onCreateNewGame: (mode) => root.createNewGame(mode),
      }),
    ),
  ]);
});

export default Game;
