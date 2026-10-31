/**
 * Reading a thumbstick as discrete steps rather than as a continuous value.
 *
 * The stick has to travel back towards its centre before it can produce
 * another step, so one flick rotates a brick exactly once no matter how long
 * the stick is held or how many frames it is sampled over.
 */

export type Step = -1 | 0 | 1;

export interface StickLatch {
  x: Step;
  y: Step;
}

export interface StickReading {
  x: number;
  y: number;
}

export interface StickSteps {
  latch: StickLatch;
  x: Step;
  y: Step;
}

export const neutralLatch: StickLatch = { x: 0, y: 0 };

const ENGAGE = 0.6;
const RELEASE = 0.35;

export function readStick(gamepad?: Gamepad | null): StickReading {
  const axes = gamepad?.axes;
  if (!axes || axes.length === 0) {
    return { x: 0, y: 0 };
  }
  // The xr-standard mapping puts the touchpad on axes 0 and 1 and the
  // thumbstick on 2 and 3; controllers without a touchpad only report the
  // first pair.
  const offset = axes.length >= 4 ? 2 : 0;
  return { x: axes[offset] ?? 0, y: axes[offset + 1] ?? 0 };
}

function latchAxis(latch: Step, value: number): Step {
  if (latch !== 0) {
    return Math.abs(value) < RELEASE ? 0 : latch;
  }
  if (value >= ENGAGE) {
    return 1;
  }
  if (value <= -ENGAGE) {
    return -1;
  }
  return 0;
}

/**
 * Advance the latch by one sample. A step is reported only on the frame the
 * stick engages, which is what keeps a held stick from spinning the brick.
 */
export function stepStick(latch: StickLatch, reading: StickReading): StickSteps {
  const x = latchAxis(latch.x, reading.x);
  const y = latchAxis(latch.y, reading.y);
  return {
    latch: { x, y },
    x: latch.x === 0 ? x : 0,
    y: latch.y === 0 ? y : 0,
  };
}
