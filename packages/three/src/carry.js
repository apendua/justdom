import * as THREE from "three";
import { Signal, makeNonReactive, onCleanup, useEffect, withComputation } from "@apendua/signal";
import { asReader, InteractionContext, setWorldMatrix } from "./interactions.js";
import { useFrame } from "./render.js";

/**
 * @import { EntityEffect } from "@apendua/signal";
 * @import { Object3D, XRTargetRaySpace } from "three";
 * @import { InputEvent, InputCancelEvent, XREventMap } from "./core.js";
 * @import { Reactive } from "./interactions.js";
 */

/*
 * Carrying something about the room with a hand, without letting it tip over.
 *
 * A hand that grabs an object and simply hands its own pose to it — which is
 * what `drag()` does, by parenting the object to the controller — passes on
 * the wrist's roll and pitch as well as where the hand has got to. That is
 * right for a brick, which is being aimed; it is wrong for a board, which has
 * a floor and things standing on it. So a carry keeps only what a level thing
 * can have: where it is, and which way round it faces.
 *
 * The point the ray landed on when the hand closed — the grab point — is the
 * reference for everything that follows. It stays pinned to the ray, the same
 * distance out along it, and the board turns *about it* rather than about the
 * hand or its own centre. A board grabbed by its far corner is steered by that
 * corner, and the corner never slides out from under the cursor: tipping the
 * wrist moves the board where the ray now points, while the board itself stays
 * level throughout.
 */

const upAxis = new THREE.Vector3(0, 1, 0);

/**
 * A pose with no tilt in it: somewhere to stand, and which way round to face.
 *
 * @typedef {object} LevelPose
 * @property {THREE.Vector3} position
 * @property {number} yaw
 */

/**
 * What has to be remembered from the moment a thing was taken hold of.
 *
 * @typedef {object} Grip
 * @property {number} handYaw Which way round the hand was held when it closed.
 * @property {number} distance How far out along the ray the grab point was.
 * @property {THREE.Vector3} offset From the grab point to where the carried
 *   thing stood, at that moment.
 * @property {number} yaw Which way round the carried thing faced when the hand
 *   closed on it.
 */

/**
 * How far a rotation turns about the up axis, with the tipping over left out:
 * the twist of the rotation about the vertical, which for a quaternion is
 * simply the part of it that lies along that axis.
 *
 * Asked of the direction the hand points instead, this would fall apart in the
 * one pose a board on a table is always reached for — a hand aimed at the floor
 * points nowhere in particular, and the yaw of a vertical ray is anybody's
 * guess. The twist has no such blind spot: a hand pointing straight down still
 * says which way round it is held.
 *
 * Tip a hand over about any level axis and this does not budge, which is the
 * property the carry rests on. A wrist motion that does turn about the vertical
 * — and pitching then rolling is partly that, however it feels — turns the
 * board with it, because that is a turn the player made.
 *
 * @param {THREE.Quaternion} quaternion
 * @returns {number}
 */
export function yawOf(quaternion) {
  const angle = 2 * Math.atan2(quaternion.y, quaternion.w);
  // A quaternion says the same thing twice over, so that spans two turns.
  // Brought back to one, to keep the numbers something a person can read.
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * Reads a matrix as the nearest level pose, dropping whatever tilt it had.
 *
 * @param {THREE.Matrix4} matrix
 * @returns {LevelPose}
 */
export function levelPose(matrix) {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, yaw: yawOf(quaternion) };
}

/**
 * The hand as a pointing device: where it is, and where it is aiming.
 *
 * @param {THREE.Matrix4} hand
 */
function rayOf(hand) {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  hand.decompose(position, quaternion, scale);
  // A target ray space points down its own -z; the same convention
  // three.js's Raycaster.setFromXRController casts along.
  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  return { position, quaternion, direction };
}

/**
 * Takes hold: the hand, the point its ray landed on, and where the carried
 * thing stood, all as they are at this moment.
 *
 * @param {THREE.Matrix4} hand
 * @param {THREE.Vector3} grabPoint
 * @param {LevelPose} pose
 * @returns {Grip}
 */
export function beginCarry(hand, grabPoint, pose) {
  const ray = rayOf(hand);
  return {
    handYaw: yawOf(ray.quaternion),
    distance: grabPoint.clone().sub(ray.position).length(),
    offset: pose.position.clone().sub(grabPoint),
    yaw: pose.yaw,
  };
}

/**
 * Where the carried thing belongs now the hand has moved on. The grab point is
 * put back on the ray, as far out as it was taken hold of, and the thing hangs
 * off it by the offset it was grabbed with — turned about the grab point as the
 * hand turns about the vertical, so a twist of the wrist pivots the board on
 * the spot the cursor is holding rather than sweeping it sideways. The wrist's
 * roll and pitch never tilt it: they only steer where the ray, and with it the
 * grab point, goes.
 *
 * @param {Grip} grip
 * @param {THREE.Matrix4} hand
 * @returns {LevelPose}
 */
export function carriedPose(grip, hand) {
  const ray = rayOf(hand);
  const turned = yawOf(ray.quaternion) - grip.handYaw;
  const grabPoint = ray.position.clone().addScaledVector(ray.direction, grip.distance);
  const offset = grip.offset.clone().applyAxisAngle(upAxis, turned);
  return {
    position: grabPoint.add(offset),
    yaw: grip.yaw + turned,
  };
}

/**
 * Puts an object at a pose given in world coordinates, leaving its size alone —
 * the boards being carried here are scaled down to the room, and a carry has no
 * business changing how big anything is.
 *
 * @param {THREE.Object3D} object
 * @param {LevelPose} pose
 * @returns {void}
 */
export function applyLevelPose(object, pose) {
  object.updateWorldMatrix(true, false);
  const scale = new THREE.Vector3();
  object.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  setWorldMatrix(
    object,
    new THREE.Matrix4().compose(
      pose.position,
      new THREE.Quaternion().setFromAxisAngle(upAxis, pose.yaw),
      scale,
    ),
  );
}

/**
 * The hand carrying the object: which controller, and the input source
 * driving it. A carry can change hands, so both can change over its life.
 *
 * @typedef {object} CarryHold
 * @property {XRTargetRaySpace} controller
 * @property {XRInputSource} inputSource
 */

/**
 * @typedef {object} CarryOptions
 * @property {Reactive<boolean>} [enabled] Whether a press on a handle can take
 *   hold right now — a boolean, a reactive getter, or an observable, as
 *   `makeInteractive` takes. Unlike a drag, a carry that is disabled while
 *   under way is put down where it is: nothing was reparented, so there is
 *   nothing to undo, and a board left hanging off a hand that can no longer
 *   steer it is worse than one set down.
 */

/**
 * @typedef {object} Carry
 * @property {<T extends Object3D<XREventMap>>() => EntityEffect<T>} carriable
 *   The operator for the object that is carried, for its operator list.
 * @property {<T extends Object3D<XREventMap>>() => EntityEffect<T>} handle
 *   The operator for a handle: an object a press on takes the carried thing
 *   by. It listens for the presses; it does not make the object pointable,
 *   because which of the carried thing's parts are handles is the scene's
 *   decision — `makeInteractive()` goes in the same list, or the presses
 *   bubble up from parts that already are.
 * @property {() => CarryHold | null} held The hand carrying the object, or
 *   null while nobody is. Reactive: read it inside an effect and the effect
 *   re-runs as the object is taken, handed over, and put down.
 */

/**
 * Carrying an object about the room with a hand, level.
 *
 * Where `drag()` hands the object the hand's whole pose, this keeps only what
 * a level thing can have — where it is, and which way round it faces — and
 * steers it by the grab point, the spot the ray landed on when the hand
 * closed: see the top of this file. The object is not reparented; it is
 * posed, once a frame, from where the hand has got to.
 *
 * The presses are taken by handles rather than by the carried object as a
 * whole, so that only furniture starts a carry: a board by its floor, a tray
 * by its rails. A press that bubbled up from anywhere else — a panel that did
 * not want it, whatever sits behind one — would otherwise carry the board off,
 * which is a surprising thing for a board to do when the player has just
 * pressed a button. A scene that does want any unclaimed press to carry can
 * put `handle()` on the carried object itself.
 *
 * The bookkeeping is `drag()`'s: it remembers which hand, so a press from the
 * other hand while the object is carried is a handover — the new hand takes
 * the grip from wherever its own ray lands — and only the carrying hand's
 * release puts the object down; and the presses a handle takes never reach
 * whatever is behind it.
 *
 * ```js
 * const board = carry(ctx, { enabled: () => phase.get() === "build" });
 * $(new THREE.Group(), [
 *   board.carriable(),
 *   children(
 *     $(floor, [makeInteractive(), board.handle()]),
 *     Game(ctx),
 *   ),
 * ]);
 * ```
 *
 * @param {WeakKey} ctx
 * @param {CarryOptions} [options]
 * @returns {Carry}
 */
export function carry(ctx, options = {}) {
  const { enabled = true } = options;
  const manager = InteractionContext.get(ctx);
  const isEnabled = asReader(enabled);
  /** @type {Signal<(CarryHold & { grip: Grip }) | null>} */
  const hold = Signal.of(null);
  /** @type {Object3D | undefined} */
  let object;

  const take = makeNonReactive(
    /**
     * @param {InputEvent} event
     */
    (event) => {
      if (!isEnabled()) {
        return;
      }
      manager.stopPropagation(event);
      if (!object) {
        return;
      }
      const { controller, inputSource } = event;
      controller.updateWorldMatrix(true, false);
      object.updateWorldMatrix(true, false);
      // A press from the other hand while carried is a handover, and takes the
      // grip afresh from where its own ray lands; the same hand pressing again
      // cannot happen without a release in between.
      hold.set({
        controller,
        inputSource,
        grip: beginCarry(
          controller.matrixWorld,
          event.intersection.point.clone(),
          levelPose(object.matrixWorld),
        ),
      });
    },
  );

  const drop = makeNonReactive(
    /**
     * @param {InputCancelEvent} event
     */
    (event) => {
      const current = hold.get();
      if (!current) {
        // The press this releases was swallowed above while it was carriable,
        // so the release is swallowed too rather than reaching whatever is
        // behind as a release it never saw the press of.
        if (isEnabled()) {
          manager.stopPropagation(event);
        }
        return;
      }
      manager.stopPropagation(event);
      if (current.controller === event.controller) {
        hold.set(null);
      }
    },
  );

  /**
   * @template {Object3D<XREventMap>} T
   * @returns {EntityEffect<T>}
   */
  const handle = () => (entity) => {
    entity.addEventListener("selectstart", take);
    entity.addEventListener("selectend", drop);
    onCleanup(() => {
      entity.removeEventListener("selectstart", take);
      entity.removeEventListener("selectend", drop);
    });
  };

  /**
   * @template {Object3D<XREventMap>} T
   * @returns {EntityEffect<T>}
   */
  const carriable = () => (entity) => {
    object = entity;
    onCleanup(() => {
      if (object === entity) {
        object = undefined;
        withComputation(null, () => hold.set(null));
      }
    });
    useEffect(
      () => {
        if (!isEnabled()) {
          withComputation(null, () => {
            if (hold.get()) {
              hold.set(null);
            }
          });
        }
      },
      { name: "carry:enabled" },
    );
    useEffect(
      () => {
        const current = hold.get();
        if (!current) {
          return;
        }
        useFrame(ctx, () => {
          // three.js has written the hand's new pose by now, but only into
          // its local matrix; the world one is still last frame's.
          current.controller.updateWorldMatrix(true, false);
          applyLevelPose(entity, carriedPose(current.grip, current.controller.matrixWorld));
        });
      },
      { name: "carry:follow" },
    );
  };

  return {
    carriable,
    handle,
    held: () => {
      const current = hold.get();
      return current ? { controller: current.controller, inputSource: current.inputSource } : null;
    },
  };
}
