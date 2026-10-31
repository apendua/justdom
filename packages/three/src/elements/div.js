import * as THREE from "three";
import { createProperty, Effect, onCleanup, Signal } from "justdom-signal";
import { Derived, effects, flatMap, just, on, set, observable, useEffects } from "justdom-signal";
import { $, children, Nothing } from "../operators.js";
import { interactions } from "../interactions.js";
import VisualProperties from "./VisualProperties.js";
import {
  batchedBoxMaterial,
  createRectMaterial,
  createRectUniforms,
  rectGeometry,
  writeClipUniforms,
  writeGradientUniforms,
  writeImageUniforms,
  writeRectUniforms,
} from "./sdfRect.js";
import { RampSlot } from "./gradient.js";
import { contentImage, isImageElement } from "./image.js";
import { createBlocker, coverBox } from "./blocker.js";
import {
  getBorderBoxSize,
  getBoxOffset,
  getChildNodes,
  getLocalClipBox,
  getParentElement,
  getScrollOffset,
  isVisibilityHidden,
} from "./mirror.js";
import { clipBoxShows, clipRaycast, UNCLIPPED } from "./clip.js";
import {
  composeTransform,
  hasDepthTransform,
  isTransformed,
  readOwnTransform,
} from "./cssTransform.js";
import {
  getContentRenderOrder,
  getLayer,
  getPaintedBounds,
  getPaintLayer,
  isOverlay,
  OVERLAY_LIFT,
  overlaps,
  paintedBoundsInto,
} from "./elevation.js";
import { LayerOrderContext } from "./layerOrder.js";
import { registerDrawOrder } from "../drawOrder.js";
import { isScrollable } from "./scroll.js";
import { place, placeAndScale } from "./place.js";
import { BOX_BUCKET_BIAS, BoxBatchContext, UNBATCHED_BOX_BIAS } from "./boxBatch.js";
import { TextBatchContext } from "./textBatch.js";
import { forwardListEvents, forwardPointerEvents, isRayTarget } from "./pointerForwarding.js";
import { lazyPanel, pressInit } from "./dragAndDrop.js";
import { setContentGroup } from "./contentGroup.js";

/** Scratch for composing a scroll onto a content group's matrix. */
const scrollTranslation = new THREE.Matrix4();

/**
 * Whether the panel these elements belong to is ready to be interacted with,
 * as a reactive getter. The portal sets it while a panel is still building
 * its initial mount: nothing the panel built is attached under its container
 * until the commit that ends the mount, and the raycast set is the
 * registered objects rather than the scene, so a registered button would be
 * cast from wherever its loose object stands and take presses before the
 * panel is anywhere. Elements built outside any portal get the default and
 * are pointable whenever they are shown, exactly as before.
 */
export const PortalReadyContext = createProperty(
  /**
   * @returns {() => boolean}
   */
  () => () => true,
);

/**
 * The channel a box writes its matrix in, apart from the panel's: the
 * portal's `motionChannel`, which drains of its own accord. Null outside a
 * portal, where no motion effect is built: the place effect runs the
 * motion step in its own run.
 */
export const MotionChannelContext = createProperty(
  /**
   * @returns {import("justdom-signal").UpdateChannel | null}
   */
  () => null,
);

/**
 * @import {Component, XREventMap} from '../core.js';
 * @import {ClipBox} from './clip.js';
 * @import {PaintedBounds, PaintLayer} from './elevation.js';
 * @import {EntityEffect, Subscribable} from 'justdom-signal';
 */

/**
 * Where an overlay's blocker sits, relative to the overlay's own origin. Local
 * z runs away from the viewer, so this has to land behind the overlay's own
 * background, which the meshes below put level with the origin, and still
 * in front of the parent's, `OVERLAY_LIFT` further back.
 */
const BLOCKER_OFFSET = 2;

/**
 * Where a box stands in its parent's object, as the panel's channel last
 * committed it (see `placement` in `box`): everything its matrix is composed
 * from but the element's own transform, and the answers the panel's order
 * was written from, which a transform can change.
 *
 * @typedef {object} Placement
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} width The border box the transform's origin resolves
 *   against.
 * @property {number} height
 * @property {boolean} transformed `isTransformed`: whether the box is placed
 *   by a matrix.
 * @property {boolean} depth `hasDepthTransform`: whether it is a layer by
 *   its transform.
 * @property {boolean} layer Whether it is a layer's root (`getLayer`).
 * @property {PaintLayer} paintLayer `getPaintLayer`.
 * @property {PaintedBounds | null} bounds The bounds its siblings' draw
 *   levels were worked out against, while those can depend on them: null for
 *   a layer, which the walk orders, and for a box in the flow, which clears
 *   nothing and is cleared by nothing.
 */

/**
 * @param {PaintedBounds | null} a
 * @param {PaintedBounds | null} b
 * @returns {boolean}
 */
function boundsEqual(a, b) {
  if (a === null || b === null) {
    return a === b;
  }
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/**
 * @param {Placement} a
 * @param {Placement} b
 * @returns {boolean}
 */
function placementEqual(a, b) {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.z === b.z &&
    a.width === b.width &&
    a.height === b.height &&
    a.transformed === b.transformed &&
    a.depth === b.depth &&
    a.layer === b.layer &&
    a.paintLayer === b.paintLayer &&
    boundsEqual(a.bounds, b.bounds)
  );
}

/**
 * Each box's committed placement, by its element, for its siblings' motion
 * steps to test their bounds against.
 *
 * @type {WeakMap<Element, Signal<Placement | null>>}
 */
const committedPlacements = new WeakMap();

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
 * @property {() => boolean} hidden Whether the element's own `visibility`
 *   hides it, read reactively. Content drawn inside the box is the box's
 *   own painting and goes with it — unlike the element's child nodes, which
 *   answer for themselves.
 */

/**
 * @typedef {object} BoxOptions
 * @property {(element: HTMLElement) => boolean} [clickable] Whether the element
 *   is a ray target, read reactively. Defaults to the rule every ordinary box
 *   follows, `cursor: pointer` or `draggable="true"`, which is there to tell
 *   a button, or a card to pick up, from the panel it sits on; a control
 *   needs no such telling and can answer for itself.
 * @property {(surface: BoxSurface) => Subscribable<Component>[]} [content] What
 *   else belongs inside the box, on top of its background — the tick in a
 *   checkbox, and nothing at all for an element whose contents are its own
 *   child nodes.
 * @property {(target: THREE.Matrix4) => void} [contentMatrix] Where the
 *   element's children are drawn from, if not from its border-box corner:
 *   writes the matrix from the children's frame to the element's into
 *   `target`, read reactively. An `<svg>` root is the case — its children
 *   are in user space, and this is its `viewBox`. The scroll offset is
 *   applied on top of it.
 * @property {() => void} [onPress] Told when a ray's press on this box has
 *   been delivered as a click, to the element or to the clickable element
 *   inside it that the ray met, which the click bubbles up from. It is for
 *   a control that has to do something the DOM will not do for it, such as
 *   a text field asking for a keyboard. After the click, so whatever the click's own handlers did is
 *   done by then; and only for a press that was a press, not the start of a
 *   scroll.
 * @property {EntityEffect<THREE.Object3D<XREventMap>>[]} [interactions] More
 *   of what the box hears from rays, for a control that needs more of it
 *   than a click — a text field placing its caret where the ray is. Put on
 *   the box's object with its own handlers, and taken off with them, so
 *   they come and go as the box stops and starts being a ray target.
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
 * @returns {import("justdom-signal").Source<THREE.Object3D>}
 */
export function box(ctx, element, options = {}) {
  const {
    clickable: isTarget = isRayTarget,
    content = () => [],
    contentMatrix,
    onPress,
    interactions: ownInteractions = [],
  } = options;
  /** @type {THREE.Object3D<XREventMap>} */
  const object = new THREE.Object3D();
  const properties = new VisualProperties();

  // The element's projected children live one group down, positioned in
  // content space; scrolling translates the group. See `getContentGroup`.
  const contentGroup = new THREE.Group();
  object.add(contentGroup);
  setContentGroup(object, contentGroup);

  const { makeInteractive, stopPropagation } = interactions(ctx);
  /** The panel the box is in, for where a click on an overlay is on the page. */
  const panel = lazyPanel(object);
  const isPanelReady = PortalReadyContext.get(ctx);
  /**
   * Whether this element wants to be a ray target, as its own signal so that
   * the group below is attached and detached only when the answer actually
   * flips. Reading `isRayTarget` straight from the effect would rebuild the
   * group far more often than that: the computed style is deliberately
   * invalidated by every attribute mutation, and the handlers write
   * `data-xr-*` back onto this very element, so each pointer event they
   * handled would tear down the listeners that handled it.
   */
  const clickable = new Derived(() => isTarget(element));

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
   * Whether `visibility` hides this element. What that hides is the
   * element's own painting — its quad, whatever `content` draws on it, the
   * blocker an overlay puts behind itself — and its standing as a ray
   * target, the way a hidden element on a page takes no clicks. It does not
   * hide the content group: `visibility` is inherited but can be overridden,
   * so a child that says `visible` is drawn and pointable under a parent
   * that is not. That is why this never touches `object.visible`, which
   * prunes the subtree; see `isVisibilityHidden`.
   */
  const hidden = () => isVisibilityHidden(element);

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
   * The origin comes from the client rect for an untransformed element, and
   * from its layout offsets on a transformed chain, where the rect is the
   * transformed bounds: the clip lands where the page puts the element,
   * before its transform. The box is axis-aligned in that frame, so it turns
   * with the element. An `<svg>` root has no layout offsets, so on a
   * transformed chain it is placed from its client rect after all, and its
   * clip moves with the transformed bounds (see `pageOffset`).
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

  /**
   * The numbers this box is drawn from, held apart from anything that draws
   * with them.
   *
   * A batched box is drawn as one instance among many and its own mesh never
   * reaches the render list, so a material of its own would be a uuid, a
   * place in three's bookkeeping and a `dispose()` at teardown, per box, for
   * a program that is never compiled. What it actually needs is this record,
   * which the batch copies into its instance buffers.
   */
  const uniforms = createRectUniforms();
  clipRaycast(boxMesh, () => currentClipBox, object);

  /**
   * This box's hold on a row of the page's gradient ramps. Kept for the life
   * of the box rather than of a write, so that rewriting a box whose gradient
   * has not changed — every frame of a layout animation — bakes nothing.
   */
  const rampSlot = new RampSlot();

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
  /** The panel's order of its layers, null outside a portal. */
  const layerOrder = LayerOrderContext.get(ctx);
  // The panel draws the box level with what it covers, so the hit test goes
  // by the order it draws at: the one batch's, or its own for a box that
  // draws itself.
  registerDrawOrder(boxMesh, batch ? BOX_BUCKET_BIAS : 0);

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
   * Whether the element's own transform takes it out of its parent's plane,
   * behind its own signal so that a frame of the transform that leaves the
   * answer alone reaches no one through it.
   */
  const depth = new Derived(() => hasDepthTransform(element));

  /**
   * Where this box stands in its parent's object, but for its own
   * transform: content-space offsets, a lift, and the box the transform's
   * origin is resolved against, with the answers the panel's order is
   * written from. The offset on a transformed chain is layout offsets (see
   * `getBoxOffset`), and `getBoxOffset` reads the reflow context, so layout
   * moves recompute this. A scroll does not, which is what lets the effect
   * that writes it share a run with the clip.
   *
   * The place effect below commits it with the panel's channel; the motion
   * effect composes the matrix from it and from the element's live
   * transform (`docs/freedom-transform-motion-plan.md`).
   */
  const placement = new Derived(
    () => {
      // How far in front of the parent this box sits: an overlay floats,
      // and everything else is level with its parent's content. An
      // overlay's subtree is positioned against the overlay, so it comes
      // along.
      const z = overlay.get() ? -OVERLAY_LIFT : 0;
      const offset = getBoxOffset(element);
      const size = getBorderBoxSize(element);
      const layer = getLayer(element) === element;
      const paintLayer = getPaintLayer(element);
      return {
        x: offset.x,
        y: offset.y,
        z,
        width: size.width,
        height: size.height,
        transformed: isTransformed(element),
        depth: depth.get(),
        layer,
        paintLayer,
        bounds: layer || paintLayer === null ? null : getPaintedBounds(element),
      };
    },
    { isEqual: placementEqual },
  );

  /**
   * The placement the panel's channel last committed, for the motion effect
   * to compose the matrix from. Written by the place effect, so it moves
   * when the panel's update lands and not before.
   */
  const committed = Signal.of(/** @type {Placement | null} */ (null));

  /**
   * The channel the motion effect runs in (see `MotionChannelContext`).
   */
  const motionChannel = MotionChannelContext.get(ctx);

  // What the motion effect composes into, kept for the box's life so that a
  // frame of an animation allocates nothing.
  const ownMatrix = new THREE.Matrix4();
  const ownOrigin = { x: 0, y: 0, z: 0 };
  const nextMatrix = new THREE.Matrix4();
  /** @type {PaintedBounds} */
  const liveBounds = { left: 0, top: 0, right: 0, bottom: 0 };
  /** Whether the matrix was last written whole, rather than by `place`. */
  let wroteMatrix = false;
  /**
   * The placement the last plain write was made from, so a run that finds
   * the same one writes nothing.
   *
   * @type {Placement | null}
   */
  let placed = null;

  /**
   * Whether every sibling the element overlapped, by the bounds its order
   * was written from, it still overlaps at `bounds`, and no other: tested
   * against the bounds each sibling's order was written from. A sibling that
   * is a layer, or in the flow, is skipped, since an overlap with it changes
   * no draw level (`getDrawLevel`, `getClearedSiblings`).
   *
   * @param {PaintedBounds} was
   * @param {PaintedBounds} bounds
   * @returns {boolean}
   */
  const keepsOverlaps = (was, bounds) => {
    const parent = getParentElement(element);
    if (!parent) {
      return true;
    }
    for (const node of getChildNodes(parent)) {
      if (node === element || node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      const theirs = committedPlacements.get(/** @type {Element} */ (node))?.get();
      if (!theirs?.bounds) {
        continue;
      }
      if (overlaps(bounds, theirs.bounds) !== overlaps(was, theirs.bounds)) {
        return false;
      }
    }
    return true;
  };

  /**
   * The motion step: the matrix from the committed placement and the live
   * transform. A step whose transform would change the order the panel's
   * channel last committed writes nothing, and the matrix stays where the
   * last step put it until the channel's commit catches up (the plan's
   * rules, in `docs/freedom-transform-motion-plan.md`).
   *
   * @param {THREE.Object3D} obj
   * @param {Placement | null} at
   */
  const move = (obj, at) => {
    if (!at) {
      return;
    }
    if (
      isTransformed(element) !== at.transformed ||
      depth.get() !== at.depth ||
      getPaintLayer(element) !== at.paintLayer
    ) {
      return;
    }
    if (!at.transformed) {
      if (at !== placed || wroteMatrix) {
        // Content-space coordinates: relative to the parent's border box
        // plus its scroll offset, which is what makes them constants of
        // the layout — a scroll changes the content group's translation
        // below, not this. A positioned element is anchored to its
        // containing block instead, and holds still while scrollers
        // between the two slide (see `getObjectPosition`).
        //
        // `place` recomposes from position, quaternion and scale, which
        // is what makes this the way back out of the branch below: that
        // branch writes `matrix` without ever disturbing the three, so
        // they are still the identity a plain box wants.
        place(obj, at.x, at.y, at.z);
        placed = at;
        wroteMatrix = false;
        batchChanged();
      }
      return;
    }
    const own = readOwnTransform(element, at.width, at.height, ownMatrix, ownOrigin);
    if (at.bounds) {
      const bounds = paintedBoundsInto(
        liveBounds,
        element,
        at.x,
        at.y,
        at.width,
        at.height,
        own ? ownMatrix : null,
        ownOrigin,
      );
      if (!keepsOverlaps(at.bounds, bounds)) {
        return;
      }
    }
    if (own) {
      composeTransform(nextMatrix, at.x, at.y, at.z, ownMatrix, ownOrigin);
    } else {
      nextMatrix.makeTranslation(at.x, at.y, at.z);
    }
    if (wroteMatrix && nextMatrix.equals(obj.matrix)) {
      return;
    }
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(nextMatrix);
    obj.matrixWorldNeedsUpdate = true;
    wroteMatrix = true;
    placed = null;
    batchChanged();
  };

  /**
   * Being a ray target, and forwarding what happens there back to the DOM.
   *
   * @type {EntityEffect<THREE.Object3D<XREventMap>>[]}
   */
  const interactivity = [
    ...forwardPointerEvents(ctx, element, object, {
      enabled: () => isPanelReady() && shown.get(),
      onPress,
    }),
    ...ownInteractions,
  ];

  /**
   * A scrolling list that is not itself a button still has to be grabbable,
   * or it could only be dragged by its rows — and a list of plain text would
   * have nothing to grab at all. It becomes a ray target for the gaps
   * between its rows and for its own padding, gated on `shown` the way the
   * ordinary interactivity is: a list scrolled entirely out of some outer
   * scroller is not something a ray should find. What a press there does is
   * the panel's forwarder's (see `createPanelForwarder`).
   *
   * @type {EntityEffect<THREE.Object3D<XREventMap>>[]}
   */
  const draggability = forwardListEvents(ctx, element, object, () => isPanelReady() && shown.get());

  return just(object, [
    // `cursor: pointer` is a live stylesheet decision — a button gets disabled,
    // a card becomes clickable — so interactivity follows it rather than being
    // fixed at the moment the element was first projected into the scene.
    // A hidden element takes no clicks, and stops being forwarded along with
    // the registration, for the reason `forwardPointerEvents` gives. A visible
    // child's events still bubble up the object chain through this one.
    effects((obj) => {
      if (!clickable.get() || hidden()) {
        return;
      }
      useEffects(obj, interactivity);
    }),
    // A press on a clickable list, or on a control in one, is handed to the
    // scroll gesture by the panel's forwarder through the registration
    // above; this is for the ordinary case of a list that is only a list.
    effects((obj) => {
      if (clickable.get() || !scrollable.get() || hidden()) {
        return;
      }
      useEffects(obj, draggability);
    }),
    effects(() => {
      properties.setFromElement(element);
      batchChanged();
    }),
    // Where the box stands and what clips it, in one effect: the clip is
    // given in the box's own frame, so a box that moves inside a clipping
    // ancestor changes both, and a channel that runs effects under a budget
    // could otherwise draw the box in its new place through the clip of
    // the old one. The place is committed here and drawn by the motion
    // effect after it, which runs in the same frame (see `motionChannel`
    // in `portal.js`). A scroll shifts the clip and slides this element's
    // own content group while the placement holds still, and the placement
    // is a `Derived` compared by value, so a scroll re-runs this without
    // moving the placement: the layout reads behind it are not re-run, and
    // three is not asked to recompute the world matrices under the box.
    effects((obj) => {
      const at = placement.get();
      committed.set(at);
      // Outside a portal there is no channel of its own to move in, and a
      // budget may stop between two effects, so the place and the clip are
      // written in this one.
      if (!motionChannel) {
        move(obj, at);
      }
      // A scroll, applied where a scroll belongs: one translation of the
      // group that carries the scrolled content. Nothing inside is
      // re-measured or repositioned — their coordinates were chosen so the
      // scroll could not change them. (`|| 0` turns the -0 an unscrolled
      // axis would negate to back into 0.)
      if (!contentMatrix) {
        const scroll = getScrollOffset(element);
        place(contentGroup, -scroll.left || 0, -scroll.top || 0, 0);
      }
      currentClipBox = getLocalClipBox(element);
      writeClipUniforms(uniforms, currentClipBox);
      // Fragments outside the box are discarded, but an element with nothing
      // left to show is worth skipping wholesale — `visible` prunes it and
      // its descendants from the render traversal, and from the batch's walk,
      // which follows the same flag for the same reason.
      obj.visible = shown.get();
      batchChanged();
    }),
    // The motion effect, after the place effect so that its first run finds
    // a placement committed. Its own channel, so that a transform animating
    // on its own is drawn in the frame the clock samples it, whatever the
    // panel's channel still holds.
    effects((obj) => {
      committedPlacements.set(element, committed);
      const motion = motionChannel
        ? new Effect(() => move(obj, committed.get()), { name: "motion", channel: motionChannel })
        : null;
      onCleanup(() => {
        motion?.dispose();
        if (committedPlacements.get(element) === committed) {
          committedPlacements.delete(element);
        }
      });
    }),
    // The content group of a box whose children are in a frame of their
    // own: the same scroll, applied after the matrix into the box's frame.
    // An effect apart, and only for such a box, so the matrix's reads — a
    // `viewBox`, the content box it is fitted to — are nobody else's.
    ...(contentMatrix
      ? [
          effects(() => {
            const scroll = getScrollOffset(element);
            contentGroup.matrixAutoUpdate = false;
            contentMatrix(contentGroup.matrix);
            contentGroup.matrix.premultiply(
              scrollTranslation.makeTranslation(-scroll.left || 0, -scroll.top || 0, 0),
            );
            contentGroup.matrixWorldNeedsUpdate = true;
            // The batches copy instance matrices by walking the panel, and
            // re-walk only when told; anything batched under this group
            // would otherwise stay where it was. Nothing SVG is batched
            // today, so this is for what a plugin may put under a content
            // matrix of its own.
            batchChanged();
          }),
        ]
      : []),
    children(
      // An overlay is opaque to rays in its own right. Without this the ray
      // that lands between two menu rows carries on through the menu and hits
      // a panel button behind it — which is not merely a miss, it is a click
      // on something the menu is covering.
      // No `distinctUntilChanged` between the two: `overlay` is a `Derived`,
      // and a recomputation that lands on the value it already held stops
      // there and tells nobody.
      flatMap((/** @type {boolean} */ isElevated) => {
        if (!isElevated) {
          return Nothing();
        }
        const blocker = createBlocker();
        // Opaque only where the overlay is actually showing. The blocker is
        // a unit plane covering the element rather than a mesh in element
        // px, so it names the element as the frame the box is read in.
        clipRaycast(blocker, () => currentClipBox, object);
        return $(blocker, [
          makeInteractive(isPanelReady),
          on("select", (e) => {
            element.dispatchEvent(new MouseEvent("click", pressInit(panel(), e, false)));
            // Unlike the portal's own blocker, which lets the scene
            // behind a panel see the click as well, an overlay is a
            // layer: what happens on it does not reach what it covers.
            stopPropagation(e);
          }),
          effects((obj) => {
            coverBox(obj, properties.totalWidth, properties.totalHeight, BLOCKER_OFFSET);
          }),
          // A hidden overlay covers nothing: rays pass through to what is
          // behind it. `visible` rather than the registration alone, because
          // a registered ancestor is raycast as a subtree and would find the
          // plane regardless.
          effects((obj) => {
            obj.visible = !hidden();
          }),
        ]);
      })(observable(() => overlay.get())),
      // The whole box — background and border ring both — is one quad and a
      // distance field. Geometry is shared and never rebuilt: a resize is a
      // scale write, everything else a uniform write, which is what makes a
      // layout animation affordable and a style change nearly free.
      $(boxMesh, [
        set("material", () => {
          if (batch) {
            // Shared, invisible, and never disposed — see `batchedBoxMaterial`.
            // The numbers live in `uniforms` instead, which is what the batch
            // reads.
            return batchedBoxMaterial();
          }
          // No batch to draw this box: an `<img>`, whose picture is a texture
          // binding and so a draw of its own, or a panel built outside a
          // portal. Those still draw themselves, from a material of their own.
          const material = createRectMaterial(uniforms);
          // The panel's depth is one quad over its root's
          // (`createDepthQuad`), and no box writes any.
          material.depthWrite = false;
          onCleanup(() => {
            material.dispose();
          });
          return material;
        }),
        // After the material, which is what carries the flag that takes this
        // mesh out of the draw — and which is built once, since its factory
        // reads nothing that changes while the box is in its panel.
        effects(() => {
          if (!batch) {
            return;
          }
          batch.add(boxMesh, uniforms);
          onCleanup(() => {
            batch.remove(boxMesh);
          });
        }),
        // A box that is a layer's root is one of the planes the panel's walk
        // orders (`layerOrder.js`), for as long as it is one.
        effects(() => {
          if (!layerOrder || getLayer(element) !== element) {
            return;
          }
          layerOrder.addLayer(element);
          onCleanup(() => {
            layerOrder.removeLayer(element);
          });
        }),
        // The quad is the element's own painting, so it goes when the element
        // is hidden — out of the draw, out of the batch's walk and out of the
        // raycast, all three of which follow this flag — while the content
        // group beside it stays for any child that says `visible`.
        effects((obj) => {
          obj.visible = !hidden();
          batchChanged();
        }),
        // Lets go of the ramp row when the box goes, and not before.
        effects(() => {
          onCleanup(() => {
            rampSlot.release();
          });
        }),
        effects((obj) => {
          writeRectUniforms(uniforms, properties);
          writeGradientUniforms(uniforms, properties, rampSlot);
          // A quad scaled to nothing has no surface to draw or hit, and a
          // zero scale is not invertible; an empty box is better described
          // as very small — same convention as the blocker. It is level with
          // its object, and drawn in front of what it covers by the order
          // alone.
          placeAndScale(
            obj,
            0,
            0,
            0,
            Math.max(properties.totalWidth, 1e-6),
            Math.max(properties.totalHeight, 1e-6),
            1,
          );
          // A batched box's order is the one the batch lays it at, with the
          // bias added there. One that draws itself takes its own, behind its
          // integer, since its origin, level with the container's, cannot
          // order it against the text.
          obj.renderOrder = properties.renderOrder + (batch ? 0 : UNBATCHED_BOX_BIAS);
          batchChanged();
        }),
        // Its own effect, and only where there is a picture: a texture
        // arriving late must not look like a reason to rewrite the box, and
        // the box moving must not look like a reason to rebind a texture.
        ...(image
          ? [
              effects((obj) => {
                writeImageUniforms(uniforms, image.get());
              }),
            ]
          : []),
      ]),
      ...content({
        properties,
        contentRenderOrder: () => getContentRenderOrder(element),
        clipBox: () => getLocalClipBox(element),
        hidden,
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
 * @returns {import("justdom-signal").Source<THREE.Object3D>}
 */
export function div(ctx, element) {
  return box(ctx, element);
}
