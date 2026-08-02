import { memo, mutate, store } from "@apendua/signal";
import {
  ANIMATION_KNOCKOUT,
  ANIMATION_WALK,
  type ActorType,
  type AnimationType,
} from "../constants";
import {
  areTheSameField,
  createMapOfDistances,
  createMapOfObstacles,
  findPathTo,
  generateFields,
  getMapValue,
} from "../helpers/map";
import { createNeighborsGenerator, getDirection } from "../helpers/neighbors";
import type { FieldCoords } from "../types";
import type Actor from "./Actor";
import type Game from "./Game";

const NOWHERE: FieldCoords = { row: -1, column: -1 };

export interface BoardProps {
  game: Game;
  /**
   * Whether the player may still give an order. When they can't, the board
   * stops offering paths to walk.
   */
  isActive: boolean;
}

/**
 * What the semi transparent preview at the end of the path should look like.
 */
export interface Ghost {
  type: ActorType;
  row: number;
  column: number;
  animation: AnimationType;
  direction: number;
}

/**
 * Everything the board derives from the cursor position and the state of the
 * game: where the player may walk, how they get there, and what the move would
 * look like.
 *
 * Each step is a `@memo()` getter, so a value is recomputed only once anything
 * it actually reads has changed. Moving the cursor within a single field, for
 * instance, does not re-run the flood fill that maps out walking distances.
 */
export default class BoardStore {
  #props: BoardProps;
  #state = store({
    // NOTE: NaN would cause problems because NaN !== NaN
    cursor: { ...NOWHERE },
    neighbor: { ...NOWHERE },
  });

  public constructor(props: BoardProps) {
    this.#props = props;
  }

  public get cursorCoords(): FieldCoords {
    return this.#state.cursor;
  }

  @mutate()
  public setCursor(cursor: FieldCoords, neighbor: FieldCoords): void {
    if (!areTheSameField(this.#state.cursor, cursor)) {
      this.#state.cursor = { row: cursor.row, column: cursor.column };
    }
    if (!areTheSameField(this.#state.neighbor, neighbor)) {
      this.#state.neighbor = { row: neighbor.row, column: neighbor.column };
    }
  }

  /**
   * Fields nobody can walk onto: the terrain, plus every stack still standing
   * other than the one being moved.
   */
  @memo()
  public get mapOfObstacles(): boolean[][] {
    const { game } = this.#props;
    const current = game.currentActor;
    return createMapOfObstacles(
      game.nRows,
      game.nColumns,
      game.obstacles,
      game.actors.filter((actor) => actor.isAlive && actor !== current),
    );
  }

  /**
   * The field the player is aiming at. Pointing at an obstacle — a wall, or an
   * enemy — aims at the free field next to it instead, which is how you walk up
   * to something and hit it.
   */
  @memo(areTheSameField)
  public get targetCoords(): FieldCoords {
    let target = this.#state.cursor;
    if (getMapValue(target, this.mapOfObstacles)) {
      target = this.#state.neighbor;
    }
    if (getMapValue(target, this.mapOfObstacles)) {
      return NOWHERE;
    }
    return { row: target.row, column: target.column };
  }

  /**
   * How many steps it takes the current stack to reach every field.
   */
  @memo()
  public get mapOfDistances(): number[][] {
    const { game } = this.#props;
    return createMapOfDistances(game.nRows, game.nColumns, game.currentCoords, this.mapOfObstacles);
  }

  /**
   * The route the current stack would take to the field being aimed at, or an
   * empty path when it can't get there this turn.
   */
  @memo()
  public get pathToCursor(): FieldCoords[] {
    if (!this.#props.isActive) {
      return [];
    }
    const { game } = this.#props;
    const distanceLimit = game.currentActor?.speed ?? 0;
    const distance = getMapValue(this.targetCoords, this.mapOfDistances);

    if (distance === undefined || distance > distanceLimit) {
      return [];
    }
    return findPathTo(
      this.targetCoords,
      createNeighborsGenerator(game.nRows, game.nColumns),
      this.mapOfDistances,
    );
  }

  /**
   * Everything the current stack can reach this turn, highlighted on the board.
   */
  @memo()
  public get fieldsWithinDistance(): FieldCoords[] {
    const { game } = this.#props;
    const distance = game.currentActor?.speed ?? 0;
    const fields: FieldCoords[] = [];
    for (const { row, column } of generateFields(game.nRows, game.nColumns)) {
      const value = getMapValue({ row, column }, this.mapOfDistances);
      if (value !== undefined && value <= distance) {
        fields.push({ row, column });
      }
    }
    return fields;
  }

  /**
   * The stack standing under the cursor, if it is still alive.
   */
  public get actorUnderCursor(): Actor | undefined {
    return this.#props.game.actors.find(
      (actor) => actor.isAlive && areTheSameField(actor, this.#state.cursor),
    );
  }

  /**
   * The preview of the move the player is about to make: walking to the end of
   * the path, or knocking out whoever is standing there.
   */
  @memo()
  public get ghost(): Ghost | null {
    const path = this.pathToCursor;
    const actor = this.#props.game.currentActor;
    const numSteps = path.length;

    if (numSteps === 0 || !actor) {
      return null;
    }
    const { row, column } = path[numSteps - 1];
    const targetActor = this.actorUnderCursor;

    if (targetActor && targetActor.side !== actor.side) {
      return {
        type: actor.type,
        row,
        column,
        animation: ANIMATION_KNOCKOUT,
        direction: getDirection(path[numSteps - 1], targetActor),
      };
    }
    if (numSteps >= 2) {
      return {
        type: actor.type,
        row,
        column,
        animation: ANIMATION_WALK,
        direction: getDirection(path[numSteps - 2], path[numSteps - 1]),
      };
    }
    return null;
  }
}
