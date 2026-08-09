import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyLevelPose, beginCarry, carriedPose, levelPose, yawOf } from "./carry.js";

const QUARTER = Math.PI / 2;

const upAxis = new THREE.Vector3(0, 1, 0);
const rightAxis = new THREE.Vector3(1, 0, 0);

/**
 * Level axes to tip a hand over about. Pitching is a turn about the first,
 * rolling one about the third; the diagonals are both at once, which is how a
 * wrist actually moves.
 */
const levelAxes = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(1, 0, 1),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(-1, 0, 2),
];

/** How far a hand is tipped over, and about which level axis. */
interface Tilt {
  axis?: THREE.Vector3;
  angle?: number;
}

/**
 * A wrist: turned this far about the vertical, then tipped over about a level
 * axis. Splitting it up this way is what lets a test tip a hand without also
 * turning it — composing a pitch with a roll turns it a little as well.
 */
function turned(yaw: number, { axis = rightAxis, angle = 0 }: Tilt = {}): THREE.Quaternion {
  return new THREE.Quaternion()
    .setFromAxisAngle(upAxis, yaw)
    .multiply(new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), angle));
}

/** A hand somewhere in the room, held however the wrist likes. */
function hand(position: THREE.Vector3, yaw = 0, tilt: Tilt = {}): THREE.Matrix4 {
  return new THREE.Matrix4().compose(position, turned(yaw, tilt), new THREE.Vector3(1, 1, 1));
}

function rounded(vector: THREE.Vector3): number[] {
  return vector.toArray().map((value) => Math.round(value * 1000) / 1000);
}

describe("yawOf", () => {
  it("reads back the turn of a level rotation", () => {
    for (const yaw of [0, 0.4, QUARTER, 2.5, -1.2, -QUARTER]) {
      expect(yawOf(turned(yaw))).toBeCloseTo(yaw);
    }
  });

  it("takes no notice of how far the hand is tipped over", () => {
    for (const axis of levelAxes) {
      for (const angle of [0.3, -0.3, 1.2, -1.2, QUARTER, -QUARTER]) {
        expect(yawOf(turned(0.7, { axis, angle }))).toBeCloseTo(0.7);
      }
    }
  });

  it("still reads the turn of a hand pointing straight down", () => {
    // The pose a board on a table is always reached for in, and the one where
    // the direction the hand points has nothing left to say about the wrist.
    expect(yawOf(turned(1.1, { angle: -QUARTER }))).toBeCloseTo(1.1);
    expect(yawOf(turned(-2.4, { angle: -QUARTER }))).toBeCloseTo(-2.4);
  });
});

describe("levelPose", () => {
  it("keeps the position and drops the tilt", () => {
    const pose = levelPose(hand(new THREE.Vector3(1, 2, 3), 0.6, { angle: -0.8 }));
    expect(pose.position.toArray()).toEqual([1, 2, 3]);
    expect(pose.yaw).toBeCloseTo(0.6);
  });
});

describe("carriedPose", () => {
  const board = { position: new THREE.Vector3(0, -0.4, -1.1), yaw: 0.2 };

  it("leaves the board where it was until the hand moves", () => {
    const grabbed = hand(new THREE.Vector3(0.1, 0, -0.9), 0.3, { angle: -0.7 });
    const pose = carriedPose(beginCarry(grabbed, board), grabbed);
    expect(pose.position.distanceTo(board.position)).toBeCloseTo(0);
    expect(pose.yaw).toBeCloseTo(board.yaw);
  });

  it("carries the board along with the hand", () => {
    const from = new THREE.Vector3(0.1, 0, -0.9);
    const to = new THREE.Vector3(0.6, 0.3, -1.4);
    const pose = carriedPose(beginCarry(hand(from), board), hand(to));
    expect(rounded(pose.position)).toEqual(
      rounded(board.position.clone().add(to.clone().sub(from))),
    );
    expect(pose.yaw).toBeCloseTo(board.yaw);
  });

  it("takes no notice of the wrist tipping over", () => {
    const place = new THREE.Vector3(0.1, 0.2, -0.9);
    const carry = beginCarry(hand(place, 0.3), board);
    for (const axis of levelAxes) {
      for (const angle of [-1.2, -QUARTER, 0.9]) {
        const pose = carriedPose(carry, hand(place, 0.3, { axis, angle }));
        expect(pose.position.distanceTo(board.position)).toBeCloseTo(0);
        expect(pose.yaw).toBeCloseTo(board.yaw);
      }
    }
  });

  it("turns the board with the hand, and swings it round the hand", () => {
    const place = new THREE.Vector3();
    const carry = beginCarry(hand(place), board);
    const pose = carriedPose(carry, hand(place, QUARTER));
    expect(pose.yaw).toBeCloseTo(board.yaw + QUARTER);
    // Taken hold of at the origin and turned a quarter turn about it, so the
    // board comes round with the hand rather than staying put.
    expect(rounded(pose.position)).toEqual(
      rounded(board.position.clone().applyAxisAngle(upAxis, QUARTER)),
    );
  });

  it("keeps hold of the spot it was grabbed by, wherever the hand goes", () => {
    const grabbedAt = new THREE.Vector3(0.4, 0.1, -0.8);
    const carry = beginCarry(hand(grabbedAt, 0.2), board);
    const moved = new THREE.Vector3(-0.7, 0.5, 0.3);
    const pose = carriedPose(carry, hand(moved, 1.9, { axis: levelAxes[1], angle: -1.1 }));
    const reach = board.position.clone().sub(grabbedAt);
    // The board is still the same distance from the hand, and still the same
    // amount above it: the grip does not slide, and the turn stays level.
    expect(pose.position.distanceTo(moved)).toBeCloseTo(reach.length());
    expect(pose.position.y - moved.y).toBeCloseTo(reach.y);
  });
});

describe("applyLevelPose", () => {
  it("puts the object level at the pose, at the size it already was", () => {
    const parent = new THREE.Group();
    parent.position.set(1, 2, 3);
    parent.quaternion.setFromAxisAngle(rightAxis, 0.5);
    const object = new THREE.Group();
    object.scale.setScalar(0.1);
    parent.add(object);

    applyLevelPose(object, { position: new THREE.Vector3(-0.2, 0.4, -1), yaw: 0.9 });
    object.updateWorldMatrix(true, false);

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    object.matrixWorld.decompose(position, quaternion, scale);
    expect(rounded(position)).toEqual([-0.2, 0.4, -1]);
    expect(upAxis.clone().applyQuaternion(quaternion).y).toBeCloseTo(1);
    expect(yawOf(quaternion)).toBeCloseTo(0.9);
    expect(scale.x).toBeCloseTo(0.1);
  });
});
