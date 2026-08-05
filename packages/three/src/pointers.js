import * as THREE from "three";
import {
  addDependency,
  effects,
  fromEvent,
  memoize,
  onCleanup,
  observeFn,
  set,
} from "@apendua/signal";
import { list } from "./core.js";
import { $ } from "./operators.js";
import { InteractionContext } from "./interactions.js";

/**
 * @import { Observable } from 'rxjs';
 * @import { Signal } from '@apendua/signal';
 * @import { Component, XREventMap } from './core.js';
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
    // it is not part of the scene being lit.
    const material = new THREE.MeshBasicMaterial({ color });
    onCleanup(() => {
      material.dispose();
    });
    return material;
  },
);

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
 * @typedef {object} CursorOptions
 * @property {THREE.Object3D} [object] Drawn instead of the default ball, one
 *   clone per active pointer. Cloning shares geometries and materials with the
 *   original, so the original is a template and is never added to the scene
 *   itself.
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
      return $(widget, [effects(follow(pointer))]);
    }
    const widget = new THREE.Mesh();
    widget.scale.setScalar(scale);
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
