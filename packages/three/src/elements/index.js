import * as THREE from "three";
import { just, replaceSegment } from "@apendua.dev/reactive";
import { map, NEVER, switchMap } from "rxjs";
// import { replaceSegment } from "./helpers.js";
import { div } from "./div.js";

/**
 * @import {Object3D} from 'three';
 * @import {Observable} from 'rxjs';
 * @import {Mountable} from "@apendua.dev/reactive";
 * @import {Component} from '../core.js';
 */

/** @type {WeakMap<Node, Object3D>} */
const objects = new WeakMap();

/**
 * @template {keyof HTMLElementTagNameMap} T
 * @param {T} tagName
 * @param {WeakKey} ctx
 * @param {import("rxjs").MonoTypeOperatorFunction<HTMLElementTagNameMap[T]>[]} [operators]
 * @returns {Observable<Mountable<Node> & Component>}
 */
export function renderElement(tagName, ctx, operators = []) {
  const element = document.createElement(tagName);

  /**
   * @param {Object3D} object
   */
  function toMountable(object) {
    return {
      /**
       * @param {Object3D} parent
       */
      addTo: (parent) => {
        const container = document.createElement("div");
        container.style.position = "absolute";
        container.style.top = "0";
        container.style.left = "0";
        // container.style.visibility = "hidden";
        container.appendChild(element);
        document.body.appendChild(container);

        const containerObject = new THREE.Group();
        containerObject.add(object);
        objects.set(container, containerObject);
        parent.add(containerObject);

        container.querySelectorAll("*").forEach((child) => {
          if (child.parentNode) {
            const childObject = objects.get(child);
            const parentObject = objects.get(child.parentNode);
            if (childObject && parentObject) {
              parentObject.add(childObject);
            }
          }
        });

        /**
         * @param {MutationRecord[]} mutationList
         */
        const callback = (mutationList) => {
          for (const mutation of mutationList) {
            if (mutation.type === "childList") {
              /** @type {Set<Node>} */
              const alreadySeen = new Set();
              mutation.addedNodes.forEach((node) => {
                alreadySeen.add(node);
                const childObject = objects.get(node);
                const parentObject = objects.get(mutation.target);
                if (childObject && parentObject) {
                  parentObject.add(childObject);
                }
              });
              mutation.removedNodes.forEach((node) => {
                if (!alreadySeen.has(node)) {
                  const childObject = objects.get(node);
                  const parentObject = objects.get(mutation.target);
                  if (childObject && parentObject) {
                    parentObject.remove(childObject);
                  }
                }
              });
            }
          }
        };

        const mutationObserver = new MutationObserver(callback);
        mutationObserver.observe(element, { childList: true, subtree: true });

        const resizeObserver = new ResizeObserver(() => {
          const scale = 0.01;
          const sizeX = scale * element.offsetWidth;
          const sizeY = scale * element.offsetHeight;
          containerObject.scale.set(scale, scale, scale);
          containerObject.rotation.set(Math.PI, 0, 0);
          containerObject.position.set(-sizeX / 2, sizeY / 2, 0);
        });
        resizeObserver.observe(element);

        return () => {
          if (object && object.parent) {
            object.parent.remove(object);
          }
          if (container.parentNode) {
            container.parentNode.removeChild(container);
          }
          mutationObserver.disconnect();
          resizeObserver.disconnect();
        };
      },
      /**
       * @param {[Node, Node]} segment
       */
      replace: (segment) => {
        return replaceSegment([element, element], segment);
      },
    };
  }

  /**
   * @param {Observable<Object3D>} observable
   * @param {import("rxjs").MonoTypeOperatorFunction<HTMLElementTagNameMap[T]>[]} [operators]
   * @returns {Observable<Mountable<Node> & Component>}
   */
  function $(observable, operators = []) {
    return observable.pipe(
      switchMap((obj) => {
        objects.set(element, obj);
        return just(element, operators).pipe(
          map(() => {
            return toMountable(obj);
          }),
        );
      }),
    );
  }

  /**
   * @param {WeakKey} ctx
   */
  switch (tagName) {
    case "div":
    case "span": {
      return $(div(ctx, element), operators);
    }
  }
  return NEVER;
}
