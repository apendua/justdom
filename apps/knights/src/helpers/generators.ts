import { ATTACKER, ATTRIBUTES, DEFENDER, KNIGHT, type Side } from "../constants";
import type { ActorSetup, FieldCoords, GameSetup } from "../types";
import { createMapOfObstacles, generateFields, getMapValue } from "./map";
import { randomFraction } from "./random";

export function generateGame(nRows: number, nColumns: number): GameSetup {
  // -----------------------
  // --- generate random map
  // -----------------------

  const generator = mapGenerator(nColumns);
  const obstacles: FieldCoords[] = [];

  for (const { row, column } of generateFields(nRows, nColumns)) {
    const field = generator({ row, column });
    if (field.isBlocked) {
      obstacles.push({ row, column });
    }
  }

  // ------------------------------------
  // --- spawn actors in random positions
  // ------------------------------------

  const mapOfObstacles = createMapOfObstacles(nRows, nColumns, obstacles);
  const actors = createActors(200, nRows, nColumns, mapOfObstacles);

  return { obstacles, actors, nRows, nColumns };
}

function mapGenerator(nColumns: number): (field: FieldCoords) => { isBlocked: boolean } {
  return ({ column: j }) => {
    return {
      isBlocked:
        randomFraction() < 0.4 * Math.pow(1 - (2 * Math.abs(j - nColumns / 2)) / nColumns, 2),
    };
  };
}

function createActors(
  perTeamAmount: number,
  nRows: number,
  nColumns: number,
  mapOfObstacles: boolean[][],
): ActorSetup[] {
  const actors: ActorSetup[] = [];
  const places: Record<string, boolean> = {};

  // ------------------------------------------------------
  // --- give each side the same total amount of actors ---
  // ------------------------------------------------------
  const sides: Side[] = [ATTACKER, DEFENDER];

  sides.forEach((side) => {
    let amountSoFar = 0;
    while (amountSoFar < perTeamAmount) {
      const amount = Math.min(perTeamAmount - amountSoFar, Math.floor(20 + randomFraction() * 60));

      const type = KNIGHT;
      const { row, column } = placeActorOnMap(side, nRows, nColumns, mapOfObstacles, places);

      actors.push({ side, amount, type, row, column, ...ATTRIBUTES[type] });
      amountSoFar += amount;
    }
  });

  // ---------------------------------------------------------------------
  // --- use the order in which actors will make moves during the game ---
  // ---------------------------------------------------------------------
  actors.sort((a1, a2) => {
    if (a1.speed !== a2.speed) return a1.speed - a2.speed;
    if (a1.row !== a2.row) return a1.row - a2.row;
    if (a1.side !== a2.side) return a1.side === ATTACKER ? -1 : 1;
    return a1.column - a2.column;
  });

  // -------------------------------------------------------------
  // --- remove actors who didn't fit due to the lack of space ---
  // -------------------------------------------------------------
  return actors.filter((actor) => actor.row >= 0 && actor.column >= 0);
}

/**
 * Try putting the actor on map in an unused spot on a field that is not blocked.
 * There's a limited number of attempts, though. If all of them fail,
 * return { row: -1, column: -1 }.
 */
function placeActorOnMap(
  side: Side,
  nRows: number,
  nColumns: number,
  mapOfObstacles: boolean[][],
  placesUsed: Record<string, boolean>,
): FieldCoords {
  // NOTE: There's the maximal number of 100 attempts.
  for (let n = 0; n < 100; n += 1) {
    const row = Math.floor(randomFraction() * nRows);
    let column = Math.floor(randomFraction() * 4);

    if (side === DEFENDER) {
      column = nColumns - 1 - column;
    }

    const key = `(${row},${column})`;

    if (!placesUsed[key] && !getMapValue({ row, column }, mapOfObstacles)) {
      placesUsed[key] = true;
      return { row, column };
    }
  }

  return { row: -1, column: -1 };
}
