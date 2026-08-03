import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  align,
  alignUpright,
  quaternions,
  QUARTER_TURN,
  snapToHorizontalAxis,
  turn,
  upAxis,
  uprightQuaternions,
} from "./rotations.js";

const identity = new THREE.Quaternion();
const xAxis = new THREE.Vector3(1, 0, 0);
const yAxis = new THREE.Vector3(0, 1, 0);
const zAxis = new THREE.Vector3(0, 0, 1);

function isAligned(quaternion: THREE.Quaternion) {
  return quaternions.some((candidate) => Math.abs(candidate.dot(quaternion)) > 1 - 1e-6);
}

function apply(quaternion: THREE.Quaternion, axis: THREE.Vector3) {
  const result = new THREE.Vector3().copy(axis).applyQuaternion(quaternion);
  // Rounding keeps the comparison readable; every value here is 0, 1 or -1.
  // The `|| 0` turns a negative zero into a plain one.
  return [Math.round(result.x) || 0, Math.round(result.y) || 0, Math.round(result.z) || 0];
}

describe("snapToHorizontalAxis", () => {
  it("picks the grid axis closest to the direction", () => {
    expect(snapToHorizontalAxis(new THREE.Vector3(0.9, 0, 0.3))).toEqual(xAxis);
    expect(snapToHorizontalAxis(new THREE.Vector3(-0.9, 0, 0.3))).toEqual(
      new THREE.Vector3(-1, 0, 0),
    );
    expect(snapToHorizontalAxis(new THREE.Vector3(0.2, 0, -0.9))).toEqual(
      new THREE.Vector3(0, 0, -1),
    );
  });

  it("ignores how steeply the direction points up or down", () => {
    expect(snapToHorizontalAxis(new THREE.Vector3(0.1, 5, 0.9))).toEqual(zAxis);
  });
});

describe("alignUpright", () => {
  it("knows the four ways round a brick can stand", () => {
    expect(uprightQuaternions).toHaveLength(4);
    for (const quaternion of uprightQuaternions) {
      expect(apply(quaternion, yAxis)).toEqual([0, 1, 0]);
    }
  });

  it("keeps a brick the right way up however the wrist is turned", () => {
    const rolled = new THREE.Quaternion().setFromEuler(new THREE.Euler(2.6, 0.4, 0.3));
    expect(apply(align(rolled), yAxis)).not.toEqual([0, 1, 0]);
    expect(apply(alignUpright(rolled), yAxis)).toEqual([0, 1, 0]);
  });

  it("still follows the wrist round", () => {
    for (const [turnBy, heading] of [
      [0, [1, 0, 0]],
      [QUARTER_TURN, [0, 0, -1]],
      [2 * QUARTER_TURN, [-1, 0, 0]],
      [3 * QUARTER_TURN, [0, 0, 1]],
    ] as const) {
      // A wrist a little off the exact quarter turn still reads as that turn.
      const wrist = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, turnBy + 0.25, 0.1));
      expect(apply(alignUpright(wrist), xAxis)).toEqual(heading);
    }
  });
});

describe("turn", () => {
  it("turns around the given axis", () => {
    expect(apply(turn(identity, upAxis, QUARTER_TURN), xAxis)).toEqual([0, 0, -1]);
    expect(apply(turn(identity, xAxis, QUARTER_TURN), yAxis)).toEqual([0, 0, 1]);
  });

  it("comes back to where it started after four quarter turns", () => {
    let quaternion = identity;
    for (let i = 0; i < 4; i++) {
      quaternion = turn(quaternion, upAxis, QUARTER_TURN);
    }
    expect(Math.abs(quaternion.dot(identity))).toBeCloseTo(1);
  });

  it("keeps stacking turns in the frame of the board, not of the brick", () => {
    const yawed = turn(turn(identity, upAxis, QUARTER_TURN), upAxis, QUARTER_TURN);
    expect(apply(yawed, xAxis)).toEqual([-1, 0, 0]);

    // Tipping a yawed brick forwards still tips it around the board's x axis.
    const tipped = turn(yawed, xAxis, QUARTER_TURN);
    expect(apply(tipped, yAxis)).toEqual([0, 0, 1]);
  });

  it("leaves the result on the grid", () => {
    const tumbled = turn(
      turn(turn(identity, upAxis, QUARTER_TURN), zAxis, -QUARTER_TURN),
      xAxis,
      QUARTER_TURN,
    );
    expect(isAligned(tumbled)).toBe(true);
  });

  it("does not drift after many turns", () => {
    let quaternion = identity;
    for (let i = 0; i < 100; i++) {
      quaternion = turn(quaternion, i % 2 === 0 ? upAxis : xAxis, QUARTER_TURN);
    }
    expect(isAligned(quaternion)).toBe(true);
    expect(Math.abs(quaternion.dot(align(quaternion)))).toBeCloseTo(1);
  });
});
