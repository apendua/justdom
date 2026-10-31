import { describe, expect, it } from "vitest";
import { neutralLatch, readStick, stepStick } from "./thumbstick.js";

function gamepad(axes: number[]) {
  return { axes } as unknown as Gamepad;
}

describe("readStick", () => {
  it("reads the thumbstick from the xr-standard axes", () => {
    expect(readStick(gamepad([0.1, 0.2, 0.7, -0.8]))).toEqual({ x: 0.7, y: -0.8 });
  });

  it("falls back to the first pair of axes when there is no touchpad", () => {
    expect(readStick(gamepad([0.7, -0.8]))).toEqual({ x: 0.7, y: -0.8 });
  });

  it("reads nothing from a controller without a gamepad", () => {
    expect(readStick(undefined)).toEqual({ x: 0, y: 0 });
    expect(readStick(gamepad([]))).toEqual({ x: 0, y: 0 });
  });
});

describe("stepStick", () => {
  it("ignores a stick that is barely pushed", () => {
    const steps = stepStick(neutralLatch, { x: 0.5, y: -0.5 });
    expect(steps).toMatchObject({ x: 0, y: 0, latch: { x: 0, y: 0 } });
  });

  it("reports a step in the direction the stick was pushed", () => {
    expect(stepStick(neutralLatch, { x: 0.7, y: 0 })).toMatchObject({ x: 1, y: 0 });
    expect(stepStick(neutralLatch, { x: -0.7, y: 0 })).toMatchObject({ x: -1, y: 0 });
    expect(stepStick(neutralLatch, { x: 0, y: 0.7 })).toMatchObject({ x: 0, y: 1 });
    expect(stepStick(neutralLatch, { x: 0, y: -0.7 })).toMatchObject({ x: 0, y: -1 });
  });

  it("reports one step per flick, no matter how long the stick is held", () => {
    let latch = neutralLatch;
    const held = [1, 0.9, 0.8, 0.7];
    const reported: number[] = [];
    for (const x of held) {
      const steps = stepStick(latch, { x, y: 0 });
      latch = steps.latch;
      reported.push(steps.x);
    }
    expect(reported).toEqual([1, 0, 0, 0]);
  });

  it("stays latched until the stick travels back towards the centre", () => {
    let { latch } = stepStick(neutralLatch, { x: 0.9, y: 0 });
    // Still outside the release threshold, so no new step.
    ({ latch } = stepStick(latch, { x: 0.4, y: 0 }));
    expect(latch.x).toBe(1);
    expect(stepStick(latch, { x: 0.9, y: 0 }).x).toBe(0);

    ({ latch } = stepStick(latch, { x: 0.1, y: 0 }));
    expect(latch.x).toBe(0);
    expect(stepStick(latch, { x: 0.9, y: 0 }).x).toBe(1);
  });

  it("latches the two axes independently", () => {
    const first = stepStick(neutralLatch, { x: 0.9, y: 0 });
    expect(first).toMatchObject({ x: 1, y: 0 });
    const second = stepStick(first.latch, { x: 0.9, y: 0.9 });
    expect(second).toMatchObject({ x: 0, y: 1 });
  });
});
