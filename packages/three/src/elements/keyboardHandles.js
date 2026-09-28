import * as THREE from "three";
import { useEffect, withComputation } from "@apendua/signal";
import { carry } from "../carry.js";
import { interactions } from "../interactions.js";
import { $ } from "../operators.js";

/**
 * @import {Unsubscribable} from '@apendua/signal';
 * @import {PointerCancelEvent, PointerEvent, XREventMap} from '../core.js';
 */

/**
 * The handles a keyboard in the room is moved by.
 *
 * A board opened in front of the player is where the host guessed they
 * would want it; it is the player who knows. So it can be picked up, by
 * four strips along its edges — never by its keys, which a press means
 * something else on. The strips are the host's, drawn beside the board
 * rather than in its DOM, so a keyboard an app wrote does not have to know
 * it can be moved.
 *
 * They are not there until they are wanted. With no ray on the board they
 * are invisible, though a ray finds them all the same; with a ray anywhere
 * on it they show faintly, so there is something to find; the one a ray is
 * on, and all of them while the board is being carried, show in full.
 *
 * A carry keeps the board level and turns it only about the vertical,
 * which is `carry()`'s whole point: the recline is under the anchor it
 * poses, on the hinge, and is left as it was.
 */

/**
 * How wide the strips are, in the board's px: a fingertip, at a millimetre
 * a px.
 */
export const DEFAULT_HANDLE_WIDTH = 14;

/**
 * How much of each strip shows, by what the rays are doing. Taste rather
 * than measurement: enough to be found, and then enough to be sure of.
 */
export const HANDLE_OPACITY_IDLE = 0;
export const HANDLE_OPACITY_NEAR = 0.25;
export const HANDLE_OPACITY_ACTIVE = 0.9;

const BAR_COLOR = 0xe8ecf2;
/** The drawn bar's thickness, in px, and its length as a share of its side. */
const BAR_THICKNESS = 4;
const BAR_LENGTH = 0.4;

/** @typedef {"top" | "bottom" | "left" | "right"} Side */

/** @type {readonly Side[]} */
const SIDES = ["top", "bottom", "left", "right"];

/**
 * @typedef {object} KeyboardHandles
 * @property {(width: number, height: number, units: number) => void} layout
 *   Fit the strips to a board this many px across and down, hanging from
 *   the hinge, at `units` per px.
 * @property {() => void} dispose
 */

/**
 * @param {WeakKey} ctx A context with interactions and a renderer: the
 *   carry follows the hand once a frame.
 * @param {object} options
 * @param {THREE.Object3D} options.anchor What is carried: the board's anchor
 *   in the room.
 * @param {THREE.Object3D} options.pivot The hinge, whose frame the board and
 *   the strips are laid out in.
 * @param {number} [options.width] The strips' width, in the board's px.
 * @param {() => void} options.onPutDown Told when a carry ends, with the
 *   board where the player left it.
 * @returns {KeyboardHandles}
 */
export function createKeyboardHandles(
  ctx,
  { anchor, pivot, width = DEFAULT_HANDLE_WIDTH, onPutDown },
) {
  const { makeInteractive } = interactions(ctx);
  const carried = carry(ctx);

  const group = new THREE.Group();
  pivot.add(group);
  const plane = new THREE.PlaneGeometry(1, 1);
  // Never drawn, always hit: the manager leaves out what is not `visible`,
  // and three's raycast does not ask the material.
  const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });

  const strips = SIDES.map((side) => {
    const hit = /** @type {THREE.Mesh<THREE.PlaneGeometry, THREE.Material, XREventMap>} */ (
      new THREE.Mesh(plane, hitMaterial)
    );
    hit.name = `keyboard-handle-${side}`;
    const bar = new THREE.Mesh(
      plane,
      new THREE.MeshBasicMaterial({
        color: BAR_COLOR,
        transparent: true,
        opacity: HANDLE_OPACITY_IDLE,
        depthWrite: false,
      }),
    );
    bar.name = `keyboard-handle-${side}-bar`;
    bar.visible = false;
    // Beside the strip rather than under it, so the ray tests the strip
    // alone.
    group.add(hit, bar);
    return { side, hit, bar };
  });

  /**
   * What each ray is on, among the board's things: its keys, its
   * background, the strips. A pointer event bubbles from what the ray met up
   * to the anchor, and `originalTarget` is what it met.
   *
   * @type {Map<unknown, THREE.Object3D>}
   */
  const pointing = new Map();
  let carrying = false;

  function refresh() {
    const pointedAt = new Set(pointing.values());
    for (const { hit, bar } of strips) {
      const opacity =
        carrying || pointedAt.has(hit)
          ? HANDLE_OPACITY_ACTIVE
          : pointing.size > 0
            ? HANDLE_OPACITY_NEAR
            : HANDLE_OPACITY_IDLE;
      bar.material.opacity = opacity;
      bar.visible = opacity > 0;
    }
  }

  /** @param {PointerEvent} event */
  const onEnter = (event) => {
    pointing.set(event.controller, /** @type {THREE.Object3D} */ (event.originalTarget));
    refresh();
  };
  /** @param {PointerCancelEvent} event */
  const onLeave = (event) => {
    if (pointing.get(event.controller) === event.originalTarget) {
      pointing.delete(event.controller);
      refresh();
    }
  };
  const target = /** @type {THREE.Object3D<XREventMap>} */ (anchor);
  target.addEventListener("pointerenter", onEnter);
  target.addEventListener("pointerleave", onLeave);

  /** @type {Unsubscribable[]} */
  const subscriptions = [
    $(target, [
      carried.carriable(),
      () => {
        useEffect(
          () => {
            const held = carried.held() !== null;
            withComputation(null, () => {
              if (carrying && !held) {
                onPutDown();
              }
              carrying = held;
              refresh();
            });
          },
          { name: "keyboard-handles:held" },
        );
      },
    ]).subscribe({}),
    ...strips.map(({ hit }) => $(hit, [makeInteractive(), carried.handle()]).subscribe({})),
  ];

  return {
    layout(boardWidth, boardHeight, units) {
      const w = boardWidth;
      const h = boardHeight;
      const hw = width;
      /** @type {Record<Side, [number, number, number, number]>} */
      const boxes = {
        top: [0, hw / 2, w, hw],
        bottom: [0, -h - hw / 2, w, hw],
        left: [-(w + hw) / 2, -h / 2, hw, h],
        right: [(w + hw) / 2, -h / 2, hw, h],
      };
      for (const { side, hit, bar } of strips) {
        const [x, y, sx, sy] = boxes[side];
        hit.position.set(x * units, y * units, 0);
        hit.scale.set(Math.max(sx, 1e-3) * units, Math.max(sy, 1e-3) * units, 1);
        const across = side === "top" || side === "bottom";
        bar.position.copy(hit.position);
        bar.scale.set(
          (across ? sx * BAR_LENGTH : BAR_THICKNESS) * units || 1e-6,
          (across ? BAR_THICKNESS : sy * BAR_LENGTH) * units || 1e-6,
          1,
        );
      }
    },
    dispose() {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
      target.removeEventListener("pointerenter", onEnter);
      target.removeEventListener("pointerleave", onLeave);
      group.removeFromParent();
      plane.dispose();
      hitMaterial.dispose();
      for (const { bar } of strips) {
        bar.material.dispose();
      }
    },
  };
}
