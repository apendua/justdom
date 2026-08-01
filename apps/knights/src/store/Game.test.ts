import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACKER, COMPUTER, DEFENDER, HUMAN, KNIGHT, type Controller } from "../constants";
import type { ActorSetup, GameSetup } from "../types";
import Game from "./Game";

function knight(
  side: typeof ATTACKER | typeof DEFENDER,
  row: number,
  column: number,
  amount = 10,
): ActorSetup {
  return {
    side,
    row,
    column,
    amount,
    type: KNIGHT,
    speed: 5,
    strength: 2,
    toughness: 5,
  };
}

/**
 * Two stacks standing next to each other on a tiny open map.
 */
function duel(): GameSetup {
  return {
    nRows: 3,
    nColumns: 3,
    obstacles: [],
    actors: [knight(ATTACKER, 1, 1), knight(DEFENDER, 1, 2)],
  };
}

const bothHuman: Record<string, Controller> = { [ATTACKER]: HUMAN, [DEFENDER]: HUMAN };

function newGame(setup: GameSetup = duel(), controllers = bothHuman): Game {
  return new Game(setup, { gameId: "game", controllers });
}

/**
 * Run every step the queue can run without waiting. Fake timers drain one
 * chained zero delay step per millisecond, and a move never queues more than a
 * handful of them back to back.
 */
function settle(): void {
  vi.advanceTimersByTime(10);
}

describe("Game", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with the first stack ready to be given an order", () => {
    const game = newGame();
    expect(game.currentRound).toBe(0);
    expect(game.currentActor).toBe(game.actors[0]);
    expect(game.isActive).toBe(true);
    expect(game.isOver).toBe(false);
    expect(game.winner).toBe(null);
  });

  it("hands the computer's stacks to the computer", () => {
    const game = newGame(duel(), { [ATTACKER]: HUMAN, [DEFENDER]: COMPUTER });

    expect(game.isControlledByHuman).toBe(true);
    expect(game.isWaitingForBot).toBe(false);

    game.nextActor();
    expect(game.currentActor?.side).toBe(DEFENDER);
    expect(game.isControlledByHuman).toBe(false);
    expect(game.isActive).toBe(false);
    expect(game.isWaitingForBot).toBe(true);
  });

  it("walks a stack to the end of its path", () => {
    const game = newGame({
      nRows: 3,
      nColumns: 3,
      obstacles: [],
      actors: [knight(ATTACKER, 0, 0), knight(DEFENDER, 2, 2)],
    });
    const [actor] = game.actors;
    const path = [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 0, column: 2 },
    ];

    game.moveActor(actor, path);
    settle();

    // The stack sets off, and is committed to having moved this turn.
    expect(actor.movePath).toEqual(path);
    expect(game.actorHasMoved).toBe(true);
    expect(actor.column).toBe(0);

    // It arrives only after the walk has been given the time to play out.
    vi.advanceTimersByTime(1500);
    expect(actor.movePath).toBe(null);
    expect(actor.row).toBe(0);
    expect(actor.column).toBe(2);
  });

  it("plays out an attack and the counterattack that follows it", () => {
    const game = newGame();
    const [attacker, defender] = game.actors;

    game.moveActor(attacker, [{ row: 1, column: 1 }], defender);

    settle();
    // The blow is swung; nobody has taken damage yet.
    expect(attacker.isAttacking).toBe(true);
    expect(defender.isHit).toBe(true);
    expect(attacker.direction).toBe(2);
    // The defender turns to face the attacker.
    expect(defender.direction).toBe(-2);
    expect(defender.totalHealth).toBe(50);

    // It lands: ten knights hitting for two each.
    vi.advanceTimersByTime(1200);
    expect(attacker.isAttacking).toBe(false);
    expect(defender.isHit).toBe(false);
    expect(defender.totalHealth).toBe(30);
    expect(defender.amount).toBe(6);

    // The defender hits back, now with only six knights left.
    vi.advanceTimersByTime(500);
    expect(defender.isAttacking).toBe(true);
    expect(attacker.isHit).toBe(true);

    vi.advanceTimersByTime(1200);
    expect(attacker.totalHealth).toBe(38);
    expect(defender.isAttacking).toBe(false);

    // And the turn moves on.
    settle();
    expect(game.currentActor).toBe(defender);
    expect(game.actorHasMoved).toBe(false);
  });

  it("marks a stack as finished off when the blow would wipe it out", () => {
    const game = newGame({
      nRows: 3,
      nColumns: 3,
      obstacles: [],
      // Twenty units of health against a stack that hits for exactly twenty.
      actors: [knight(ATTACKER, 1, 1), knight(DEFENDER, 1, 2, 4)],
    });
    const [attacker, defender] = game.actors;

    game.moveActor(attacker, [{ row: 1, column: 1 }], defender);
    settle();
    expect(attacker.isFinishing).toBe(true);
    expect(defender.isDying).toBe(true);

    vi.advanceTimersByTime(1200);
    expect(defender.totalHealth).toBe(0);
    expect(defender.isAlive).toBe(false);
    // A stack that went down keeps facing the way it fell.
    expect(defender.direction).toBe(-2);

    // There is nothing left to hit back, and the battle is decided.
    vi.advanceTimersByTime(2000);
    expect(attacker.totalHealth).toBe(50);
    expect(game.isOver).toBe(true);
    expect(game.winner).toBe(ATTACKER);
    expect(game.isActive).toBe(false);
    expect(game.isWaitingForBot).toBe(false);
  });

  it("hands the turn round the board, counting rounds as it wraps", () => {
    const game = newGame({
      nRows: 3,
      nColumns: 3,
      obstacles: [],
      actors: [knight(ATTACKER, 0, 0), knight(DEFENDER, 2, 2)],
    });

    expect(game.currentActor).toBe(game.actors[0]);
    game.nextActor();
    expect(game.currentActor).toBe(game.actors[1]);
    expect(game.currentRound).toBe(0);

    game.nextActor();
    expect(game.currentActor).toBe(game.actors[0]);
    expect(game.currentRound).toBe(1);
  });

  it("cuts an animation short without dropping the steps behind it", () => {
    const game = newGame();
    const [attacker, defender] = game.actors;

    game.moveActor(attacker, [{ row: 1, column: 1 }], defender);
    settle();
    expect(defender.isHit).toBe(true);

    // Without skipping, the blow would need another 1200ms to land.
    game.skipAnimation();
    settle();
    expect(defender.totalHealth).toBe(30);
    // The counterattack still waits its turn.
    expect(defender.isAttacking).toBe(false);

    vi.advanceTimersByTime(500);
    expect(defender.isAttacking).toBe(true);
  });

  it("stops a half played move from landing on a game that was thrown away", () => {
    const game = newGame();
    const [attacker, defender] = game.actors;

    game.moveActor(attacker, [{ row: 1, column: 1 }], defender);
    settle();
    game.dispose();
    vi.advanceTimersByTime(5000);

    expect(defender.totalHealth).toBe(50);
    expect(game.currentActor).toBe(attacker);
  });
});
