import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACKER, COMPUTER, DEFENDER, HUMAN, KNIGHT } from "../constants";
import { areTheSameField } from "../helpers/map";
import { isNeighbor } from "../helpers/neighbors";
import type { ActorSetup, FieldCoords, GameSetup } from "../types";
import BotPlayer from "./BotPlayer";
import Game from "./Game";
import chooseMove from "./bot";

function knight(
  side: typeof ATTACKER | typeof DEFENDER,
  row: number,
  column: number,
  amount = 10,
  speed = 5,
): ActorSetup {
  return { side, row, column, amount, speed, type: KNIGHT, strength: 2, toughness: 5 };
}

function newGame(setup: Partial<GameSetup> & Pick<GameSetup, "actors">): Game {
  return new Game(
    { nRows: 8, nColumns: 8, obstacles: [], ...setup },
    { gameId: "game", controllers: { [ATTACKER]: HUMAN, [DEFENDER]: COMPUTER } },
  );
}

describe("chooseMove", () => {
  it("attacks an enemy it is already standing next to, without walking off", () => {
    const game = newGame({ actors: [knight(DEFENDER, 3, 3), knight(ATTACKER, 3, 4)] });
    const [bot, enemy] = game.actors;

    const move = chooseMove(game, bot);
    expect(move?.opponent).toBe(enemy);
    expect(move?.path).toHaveLength(1);
    expect(areTheSameField(move!.path[0], bot)).toBe(true);
  });

  it("walks up to an enemy within reach and hits it", () => {
    const game = newGame({ actors: [knight(DEFENDER, 3, 0), knight(ATTACKER, 3, 4)] });
    const [bot, enemy] = game.actors;

    const move = chooseMove(game, bot);
    expect(move?.opponent).toBe(enemy);
    // The route starts where the stack stands and ends next to its target.
    expect(areTheSameField(move!.path[0], bot)).toBe(true);
    expect(isNeighbor(move!.path[move!.path.length - 1], enemy)).toBe(true);
    expect(move!.path.length - 1).toBeLessThanOrEqual(bot.speed);
  });

  it("prefers the enemy it can wipe out over the one it can merely dent", () => {
    const game = newGame({
      actors: [
        knight(DEFENDER, 3, 3),
        // Four units die to a stack that hits for twenty; sixty do not.
        knight(ATTACKER, 3, 4, 60),
        knight(ATTACKER, 2, 3, 4),
      ],
    });
    const [bot, , weakling] = game.actors;

    expect(chooseMove(game, bot)?.opponent).toBe(weakling);
  });

  it("prefers the trade that costs it less when neither target dies", () => {
    const game = newGame({
      actors: [
        knight(DEFENDER, 3, 3, 5),
        // Both survive the blow, but the bigger stack hits back much harder.
        knight(ATTACKER, 3, 4, 60),
        knight(ATTACKER, 2, 3, 20),
      ],
    });
    const [bot, , smaller] = game.actors;

    expect(chooseMove(game, bot)?.opponent).toBe(smaller);
  });

  it("closes the distance when there is nothing within reach", () => {
    const game = newGame({ actors: [knight(DEFENDER, 0, 0), knight(ATTACKER, 7, 7)] });
    const [bot, enemy] = game.actors;

    const move = chooseMove(game, bot);
    expect(move).not.toBe(null);
    expect(move?.opponent).toBeUndefined();
    expect(move!.path.length).toBeGreaterThan(1);
    expect(move!.path.length - 1).toBeLessThanOrEqual(bot.speed);

    // It ends up genuinely closer to the enemy than it started.
    const distanceTo = (field: FieldCoords) =>
      Math.abs(field.row - enemy.row) + Math.abs(field.column - enemy.column);
    expect(distanceTo(move!.path[move!.path.length - 1])).toBeLessThan(distanceTo(bot));
  });

  it("goes around a wall rather than through it", () => {
    const wall: FieldCoords[] = [0, 1, 2, 3, 4, 5].map((row) => ({ row, column: 3 }));
    const game = newGame({
      obstacles: wall,
      actors: [knight(DEFENDER, 0, 0), knight(ATTACKER, 0, 5)],
    });
    const [bot] = game.actors;

    const move = chooseMove(game, bot);
    expect(move).not.toBe(null);
    for (const field of move!.path) {
      expect(wall.some((o) => areTheSameField(o, field))).toBe(false);
    }
  });

  it("passes when it is walled in", () => {
    const game = newGame({
      // The lone defender is boxed into the top left corner.
      obstacles: [
        { row: 0, column: 1 },
        { row: 1, column: 0 },
        { row: 1, column: 1 },
      ],
      actors: [knight(DEFENDER, 0, 0), knight(ATTACKER, 7, 7)],
    });
    const [bot] = game.actors;

    expect(chooseMove(game, bot)).toBe(null);
  });

  it("has nothing to do once there is no enemy left", () => {
    const game = newGame({ actors: [knight(DEFENDER, 3, 3), knight(ATTACKER, 3, 4, 0)] });
    const [bot] = game.actors;

    expect(chooseMove(game, bot)).toBe(null);
  });

  it("does not move a stack that is already dead", () => {
    const game = newGame({ actors: [knight(DEFENDER, 3, 3, 0), knight(ATTACKER, 3, 4)] });
    const [bot] = game.actors;

    expect(chooseMove(game, bot)).toBe(null);
  });
});

describe("BotPlayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes its turn on its own, once, after a pause", () => {
    const game = newGame({ actors: [knight(ATTACKER, 3, 4), knight(DEFENDER, 3, 3)] });
    const bot = new BotPlayer(game, 400);
    const [, botActor] = game.actors;

    // The human is up first, so nothing happens.
    vi.advanceTimersByTime(1000);
    expect(game.actorHasMoved).toBe(false);

    game.nextActor();
    expect(game.isWaitingForBot).toBe(true);

    // It thinks before it moves.
    vi.advanceTimersByTime(399);
    expect(game.actorHasMoved).toBe(false);

    vi.advanceTimersByTime(11);
    expect(game.actorHasMoved).toBe(true);
    expect(botActor.isAttacking || botActor.movePath !== null).toBe(true);

    bot.dispose();
  });

  it("plays a battle through to the end without being prodded", () => {
    const game = new Game(
      {
        nRows: 6,
        nColumns: 6,
        obstacles: [],
        actors: [knight(ATTACKER, 2, 2), knight(DEFENDER, 3, 3)],
      },
      { gameId: "game", controllers: { [ATTACKER]: COMPUTER, [DEFENDER]: COMPUTER } },
    );
    const bot = new BotPlayer(game, 50);

    // Two stacks whittling each other down; a minute of game time is plenty.
    vi.advanceTimersByTime(60_000);

    expect(game.isOver).toBe(true);
    expect(game.winner).not.toBe(null);
    expect(game.isWaitingForBot).toBe(false);

    bot.dispose();
  });

  it("stops playing once it has been disposed", () => {
    const game = newGame({ actors: [knight(ATTACKER, 3, 4), knight(DEFENDER, 3, 3)] });
    const bot = new BotPlayer(game, 400);

    game.nextActor();
    bot.dispose();
    vi.advanceTimersByTime(5000);

    expect(game.actorHasMoved).toBe(false);
  });
});
