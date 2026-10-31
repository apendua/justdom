import * as THREE from "three";
import { Derived, effects, onCleanup } from "@apendua/signal";
import { children } from "../operators.js";
import { acquireImage, releaseImage } from "../elements/image.js";
import { getAttributeCached, getComputedStyleCached } from "../elements/mirror.js";
import { parsePreserveAspectRatio, viewportMatrix } from "./geometry.js";
import { isDrawnHidden, svgNode, viewportSize } from "./shape.js";
import { parseLengthIn, parsePointerEvents, readProperty } from "./style.js";

/**
 * @import {Source} from '@apendua/signal';
 * @import {Size} from '../elements/objectFit.js';
 * @import {PreserveAspectRatio} from './geometry.js';
 * @import {Instance} from './shape.js';
 */

/**
 * An `<image>` inside inline SVG, projected into the scene as one textured
 * quad in the element's user space.
 *
 * The picture comes through the same texture cache an `<img>` uses, shared
 * by URL and reference-counted, so a diagram that shows one icon forty
 * times decodes and uploads it once. Where it goes is worked out the way a
 * shape's geometry is: in user space, under an object that carries the
 * element's own transform, below the groups and the root that carry
 * theirs. A rotation on a `<g>` turns the picture with it, which an `<img>`
 * in a box cannot do.
 *
 * An `<image>` whose `href` is an SVG file is a bitmap of that file, as an
 * `<img>` is. Nothing inside it is reachable from CSS or from the portal.
 */

/**
 * Where a picture lands in user space and which part of it shows.
 *
 * @typedef {object} ImageQuad
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 * @property {number} u0 The texture coordinate at `left`, 0 at the
 *   picture's left edge and 1 at its right.
 * @property {number} v0 The texture coordinate at `top`, 0 at the picture's
 *   top edge and 1 at its bottom.
 * @property {number} u1
 * @property {number} v1
 */

/**
 * The `x`, `y`, `width` and `height` an `<image>` names, in user units, a
 * percentage already resolved against the viewport. A size that is `auto`
 * or missing is NaN, for `placeImage` to take from the picture.
 *
 * @typedef {object} ImageBox
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * The quad an `<image>` draws, or null for nothing to draw.
 *
 * A size left `auto` takes the picture's: both, and the picture is drawn at
 * its intrinsic size; one, and the other follows the picture's aspect
 * ratio. The picture is then fitted into the box by `preserveAspectRatio`,
 * by the same arithmetic that fits a `viewBox` into a viewport: SVG places a
 * picture as though it were a `viewBox` of its own intrinsic size. Whatever
 * of it falls outside the box, which `slice` does on one axis, is cut off
 * the quad rather than drawn and clipped.
 *
 * @param {ImageBox} box
 * @param {PreserveAspectRatio} aspect
 * @param {Size} natural The picture's intrinsic size.
 * @returns {ImageQuad | null}
 */
export function placeImage(box, aspect, natural) {
  if (!(natural.width > 0 && natural.height > 0)) {
    return null;
  }
  let { width, height } = box;
  if (Number.isNaN(width) && Number.isNaN(height)) {
    width = natural.width;
    height = natural.height;
  } else if (Number.isNaN(width)) {
    width = (height * natural.width) / natural.height;
  } else if (Number.isNaN(height)) {
    height = (width * natural.height) / natural.width;
  }
  if (!(width > 0 && height > 0)) {
    return null;
  }
  const [sx, , , sy, tx, ty] = viewportMatrix(
    { x: 0, y: 0, width: natural.width, height: natural.height },
    aspect,
    width,
    height,
  );
  const x = box.x + tx;
  const y = box.y + ty;
  const drawnWidth = natural.width * sx;
  const drawnHeight = natural.height * sy;
  const left = Math.max(box.x, x);
  const top = Math.max(box.y, y);
  const right = Math.min(box.x + width, x + drawnWidth);
  const bottom = Math.min(box.y + height, y + drawnHeight);
  if (!(right > left && bottom > top)) {
    return null;
  }
  return {
    left,
    top,
    right,
    bottom,
    u0: (left - x) / drawnWidth,
    v0: (top - y) / drawnHeight,
    u1: (right - x) / drawnWidth,
    v1: (bottom - y) / drawnHeight,
  };
}

/**
 * @param {ImageQuad | null} a
 * @param {ImageQuad | null} b
 * @returns {boolean}
 */
function quadEqual(a, b) {
  if (!a || !b) {
    return a === b;
  }
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.u0 === b.u0 &&
    a.v0 === b.v0 &&
    a.u1 === b.u1 &&
    a.v1 === b.v1
  );
}

/**
 * The quad as a geometry. The texture coordinates flip v, because a loaded
 * texture is uploaded with its first row at the bottom.
 *
 * @param {ImageQuad} quad
 * @returns {THREE.BufferGeometry}
 */
export function buildImageGeometry(quad) {
  const { left, top, right, bottom, u0, v0, u1, v1 } = quad;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([left, top, 0, right, top, 0, right, bottom, 0, left, bottom, 0]),
      3,
    ),
  );
  geometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(
      new Float32Array([u0, 1 - v0, u1, 1 - v0, u1, 1 - v1, u0, 1 - v1]),
      2,
    ),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

/**
 * The URL an `<image>` shows, resolved against the document so that it
 * names the same cache entry an `<img>` with the same picture does.
 *
 * `href` is an attribute and not a CSS property, so it is read as one, a
 * dependency of its own: a swapped `href` is re-read when it is written.
 * The legacy `xlink:href` is read by its qualified name, as SVG files
 * write it.
 *
 * @param {Element} element
 * @returns {string | null}
 */
export function getSvgImageSource(element) {
  const href = getAttributeCached(element, "href") ?? getAttributeCached(element, "xlink:href");
  if (!href) {
    return null;
  }
  try {
    return new URL(href, element.baseURI).href;
  } catch {
    return null;
  }
}

/**
 * @param {WeakKey} ctx
 * @param {Element} element
 * @param {Instance | null} [instance] The instance this picture is part of,
 *   when it is template content drawn somewhere else.
 * @returns {Source<THREE.Object3D>}
 */
export function image(ctx, element, instance = null) {
  const style = () => getComputedStyleCached(element);

  const source = new Derived(() => getSvgImageSource(element));

  /**
   * The share in the texture, which changes only when the URL does, for the
   * reason `contentImage` gives: a release followed by an acquire of the
   * same URL sends the entry through the idle list, where a full budget
   * could dispose it and the acquire would fetch it again.
   */
  const owned = new Derived(() => {
    const url = source.get();
    if (!url) {
      return null;
    }
    const entry = acquireImage(url);
    onCleanup(() => releaseImage(url));
    return entry;
  });

  const loaded = new Derived(() => owned.get()?.state.get() ?? null);
  const texture = new Derived(() => loaded.get()?.texture ?? null);

  const quad = new Derived(
    () => {
      const state = loaded.get();
      if (!state?.texture) {
        return null;
      }
      const current = style();
      const viewport = viewportSize(element, instance);
      /**
       * @param {string} name
       * @param {"width" | "height"} axis What a percentage is of.
       * @param {number} fallback
       */
      const length = (name, axis, fallback) =>
        parseLengthIn(readProperty(current, element, name), viewport?.[axis], fallback);
      return placeImage(
        {
          x: length("x", "width", 0),
          y: length("y", "height", 0),
          width: length("width", "width", Number.NaN),
          height: length("height", "height", Number.NaN),
        },
        parsePreserveAspectRatio(getAttributeCached(element, "preserveAspectRatio")),
        { width: state.width, height: state.height },
      );
    },
    { isEqual: quadEqual },
  );

  const hidden = new Derived(() => isDrawnHidden(element, instance));

  /**
   * Whether a ray can hit the picture. An image has one region, its area,
   * which `pointer-events` treats as a fill that is always painted: the
   * values that name only the stroke, and `none`, leave it to what is
   * behind.
   */
  const hittable = new Derived(() => {
    const rule = parsePointerEvents(readProperty(style(), element, "pointer-events")).fill;
    return rule !== null && (!rule.visible || !hidden.get());
  });

  return svgNode(ctx, element, instance, (node) => ({
    hittable: () => hittable.get() && quad.get() !== null,
    content: [
      children(
        node.mesh({
          geometry: () => {
            const current = quad.get();
            return current ? buildImageGeometry(current) : null;
          },
          // A picture paints once it has loaded, which is after the node is
          // built, into the material the node was built with.
          paints: () => quad.get() !== null,
          paint: [
            effects((obj) => {
              const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
              const next = texture.get();
              if (material.map !== next) {
                // Three compiles a program with a map or without one, so
                // gaining or losing it recompiles; one picture replacing
                // another does not.
                if (!material.map !== !next) {
                  material.needsUpdate = true;
                }
                material.map = next;
              }
            }),
            effects((obj) => {
              /** @type {THREE.MeshBasicMaterial} */ (obj.material).opacity = node.opacity();
            }),
          ],
          hidden: () => hidden.get(),
          hit: () => quad.get() !== null && hittable.get(),
          layer: 0,
        }),
      ),
    ],
  }));
}
