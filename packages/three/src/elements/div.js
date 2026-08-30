import * as THREE from "three";
import { createProperty, onCleanup } from "@apendua/signal";
import { Derived, effects, just, on, set, observable, useEffects } from "@apendua/signal";
import { distinctUntilChanged, switchMap } from "rxjs";
import { rx } from "@apendua/signal/rxjs";
import { $, children, Nothing } from "../operators.js";
import { interactions } from "../interactions.js";
import VisualProperties from "./VisualProperties.js";
import {
  createRectMaterial,
  rectGeometry,
  writeClipUniforms,
  writeImageUniforms,
  writeRectUniforms,
} from "./sdfRect.js";
import { contentImage, isImageElement } from "./image.js";
import { createBlocker, coverBox } from "./blocker.js";
import {
  getBorderBoxSize,
  getComputedStyleCached,
  getLocalClipBox,
  getObjectPosition,
  getScrollOffset,
} from "./mirror.js";
import { clipBoxShows, clipRaycast, UNCLIPPED } from "./clip.js";
import {
  composeTransform,
  getOwnTransform,
  isTransformed,
  untransformedOffset,
} from "./cssTransform.js";
import { getContentRenderOrder, isOverlay } from "./elevation.js";
import { isScrollable, scrollDrags } from "./scroll.js";
import { place, placeAndScale } from "./place.js";
import { BoxBatchContext } from "./boxBatch.js";
import { TextBatchContext } from "./textBatch.js";

/**
 * The group that carries an element's projected DOM children, one per box.
 *
 * Its whole purpose is scrolling: children are positioned in their parent's
 * *content* space — coordinates that a scroll does not change — and the
 * group is translated by minus the scroll offset, so a scroll is one
 * position write here instead of a re-measure of everything inside. The
 * portal attaches child objects through `getContentGroup`.
 *
 * @type {WeakMap<THREE.Object3D, THREE.Object3D>}
 */
const contentGroups = new WeakMap();

/**
 * Where a node's projected children belong under its object: the content
 * group for a box, the object itself for anything that has none (the
 * portal's own container).
 *
 * @param {THREE.Object3D} object
 * @returns {THREE.Object3D}
 */
export function getContentGroup(object) {
  return contentGroups.get(object) ?? object;
}

/**
 * Whether the panel these elements belong to is ready to be interacted with,
 * as a reactive getter. The portal sets it while a panel is still building
 * its initial mount: the panel is hidden for those frames, and a hidden
 * panel must not be a ray target either — the raycast set is a flat list of
 * registered objects, so an ancestor's `visible` flag shields none of them,
 * and an invisible button that still takes clicks is worse than a visible
 * half-built one. Elements built outside any portal get the default and
 * are pointable whenever they are shown, exactly as before.
 */
export const PortalReadyContext = createProperty(
  /**
   * @returns {() => boolean}
   */
  () => () => true,
);

/**
 * @import {Component, XREventMap} from '../core.js';
 * @import {ClipBox} from './clip.js';
 * @import {Observable} from 'rxjs';
 * @import {EntityEffect} from '@apendua/signal';
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
 * What a box hands to whatever else is drawn inside it: the properties it is
 * being drawn from — the same live object its own mesh reads, so a mark keeps
 * step with the surface it sits on — and where that content belongs in the
 * draw order, which is one step past the box's own.
 *
 * Content is clipped the way the box itself is, and has to be: an element
 * scrolled to the edge of an `overflow: hidden` window is cut there, and a
 * mark drawn inside it that ignored the cut would hang outside the window and
 * go on being clickable there. Both halves of that are handed over —
 * `clipBox` for the drawing, `clipMesh` for the hit region — expressed in the
 * element's own coordinates, which is the frame content should be authored
 * in.
 *
 * @typedef {object} BoxSurface
 * @property {VisualProperties} properties
 * @property {() => number} contentRenderOrder
 * @property {() => ClipBox} clipBox What the overflow-hiding ancestors leave
 *   of this element, read reactively — for `applyClip`'s uniform.
 * @property {(mesh: THREE.Mesh) => void} clipMesh Trim a mesh's hits to that
 *   same region. Call once, on a mesh that is not replaced: it wraps
 *   `raycast`, so calling it again on every restyle would nest the wrappers.
 */

/**
 * @typedef {object} BoxOptions
 * @property {(element: HTMLElement) => boolean} [clickable] Whether the element
 *   is a ray target, read reactively. Defaults to the `cursor: pointer` rule
 *   every ordinary box follows, which is there to tell a button from the card
 *   it sits on; a control needs no such telling and can answer for itself.
 * @property {(surface: BoxSurface) => Observable<Component>[]} [content] What
 *   else belongs inside the box, on top of its background — the tick in a
 *   checkbox, and nothing at all for an element whose contents are its own
 *   child nodes.
 */

/**
 * The CSS box: the border, the background, the position within its parent, and
 * the pointer events the element is entitled to hear about — everything an
 * element is drawn as before anything specific to what it *is* comes into it.
 *
 * `div` is this and no more, which is what most elements need; the components
 * that mirror a control are this plus what the control draws in the middle.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {BoxOptions} [options]
 * @returns {import("@apendua/signal").Source<THREE.Object3D>}
 */
export function box(ctx, element, options = {}) {
  const { clickable: isRayTarget = isClickable, content = () => [] } = options;
  /** @type {THREE.Object3D<XREventMap>} */
  const object = new THREE.Object3D();
  const properties = new VisualProperties();

  // The element's projected children live one group down, positioned in
  // content space; scrolling translates the group. See `getContentGroup`.
  const contentGroup = new THREE.Group();
  object.add(contentGroup);
  contentGroups.set(object, contentGroup);

  const { makeInteractive, stopPropagation } = interactions(ctx);
  const drags = scrollDrags(ctx);
  const isPanelReady = PortalReadyContext.get(ctx);

  /**
   * Whether this element wants to be a ray target, as its own signal so that
   * the group below is attached and detached only when the answer actually
   * flips. Reading `isClickable` straight from the effect would rebuild the
   * group far more often than that: the computed style is deliberately
   * invalidated by every attribute mutation, and the handlers write
   * `data-xr-*` back onto this very element, so each pointer event they
   * handled would tear down the listeners that handled it.
   */
  const clickable = new Derived(() => isRayTarget(element));

  /**
   * Whether this element floats above what it overlaps, as its own signal for
   * the same reason `clickable` is one: the blocker below is attached and
   * detached with it, and the computed style it reads is invalidated by every
   * attribute mutation in the portal.
   */
  const overlay = new Derived(() => isOverlay(element));

  /**
   * Whether this element is a list with more in it than fits — and so
   * something to take hold of. Its own signal for the reason the others are:
   * the handlers below come and go with it, and a list becomes draggable the
   * moment a row overflows it, without anything being told.
   */
  const scrollable = new Derived(() => isScrollable(element));

  /**
   * The picture this element paints inside its box, for the ones that have
   * any. Built only for elements that can carry one, and a tag never changes,
   * so this is decided once rather than watched: an ordinary div pays nothing
   * — no signal, no effect, no uniform write — for a feature it will never
   * use, which matters when a panel is a few hundred of them.
   *
   * @type {Derived<import('./image.js').ContentImage | null> | null}
   */
  const image = isImageElement(element) ? contentImage(element, properties) : null;

  /**
   * What this element's overflow-hiding ancestors leave of it, in its own
   * px — the space its quad is drawn in, so the same numbers serve the
   * shader and the raycast filter. The mirror keeps it: cached per level in
   * the clip owner's own frame, where a scroll cannot move it, and shifted
   * into this element's frame by arithmetic on the scroll offsets — so a
   * frame of scrolling costs no measurement here, only the shift.
   *
   * The origin comes from the client rect, which is exact for an
   * untransformed element and for a translated one. Under a rotation or a
   * scale the rect is the transformed bounds, and the clip edge inherits
   * that approximation.
   *
   * The snapshot in the variable is for the raycast filter, which is called
   * from inside three's traversal — somewhere the reactive graph does not
   * reach.
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
   * The batch this box is drawn by, if there is one and this box can join it.
   *
   * An `<img>` cannot: its picture is a texture binding, and a binding is per
   * draw. Those boxes go on drawing themselves — the same carve-out `image`
   * above already makes for every other cost a picture brings, decided once
   * here rather than watched, because a tag never changes.
   *
   * @type {import('./boxBatch.js').BoxBatch | null}
   */
  const batch = image ? null : BoxBatchContext.get(ctx);

  /**
   * The text of this panel, which has to hear about this element moving even
   * though it draws none of it.
   *
   * A box moving moves everything inside it, and a scroll is the case that
   * makes the point: the content group slides, every descendant goes with it,
   * and not one of those descendants re-runs an effect of its own — that
   * invariance is what makes scrolling cheap. The batches recompute their
   * instance matrices by walking the panel, so one of them being told is
   * enough for its own contents and no use at all to the other's.
   *
   * Today the text inside a scroller would in fact notice, because its clip
   * box is expressed against the scroll offset and so changes with it. That
   * is a chain of reasoning three files long, and a silent desync — text left
   * behind where the panel used to be — is what it costs when it breaks.
   *
   * @type {import('./textBatch.js').TextBatch | null}
   */
  const textBatch = TextBatchContext.get(ctx);

  /**
   * Say that something the batches copied out of this box has changed. Cheap
   * and coalesced — each rebuilds once however many boxes call it — so the
   * effects below can simply say so whenever they write anything.
   *
   * @returns {void}
   */
  const batchChanged = () => {
    batch?.invalidate();
    textBatch?.invalidate();
  };

  /**
   * Whether any part of this element survives that clipping. An element
   * scrolled entirely out of its scroller is not drawn and, more to the point,
   * is not a ray target: the raycaster walks the descendants of whatever is
   * registered, so dropping the registration takes the whole subtree with it.
   * Partly clipped elements stay registered and are trimmed by `clipRaycast`.
   *
   * Taking the subtree is deliberate but not exact: `getLocalClipBox` lets an
   * absolutely positioned descendant escape the clip that hid this element, so
   * a menu whose containing block sits above the scroller would, on paper,
   * survive a row that scrolled away — and vanishes here with it. Accepted
   * until a real panel shows the difference: the arrangements that ship anchor
   * such a menu outside the scroller or dismiss it on scroll.
   */
  const shown = new Derived(() => {
    const box = getLocalClipBox(element);
    if (box === UNCLIPPED) {
      return true;
    }
    const size = getBorderBoxSize(element);
    if (size.width <= 0 || size.height <= 0) {
      // Nothing to cull, and nothing that could be hit either way. Culling on
      // a degenerate box would mean trusting a layout that may not have
      // happened yet.
      return true;
    }
    return clipBoxShows(box, size.width, size.height);
  });

  /**
   * Being a ray target, and forwarding what happens there back to the DOM.
   * These belong together: an element that stops being clickable has to lose
   * the handlers too, not just the registration. The interaction manager
   * dispatches up the parent chain, so a listener left behind on a wrapper
   * that is no longer clickable would still see events bubbling out of a
   * button inside it and synthesise a second, spurious click on the wrapper.
   *
   * @type {EntityEffect<THREE.Object3D<XREventMap>>[]}
   */
  const interactivity = [
    makeInteractive(() => isPanelReady() && shown.get()),
    on("select", (e) => {
      // A press that turned into a drag was the player scrolling the list
      // this button sits in, not pressing the button — the same bargain a
      // touchscreen strikes, and for the same reason: there is nowhere else
      // to grab a list that is made of buttons.
      if (drags.didScroll(e.controller)) {
        stopPropagation(e);
        return;
      }
      const event = new MouseEvent("click", {
        bubbles: true,
      });
      element.dispatchEvent(event);
      stopPropagation(e);
    }),
    on("selectstart", (e) => {
      // Offered to the scroll gesture before anything else: a press over a
      // list may become a drag, and only holding it will tell. Elements with
      // no scrolling ancestor are declined and nothing changes for them.
      drags.begin(e.controller, element, object);
      const event = new MouseEvent("mousedown", {
        bubbles: true,
      });
      element.dispatchEvent(event);
      element.dataset.xrActive = "true";
      stopPropagation(e);
    }),
    on("selectend", (e) => {
      drags.end(e.controller);
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

  /**
   * A scrolling list that is not itself a button still has to be grabbable,
   * or it could only be dragged by its rows — and a list of plain text would
   * have nothing to grab at all. It becomes a ray target for the gaps
   * between its rows and for its own padding, gated on `shown` the way the
   * ordinary interactivity is: a list scrolled entirely out of some outer
   * scroller is not something a ray should find.
   *
   * No hover or press styling comes with this: the list is draggable, not
   * clickable, and the `data-xr-*` flags are what say "this reacts to being
   * pointed at". A press that never became a drag still reports a click,
   * which is what the panel's background would have reported had the list
   * not been in the way.
   *
   * @type {EntityEffect<THREE.Object3D<XREventMap>>[]}
   */
  const draggability = [
    makeInteractive(() => isPanelReady() && shown.get()),
    on("selectstart", (e) => {
      drags.begin(e.controller, element, object);
      stopPropagation(e);
    }),
    on("selectend", (e) => {
      drags.end(e.controller);
      stopPropagation(e);
    }),
    on("select", (e) => {
      if (!drags.didScroll(e.controller)) {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      stopPropagation(e);
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
    // A clickable list already carries the gesture through the handlers
    // above; this is for the ordinary case of a list that is only a list.
    effects((obj) => {
      if (clickable.get() || !scrollable.get()) {
        return;
      }
      useEffects(obj, draggability);
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
        // Content-space coordinates: relative to the parent's border box
        // plus its scroll offset, which is what makes them constants of the
        // layout — a scroll changes the content group's translation below,
        // not this. A positioned element is anchored to its containing
        // block instead, and holds still while scrollers between the two
        // slide (see `getObjectPosition`).
        //
        // `place` recomposes from position, quaternion and scale, which is
        // what makes this the way back out of the transformed branch above:
        // that branch writes `matrix` without ever disturbing the three, so
        // they are still the identity a plain box wants.
        const position = getObjectPosition(element);
        place(obj, position.x, position.y, z);
      }
      properties.setFromElement(element);
      batchChanged();
    }),
    // Everything a scroll can move, kept apart from the layout effect above:
    // a scroll shifts the clip and slides this element's own content group,
    // while positions and sizes hold still — so neither recomputes the
    // other's dependencies. One effect for the three cheap writes rather
    // than one each; every element pays for its computations up front, in
    // allocation and subscription, and these always move together.
    effects((obj) => {
      // A scroll, applied where a scroll belongs: one translation of the
      // group that carries the scrolled content. Nothing inside is
      // re-measured or repositioned — their coordinates were chosen so the
      // scroll could not change them. (`|| 0` turns the -0 an unscrolled
      // axis would negate to back into 0.)
      const scroll = getScrollOffset(element);
      place(contentGroup, -scroll.left || 0, -scroll.top || 0, 0);
      currentClipBox = getLocalClipBox(element);
      // Fragments outside the box are discarded, but an element with nothing
      // left to show is worth skipping wholesale — `visible` prunes it and
      // its descendants from the render traversal, and from the batch's walk,
      // which follows the same flag for the same reason.
      obj.visible = shown.get();
      batchChanged();
    }),
    children(
      // An overlay is opaque to rays in its own right. Without this the ray
      // that lands between two menu rows carries on through the menu and hits
      // a panel button behind it — which is not merely a miss, it is a click
      // on something the menu is covering.
      rx(observable(() => overlay.get())).pipe(
        distinctUntilChanged(),
        switchMap((/** @type {boolean} */ isElevated) => {
          if (!isElevated) {
            return rx(Nothing());
          }
          const blocker = createBlocker();
          // Opaque only where the overlay is actually showing. The blocker is
          // a unit plane covering the element rather than a mesh in element
          // px, so it names the element as the frame the box is read in.
          clipRaycast(blocker, () => currentClipBox, object);
          return rx(
            $(blocker, [
              makeInteractive(isPanelReady),
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
            ]),
          );
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
        // After the material, which is what carries the flag that takes this
        // mesh out of the draw — and which is built once, since its factory
        // reads nothing reactive.
        effects(() => {
          if (!batch) {
            return;
          }
          batch.add(boxMesh);
          onCleanup(() => {
            batch.remove(boxMesh);
          });
        }),
        // Its own effect, so a scroll writes four numbers and nothing else.
        effects((obj) => {
          writeClipUniforms(
            /** @type {THREE.ShaderMaterial} */ (obj.material),
            getLocalClipBox(element),
          );
          batchChanged();
        }),
        effects((obj) => {
          writeRectUniforms(/** @type {THREE.ShaderMaterial} */ (obj.material), properties);
          // A quad scaled to nothing has no surface to draw or hit, and a
          // zero scale is not invertible; an empty box is better described
          // as very small — same convention as the blocker.
          placeAndScale(
            obj,
            0,
            0,
            1,
            Math.max(properties.totalWidth, 1e-6),
            Math.max(properties.totalHeight, 1e-6),
            1,
          );
          obj.renderOrder = properties.renderOrder;
          batchChanged();
        }),
        // Its own effect, and only where there is a picture: a texture
        // arriving late must not look like a reason to rewrite the box, and
        // the box moving must not look like a reason to rebind a texture.
        ...(image
          ? [
              effects((obj) => {
                writeImageUniforms(/** @type {THREE.ShaderMaterial} */ (obj.material), image.get());
              }),
            ]
          : []),
      ]),
      ...content({
        properties,
        contentRenderOrder: () => getContentRenderOrder(element),
        clipBox: () => getLocalClipBox(element),
        // The snapshot rather than the signal, and this element's frame rather
        // than the mesh's — the same two reasons the box's own quad is trimmed
        // this way: the filter runs inside three's traversal, and content is
        // authored in the element's coordinates.
        clipMesh: (mesh) => {
          clipRaycast(mesh, () => currentClipBox, object);
        },
      }),
    ),
  ]);
}

/**
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @returns {import("@apendua/signal").Source<THREE.Object3D>}
 */
export function div(ctx, element) {
  return box(ctx, element);
}
