import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { clampDraw, computeLaunch, defaultLaunchOptions } from "./launch.js";

const fork = new THREE.Vector3(0, 2, 0);

describe("computeLaunch", () => {
  it("fires along the line from the pouch through the fork", () => {
    // Pouch pulled straight back and a little down, as a hand does.
    const pouch = new THREE.Vector3(0, 1, 3);
    const launch = computeLaunch(fork, pouch);
    expect(launch).not.toBeNull();
    const direction = launch!.velocity.clone().normalize();
    const expected = fork.clone().sub(pouch).normalize();
    expect(direction.x).toBeCloseTo(expected.x);
    expect(direction.y).toBeCloseTo(expected.y);
    expect(direction.z).toBeCloseTo(expected.z);
  });

  it("gives a longer pull a faster stone", () => {
    const soft = computeLaunch(fork, new THREE.Vector3(0, 2, 1))!;
    const hard = computeLaunch(fork, new THREE.Vector3(0, 2, 4))!;
    expect(hard.velocity.length()).toBeGreaterThan(soft.velocity.length());
    expect(soft.velocity.length()).toBeCloseTo(1 * defaultLaunchOptions.speedPerUnit);
  });

  it("stops gaining speed once the bands are out of stretch", () => {
    const { maxDraw, speedPerUnit } = defaultLaunchOptions;
    const far = computeLaunch(fork, new THREE.Vector3(0, 2, maxDraw + 10))!;
    expect(far.velocity.length()).toBeCloseTo(maxDraw * speedPerUnit);
  });

  it("does not fire when the bands are hardly pulled", () => {
    expect(computeLaunch(fork, new THREE.Vector3(0, 2, 0.1))).toBeNull();
    expect(computeLaunch(fork, fork.clone())).toBeNull();
  });

  it("starts the stone ahead of the fork, not inside it", () => {
    const pouch = new THREE.Vector3(0, 2, 3);
    const launch = computeLaunch(fork, pouch)!;
    expect(launch.position.z).toBeCloseTo(fork.z - defaultLaunchOptions.muzzleOffset);
    expect(launch.position.distanceTo(pouch)).toBeGreaterThan(fork.distanceTo(pouch));
  });
});

describe("clampDraw", () => {
  it("leaves the pouch in the hand while there is stretch left", () => {
    const hand = new THREE.Vector3(0, 2, 2);
    expect(clampDraw(fork, hand, 6).toArray()).toEqual(hand.toArray());
  });

  it("holds the pouch at the end of the bands", () => {
    const hand = new THREE.Vector3(0, 2, 20);
    const pouch = clampDraw(fork, hand, 6);
    expect(pouch.distanceTo(fork)).toBeCloseTo(6);
    // Still on the line between the fork and the hand.
    expect(pouch.x).toBeCloseTo(0);
    expect(pouch.y).toBeCloseTo(2);
  });

  it("survives a hand sitting exactly on the fork", () => {
    const pouch = clampDraw(fork, fork.clone(), 6);
    expect(pouch.toArray()).toEqual(fork.toArray());
  });
});
