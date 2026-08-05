import * as THREE from "three";
import { onCleanup } from "@apendua/signal";
import { effects, just, on, set, memoize } from "@apendua/signal";
import { $, children } from "../operators.js";
import { interactions } from "../interactions.js";
import VisualProperties from "./VisualProperties.js";
import { makeRectangleGeometry, shrinkRectangle } from "./rectangle.js";
import { getBoundingClientRectCached, getComputedStyleCached } from "./cache.js";

/**
 * @import {XREventMap} from '../core.js';
 * @import {Observable} from 'rxjs';
 * @import {MonoTypeOperatorFunction} from 'rxjs';
 */

/**
 * Whether the element asks to be a ray target of its own. `cursor: pointer`
 * is the same signal the ordinary web uses to mark an element clickable, so
 * buttons opt in through their stylesheet with no extra attribute. Everything
 * else — cards, labels, layout wrappers — stays out of the raycast set; the
 * portal's blocker plane keeps the panel as a whole opaque to rays.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
function isClickable(element) {
  return getComputedStyleCached(element).cursor === "pointer";
}

/**
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @returns {Observable<THREE.Object3D>}
 */
export function div(ctx, element) {
  /** @type {THREE.Object3D<XREventMap>} */
  const object = new THREE.Object3D();
  const properties = new VisualProperties();

  // const material = new Derived(() => {
  //   const basic = new THREE.MeshBasicMaterial();
  //   new Derived(() => {
  //     basic.color.set(backgroundColor.get());
  //   }).get();
  //   onCleanup(() => {
  //     basic.dispose();
  //   });
  //   return basic;
  // });

  const fillMaterial = memoize(
    /**
     * @param {THREE.Color} color
     * @param {number} opacity
     * @returns {THREE.Material}
     */
    (color, opacity) => {
      const material = new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        color,
        opacity,
        transparent: opacity < 1.0,
      });
      onCleanup(() => {
        material.dispose();
      });
      return material;
    },
  );

  const { makeInteractive, stopPropagation } = interactions(ctx);

  /** @type {MonoTypeOperatorFunction<THREE.Object3D<XREventMap>>[]} */
  const interactivity = isClickable(element)
    ? [
        makeInteractive(),
        on("select", (e) => {
          const event = new MouseEvent("click", {
            bubbles: true,
          });
          element.dispatchEvent(event);
          stopPropagation(e);
        }),
        on("selectstart", (e) => {
          const event = new MouseEvent("mousedown", {
            bubbles: true,
          });
          element.dispatchEvent(event);
          element.dataset.xrActive = "true";
          stopPropagation(e);
        }),
        on("selectend", (e) => {
          const event = new MouseEvent("mouseup", {
            bubbles: true,
          });
          element.dispatchEvent(event);
          delete element.dataset.xrActive;
          stopPropagation(e);
        }),
        on("pointermove", () => {
          const event = new MouseEvent("mousemove", {
            bubbles: false,
          });
          element.dispatchEvent(event);
        }),
        on("pointerenter", () => {
          element.dataset.xrHover = "true";
        }),
        on("pointerleave", () => {
          delete element.dataset.xrHover;
        }),
      ]
    : [];

  return just(object, [
    ...interactivity,
    effects((obj) => {
      const elementRect = getBoundingClientRectCached(element);
      const parentRect = element.parentElement
        ? getBoundingClientRectCached(element.parentElement)
        : null;
      if (parentRect) {
        obj.position.set(elementRect.left - parentRect.left, elementRect.top - parentRect.top, -2);
      } else {
        obj.position.set(elementRect.left, elementRect.top, -2);
      }
      properties.setFromElement(element);
    }),
    children(
      $(new THREE.Mesh(), [
        set("material", () => fillMaterial(properties.borderColor, properties.borderAlpha)),
        set("geometry", () => {
          const geometry = makeRectangleGeometry(properties.getRectangleParams(), {
            left: properties.borderLeftWidth,
            right: properties.borderRightWidth,
            top: properties.borderTopWidth,
            bottom: properties.borderBottomWidth,
          });
          onCleanup(() => {
            geometry.dispose();
          });
          return geometry;
        }),
        effects((obj) => {
          obj.position.set(0, 0, 1);
          obj.renderOrder = properties.layerNo;
        }),
      ]),
      $(new THREE.Mesh(), [
        set("material", () => fillMaterial(properties.backgroundColor, properties.backgroundAlpha)),
        set("geometry", () => {
          const geometry = makeRectangleGeometry(
            shrinkRectangle(properties.getRectangleParams(), {
              left: properties.borderLeftWidth,
              right: properties.borderRightWidth,
              top: properties.borderTopWidth,
              bottom: properties.borderBottomWidth,
            }),
          );
          onCleanup(() => {
            geometry.dispose();
          });
          return geometry;
        }),
        effects((obj) => {
          obj.position.set(0, 0, 1);
          obj.renderOrder = properties.layerNo;
        }),
      ]),
    ),
  ]);
}
