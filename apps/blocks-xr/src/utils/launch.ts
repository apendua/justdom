/**
 * What a slingshot does when it is let go.
 *
 * A real slingshot has no aiming device: the stone leaves along the line that
 * runs from the pouch through the fork, and how fast it leaves depends on how
 * far back the bands were pulled. Both hands therefore matter — one decides
 * where, the other how hard — which is the whole ergonomics of the thing, and
 * the reason this is worth having as a function of two points.
 *
 * Everything here is in board units, one unit to a cell.
 */
import * as THREE from "three";

export interface LaunchOptions {
  /** Below this the bands are barely stretched and nothing is fired. */
  minDraw: number;
  /** Pulling further than this adds no more speed, as the bands run out. */
  maxDraw: number;
  /** Speed gained per unit of draw. */
  speedPerUnit: number;
  /** How far ahead of the fork the stone appears, so it starts clear of it. */
  muzzleOffset: number;
}

export interface Launch {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** How far the bands were pulled, after clamping. */
  draw: number;
}

export const defaultLaunchOptions: LaunchOptions = {
  minDraw: 0.5,
  maxDraw: 6,
  speedPerUnit: 17.5,
  muzzleOffset: 0.4,
};

/**
 * Where the pouch is allowed to be, given where the hand holding it is. Pulling
 * past the end of the bands stops moving the pouch, exactly as it would stop
 * stretching real rubber.
 */
export function clampDraw(
  fork: THREE.Vector3,
  hand: THREE.Vector3,
  maxDraw: number,
): THREE.Vector3 {
  const pull = hand.clone().sub(fork);
  const length = pull.length();
  if (length <= maxDraw || length === 0) {
    return hand.clone();
  }
  return fork.clone().add(pull.multiplyScalar(maxDraw / length));
}

/**
 * The shot a release produces, or null if the bands were not pulled far enough
 * to be worth firing.
 */
export function computeLaunch(
  fork: THREE.Vector3,
  pouch: THREE.Vector3,
  options: LaunchOptions = defaultLaunchOptions,
): Launch | null {
  const pull = fork.clone().sub(pouch);
  const length = pull.length();
  if (length < options.minDraw) {
    return null;
  }
  const draw = Math.min(length, options.maxDraw);
  const direction = pull.divideScalar(length);
  return {
    position: fork.clone().addScaledVector(direction, options.muzzleOffset),
    velocity: direction.clone().multiplyScalar(draw * options.speedPerUnit),
    draw,
  };
}
