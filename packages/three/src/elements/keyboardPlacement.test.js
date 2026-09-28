import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { viewerPose } from "./keyboardPlacement.js";

/**
 * A head at the given place, turned by the given yaw and pitch.
 *
 * @param {[number, number, number]} position
 * @param {number} [yaw]
 * @param {number} [pitch]
 */
function head(position, yaw = 0, pitch = 0) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ")),
    new THREE.Vector3(1, 1, 1),
  );
}

/**
 * @param {THREE.Vector3} actual
 * @param {[number, number, number]} expected
 */
function assertNear(actual, [x, y, z]) {
  assert.ok(
    Math.abs(actual.x - x) < 1e-9 && Math.abs(actual.y - y) < 1e-9 && Math.abs(actual.z - z) < 1e-9,
    `expected (${x}, ${y}, ${z}), got (${actual.x}, ${actual.y}, ${actual.z})`,
  );
}

/**
 * Which way the board's face, its +z, points once turned by the yaw.
 *
 * @param {number} yaw
 */
function faceOf(yaw) {
  return new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
}

describe("viewerPose", () => {
  test("puts the board ahead of the eyes and below them, facing back", () => {
    const pose = viewerPose(head([0, 1.6, 0]));
    assertNear(pose.position, [0, 1.4, -0.45]);
    assertNear(faceOf(pose.yaw), [0, 0, 1]);
  });

  test("turns with the head's heading", () => {
    const pose = viewerPose(head([1, 1.6, 1], Math.PI / 2));
    assertNear(pose.position, [1 - 0.45, 1.4, 1]);
    assertNear(faceOf(pose.yaw), [1, 0, 0]);
  });

  test("keeps it level when the head looks down", () => {
    const pose = viewerPose(head([0, 1.6, 0], 0, -Math.PI / 3));
    assertNear(pose.position, [0, 1.4, -0.45]);
    assertNear(faceOf(pose.yaw), [0, 0, 1]);
  });

  test("falls back to the room's forward when there is no heading", () => {
    const pose = viewerPose(head([0, 1.6, 0], 0, -Math.PI / 2));
    assertNear(pose.position, [0, 1.4, -0.45]);
  });

  test("takes reach and drop", () => {
    const pose = viewerPose(head([0, 1.6, 0]), { reach: 0.6, drop: 0.3 });
    assertNear(pose.position, [0, 1.3, -0.6]);
  });
});
