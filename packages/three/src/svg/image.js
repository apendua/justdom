import * as THREE from "three";
import { addDependency, Derived, effects, fromEvent, just, onCleanup, set } from "@apendua/signal";
import { $, children } from "../operators.js";
import { applyClip, clipRaycast } from "../elements/clip.js";
import { acquireImage, releaseImage } from "../elements/image.js";
import { getComputedStyleCached } from "../elements/mirror.js";
import { place } from "../elements/place.js";
import { matrixEqual, parsePreserveAspectRatio, viewportMatrix } from "./geometry.js";
import {
  chainEqual,
  clipUniforms,
  commitMatrix,
  emptyGeometry,
  isDrawnHidden,
  localMatrix,
  paintSlot,
  rayTarget,
  readChain,
  viewportSize,
} from "./shape.js";
import { parseLengthIn, parsePointerEvents, readProperty } from "./style.js";

/**
 * @import {Source} from '@apendua/signal';
 * @import {XREventMap} from '../core.js';
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

/** The namespace of the legacy `xlink:href`. */
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

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
 * `href` is an attribute and not a CSS property, and it is not in the
 * portal's `attributeFilter`. An `<image>` announces a new picture the way
 * an `<img>` does, with `load` or `error`, so both events are dependencies
 * and a swapped `href` is re-read when the picture it names arrives.
 *
 * @param {Element} element
 * @returns {string | null}
 */
export function getSvgImageSource(element) {
  // `fromEvent` is typed for the HTML elements it was written for; an SVG
  // element dispatches `load` and `error` the same way.
  const target = /** @type {HTMLElement} */ (element);
  addDependency(fromEvent(target, "load"));
  addDependency(fromEvent(target, "error"));
  const href = element.getAttribute("href") ?? element.getAttributeNS(XLINK_NAMESPACE, "href");
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
  /** @type {THREE.Object3D<XREventMap>} */
  const object = new THREE.Object3D();
  const style = () => getComputedStyleCached(element);

  const own = new Derived(() => localMatrix(element), { isEqual: matrixEqual });
  const chain = new Derived(() => readChain(element, instance), { isEqual: chainEqual });
  const root = new Derived(() => chain.get().root);
  const opacity = new Derived(() => chain.get().opacity);

  const source = new Derived(() => getSvgImageSource(element));

  /**
   * The share in the texture, which changes only when the URL does, for the
   * reason `contentImage` gives: a release followed by an acquire of the
   * same URL would dispose the texture and fetch it again.
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
      const viewport = viewportSize(element);
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
        parsePreserveAspectRatio(element.getAttribute("preserveAspectRatio")),
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
    if (instance) {
      // Drawn and never hit, as template content is in `shape`.
      return false;
    }
    const rule = parsePointerEvents(readProperty(style(), element, "pointer-events")).fill;
    return rule !== null && (!rule.visible || !hidden.get());
  });

  const { clip, clipMatrix, clipBox, followClip } = clipUniforms(
    () => root.get(),
    () => chain.get().ctm,
  );

  const mesh = new THREE.Mesh();
  clipRaycast(mesh, clipBox, mesh, clipMatrix);
  const clipped = mesh.raycast;
  let rayHits = false;
  mesh.raycast = (raycaster, intersects) => {
    if (rayHits) {
      clipped(raycaster, intersects);
    }
  };

  return just(object, [
    effects((obj) => {
      commitMatrix(obj, own.get());
    }),
    rayTarget(ctx, element, () => hittable.get() && quad.get() !== null),
    effects((obj) => {
      obj.visible = style().display !== "none";
    }),
    ...followClip,
    children(
      $(mesh, [
        set("material", () => {
          // One material for the life of the node, whatever picture it
          // shows. The effects below write its opacity and visibility, and
          // a material built afresh per picture would come back without
          // them, since a picture arrives after the node is built.
          const material = new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide,
            forceSinglePass: true,
            transparent: true,
            depthWrite: false,
          });
          applyClip(material, clip, clipMatrix);
          onCleanup(() => {
            material.dispose();
          });
          return material;
        }),
        set("geometry", () => {
          const current = quad.get();
          if (!current) {
            return emptyGeometry;
          }
          const built = buildImageGeometry(current);
          onCleanup(() => {
            built.dispose();
          });
          return built;
        }),
        effects((obj) => {
          const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
          const next = texture.get();
          if (material.map !== next) {
            // Three compiles a program with a map or without one, so gaining
            // or losing it recompiles; one picture replacing another does
            // not.
            if (!material.map !== !next) {
              material.needsUpdate = true;
            }
            material.map = next;
          }
        }),
        effects((obj) => {
          /** @type {THREE.MeshBasicMaterial} */ (obj.material).opacity = opacity.get();
        }),
        effects((obj) => {
          const shown = quad.get() !== null;
          const drawn = shown && !hidden.get();
          rayHits = shown && hittable.get();
          /** @type {THREE.MeshBasicMaterial} */ (obj.material).visible = drawn;
          // The raycaster skips an invisible object, so a picture that is
          // only hit, under `pointer-events: all` while hidden, stays visible
          // and its material keeps it out of the draw.
          obj.visible = drawn || rayHits;
        }),
        effects((obj) => {
          place(obj, 0, 0, 0);
          obj.renderOrder = paintSlot(element, root.get(), instance, 0).start;
        }),
      ]),
    ),
  ]);
}
