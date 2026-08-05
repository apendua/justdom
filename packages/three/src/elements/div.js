import * as THREE from "three";
import { onCleanup } from "@apendua/signal";
import { Derived, effects, just, on, set, memoize, useEffects } from "@apendua/signal";
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

  /**
   * Whether this element wants to be a ray target, as its own signal so that
   * the group below is attached and detached only when the answer actually
   * flips. Reading `isClickable` straight from the effect would rebuild the
   * group far more often than that: the computed style is deliberately
   * invalidated by every attribute mutation, and the handlers write
   * `data-xr-*` back onto this very element, so each pointer event they
   * handled would tear down the listeners that handled it.
   */
  const clickable = new Derived(() => isClickable(element));

  /**
   * Being a ray target, and forwarding what happens there back to the DOM.
   * These belong together: an element that stops being clickable has to lose
   * the handlers too, not just the registration. The interaction manager
   * dispatches up the parent chain, so a listener left behind on a wrapper
   * that is no longer clickable would still see events bubbling out of a
   * button inside it and synthesise a second, spurious click on the wrapper.
   *
   * @type {MonoTypeOperatorFunction<THREE.Object3D<XREventMap>>[]}
   */
  const interactivity = [
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
  ];

  return just(object, [
    // `cursor: pointer` is a live stylesheet decision — a button gets disabled,
    // a card becomes clickable — so interactivity follows it rather than being
    // fixed at the moment the element was first projected into the scene.
    effects((obj) => {
      if (!clickable.get()) {
        return;
      }
      useEffects(obj, interactivity);
      // Losing the handlers means losing the `pointerleave` that would have
      // cleared these, so an element that stops being clickable while the ray
      // is on it would stay stuck in its hover or active styling.
      onCleanup(() => {
        delete element.dataset.xrHover;
        delete element.dataset.xrActive;
      });
    }),
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
