import * as THREE from "three";
import { onCleanup } from "@apendua/signal";
import { Derived, effects, just, on, set, observable, useEffects } from "@apendua/signal";
import { distinctUntilChanged, switchMap } from "rxjs";
import { $, children, Nothing } from "../operators.js";
import { interactions } from "../interactions.js";
import VisualProperties from "./VisualProperties.js";
import {
  createRectMaterial,
  rectGeometry,
  writeClipUniforms,
  writeRectUniforms,
} from "./sdfRect.js";
import { createBlocker, coverBox } from "./blocker.js";
import { getBoundingClientRectCached, getClipBoxCached, getComputedStyleCached } from "./cache.js";
import { clipBoxEqual, clipBoxShows, clipRaycast, toLocalClipBox, UNCLIPPED } from "./clip.js";
import {
  composeTransform,
  getOwnTransform,
  isTransformed,
  untransformedOffset,
} from "./cssTransform.js";
import { isOverlay } from "./elevation.js";

/**
 * @import {XREventMap} from '../core.js';
 * @import {Observable} from 'rxjs';
 * @import {MonoTypeOperatorFunction} from 'rxjs';
 */

/**
 * How far in front of its parent each box sits, in the container's local px.
 * Small enough to read as one surface, large enough that a child never fights
 * its parent's background for the same pixels.
 */
const CONTENT_STEP = 2;

/**
 * The extra distance an overlay puts between itself and the surface it floats
 * above. A few times the ordinary step: enough that stereo reads it as
 * hovering rather than as one more nested box, and enough room underneath for
 * the tree it covers, however deep that happens to be. At the scale panels are
 * usually mounted at this is a matter of millimetres.
 */
const ELEVATION_STEP = 8;

/**
 * Where an overlay's blocker sits, relative to the overlay's own origin. Local
 * z runs away from the viewer, so this has to land behind the overlay's own
 * background — which the meshes below put at +1 — and still in front of the
 * parent's, a whole elevation step further back.
 */
const BLOCKER_OFFSET = 2;

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
   * Whether this element floats above what it overlaps, as its own signal for
   * the same reason `clickable` is one: the blocker below is attached and
   * detached with it, and the computed style it reads is invalidated by every
   * attribute mutation in the portal.
   */
  const overlay = new Derived(() => isOverlay(element));

  /**
   * What this element's overflow-hiding ancestors leave of it, in its own px —
   * the space its quad is drawn in, so the same numbers serve the shader and
   * the raycast filter.
   *
   * The origin comes from the client rect, which is exact for an untransformed
   * element and for a translated one (its rect moves with it, and so does the
   * box the shader draws). Under a rotation or a scale the rect is the
   * transformed bounds, and the clip edge inherits that approximation.
   */
  const clipBox = new Derived(
    () => {
      const box = getClipBoxCached(element);
      if (box === UNCLIPPED) {
        return box;
      }
      const rect = getBoundingClientRectCached(element);
      return toLocalClipBox(box, rect.left, rect.top);
    },
    { isEqual: clipBoxEqual },
  );

  /**
   * The same box, in a variable, because the raycast filter is called from
   * inside three's traversal — somewhere the reactive graph does not reach.
   *
   * @type {import('./clip.js').ClipBox}
   */
  let currentClipBox = UNCLIPPED;

  // The quad this element draws itself with, created here rather than inline
  // below so its hit region is trimmed once: wrapping `raycast` from an
  // operator would wrap it again on every restyle. Hits are read in the
  // element's frame, not the quad's — the quad is a unit square scaled to the
  // element's size, so its own coordinates run 0..1.
  const boxMesh = new THREE.Mesh(rectGeometry);
  clipRaycast(boxMesh, () => currentClipBox, object);

  /**
   * Whether any part of this element survives that clipping. An element
   * scrolled entirely out of its scroller is not drawn and, more to the point,
   * is not a ray target: the raycaster walks the descendants of whatever is
   * registered, so dropping the registration takes the whole subtree with it.
   * Partly clipped elements stay registered and are trimmed by `clipRaycast`.
   */
  const shown = new Derived(() => {
    const box = clipBox.get();
    if (box === UNCLIPPED) {
      return true;
    }
    const rect = getBoundingClientRectCached(element);
    if (rect.width <= 0 || rect.height <= 0) {
      // Nothing to cull, and nothing that could be hit either way. Culling on
      // a degenerate box would mean trusting a layout that may not have
      // happened yet.
      return true;
    }
    return clipBoxShows(box, rect.width, rect.height);
  });

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
    makeInteractive(() => shown.get()),
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
      // Only the element that opens a layer pays for it. Everything inside the
      // overlay is positioned against the overlay, so it comes along.
      const z = -CONTENT_STEP - (overlay.get() ? ELEVATION_STEP : 0);
      if (isTransformed(element)) {
        // Client rects are transformed bounds — useless for a box that has to
        // come out untransformed and then carry the CSS transform as its own
        // matrix — so the position falls back to layout offsets. Layout moves
        // still re-run this: `setFromElement` below reads the element's rect,
        // and every structural mutation invalidates it.
        const offset = untransformedOffset(element, element.parentElement);
        const own = getOwnTransform(element);
        obj.matrixAutoUpdate = false;
        if (own) {
          composeTransform(obj.matrix, offset.x, offset.y, z, own.matrix, own.origin);
        } else {
          obj.matrix.makeTranslation(offset.x, offset.y, z);
        }
        obj.matrixWorldNeedsUpdate = true;
      } else {
        obj.matrixAutoUpdate = true;
        const elementRect = getBoundingClientRectCached(element);
        const parentRect = element.parentElement
          ? getBoundingClientRectCached(element.parentElement)
          : null;
        if (parentRect) {
          obj.position.set(elementRect.left - parentRect.left, elementRect.top - parentRect.top, z);
        } else {
          obj.position.set(elementRect.left, elementRect.top, z);
        }
      }
      properties.setFromElement(element);
    }),
    // Kept apart from the layout effect above: a scroll moves content inside a
    // window that has not moved, so positions change while the clip does not,
    // and neither recomputes the other's dependencies.
    effects((obj) => {
      currentClipBox = clipBox.get();
      // Fragments outside the box are discarded, but an element with nothing
      // left to show is worth skipping wholesale — `visible` prunes it and
      // its descendants from the render traversal.
      obj.visible = shown.get();
    }),
    children(
      // An overlay is opaque to rays in its own right. Without this the ray
      // that lands between two menu rows carries on through the menu and hits
      // a panel button behind it — which is not merely a miss, it is a click
      // on something the menu is covering.
      observable(() => overlay.get()).pipe(
        distinctUntilChanged(),
        switchMap((isElevated) => {
          if (!isElevated) {
            return Nothing();
          }
          const blocker = createBlocker();
          // Opaque only where the overlay is actually showing. The blocker is
          // a unit plane covering the element rather than a mesh in element
          // px, so it names the element as the frame the box is read in.
          clipRaycast(blocker, () => currentClipBox, object);
          return $(blocker, [
            makeInteractive(),
            on("select", (e) => {
              element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
              // Unlike the portal's own blocker, which lets the scene
              // behind a panel see the click as well, an overlay is a
              // layer: what happens on it does not reach what it covers.
              stopPropagation(e);
            }),
            effects((obj) => {
              coverBox(obj, properties.totalWidth, properties.totalHeight, BLOCKER_OFFSET);
            }),
          ]);
        }),
      ),
      // The whole box — background and border ring both — is one quad and a
      // distance field. Geometry is shared and never rebuilt: a resize is a
      // scale write, everything else a uniform write, which is what makes a
      // layout animation affordable and a style change nearly free.
      $(boxMesh, [
        set("material", () => {
          const material = createRectMaterial();
          onCleanup(() => {
            material.dispose();
          });
          return material;
        }),
        // Its own effect, so a scroll writes four numbers and nothing else.
        effects((obj) => {
          writeClipUniforms(/** @type {THREE.ShaderMaterial} */ (obj.material), clipBox.get());
        }),
        effects((obj) => {
          writeRectUniforms(/** @type {THREE.ShaderMaterial} */ (obj.material), properties);
          // A quad scaled to nothing has no surface to draw or hit, and a
          // zero scale is not invertible; an empty box is better described
          // as very small — same convention as the blocker.
          obj.scale.set(
            Math.max(properties.totalWidth, 1e-6),
            Math.max(properties.totalHeight, 1e-6),
            1,
          );
          obj.position.set(0, 0, 1);
          obj.renderOrder = properties.renderOrder;
        }),
      ]),
    ),
  ]);
}
