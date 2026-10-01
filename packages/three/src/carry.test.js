import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Signal } from "@apendua/signal";
import { InteractionContext, InteractionManager } from "./interactions.js";
import { RendererContext, runFrame } from "./render.js";
import { $, children } from "./operators.js";
import {
  applyLevelPose,
  beginCarry,
  beginFreeCarry,
  carriedPose,
  carry,
  levelPose,
  yawOf,
} from "./carry.js";

/**
 * @import { XREventMap } from "./core.js";
 * @import { CarryOptions } from "./carry.js";
 */

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

/**
 * How far a hand is tipped over, and about which level axis.
 *
 * @typedef {object} Tilt
 * @property {THREE.Vector3} [axis]
 * @property {number} [angle]
 */

/**
 * A wrist: turned this far about the vertical, then tipped over about a level
 * axis. Splitting it up this way is what lets a test tip a hand without also
 * turning it — composing a pitch with a roll turns it a little as well.
 *
 * @param {number} yaw
 * @param {Tilt} [tilt]
 */
function turned(yaw, { axis = rightAxis, angle = 0 } = {}) {
  return new THREE.Quaternion()
    .setFromAxisAngle(upAxis, yaw)
    .multiply(new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), angle));
}

/**
 * A hand somewhere in the room, held however the wrist likes.
 *
 * @param {THREE.Vector3} position
 * @param {number} [yaw]
 * @param {Tilt} [tilt]
 */
function hand(position, yaw = 0, tilt = {}) {
  return new THREE.Matrix4().compose(position, turned(yaw, tilt), new THREE.Vector3(1, 1, 1));
}

/**
 * Where a hand's ray reaches, this far out along it.
 *
 * @param {THREE.Matrix4} matrix
 * @param {number} distance
 */
function reach(matrix, distance) {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  matrix.decompose(position, quaternion, new THREE.Vector3());
  return position.addScaledVector(
    new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion),
    distance,
  );
}

/** @param {THREE.Vector3} vector */
function rounded(vector) {
  return vector.toArray().map((value) => Math.round(value * 1000) / 1000);
}

/**
 * @param {number} actual
 * @param {number} expected
 * @param {string} [message]
 */
function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `${actual} is not close to ${expected}`);
}

describe("yawOf", () => {
  test("reads back the turn of a level rotation", () => {
    for (const yaw of [0, 0.4, QUARTER, 2.5, -1.2, -QUARTER]) {
      close(yawOf(turned(yaw)), yaw);
    }
  });

  test("takes no notice of how far the hand is tipped over", () => {
    for (const axis of levelAxes) {
      for (const angle of [0.3, -0.3, 1.2, -1.2, QUARTER, -QUARTER]) {
        close(yawOf(turned(0.7, { axis, angle })), 0.7);
      }
    }
  });

  test("still reads the turn of a hand pointing straight down", () => {
    // The pose a board on a table is always reached for in, and the one where
    // the direction the hand points has nothing left to say about the wrist.
    close(yawOf(turned(1.1, { angle: -QUARTER })), 1.1);
    close(yawOf(turned(-2.4, { angle: -QUARTER })), -2.4);
  });
});

describe("levelPose", () => {
  test("keeps the position and drops the tilt", () => {
    const pose = levelPose(hand(new THREE.Vector3(1, 2, 3), 0.6, { angle: -0.8 }));
    assert.deepEqual(pose.position.toArray(), [1, 2, 3]);
    close(pose.yaw, 0.6);
  });
});

describe("carriedPose", () => {
  const board = { position: new THREE.Vector3(0, -0.4, -1.1), yaw: 0.2 };

  /**
   * A grab: the hand aims somewhere and takes hold of what its ray hits.
   *
   * @param {THREE.Matrix4} grabbed
   * @param {number} distance
   */
  function grab(grabbed, distance) {
    return beginCarry(grabbed, reach(grabbed, distance), board);
  }

  test("leaves the board where it was until the hand moves", () => {
    const grabbed = hand(new THREE.Vector3(0.1, 0, -0.9), 0.3, { angle: -0.7 });
    const pose = carriedPose(grab(grabbed, 0.6), grabbed);
    close(pose.position.distanceTo(board.position), 0);
    close(pose.yaw, board.yaw);
  });

  test("carries the board along with the hand", () => {
    const from = new THREE.Vector3(0.1, 0, -0.9);
    const to = new THREE.Vector3(0.6, 0.3, -1.4);
    const pose = carriedPose(grab(hand(from), 0.5), hand(to));
    assert.deepEqual(
      rounded(pose.position),
      rounded(board.position.clone().add(to.clone().sub(from))),
    );
    close(pose.yaw, board.yaw);
  });

  test("keeps the grab point pinned to the ray, however the wrist tips", () => {
    const place = new THREE.Vector3(0.1, 0.2, -0.9);
    const grabbed = hand(place, 0.3, { angle: -0.5 });
    const distance = 0.8;
    const grip = grab(grabbed, distance);
    const offset = board.position.clone().sub(reach(grabbed, distance));
    for (const axis of levelAxes) {
      for (const angle of [-1.2, -QUARTER, -0.2, 0.4]) {
        const tipped = hand(place, 0.3, { axis, angle });
        const pose = carriedPose(grip, tipped);
        // The board is not tilted by the wrist — only towed: it still hangs
        // off the grab point by the same offset, and still faces the same way.
        assert.deepEqual(
          rounded(pose.position),
          rounded(reach(tipped, distance).clone().add(offset)),
        );
        close(pose.yaw, board.yaw);
      }
    }
  });

  test("pivots the board about the grab point when the hand turns", () => {
    const place = new THREE.Vector3(0.2, 0.1, -0.3);
    const grabbed = hand(place, 0, { angle: -0.6 });
    const distance = 0.7;
    const grip = grab(grabbed, distance);
    const grabPoint = reach(grabbed, distance);
    const turnedHand = hand(place, QUARTER, { angle: -0.6 });
    const pose = carriedPose(grip, turnedHand);
    close(pose.yaw, board.yaw + QUARTER);
    close(pose.turned, QUARTER, "how far it turned");
    // The whole grip turned a quarter turn about the vertical through the
    // hand, and the board hangs off the grab point turned the same way.
    const turnedGrabPoint = reach(turnedHand, distance);
    const expected = board.position
      .clone()
      .sub(grabPoint)
      .applyAxisAngle(upAxis, QUARTER)
      .add(turnedGrabPoint);
    assert.deepEqual(rounded(pose.position), rounded(expected));
  });

  test("keeps hold of the spot it was grabbed by, wherever the hand goes", () => {
    const grabbed = hand(new THREE.Vector3(0.4, 0.1, -0.8), 0.2, { angle: -0.4 });
    const distance = 1.1;
    const grip = grab(grabbed, distance);
    const offset = board.position.clone().sub(reach(grabbed, distance));
    const moved = hand(new THREE.Vector3(-0.7, 0.5, 0.3), 1.9, { axis: levelAxes[1], angle: -1.1 });
    const pose = carriedPose(grip, moved);
    // The grab point is still as far out along the ray as it was taken hold
    // of, and the board is still the same distance from it, and the same
    // amount above it: the grip does not slide, and the turn stays level.
    const grabPoint = reach(moved, distance);
    close(pose.position.distanceTo(grabPoint), offset.length());
    close(pose.position.y - grabPoint.y, offset.y);
  });
});

describe("applyLevelPose", () => {
  test("puts the object level at the pose, at the size it already was", () => {
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
    assert.deepEqual(rounded(position), [-0.2, 0.4, -1]);
    close(upAxis.clone().applyQuaternion(quaternion).y, 1);
    close(yawOf(quaternion), 0.9);
    close(scale.x, 0.1);
  });
});

describe("beginFreeCarry", () => {
  test("keeps the thing where it was in the hand, tilt and all", () => {
    const start = hand(new THREE.Vector3(0, 1, 0));
    const board = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 1, -0.5),
      new THREE.Quaternion(),
      new THREE.Vector3(0.1, 0.1, 0.1),
    );
    const offset = beginFreeCarry(start, board);
    close(new THREE.Matrix4().multiplyMatrices(start, offset).elements[14], -0.5);

    // The wrist pitched up a quarter turn: the board goes up with the ray,
    // and turns over with the hand, which a level carry would not do.
    const tipped = hand(new THREE.Vector3(0, 1, 0), 0, { axis: rightAxis, angle: QUARTER });
    const world = new THREE.Matrix4().multiplyMatrices(tipped, offset);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    world.decompose(position, quaternion, scale);
    // Where the ray now points.
    close(position.distanceTo(new THREE.Vector3(0, 1.5, 0)), 0);
    close(upAxis.clone().applyQuaternion(quaternion).y, 0);
    close(scale.x, 0.1);
  });
});

/**
 * A hand at the origin, looking down -Z, which is all
 * `Raycaster.setFromXRController` reads off it.
 *
 * @returns {THREE.XRTargetRaySpace}
 */
function controllerAtOrigin() {
  const controller = new THREE.Object3D();
  controller.updateMatrixWorld();
  return /** @type {THREE.XRTargetRaySpace} */ (/** @type {unknown} */ (controller));
}

/**
 * @param {THREE.Object3D} controller
 * @param {"selectstart" | "selectend"} type
 */
function press(controller, type) {
  controller.dispatchEvent(/** @type {any} */ ({ type, data: {} }));
}

/**
 * A board with a floor for a handle and a panel that is not one, mounted
 * through `$` the way a scene mounts it, with the carry on the board and two
 * hands wired to the manager. The room listens for the presses too, to say
 * which of them got past the board.
 *
 * @param {CarryOptions} [options]
 */
function setup(options) {
  const manager = new InteractionManager();
  const left = controllerAtOrigin();
  const right = controllerAtOrigin();
  const subscriptions = [
    manager.addController(left, () => () => {}).subscribe(),
    manager.addController(right, () => () => {}).subscribe(),
  ];
  const renderer = /** @type {any} */ ({});
  const ctx = RendererContext.set(InteractionContext.set({}, manager), renderer);
  const board = carry(ctx, options);

  const room = /** @type {THREE.Object3D<XREventMap>} */ (
    /** @type {unknown} */ (new THREE.Group())
  );
  const group = /** @type {THREE.Object3D<XREventMap>} */ (
    /** @type {unknown} */ (new THREE.Group())
  );
  const floor = /** @type {THREE.Object3D<XREventMap>} */ (
    /** @type {unknown} */ (
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    )
  );
  floor.position.set(0, 0, -5);
  const panel = /** @type {THREE.Object3D<XREventMap>} */ (
    /** @type {unknown} */ (
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    )
  );
  panel.position.set(0, 0, -3);
  manager.add(floor);
  manager.add(panel);

  /** @type {string[]} */
  const events = [];
  for (const type of /** @type {const} */ (["selectstart", "selectend"])) {
    room.addEventListener(type, () => events.push(`room:${type}`));
  }

  subscriptions.push(
    $(group, [board.carriable(), children($(panel))]).subscribe((component) => {
      component.addTo(room);
    }),
  );
  // The floor is mounted on its own, so a test can take it out of the scene
  // while the board stays: a handle that comes and goes, the way a landscape
  // rebuilt for a new seed does.
  const handleSubscription = $(floor, [board.handle()]).subscribe((component) => {
    component.addTo(group);
    room.updateMatrixWorld(true);
  });

  return {
    left,
    right,
    board,
    group,
    panel,
    /** One frame of the loop, which is when a carry follows the hand. */
    frame: () => {
      runFrame(renderer, 0, /** @type {any} */ ({}));
      group.updateWorldMatrix(true, false);
    },
    events,
    unmountHandle: () => handleSubscription.unsubscribe(),
    dispose: () => {
      handleSubscription.unsubscribe();
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
    },
  };
}

/** Slide something out of the ray, as a hand moving does to what it was on. */
function moveAside(/** @type {THREE.Object3D} */ object) {
  object.position.x = 100;
  object.updateMatrixWorld();
}

describe("carry", () => {
  test("a press on a handle takes hold, and the same hand's release puts it down", () => {
    const { left, board, panel, events, dispose } = setup();
    moveAside(panel);

    press(left, "selectstart");
    assert.strictEqual(board.held()?.controller, left);
    press(left, "selectend");
    assert.equal(board.held(), null);
    // Neither press reached the room behind.
    assert.deepEqual(events, []);
    dispose();
  });

  test("keeps the tilt the board was taken with, and turns it only about the vertical", () => {
    const { left, group, panel, frame, dispose } = setup();
    moveAside(panel);
    // Rolled about the ray, so the floor is still where the ray meets it.
    group.rotation.set(0, 0, 0.4);
    group.updateMatrixWorld(true);
    press(left, "selectstart");
    // The hand turns about the vertical, and tips over as well.
    left.quaternion.copy(turned(0.3, { axis: rightAxis, angle: 0.5 }));
    left.updateMatrixWorld();
    frame();
    const quaternion = new THREE.Quaternion();
    group.matrixWorld.decompose(new THREE.Vector3(), quaternion, new THREE.Vector3());
    const expected = new THREE.Quaternion()
      .setFromAxisAngle(upAxis, 0.3)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.4));
    close(Math.abs(quaternion.dot(expected)), 1);
    press(left, "selectend");
    dispose();
  });

  test("not kept level, it goes with the hand, tilt and all", () => {
    const { left, board, group, panel, frame, events, dispose } = setup({ level: false });
    moveAside(panel);
    press(left, "selectstart");
    assert.strictEqual(board.held()?.controller, left);
    // The board was where the hand was, so now it is wherever the hand is.
    left.position.set(0.2, 1, -0.3);
    left.quaternion.copy(turned(0.3, { axis: rightAxis, angle: 0.5 }));
    left.updateMatrixWorld();
    frame();
    group.matrixWorld.elements.forEach((value, i) => close(value, left.matrixWorld.elements[i]));
    press(left, "selectend");
    assert.equal(board.held(), null);
    assert.deepEqual(events, []);
    dispose();
  });

  test("a press on something that is not a handle carries nothing", () => {
    const { left, board, events, dispose } = setup();
    // The panel is nearer, so it is what the ray meets.
    press(left, "selectstart");
    assert.equal(board.held(), null);
    press(left, "selectend");
    assert.deepEqual(events, ["room:selectstart", "room:selectend"]);
    dispose();
  });

  test("the other hand can take it over, and only that hand's release puts it down", () => {
    const { left, right, board, panel, dispose } = setup();
    moveAside(panel);

    press(left, "selectstart");
    press(right, "selectstart");
    assert.strictEqual(board.held()?.controller, right);

    press(left, "selectend");
    assert.strictEqual(board.held()?.controller, right);

    press(right, "selectend");
    assert.equal(board.held(), null);
    dispose();
  });

  test("disabled, a press passes through to what is behind", () => {
    const { left, board, panel, events, dispose } = setup({ enabled: false });
    moveAside(panel);
    press(left, "selectstart");
    press(left, "selectend");
    assert.equal(board.held(), null);
    assert.deepEqual(events, ["room:selectstart", "room:selectend"]);
    dispose();
  });

  test("being disabled mid-carry puts the object down", () => {
    const allowed = Signal.of(true);
    const { left, board, panel, events, dispose } = setup({ enabled: () => allowed.get() });
    moveAside(panel);
    press(left, "selectstart");
    assert.strictEqual(board.held()?.controller, left);
    allowed.set(false);
    // Nothing was reparented, so there is nothing to undo: it is simply down.
    assert.equal(board.held(), null);
    // And the release that follows passes through, like any press while
    // disabled.
    press(left, "selectend");
    assert.deepEqual(events, ["room:selectend"]);
    dispose();
  });

  test("a handle taken out of the scene mid-carry puts the object down", () => {
    const { left, board, panel, unmountHandle, dispose } = setup();
    moveAside(panel);
    press(left, "selectstart");
    assert.strictEqual(board.held()?.controller, left);
    // The landscape is rebuilt under the hand. The release, when it comes,
    // goes to the old tiles, which are no longer listening — so the carry
    // cannot wait for it.
    unmountHandle();
    assert.equal(board.held(), null);
    press(left, "selectend");
    assert.equal(board.held(), null);
    dispose();
  });

  test("taken out of the scene while carried, it is put down", () => {
    const { left, board, panel, dispose } = setup();
    moveAside(panel);
    press(left, "selectstart");
    assert.strictEqual(board.held()?.controller, left);
    dispose();
    assert.equal(board.held(), null);
  });
});
