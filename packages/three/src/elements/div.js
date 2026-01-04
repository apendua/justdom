import * as THREE from "three";
import { batch, Lazy, onInvalidate } from "@apendua.dev/signal";
import { effects, just, on, set, use } from "@apendua.dev/reactive";
import { animate } from "../render.js";
import { $, children } from "../operators.js";
import { shareObservable } from "@apendua.dev/store4";
import { interactions } from "../interactions.js";

/**
 * @import {XREventMap} from '../core.js';
 * @import {Observable} from 'rxjs';
 */

/**
 * @param {number} left
 * @param {number} top
 * @param {number} width
 * @param {number} height
 * @returns {THREE.BufferGeometry}
 */
function makeRectangleGeometry(left, top, width, height) {
  const geometry = new THREE.BufferGeometry();
  const vertices = new Float32Array([
    left,
    top,
    0,
    left,
    top - height,
    0,
    left + width,
    top - height,
    0,
    left + width,
    top,
    0,
  ]);
  const indices = [0, 1, 2, 2, 3, 0];
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

const square = makeRectangleGeometry(0, 0, 1, -1);

/**
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @returns {Observable<THREE.Object3D>}
 */
export function div(ctx, element) {
  /** @type {THREE.Object3D<XREventMap>} */
  const object = new THREE.Object3D();
  /** @type {Lazy<string>} */
  const backgroundColor = new Lazy();
  /** @type {Lazy<string>} */
  const borderColor = new Lazy();

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

  const backgroundMaterial = shareObservable(() => {
    return just(
      new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
      }),
      [
        effects((material) => {
          material.color.set(backgroundColor.get() ?? "white");
        }),
        effects((material) => {
          onInvalidate(() => {
            material.dispose();
          });
        }),
      ],
    );
  });

  const borderMaterial = shareObservable(() => {
    return just(
      new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
      }),
      [
        effects((material) => {
          material.color.set(borderColor.get() ?? "purple");
        }),
        effects((material) => {
          onInvalidate(() => {
            material.dispose();
          });
        }),
      ],
    );
  });

  const { makeInteractive } = interactions(ctx);

  return just(object, [
    makeInteractive(),
    on("select", () => {
      element.click();
    }),
    on("selectstart", () => {
      element.dataset.xrActive = "true";
    }),
    on("selectend", () => {
      delete element.dataset.xrActive;
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
          const style = getComputedStyle(element);
          const elementRect = element.getBoundingClientRect();
          const parentRect = element.parentElement?.getBoundingClientRect();
          batch(() => {
            backgroundColor.set(style.backgroundColor);
            borderColor.set(style.borderColor);
            if (parentRect) {
              const left = elementRect.left - parentRect.left;
              const top = elementRect.top - parentRect.top;
              obj.position.set(left, top, -0.01);
            } else {
              obj.position.set(elementRect.left, elementRect.top, -0.01);
            }
          });
        }),
      );
    }),
    children(
      $(new THREE.Mesh(), [
        set("material", borderMaterial()),
        set("geometry", just(square)),
        effects((obj) => {
          use(
            animate(ctx, () => {
              const elementRect = element.getBoundingClientRect();
              obj.position.set(0, 0, 0.009);
              obj.scale.set(elementRect.width, elementRect.height, 1);
            }),
          );
        }),
      ]),
      $(new THREE.Mesh(), [
        set("material", backgroundMaterial()),
        set("geometry", just(square)),
        effects((obj) => {
          use(
            animate(ctx, () => {
              const elementRect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              const borderWidth = parseFloat(style.borderWidth);
              obj.position.set(borderWidth, borderWidth, 0.005);
              obj.scale.set(
                elementRect.width - borderWidth * 2,
                elementRect.height - borderWidth * 2,
                1,
              );
            }),
          );
        }),
      ]),
    ),
  ]);
}
