import { mutate, store } from "@apendua.dev/signal";
import {
  ATTACKER,
  DEFENDER,
  TIMING_FRAMES_PER_SECOND,
  TIMING_MOVE_BY_ONE_FIELD,
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
  attackerId: string;
  defenderId: string;
}

export interface GameOptions {
  gameId: string;
  userId: string;
  /**
   * When set, both teams are handed to the same player and the game starts
   * right away, skipping the team chooser.
   */
  onePlayer?: boolean;
}

/**
 * One battle: the map, the stacks standing on it, and whose turn it is.
 */
export default class Game {
  public readonly gameId: string;
  public readonly userId: string;
  public readonly nRows: number;
  public readonly nColumns: number;
  public readonly obstacles: FieldCoords[];
  public readonly actors: Actor[];

  #state: GameState;
  #queue = new ActionQueue();

  public constructor(setup: GameSetup, options: GameOptions) {
    const { gameId, userId, onePlayer = false } = options;
    this.gameId = gameId;
    this.userId = userId;
    this.nRows = setup.nRows;
    this.nColumns = setup.nColumns;
    this.obstacles = setup.obstacles.map(({ row, column }) => ({ row, column }));
    this.actors = setup.actors.map((actorSetup, idx) => new Actor(actorSetup, idx));
    this.#state = store<GameState>({
      currentActor: onePlayer ? findNextActor(-1, this.actors) : -1,
      currentRound: onePlayer ? 0 : -1,
      actorHasMoved: !onePlayer,
      attackerId: onePlayer ? userId : "",
      defenderId: onePlayer ? userId : "",
    });
  }

  public get attackerId(): string {
    return this.#state.attackerId;
  }

  public get defenderId(): string {
    return this.#state.defenderId;
  }

  public get currentRound(): number {
    return this.#state.currentRound;
  }

  public get actorHasMoved(): boolean {
    return this.#state.actorHasMoved;
  }

  public get hasStarted(): boolean {
    return this.#state.currentRound >= 0;
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
   * True when the stack whose turn it is belongs to this player. It stays true
   * while the stack is animating, which is what lets the toolbar offer to skip
   * the animation.
   */
  public get isControlledByUser(): boolean {
    const actor = this.currentActor;
    if (!actor) {
      return false;
    }
    if (this.#state.attackerId === this.userId && actor.side === ATTACKER) {
      return true;
    }
    if (this.#state.defenderId === this.userId && actor.side === DEFENDER) {
      return true;
    }
    return false;
  }

  /**
   * True when this player may still give the current stack an order.
   */
  public get isActive(): boolean {
    return this.isControlledByUser && !this.#state.actorHasMoved;
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
    // NOTE: Check if the game has already started.
    if (this.#state.currentRound < 0) {
      return;
    }
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

  @mutate()
  public startGame(): void {
    if (this.#state.currentRound > 0) {
      return;
    }
    this.#state.currentActor = findNextActor(-1, this.actors);
    this.#state.currentRound = 0;
  }

  @mutate()
  public claimAttackingTeam(userId: string): void {
    if (!userId || this.#state.attackerId) {
      return;
    }
    this.#state.attackerId = userId;
    if (this.#state.defenderId) {
      this.#begin();
    }
  }

  @mutate()
  public claimDefendingTeam(userId: string): void {
    if (!userId || this.#state.defenderId) {
      return;
    }
    this.#state.defenderId = userId;
    if (this.#state.attackerId) {
      this.#begin();
    }
  }

  /**
   * Stop whatever is still queued. Called when the game is thrown away, so that
   * a half played move cannot land on the board that replaced it.
   */
  public dispose(): void {
    this.#queue.clear();
  }

  #begin(): void {
    this.#state.actorHasMoved = false;
    this.#state.currentActor = findNextActor(-1, this.actors);
    this.#state.currentRound = 0;
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
