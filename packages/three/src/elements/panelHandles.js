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
 * The handles a panel is moved by, when it says it can be.
 *
 * A panel is where the scene guessed the player would want it; it is the
 * player who knows. So a panel with `draggable` can be picked up by four
 * strips along its edges. It is never picked up by what is on it, since a
 * press there means something else. The strips are the portal's, drawn beside the panel
 * rather than in its DOM, so a panel an app wrote does not have to know it
 * can be moved. The keyboard a field brings up is a panel too, and is moved
 * by the same strips.
 *
 * They are not there until they are wanted. With no ray on the panel they
 * are invisible, though a ray finds them all the same; with a ray anywhere
 * on it they show faintly, so there is something to find; the one a ray is
 * on, and all of them while the panel is being carried, show in full.
 *
 * The carry is `carry()`'s, so by default the panel is kept level and
 * turns only about the vertical: a panel standing up stays standing up.
 * `level: false` gives it the hand's whole rotation instead.
 */

/**
 * How wide the strips are, in the panel's px: a fingertip, on a keyboard at
 * a millimetre a px.
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
 * @typedef {object} PanelHandles
 * @property {THREE.Group} frame Where the panel goes, centred on its origin:
 *   the strips are laid out around it, a ray on anything in it shows them,
 *   and it is what is carried unless `carried` says otherwise.
 * @property {(width: number, height: number, units: number) => void} layout
 *   Fit the strips to a panel this many px across and down, at `units` per
 *   px.
 * @property {() => void} dispose Take the strips down, and the frame out of
 *   its parent.
 */

/**
 * How a panel is moved, for one that can be: `PortalOptions.draggable`.
 *
 * @typedef {object} PanelDragOptions
 * @property {number} [handleWidth] The strips' width, in the panel's px. 14
 *   by default.
 * @property {boolean} [level] Whether the panel is kept level while carried,
 *   turning only about the vertical, so that a panel standing up stays
 *   standing up. True by default; false gives it the hand's whole
 *   rotation, tilt included (see `CarryOptions.level`).
 * @property {THREE.Object3D} [carried] What a hand on the strips moves. The
 *   panel by default, or an ancestor of it to move the panel together with
 *   what it hangs from. The keyboard carries the anchor its recline hangs
 *   off, so the recline is kept.
 * @property {() => void} [onPutDown] Told when a carry ends, with the panel
 *   where the player left it.
 */

/**
 * @param {WeakKey} ctx A context with interactions and a renderer: the
 *   carry follows the hand once a frame.
 * @param {PanelDragOptions} [options]
 * @returns {PanelHandles}
 */
export function createPanelHandles(ctx, options = {}) {
  /** @type {THREE.Group<XREventMap>} */
  const frame = new THREE.Group();
  const {
    handleWidth = DEFAULT_HANDLE_WIDTH,
    level,
    carried: carriedObject = frame,
    onPutDown,
  } = options;
  const { makeInteractive } = interactions(ctx);
  const carried = carry(ctx, { level });

  const group = new THREE.Group();
  group.name = "panel-handles";
  // Out of the raycast until it is laid out: a strip is a metre-wide plane
  // until then.
  group.visible = false;
  frame.add(group);
  const plane = new THREE.PlaneGeometry(1, 1);
  // Never drawn, always hit: the manager leaves out what is not `visible`,
  // and three's raycast does not ask the material.
  const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });

  const strips = SIDES.map((side) => {
    const hit = /** @type {THREE.Mesh<THREE.PlaneGeometry, THREE.Material, XREventMap>} */ (
      new THREE.Mesh(plane, hitMaterial)
    );
    hit.name = `panel-handle-${side}`;
    const bar = new THREE.Mesh(
      plane,
      new THREE.MeshBasicMaterial({
        color: BAR_COLOR,
        transparent: true,
        opacity: HANDLE_OPACITY_IDLE,
        depthWrite: false,
      }),
    );
    bar.name = `panel-handle-${side}-bar`;
    bar.visible = false;
    // Beside the strip rather than under it, so the ray tests the strip
    // alone.
    group.add(hit, bar);
    return { side, hit, bar };
  });

  /**
   * What each ray is on, among the panel's things: its controls, its
   * background, the strips. A pointer event bubbles from what the ray met up
   * to the frame, and `originalTarget` is what it met.
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
  /**
   * A hand's leave always clears it: the manager sends one leave per hand
   * before that hand's next enter, and what it names as left is whichever
   * mesh the ray was on last, which after a drift from a button's label
   * onto its background is not the mesh the enter named.
   *
   * @param {PointerCancelEvent} event
   */
  const onLeave = (event) => {
    if (pointing.delete(event.controller)) {
      refresh();
    }
  };
  frame.addEventListener("pointerenter", onEnter);
  frame.addEventListener("pointerleave", onLeave);

  /** @type {Unsubscribable[]} */
  const subscriptions = [
    $(/** @type {THREE.Object3D<XREventMap>} */ (carriedObject), [
      carried.carriable(),
      () => {
        useEffect(
          () => {
            const held = carried.held() !== null;
            withComputation(null, () => {
              if (carrying && !held) {
                onPutDown?.();
              }
              carrying = held;
              refresh();
            });
          },
          { name: "panel-handles:held" },
        );
      },
    ]).subscribe({}),
    ...strips.map(({ hit }) => $(hit, [makeInteractive(), carried.handle()]).subscribe({})),
  ];

  return {
    frame,
    layout(panelWidth, panelHeight, units) {
      const w = panelWidth;
      const h = panelHeight;
      const hw = handleWidth;
      group.visible = true;
      /** @type {Record<Side, [number, number, number, number]>} */
      const boxes = {
        top: [0, (h + hw) / 2, w, hw],
        bottom: [0, -(h + hw) / 2, w, hw],
        left: [-(w + hw) / 2, 0, hw, h],
        right: [(w + hw) / 2, 0, hw, h],
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
      frame.removeEventListener("pointerenter", onEnter);
      frame.removeEventListener("pointerleave", onLeave);
      group.removeFromParent();
      frame.removeFromParent();
      plane.dispose();
      hitMaterial.dispose();
      for (const { bar } of strips) {
        bar.material.dispose();
      }
    },
  };
}
