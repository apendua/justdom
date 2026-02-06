import * as THREE from "three";
import { onInvalidate } from "@apendua.dev/signal";
import { effects, just, on, set, use } from "@apendua.dev/reactive";
import { animate } from "../render.js";
import { $, children } from "../operators.js";
import { shareSignal } from "@apendua.dev/store4";
import { interactions } from "../interactions.js";
import VisualProperties from "./VisualProperties.js";
import { makeRectangleGeometry, shrinkRectangle } from "./rectangle.js";

/**
 * @import {XREventMap} from '../core.js';
 * @import {Observable} from 'rxjs';
 */

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
  //   onInvalidate(() => {
  //     basic.dispose();
  //   });
  //   return basic;
  // });

  const fillMaterial = shareSignal(
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
      onInvalidate(() => {
        material.dispose();
      });
      return material;
    },
  );

  const { makeInteractive, stopPropagation } = interactions(ctx);

  return just(object, [
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
    effects((obj) => {
      use(
        animate(ctx, () => {
          const elementRect = element.getBoundingClientRect();
          const parentRect = element.parentElement?.getBoundingClientRect();
          if (parentRect) {
            obj.position.set(
              elementRect.left - parentRect.left,
              elementRect.top - parentRect.top,
              -2,
            );
          } else {
            obj.position.set(elementRect.left, elementRect.top, -2);
          }
        }),
      );
      use(
        animate(ctx, () => {
          properties.setFromElement(element);
        }),
      );
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
          onInvalidate(() => {
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
          onInvalidate(() => {
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
