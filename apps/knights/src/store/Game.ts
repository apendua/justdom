import { memo, mutate, store } from "justdom-signal";
import {
  ATTACKER,
  DEFENDER,
  HUMAN,
  TIMING_FRAMES_PER_SECOND,
  TIMING_MOVE_BY_ONE_FIELD,
  type Controller,
  type Side,
} from "../constants";
import { getDirection } from "../helpers/neighbors";
import type { FieldCoords, GameSetup } from "../types";
import ActionQueue from "./ActionQueue";
import Actor from "./Actor";

/**
 * How long a full attack animation takes. It's twelve frames of the sprite
 * sheet, so it depends on how fast the sprites are played back.
 */
const TIMING_ATTACK = (12 * 1000) / TIMING_FRAMES_PER_SECOND;

/**
 * The pause between a blow landing and the counterattack starting.
 */
const TIMING_FIGHT_BACK = 500;

interface GameState {
  currentActor: number;
  currentRound: number;
  actorHasMoved: boolean;
}

export interface GameOptions {
  gameId: string;
  /**
   * Who gives the orders for each of the two armies.
   */
  controllers: Record<Side, Controller>;
}

/**
 * One battle: the map, the stacks standing on it, and whose turn it is.
 */
export default class Game {
  public readonly gameId: string;
  public readonly nRows: number;
  public readonly nColumns: number;
  public readonly obstacles: FieldCoords[];
  public readonly actors: Actor[];
  public readonly controllers: Record<Side, Controller>;

  #state: GameState;
  #queue = new ActionQueue();

  public constructor(setup: GameSetup, options: GameOptions) {
    this.gameId = options.gameId;
    this.controllers = { ...options.controllers };
    this.nRows = setup.nRows;
    this.nColumns = setup.nColumns;
    this.obstacles = setup.obstacles.map(({ row, column }) => ({ row, column }));
    this.actors = setup.actors.map((actorSetup, idx) => new Actor(actorSetup, idx));
    this.#state = store<GameState>({
      currentActor: findNextActor(-1, this.actors),
      currentRound: 0,
      actorHasMoved: false,
    });
  }

  public get currentRound(): number {
    return this.#state.currentRound;
  }

  public get actorHasMoved(): boolean {
    return this.#state.actorHasMoved;
  }

  public get currentActor(): Actor | undefined {
    return this.actors[this.#state.currentActor];
  }

  /**
   * The field the current actor is standing on, or an off-board field when
   * there is no current actor.
   */
  public get currentCoords(): FieldCoords {
    const actor = this.currentActor;
    return actor ? { row: actor.row, column: actor.column } : { row: -1, column: -1 };
  }

  /**
   * The sides that still have somebody standing.
   */
  @memo((a: Side[], b: Side[]) => a.length === b.length && a.every((side, i) => side === b[i]))
  public get livingSides(): Side[] {
    const sides: Side[] = [ATTACKER, DEFENDER];
    return sides.filter((side) =>
      this.actors.some((actor) => actor.isAlive && actor.side === side),
    );
  }

  public get isOver(): boolean {
    return this.livingSides.length <= 1;
  }

  /**
   * The side that won, once there is nobody left to fight it.
   */
  public get winner(): Side | null {
    return this.isOver ? (this.livingSides[0] ?? null) : null;
  }

  /**
   * Who gives the orders for the stack whose turn it is.
   */
  public get currentController(): Controller | undefined {
    const actor = this.currentActor;
    return actor && this.controllers[actor.side];
  }

  /**
   * True when the stack whose turn it is takes its orders from this screen. It
   * stays true while the stack is animating, which is what lets the toolbar
   * offer to skip the animation.
   */
  public get isControlledByHuman(): boolean {
    return !this.isOver && this.currentController === HUMAN;
  }

  /**
   * True when the player may still give the current stack an order.
   */
  public get isActive(): boolean {
    return this.isControlledByHuman && !this.#state.actorHasMoved;
  }

  /**
   * True when the computer owes the board a move.
   */
  public get isWaitingForBot(): boolean {
    return !this.isOver && this.currentController !== HUMAN && !this.#state.actorHasMoved;
  }

  /**
   * Order a stack to walk along the given path, optionally attacking whoever
   * stands at the end of it. Everything from here on is played out by the
   * queue, one animation step at a time.
   */
  @mutate()
  public moveActor(actor: Actor, movePath: FieldCoords[], opponent?: Actor): void {
    const delay = TIMING_MOVE_BY_ONE_FIELD * (movePath.length - 1);

    this.#queue.push(0, () => {
      actor.beginMove(movePath);
      this.#state.actorHasMoved = true;
    });
    this.#queue.push(delay, () => actor.finishMove());

    if (opponent) {
      this.#queue.push(0, () => this.#beginAttack(actor, opponent));
      this.#queue.push(TIMING_ATTACK, () => this.#finishAttack(actor, opponent));

      // fight back!
      this.#queue.push(TIMING_FIGHT_BACK, () => this.#beginAttack(opponent, actor));
      this.#queue.push(TIMING_ATTACK, () => this.#finishAttack(opponent, actor));
    }

    this.#queue.push(0, () => this.nextActor());
  }

  /**
   * Hand the turn over to the next stack that is still standing.
   */
  @mutate()
  public nextActor(): void {
    const nextActor = findNextActor(this.#state.currentActor, this.actors);
    this.#state.actorHasMoved = false;
    this.#state.currentRound =
      nextActor < this.#state.currentActor
        ? this.#state.currentRound + 1
        : this.#state.currentRound;
    this.#state.currentActor = nextActor;
  }

  /**
   * Cut short the animation step currently being waited for.
   */
  public skipAnimation(): void {
    this.#queue.skip();
  }

  /**
   * Stop whatever is still queued. Called when the game is thrown away, so that
   * a half played move cannot land on the board that replaced it.
   */
  public dispose(): void {
    this.#queue.clear();
  }

  #beginAttack(actor: Actor, opponent: Actor): void {
    const attackPower = actor.attackPower;
    if (attackPower <= 0) {
      // nothing happens if the actor is dead
      return;
    }
    const direction = getDirection(actor, opponent);
    const isFinishing = attackPower >= opponent.totalHealth;
    actor.beginAttack(direction, isFinishing);
    opponent.beginHit(direction, isFinishing);
  }

  #finishAttack(actor: Actor, opponent: Actor): void {
    const attackPower = actor.attackPower;
    if (attackPower <= 0) {
      return;
    }
    const isFinishing = attackPower >= opponent.totalHealth;
    actor.finishAttack();
    opponent.finishHit(attackPower, isFinishing);
  }
}

/**
 * Return the index of the next actor which is still alive.
 */
function findNextActor(currentActor: number, allActors: Actor[]): number {
  for (let i = currentActor + 1; i < allActors.length; i += 1) {
    if (allActors[i].isAlive) {
      return i;
    }
  }
  if (currentActor < 0) {
    return -1;
  }
  return findNextActor(-1, allActors);
}
