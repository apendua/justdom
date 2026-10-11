import * as THREE from "three";
import {
  component,
  effects,
  makeNonReactive,
  onCleanup,
  useEffect,
  withComputation,
} from "@apendua/signal";
import { asReader, InteractionContext, interactions, setWorldMatrix } from "./interactions.js";
import { createHold } from "./hold.js";
import { $ } from "./operators.js";
import { useFrame } from "./render.js";

/**
 * @import { EntityEffect, Source } from "@apendua/signal";
 * @import { Object3D, XRTargetRaySpace } from "three";
 * @import { Component, InputEvent, InputCancelEvent, PressEnd, XREventMap } from "./core.js";
 * @import { Reactive } from "./interactions.js";
 */

/*
 * Carrying something about the room with a hand, without letting it tip over.
 *
 * A hand that grabs an object and simply hands its own pose to it — which is
 * what `drag()` does, by parenting the object to the controller — passes on
 * the wrist's roll and pitch as well as where the hand has got to. That is
 * right for a brick, which is being aimed; it is wrong for a board, which has
 * a floor and things standing on it. So a carry takes only two things from
 * the hand: where it has got to, and how far it has turned about the
 * vertical. The wrist's roll and pitch never reach the board. A board that
 * was tilted when the hand closed on it keeps that tilt, and only turns
 * about the vertical on top of it.
 *
 * The point the ray landed on when the hand closed — the grab point — is the
 * reference for everything that follows. It stays pinned to the ray, the same
 * distance out along it, and the board turns *about it* rather than about the
 * hand or its own centre. A board grabbed by its far corner is steered by that
 * corner, and the corner never slides out from under the cursor: tipping the
 * wrist moves the board where the ray now points, while the board itself never
 * tips.
 */

const upAxis = new THREE.Vector3(0, 1, 0);

// Scratch for the once-a-frame path. A carry runs for as long as a hand is
// closed, and a board being posed every frame is no place to be making
// garbage: everything below that is not handed back to the caller is written
// into one of these instead.
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _direction = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
/** @type {CarriedPose} */
const _pose = { position: new THREE.Vector3(), yaw: 0, turned: 0 };

/**
 * A pose with no tilt in it: somewhere to stand, and which way round to face.
 *
 * @typedef {object} LevelPose
 * @property {THREE.Vector3} position
 * @property {number} yaw
 */

/**
 * Where a carried thing belongs, and how far it has turned about the
 * vertical since it was taken (see `carriedPose`).
 *
 * @typedef {LevelPose & { turned: number }} CarriedPose
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
 * The hand as a pointing device: where it is, and where it is aiming. Read
 * into the scratch above, so the answer is good until the next call.
 *
 * @param {THREE.Matrix4} hand
 */
function rayOf(hand) {
  hand.decompose(_position, _quaternion, _scale);
  // A target ray space points down its own -z; the same convention
  // three.js's Raycaster.setFromXRController casts along.
  _direction.set(0, 0, -1).applyQuaternion(_quaternion);
  return { position: _position, quaternion: _quaternion, direction: _direction };
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
 * grab point, goes. `turned` is how far the hand has turned about the
 * vertical since it closed, which is how far the thing has turned too.
 *
 * The answer is written into `out` where one is given, which is how a
 * carry asks once a frame without making anything; a fresh one otherwise.
 *
 * @param {Grip} grip
 * @param {THREE.Matrix4} hand
 * @param {CarriedPose} [out]
 * @returns {CarriedPose}
 */
export function carriedPose(
  grip,
  hand,
  out = { position: new THREE.Vector3(), yaw: 0, turned: 0 },
) {
  const ray = rayOf(hand);
  const turned = yawOf(ray.quaternion) - grip.handYaw;
  const offset = _offset.copy(grip.offset).applyAxisAngle(upAxis, turned);
  out.position.copy(ray.position).addScaledVector(ray.direction, grip.distance).add(offset);
  out.yaw = grip.yaw + turned;
  out.turned = turned;
  return out;
}

/**
 * Takes hold of something to be carried tilt and all: where it is in the
 * hand's own frame, which is all a carry that is not kept level has to keep.
 * The hand's pose times this is where the thing belongs from then on, so the
 * grab point stays on the ray without being remembered.
 *
 * @param {THREE.Matrix4} hand
 * @param {THREE.Matrix4} object The carried thing's world matrix.
 * @returns {THREE.Matrix4}
 */
export function beginFreeCarry(hand, object) {
  return new THREE.Matrix4().copy(hand).invert().multiply(object);
}

/**
 * Puts an object at a level pose given in world coordinates, at the world
 * scale given.
 *
 * @param {THREE.Object3D} object
 * @param {LevelPose} pose
 * @param {THREE.Vector3} scale
 * @returns {void}
 */
function placeLevel(object, pose, scale) {
  setWorldMatrix(
    object,
    _matrix.compose(pose.position, _quaternion.setFromAxisAngle(upAxis, pose.yaw), scale),
  );
}

/**
 * Takes hold of something to be kept from tipping: the grip, and the
 * rotation and size it has in the room, which the carry turns and keeps.
 *
 * @param {THREE.Matrix4} hand
 * @param {THREE.Vector3} grabPoint
 * @param {THREE.Matrix4} object The carried thing's world matrix.
 * @returns {{ grip: Grip, rotation: THREE.Quaternion, scale: THREE.Vector3 }}
 */
function takeLevel(hand, grabPoint, object) {
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  object.decompose(_position, rotation, scale);
  return { grip: beginCarry(hand, grabPoint.clone(), levelPose(object)), rotation, scale };
}

/**
 * The size an object is in the room, which a carry leaves alone — the boards
 * being carried here are scaled down to the room, and a carry has no
 * business changing how big anything is.
 *
 * @param {THREE.Object3D} object
 * @returns {THREE.Vector3}
 */
function worldScale(object) {
  object.updateWorldMatrix(true, false);
  const scale = new THREE.Vector3();
  object.matrixWorld.decompose(_position, _quaternion, scale);
  return scale;
}

/**
 * Puts an object at a pose given in world coordinates, leaving its size alone.
 *
 * @param {THREE.Object3D} object
 * @param {LevelPose} pose
 * @returns {void}
 */
export function applyLevelPose(object, pose) {
  placeLevel(object, pose, worldScale(object));
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
 *   steer it is worse than one set down. The release of the press it was
 *   taken with is still swallowed when it comes.
 * @property {boolean} [level] Whether the hand's tilt is kept from the
 *   carried thing. True by default, which is the point of a carry: it turns
 *   only about the vertical, about the grab point, and keeps whatever tilt
 *   it had when taken, as the top of this file says. False
 *   gives it the hand's whole rotation, tilt included, as `drag()` does. It
 *   is still posed once a frame rather than reparented, and still taken by
 *   handles. For a panel the player wants to lay flat or tip toward them,
 *   rather than one that has to stay standing.
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
 *   bubble up from parts that already are. A handle taken out of the scene
 *   mid-carry puts the carried thing down, since the release that would have
 *   is not coming to it any more; it still stops where the press did, short
 *   of whatever is behind.
 * @property {() => CarryHold | null} held The hand carrying the object, or
 *   null while nobody is. Reactive: read it inside an effect and the effect
 *   re-runs as the object is taken, handed over, and put down.
 */

/**
 * Carrying an object about the room with a hand, never tipped by it unless
 * `level: false`.
 *
 * Where `drag()` hands the object the hand's whole pose, this takes from the
 * hand only where it has got to and how far it has turned about the
 * vertical, and steers the object by the grab point, the spot the ray
 * landed on when the hand closed: see the top of this file. The object is
 * not reparented; it is posed, once a frame, from where the hand has got
 * to.
 *
 * The presses are taken by handles rather than by the carried object as a
 * whole, so that only furniture starts a carry: a board by its floor, a tray
 * by its rails. A press that bubbled up from anywhere else — a panel that did
 * not want it, whatever sits behind one — would otherwise carry the board off,
 * which is a surprising thing for a board to do when the player has just
 * pressed a button. A scene that does want any unclaimed press to carry can
 * put `handle()` on the carried object itself.
 *
 * The bookkeeping is `drag()`'s, both taken from `createHold`: it remembers
 * which hand, so a press from the other hand while the object is carried is
 * a handover — the new hand takes the grip from wherever its own ray lands —
 * and only the carrying hand's release puts the object down, a `lost` one
 * included, which the manager sends for a hand that disconnects; and the
 * presses it takes never reach whatever is behind it, nor do their
 * releases.
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
  const { enabled = true, level = true } = options;
  const manager = InteractionContext.get(ctx);
  const isEnabled = asReader(enabled);
  /**
   * The hand, what it took hold through, and how it took hold. Kept level,
   * that is a grip, and the rotation and size the carried thing had in the
   * room, read once here rather than once a frame, since a carry only turns
   * the one and never changes the other. Not kept level, it is where the
   * thing is in the hand's frame, which has both in it.
   *
   * @typedef {CarryHold & { button: "select", handle: Object3D } & (
   *   | {
   *       grip: Grip;
   *       rotation: THREE.Quaternion;
   *       scale: THREE.Vector3;
   *       offset?: never;
   *     }
   *   | { offset: THREE.Matrix4; grip?: never }
   * )} Holding
   */
  /** @type {import("./hold.js").HandHold<Holding>} */
  const presses = createHold(manager);
  const hold = presses.held;
  /** @type {Object3D | undefined} */
  let object;

  const take = makeNonReactive(
    /**
     * @param {Object3D} handle
     * @param {InputEvent} event
     */
    (handle, event) => {
      if (!isEnabled()) {
        return;
      }
      presses.take(event);
      if (!object) {
        return;
      }
      const { controller, inputSource } = event;
      controller.updateWorldMatrix(true, false);
      object.updateWorldMatrix(true, false);
      const hand = controller.matrixWorld;
      // A press from the other hand while carried is a handover, and takes the
      // grip afresh from where its own ray lands; the same hand pressing again
      // cannot happen without a release in between.
      hold.set({
        controller,
        inputSource,
        button: "select",
        handle,
        ...(level
          ? takeLevel(hand, event.intersection.point, object.matrixWorld)
          : { offset: beginFreeCarry(hand, object.matrixWorld) }),
      });
    },
  );

  const drop = makeNonReactive(
    /**
     * @param {InputCancelEvent & PressEnd} event
     */
    (event) => {
      if (presses.release(event, "select")) {
        hold.set(null);
      }
    },
  );

  /**
   * @template {Object3D<XREventMap>} T
   * @returns {EntityEffect<T>}
   */
  const handle = () => (entity) => {
    /** @param {InputEvent} event */
    const onStart = (event) => take(entity, event);
    entity.addEventListener("selectstart", onStart);
    entity.addEventListener("selectend", drop);
    onCleanup(() => {
      entity.removeEventListener("selectstart", onStart);
      entity.removeEventListener("selectend", drop);
      // The release is dispatched to what was pressed, and this is no longer
      // listening for it: a carry taken through this handle would otherwise
      // follow the hand for the rest of the session.
      if (withComputation(null, () => hold.get())?.handle === entity) {
        hold.set(null);
      }
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
          const hand = current.controller.matrixWorld;
          if (current.offset) {
            setWorldMatrix(entity, _matrix.multiplyMatrices(hand, current.offset));
          } else {
            const pose = carriedPose(current.grip, hand, _pose);
            // The rotation it was taken with, turned as far about the
            // vertical as the hand has turned since: whatever tilt it had,
            // it keeps.
            _quaternion.setFromAxisAngle(upAxis, pose.turned).multiply(current.rotation);
            setWorldMatrix(entity, _matrix.compose(pose.position, _quaternion, current.scale));
          }
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

/**
 * A piece of furniture that is also a handle: a mesh of the given geometry
 * and material, standing at the position, that a press on takes the carried
 * thing by. The floor a board is carried by, the rails on a tray. Presses are
 * taken by these rather than by the carried group as a whole, so that only
 * furniture starts a carry — a press on a brick or a panel means what it
 * says there.
 *
 * ```js
 * children(carryHandle(ctx, board, floorGeometry, floorMaterial, floorPosition), Game(ctx));
 * ```
 *
 * @param {WeakKey} ctx
 * @param {Carry} carried
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Material} material
 * @param {THREE.Vector3} position
 * @returns {Source<Component>}
 */
export const carryHandle =
  /** @type {(ctx: WeakKey, carried: Carry, geometry: THREE.BufferGeometry, material: THREE.Material, position: THREE.Vector3) => Source<Component>} */ (
    component(
      /**
       * @param {WeakKey} ctx
       * @param {Carry} carried
       * @param {THREE.BufferGeometry} geometry
       * @param {THREE.Material} material
       * @param {THREE.Vector3} position
       */
      (ctx, carried, geometry, material, position) => {
        const { makeInteractive } = interactions(ctx);
        const mesh = /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.Material, XREventMap>} */ (
          new THREE.Mesh(geometry, material)
        );
        return $(mesh, [
          effects((o) => {
            o.position.copy(position);
          }),
          makeInteractive(),
          carried.handle(),
        ]);
      },
    )
  );
