import { $$, attr, children, text } from "@apendua.dev/dom";
import { component, effectMap, memo, mutate, observable, store } from "@apendua.dev/signal";
import { tap } from "rxjs";
import {
  ANIMATION_ACTIVE,
  ANIMATION_ATTACK,
  ANIMATION_DEAD,
  ANIMATION_FALL,
  ANIMATION_HIT,
  ANIMATION_IDLE,
  ANIMATION_WALK,
  ATTACKER,
  TIMING_FRAMES_PER_SECOND,
  TIMING_MOVE_BY_ONE_FIELD,
  type ActorType,
  type AnimationType,
  type Side,
} from "../constants";
import { createMapping } from "../helpers/mappings";
import type { Point } from "../helpers/vector";
import { frames as clock } from "../store/clock";
import type { FieldCoords } from "../types";
import Sprite from "./Sprite";
import type { Dimensions } from "./types";

export interface ActorViewProps extends Dimensions {
  type: ActorType;
  row: number;
  column: number;
  side?: Side;
  movePath?: FieldCoords[] | null;
  totalHealth?: number;
  toughness?: number;
  isActive?: boolean;
  isAttacking?: boolean;
  isHit?: boolean;
  isDying?: boolean;
  /** Overrides the animation that would otherwise follow from the state. */
  animation?: AnimationType;
  /** Overrides the direction that would otherwise follow from the movement. */
  direction?: number;
  forceLoop?: boolean;
  opacity?: number;
}

/**
 * Turn a movement vector into one of the six directions the sprites are drawn
 * for. The sign carries the mirroring.
 */
function directionFromVector(v: Point): number {
  let d = 0;

  if (Math.abs(v.y) < 0.001) {
    d = 2;
  } else if (v.y > 0) {
    d = 3;
  } else if (v.y < 0) {
    d = 1;
  }

  return v.x < 0 ? -d : d;
}

class ActorViewStore {
  #props: ActorViewProps;
  #state = store({ moveProgress: 0, moveSpeed: 0 });

  public constructor(props: ActorViewProps) {
    this.#props = props;
  }

  @memo()
  public get mapping(): (field: FieldCoords) => Point {
    return createMapping(this.#props);
  }

  public get movePath(): FieldCoords[] | null {
    return this.#props.movePath ?? null;
  }

  public get isMoving(): boolean {
    const movePath = this.movePath;
    return !!movePath && movePath.length > 0;
  }

  /**
   * Start walking the path that was just handed to this actor. The speed is
   * chosen so that the whole path takes exactly as long as the move it renders.
   */
  @mutate()
  public restartMove(): void {
    const movePath = this.movePath;
    if (movePath && movePath.length > 0) {
      const totalTime = TIMING_MOVE_BY_ONE_FIELD * (movePath.length - 1);
      this.#state.moveSpeed = 1000 / TIMING_FRAMES_PER_SECOND / totalTime;
    } else {
      this.#state.moveSpeed = 0;
    }
    this.#state.moveProgress = 0;
  }

  @mutate()
  public tick(): void {
    if (this.#state.moveSpeed > 0) {
      this.#state.moveProgress = Math.min(1.0, this.#state.moveProgress + this.#state.moveSpeed);
    }
  }

  /**
   * Which leg of the path the actor is currently walking.
   */
  public get pathIndex(): number {
    const movePath = this.movePath;
    if (movePath && movePath.length > 0) {
      return Math.floor(this.#state.moveProgress * (movePath.length - 1));
    }
    return -1;
  }

  public get directionVector(): Point {
    const movePath = this.movePath;
    const i = this.pathIndex;

    if (!movePath || i < 0 || i === movePath.length - 1) {
      // Standing still: face the other side of the board.
      return { x: this.#props.side === ATTACKER ? 1 : -1, y: 0 };
    }
    const p0 = this.mapping(movePath[i + 0]);
    const p1 = this.mapping(movePath[i + 1]);

    return { x: p1.x - p0.x, y: p1.y - p0.y };
  }

  public get direction(): number {
    return this.#props.direction || directionFromVector(this.directionVector);
  }

  public get animation(): AnimationType {
    if (this.#props.animation) {
      return this.#props.animation;
    }
    if (this.#props.totalHealth === 0) {
      return ANIMATION_DEAD;
    }
    if (this.isMoving) {
      return ANIMATION_WALK;
    }
    if (this.#props.isHit) {
      return this.#props.isDying ? ANIMATION_FALL : ANIMATION_HIT;
    }
    if (this.#props.isAttacking) {
      return ANIMATION_ATTACK;
    }
    return this.#props.isActive ? ANIMATION_ACTIVE : ANIMATION_IDLE;
  }

  /**
   * Where the actor is drawn. While it walks, that is somewhere between two
   * fields rather than on either of them.
   */
  public get position(): Point {
    const movePath = this.movePath;
    const i = this.pathIndex;

    if (!this.isMoving || !movePath || i < 0) {
      return this.mapping(this.#props);
    }
    const posOnSegment = (movePath.length - 1) * this.#state.moveProgress - i;
    const p0 = this.mapping(movePath[i]);
    const vector = this.directionVector;

    return {
      x: p0.x + vector.x * posOnSegment,
      y: p0.y + vector.y * posOnSegment,
    };
  }

  /**
   * How many units are still standing, as shown on the badge.
   */
  public get amount(): number {
    const { totalHealth, toughness } = this.#props;
    if (totalHealth === undefined || !toughness) {
      return 0;
    }
    return Math.ceil(totalHealth / toughness);
  }
}

interface StatusBarProps extends Dimensions {
  x: number;
  y: number;
  amount: number;
  side?: Side;
}

/**
 * The badge above a stack, telling how many units it still has.
 */
const StatusBar = component((_: WeakKey, props: StatusBarProps) => {
  const textColor = () => (props.side === ATTACKER ? "black" : "white");
  const fillColor = () => (props.side === ATTACKER ? "white" : "black");

  return $$("g", [
    attr("transform", () => `translate(${props.x},${props.y - 1.5 * props.fieldHeight})`),
    attr("display", () => (props.amount > 0 ? undefined : "none")),
    children(
      $$("rect", [
        attr("x", () => (1 / 6) * props.fieldWidth),
        attr("width", () => (2 / 3) * props.fieldWidth),
        attr("height", () => (1 / 3) * props.fieldHeight),
        attr({ y: 0, "stroke-width": 1.5, stroke: "#444" }),
        attr("fill", fillColor),
      ]),
      $$("text", [
        attr("x", () => 0.5 * props.fieldWidth),
        attr("y", () => 0.25 * props.fieldHeight),
        attr("font-size", () => 0.25 * props.fieldHeight),
        attr({ "text-anchor": "middle", "stroke-width": 1 }),
        attr("stroke", textColor),
        attr("fill", textColor),
        children(text`${() => props.amount}`),
      ]),
    ),
  ]);
});

/**
 * One stack on the board: its sprite, and the badge that counts its units.
 */
const ActorView = component((ctx: WeakKey, props: ActorViewProps) => {
  const actor = new ActorViewStore(props);

  return $$("g", [
    attr("opacity", () => props.opacity ?? 1.0),
    // Every new path restarts the walk from its first field.
    effectMap(() => observable(() => actor.movePath).pipe(tap(() => actor.restartMove()))),
    effectMap(() => clock.pipe(tap(() => actor.tick()))),
    children(
      Sprite(ctx, {
        get actorType() {
          return props.type;
        },
        get animation() {
          return actor.animation;
        },
        get positionX() {
          return actor.position.x + 0.5 * props.fieldWidth;
        },
        get positionY() {
          return actor.position.y + 0.5 * props.fieldHeight;
        },
        get direction() {
          return actor.direction;
        },
        get forceLoop() {
          return props.forceLoop;
        },
        get height() {
          return 2 * props.fieldHeight;
        },
      }),
      StatusBar(ctx, {
        get x() {
          return actor.position.x;
        },
        get y() {
          return actor.position.y;
        },
        get amount() {
          return actor.amount;
        },
        get side() {
          return props.side;
        },
        get fieldWidth() {
          return props.fieldWidth;
        },
        get fieldHeight() {
          return props.fieldHeight;
        },
        get offsetX() {
          return props.offsetX;
        },
        get offsetY() {
          return props.offsetY;
        },
      }),
    ),
  ]);
});

export default ActorView;
