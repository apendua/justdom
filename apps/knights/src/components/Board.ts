import { $$, attr, children, list, on } from "@apendua/justdom";
import { component } from "@apendua/signal";
import { ANIMATION_IDLE, KNIGHT } from "../constants";
import { areTheSameField } from "../helpers/map";
import { createInverseMapping } from "../helpers/mappings";
import type { Point } from "../helpers/vector";
import BoardStore from "../store/Board";
import type Game from "../store/Game";
import ActorView from "./ActorView";
import Field from "./Field";
import FieldSet from "./FieldSet";
import type { Dimensions } from "./types";

export interface BoardProps {
  game: Game;
  /**
   * How the hex grid maps onto the canvas. It follows from the size of the map,
   * so it stays put for as long as a game is being played.
   */
  dimensions: Dimensions;
  /** Whether the player may give the current stack an order right now. */
  isActive: boolean;
  /** The id of the `<pattern>` used to fill impassable fields. */
  obstaclePattern: string;
}

/**
 * The battlefield: the grid, the terrain, the stacks standing on it, and the
 * move the player is about to make.
 */
const Board = component((ctx: WeakKey, props: BoardProps) => {
  const { game, dimensions } = props;
  const board = new BoardStore({
    game,
    get isActive() {
      return props.isActive;
    },
  });

  let rootRef: SVGGElement | undefined;
  const toFieldCoords = createInverseMapping(dimensions);

  /**
   * Translate a point in screen coordinates into a field of the hex grid. The
   * svg scales with the window, so the point has to go through the element's
   * own transform first.
   */
  const getMapCoords = ({ x, y }: Point) => {
    const svg = rootRef?.ownerSVGElement;
    if (!svg) {
      return null;
    }
    const ctm = svg.getScreenCTM();
    if (!ctm) {
      return null;
    }
    const point = svg.createSVGPoint();
    point.x = x;
    point.y = y;
    return toFieldCoords(point.matrixTransform(ctm.inverse()));
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!props.isActive) {
      return;
    }
    const coords = getMapCoords({ x: e.clientX, y: e.clientY });
    if (!coords) {
      return;
    }
    board.setCursor(
      { row: coords.row, column: coords.column },
      { row: coords.nRow, column: coords.nColumn },
    );
  };

  const handleMouseClick = (e: MouseEvent) => {
    if (!props.isActive) {
      return;
    }
    const pathToCursor = board.pathToCursor;
    const actor = game.currentActor;

    if (pathToCursor.length === 0 || !actor) {
      return;
    }
    const coords = getMapCoords({ x: e.clientX, y: e.clientY });
    if (!coords) {
      return;
    }
    const target = game.actors.find(
      (candidate) => candidate.isAlive && areTheSameField(candidate, coords),
    );
    // Walking into your own troops is not an attack, and a path of one field
    // with nobody to hit at the end of it is not a move at all.
    const opponent = target && target.side !== actor.side ? target : undefined;
    if (!opponent && pathToCursor.length === 1) {
      return;
    }
    game.moveActor(actor, pathToCursor, opponent);
  };

  return $$("g", [
    // Says the board takes orders, to the mouse and to a headset's ray
    // alike: a panel forwards the ray's moves and presses only to what is
    // under `cursor: pointer`, so without it the route would never follow
    // the ray and the trigger would send nobody anywhere.
    attr("cursor", () => (props.isActive ? "pointer" : undefined)),
    on("click", handleMouseClick),
    on("mousemove", handleMouseMove),
    on("mouseout", handleMouseMove),
    children(
      // Everything the current stack can reach this turn.
      FieldSet(ctx, {
        ...dimensions,
        get fields() {
          return board.fieldsWithinDistance;
        },
        get opacity() {
          return props.isActive ? 0.5 : 0.01;
        },
      }),
      // The terrain.
      FieldSet(ctx, {
        ...dimensions,
        fields: game.obstacles,
        opacity: 1.0,
        // Black where the hatching cannot be drawn, which is in a headset
        // panel: it draws no `<pattern>` yet, and a wall left unfilled there
        // would look like open ground.
        fill: `url(#${props.obstaclePattern}) black`,
      }),
      // The route to the cursor.
      FieldSet(ctx, {
        ...dimensions,
        get fields() {
          return board.pathToCursor;
        },
        cutHoles: true,
        borderWidth: 8,
        opacity: 0.5,
        fill: "black",
      }),
      // The field the current stack is standing on.
      Field(ctx, {
        ...dimensions,
        get row() {
          return game.currentCoords.row;
        },
        get column() {
          return game.currentCoords.column;
        },
        fill: "red",
        get opacity() {
          return props.isActive ? 1.0 : 0.2;
        },
      }),
      // The grid itself.
      FieldSet(ctx, {
        ...dimensions,
        nRows: game.nRows,
        nColumns: game.nColumns,
        opacity: 0.9,
        cutHoles: true,
        borderWidth: 2,
      }),
      // The stacks, drawn back to front so that the ones further down the board
      // overlap the ones behind them.
      list(
        () => [...game.actors].sort((a1, a2) => a1.row - a2.row),
        (actor) =>
          ActorView(ctx, {
            ...dimensions,
            type: actor.type,
            side: actor.side,
            toughness: actor.toughness,
            get row() {
              return actor.row;
            },
            get column() {
              return actor.column;
            },
            get movePath() {
              return actor.movePath;
            },
            get totalHealth() {
              return actor.totalHealth;
            },
            get isAttacking() {
              return actor.isAttacking;
            },
            get isHit() {
              return actor.isHit;
            },
            get isDying() {
              return actor.isDying;
            },
            get direction() {
              return actor.direction;
            },
            get isActive() {
              return game.currentActor === actor;
            },
          }),
      ),
      // A preview of the move the player is about to make. The key is constant,
      // so the preview stays mounted — and keeps animating — while the cursor
      // moves around the board.
      list(
        () => (board.ghost ? ["ghost"] : []),
        () =>
          ActorView(ctx, {
            ...dimensions,
            get type() {
              return board.ghost?.type ?? KNIGHT;
            },
            get row() {
              return board.ghost?.row ?? -1;
            },
            get column() {
              return board.ghost?.column ?? -1;
            },
            get animation() {
              return board.ghost?.animation ?? ANIMATION_IDLE;
            },
            get direction() {
              return board.ghost?.direction ?? 0;
            },
            forceLoop: true,
            opacity: 0.4,
          }),
      ),
    ),
    (node: SVGGElement) => {
      rootRef = node;
    },
  ]);
});

export default Board;
