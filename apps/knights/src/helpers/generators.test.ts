import { describe, expect, it } from "vitest";
import { ATTACKER, DEFENDER, KNIGHT, MAP_COLUMNS, MAP_ROWS } from "../constants";
import { generateGame } from "./generators";
import { createMapOfObstacles, getMapValue } from "./map";

describe("generateGame", () => {
  const games = Array.from({ length: 20 }, () => generateGame(MAP_ROWS, MAP_COLUMNS));

  it("reports the size of the map it generated", () => {
    for (const game of games) {
      expect(game.nRows).toBe(MAP_ROWS);
      expect(game.nColumns).toBe(MAP_COLUMNS);
    }
  });

  it("keeps everything it places inside the map", () => {
    for (const game of games) {
      for (const { row, column } of [...game.obstacles, ...game.actors]) {
        expect(row).toBeGreaterThanOrEqual(0);
        expect(row).toBeLessThan(MAP_ROWS);
        expect(column).toBeGreaterThanOrEqual(0);
        expect(column).toBeLessThan(MAP_COLUMNS);
      }
    }
  });

  it("never spawns a stack on top of an obstacle", () => {
    for (const game of games) {
      const map = createMapOfObstacles(MAP_ROWS, MAP_COLUMNS, game.obstacles);
      for (const actor of game.actors) {
        expect(getMapValue(actor, map)).toBe(false);
      }
    }
  });

  it("never spawns two stacks on the same field", () => {
    for (const game of games) {
      const keys = game.actors.map(({ row, column }) => `${row},${column}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("lines the two sides up on opposite edges of the map", () => {
    for (const game of games) {
      for (const actor of game.actors) {
        if (actor.side === ATTACKER) {
          expect(actor.column).toBeLessThan(4);
        } else {
          expect(actor.column).toBeGreaterThanOrEqual(MAP_COLUMNS - 4);
        }
      }
    }
  });

  it("fields both sides", () => {
    for (const game of games) {
      expect(game.actors.some((actor) => actor.side === ATTACKER)).toBe(true);
      expect(game.actors.some((actor) => actor.side === DEFENDER)).toBe(true);
    }
  });

  it("gives every stack units and knight attributes", () => {
    for (const game of games) {
      for (const actor of game.actors) {
        expect(actor.type).toBe(KNIGHT);
        expect(actor.amount).toBeGreaterThan(0);
        expect(actor.speed).toBeGreaterThan(0);
        expect(actor.toughness).toBeGreaterThan(0);
        expect(actor.strength).toBeGreaterThan(0);
      }
    }
  });

  it("orders the stacks by the turn they take", () => {
    for (const game of games) {
      for (let i = 1; i < game.actors.length; i += 1) {
        const previous = game.actors[i - 1];
        const actor = game.actors[i];
        if (previous.speed !== actor.speed) {
          expect(previous.speed).toBeLessThan(actor.speed);
        } else if (previous.row !== actor.row) {
          expect(previous.row).toBeLessThan(actor.row);
        } else if (previous.side !== actor.side) {
          expect(previous.side).toBe(ATTACKER);
        } else {
          expect(previous.column).toBeLessThan(actor.column);
        }
      }
    }
  });
});
