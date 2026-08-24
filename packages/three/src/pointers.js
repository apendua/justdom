import * as THREE from "three";
import {
  addDependency,
  effects,
  fromEvent,
  memoize,
  onCleanup,
  observeFn,
  set,
  toEffect,
} from "@apendua/signal";
import { list } from "./core.js";
import { $ } from "./operators.js";
import { InteractionContext } from "./interactions.js";

/**
 * @import { Signal } from '@apendua/signal';
 * @import { Component, XREventMap } from './core.js';
 * @import { Observable } from 'rxjs';
 * @import { Pointers } from './interactions.js';
 */

/**
 * Radius of the default ball, in metres — a centimetre across, which is about
 * the smallest mark that still reads as solid at arm's length.
 */
const DEFAULT_RADIUS = 0.005;

const DEFAULT_COLOR = "#ffffff";

const ballGeometry = memoize(
  /**
   * @param {number} radius
   * @returns {THREE.BufferGeometry}
   */
  (radius) => {
    const geometry = new THREE.SphereGeometry(radius, 16, 12);
    onCleanup(() => {
      geometry.dispose();
    });
    return geometry;
  },
);

const ballMaterial = memoize(
  /**
   * @param {THREE.ColorRepresentation} color
   * @returns {THREE.Material}
   */
  (color) => {
    // Unlit on purpose: the mark should read the same wherever it lands, and
    // it is not part of the scene being lit. The chrome flags are what keep
    // it visible — see `adoptAsChrome` for why a cursor is drawn over
    // everything rather than depth-tested into it.
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    onCleanup(() => {
      material.dispose();
    });
    return material;
  },
);

/**
 * Above every figure a panel gives its quads. Panels draw at
 * `elevation * 1000 + depth` (see elevation.js), so anything past a few
 * thousand already clears them; the margin is for a scene that orders
 * something of its own.
 */
const CURSOR_RENDER_ORDER = 1e9;

/**
 * Dress a widget as pointer chrome: drawn over everything, the way a desktop
 * draws the mouse cursor. A cursor depth-tested into the scene is buried by
 * what it lands on — it sits exactly on the hit surface, so half of it is
 * always inside, and a hit reported by a panel's blocker plane sits *behind*
 * the panel's own quads, which then cover the mark completely. Chrome is not
 * part of the scene: it renders after everything (`transparent` puts it in
 * the pass that follows the opaque scene, the render order puts it last
 * within that pass) and ignores depth entirely.
 *
 * The materials are cloned before they are touched — `Object3D.clone()`
 * shares materials with the template, and the template belongs to the
 * caller. The clones are this widget's own; the caller must dispose them
 * when the widget goes.
 *
 * @param {THREE.Object3D} root
 * @returns {THREE.Material[]} the materials this created, to dispose
 */
function adoptAsChrome(root) {
  /** @type {THREE.Material[]} */
  const owned = [];
  /**
   * @param {THREE.Material} material
   * @returns {THREE.Material}
   */
  const chrome = (material) => {
    const own = material.clone();
    own.transparent = true;
    own.depthTest = false;
    own.depthWrite = false;
    owned.push(own);
    return own;
  };
  root.traverse((child) => {
    child.renderOrder = CURSOR_RENDER_ORDER;
    if (!("material" in child)) {
      return;
    }
    const bearer = /** @type {THREE.Mesh} */ (child);
    bearer.material = Array.isArray(bearer.material)
      ? bearer.material.map(chrome)
      : chrome(bearer.material);
  });
  return owned;
}

/**
 * Keeps a widget sitting on the point the ray hit. The intersection is in
 * world space while the widget's position is relative to its parent, so the
 * point is converted rather than copied — that way the widget lands correctly
 * even when it is mounted under a group that is moved or scaled.
 *
 * @template {THREE.Object3D} T
 * @param {Signal<THREE.Intersection<THREE.Object3D<XREventMap>>>} pointer
 * @returns {(widget: T) => void}
 */
function follow(pointer) {
  return (widget) => {
    // The widget is positioned before it is mounted, and again once it lands
    // somewhere — its parent is what the conversion is relative to.
    addDependency(fromEvent(widget, "added"));
    addDependency(fromEvent(widget, "removed"));
    const { point } = pointer.get();
    const { parent } = widget;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      widget.position.copy(parent.worldToLocal(point.clone()));
    } else {
      widget.position.copy(point);
    }
  };
}

/**
 * Where each controller's ray currently lands. Empty for a hand that is
 * pointing at nothing; an entry appears as soon as the ray finds an object
 * that opted in through `makeInteractive()`.
 *
 * Reactive: read it inside a computation (or through `observeFn`) and the
 * computation re-runs as the hits move, appear, and go away.
 *
 * @param {WeakKey} ctx
 * @returns {Pointers}
 */
export function pointers(ctx) {
  return InteractionContext.get(ctx).pointers;
}

/**
 * How far a ray is drawn when it is pointing at nothing, in metres. Far enough
 * to read as heading off into the scene, without being a line across the room.
 */
export const DEFAULT_RAY_LENGTH = 5;

/**
 * Ends a controller's ray where the ray itself ends: at whatever it hit, or at
 * `fallback` when it hit nothing.
 *
 * The ray is drawn as a unit segment down -Z, so its length is its z scale —
 * and the manager casts from the same origin along the same line, which makes
 * its hit distance and that scale the same number.
 *
 * @param {THREE.Object3D} ray The line, already parented to `controller`.
 * @param {THREE.XRTargetRaySpace} controller
 * @param {Pointers} all
 * @param {number} [fallback]
 * @returns {Observable<never>}
 */
export function fitRayToHit(ray, controller, all, fallback = DEFAULT_RAY_LENGTH) {
  // An `Effect` rather than a `Derived`: this writes to the scene graph and
  // has no value, and a `Derived` is only ever run because somebody asked for
  // its value. Nobody would.
  return toEffect(() => {
    const pointer = all.get(controller);
    ray.scale.z = pointer ? pointer.get().distance : fallback;
  });
}

/**
 * @typedef {object} CursorOptions
 * @property {THREE.Object3D} [object] Drawn instead of the default ball, one
 *   clone per active pointer. Cloning shares geometries with the original, so
 *   the original is a template and is never added to the scene itself. The
 *   materials, though, are cloned per widget and dressed as pointer chrome —
 *   drawn over everything, ignoring depth — because a cursor depth-tested
 *   into what it points at is buried by it; the template's own materials are
 *   never touched.
 * @property {number} [scale] Uniform multiplier on the widget, default 1. It
 *   multiplies whatever scale `object` already carries, so a model authored at
 *   its natural size can be shrunk to cursor size here.
 * @property {THREE.ColorRepresentation} [color] Colour of the default ball,
 *   white unless given. Ignored when `object` is provided.
 */

/**
 * A widget drawn where each controller's ray meets the scene — the small mark
 * that tells the player what they are about to act on. One per hand that is
 * pointing at something interactive, appearing and disappearing with the hit.
 *
 * ```js
 * children(
 *   cursors(ctx),                                  // white ball, 1 cm across
 *   cursors(ctx, { scale: 2, color: "#ff0000" }),  // bigger, red
 *   cursors(ctx, { object: myArrow }),             // clone of your own object
 * )
 * ```
 *
 * @param {WeakKey} ctx
 * @param {CursorOptions} [options]
 * @returns {Observable<Component>}
 */
export function cursors(ctx, options = {}) {
  const { object, scale = 1, color = DEFAULT_COLOR } = options;
  const all = pointers(ctx);
  return list(observeFn(all).values(), (pointer) => {
    if (object) {
      const widget = object.clone();
      widget.scale.multiplyScalar(scale);
      const materials = adoptAsChrome(widget);
      return $(widget, [
        effects(() => {
          onCleanup(() => {
            for (const material of materials) {
              material.dispose();
            }
          });
        }),
        effects(follow(pointer)),
      ]);
    }
    const widget = new THREE.Mesh();
    widget.scale.setScalar(scale);
    // The ball's material carries the chrome flags itself — it is shared by
    // every default cursor, so there is nothing to clone or to own here.
    widget.renderOrder = CURSOR_RENDER_ORDER;
    return $(widget, [
      set({
        get geometry() {
          return ballGeometry(DEFAULT_RADIUS);
        },
        get material() {
          return ballMaterial(color);
        },
      }),
      effects(follow(pointer)),
    ]);
  });
}
