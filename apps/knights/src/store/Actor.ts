import { mutate, store } from "@apendua.dev/signal";
import type { ActorType, Side } from "../constants";
import type { ActorSetup, FieldCoords } from "../types";

interface ActorState {
  row: number;
  column: number;
  movePath: FieldCoords[] | null;
  isAttacking: boolean;
  isFinishing: boolean;
  isHit: boolean;
  isDying: boolean;
  direction: number;
  totalHealth: number;
}

/**
 * A single stack of units on the board.
 *
 * Everything that changes during a game lives in a `store`, so that reading a
 * property inside a component subscribes that component to it. The attributes
 * that never change are plain readonly fields.
 *
 * Every mutation refuses to touch a dead actor, which is what keeps a stack
 * that has just been wiped out from walking, swinging or being knocked out
 * again by an animation step that was queued before it died.
 */
export default class Actor {
  public readonly idx: number;
  public readonly type: ActorType;
  public readonly side: Side;
  public readonly speed: number;
  public readonly strength: number;
  public readonly toughness: number;

  #state: ActorState;

  public constructor(setup: ActorSetup, idx: number) {
    this.idx = idx;
    this.type = setup.type;
    this.side = setup.side;
    this.speed = setup.speed;
    this.strength = setup.strength;
    this.toughness = setup.toughness;
    this.#state = store<ActorState>({
      row: setup.row,
      column: setup.column,
      movePath: null,
      isAttacking: false,
      isFinishing: false,
      isHit: false,
      isDying: false,
      direction: 0,
      totalHealth: setup.amount * setup.toughness,
    });
  }

  public get row(): number {
    return this.#state.row;
  }

  public get column(): number {
    return this.#state.column;
  }

  public get movePath(): FieldCoords[] | null {
    return this.#state.movePath;
  }

  public get isAttacking(): boolean {
    return this.#state.isAttacking;
  }

  public get isFinishing(): boolean {
    return this.#state.isFinishing;
  }

  public get isHit(): boolean {
    return this.#state.isHit;
  }

  public get isDying(): boolean {
    return this.#state.isDying;
  }

  public get direction(): number {
    return this.#state.direction;
  }

  public get totalHealth(): number {
    return this.#state.totalHealth;
  }

  public get isAlive(): boolean {
    return this.#state.totalHealth > 0;
  }

  /**
   * The number of units still standing in this stack.
   */
  public get amount(): number {
    return Math.ceil(this.#state.totalHealth / this.toughness);
  }

  /**
   * The damage this stack deals in one swing. A stack that has lost units hits
   * for less, and a dead one does not hit at all.
   */
  public get attackPower(): number {
    return this.strength * this.amount;
  }

  @mutate()
  public beginMove(movePath: FieldCoords[]): void {
    if (!this.isAlive) {
      return;
    }
    this.#state.movePath = movePath;
  }

  @mutate()
  public finishMove(): void {
    const movePath = this.#state.movePath;
    if (!this.isAlive || !movePath || movePath.length === 0) {
      return;
    }
    const lastOnPath = movePath[movePath.length - 1];
    this.#state.movePath = null;
    this.#state.row = lastOnPath.row;
    this.#state.column = lastOnPath.column;
  }

  @mutate()
  public beginAttack(direction: number, isFinishing: boolean): void {
    if (!this.isAlive) {
      return;
    }
    this.#state.isAttacking = true;
    this.#state.isFinishing = isFinishing;
    this.#state.direction = direction;
  }

  @mutate()
  public finishAttack(): void {
    if (!this.isAlive) {
      return;
    }
    this.#state.isAttacking = false;
    this.#state.isFinishing = false;
    this.#state.direction = 0;
  }

  /**
   * Face the incoming blow. The direction is the one the attacker is swinging
   * in, so it has to be flipped to point back at them.
   */
  @mutate()
  public beginHit(direction: number, isDying: boolean): void {
    if (!this.isAlive) {
      return;
    }
    this.#state.isHit = true;
    this.#state.isDying = isDying;
    this.#state.direction = direction > 0 ? direction - 4 : direction + 4;
  }

  @mutate()
  public finishHit(attackPower: number, isFinishing: boolean): void {
    if (!this.isAlive) {
      return;
    }
    this.#state.isHit = false;
    this.#state.isDying = false;
    this.#state.totalHealth = Math.max(0, this.#state.totalHealth - attackPower);
    // A stack that went down keeps facing the way it fell, so that the corpse
    // matches the last frame of the animation that killed it.
    if (!isFinishing) {
      this.#state.direction = 0;
    }
  }
}
