import { clipBoxEqual, intersectClipBoxes, toLocalClipBox, UNCLIPPED } from "../clip.js";
import { frameFor, getGeometryGeneration, measureClientRect } from "../panelFrame.js";
import { nodeCache } from "./nodeCaches.js";
import { nodeDerived, probedRead, readRecordOf } from "./records.js";
import {
  getComputedStyleCached,
  getParentElement,
  getPositionStyle,
  isPortalRoot,
  isTransformed,
} from "./styleReads.js";

/**
 * @import {Derived} from 'justdom-signal';
 * @import {ClipBox} from '../clip.js';
 * @import {FramedRect} from '../panelFrame.js';
 * @import {ScrollOffset} from './records.js';
 */

/** @type {WeakMap<Element, { generation: number, rect: FramedRect }>} */
const clientRectCache = nodeCache();

/**
 * The element's client rect in its panel's layout px (see `panelFrame.js`),
 * at most once per geometry generation. A plain read with no dependencies —
 * the reactive layer decides *when* to come back, this only keeps it from
 * asking the browser the same question twice in one settling.
 *
 * @param {Element} element
 * @returns {FramedRect}
 */
export function readClientRect(element) {
  const generation = getGeometryGeneration();
  const cached = clientRectCache.get(element);
  if (cached && cached.generation === generation) {
    return cached.rect;
  }
  const rect = measureClientRect(element, frameFor(element));
  clientRectCache.set(element, { generation, rect });
  return rect;
}

/**
 * Whether a computed `position` takes the box out of its parent's flow.
 *
 * @param {string} position
 * @returns {boolean}
 */
export function isOutOfFlowPosition(position) {
  return position === "absolute" || position === "fixed";
}

/**
 * How an element arranges its children, to the two questions the mirror asks
 * about it.
 *
 * - `"none"` — no promises. Grid, tables, wrapping or reversed or centred
 *   flex, anything in a writing mode or direction that moves the start edge.
 * - `"flex"` — children are placed one after another in document order from a
 *   fixed start edge, but the cross axis is the container's to hand out:
 *   `stretch` and `align-items` mean a container that changed height changed
 *   its children with it. The order promises nothing about the items before
 *   a change: they share the main axis, so one that grows can shrink every
 *   item before it and move all but the first. `attributeChanged` tells the
 *   whole row for that reason; a child arriving or text rewritten does not
 *   yet (the plan's "Found along the way").
 * - `"block"` — the same order, and the block axis is nobody's business but
 *   each child's own. A block container that got taller got taller *because*
 *   of its children, and stacking them from the top is all it ever does.
 *
 * @typedef {"none" | "flex" | "block"} FlowMode
 */

/** @type {WeakMap<Element, Derived<FlowMode>>} */
const flowModeCache = nodeCache();

/**
 * How this element arranges its children.
 *
 * Two claims rest on this, and the distinction between them is what the three
 * answers are for. The first is that a change at one child cannot move the
 * children *before* it, which a flex row does not keep (see `FlowMode`) — a
 * narrower claim than it sounds, since plenty of ordinary containers place
 * their children from the far end, or from the middle, or in an order of their
 * own: adding a row to a `justify-content: center` list moves every row already
 * in it, and adding one to a `column-reverse` list moves all of them and puts
 * the new one first. The second is that a container growing along the block
 * axis leaves its children where they are, which is true of block flow and
 * emphatically not of flex, where the cross axis is handed out by the
 * container.
 *
 * So the whitelist is written as a whitelist, and everything not on it falls
 * back to telling every child — which costs what this did before the
 * distinction existed.
 *
 * Two things are deliberately not modelled, both the same kind of bargain
 * `:has()` gets in `getStyleContext`. A child's own `order` can reorder a flex
 * container, but reading it is a walk of the children, which is the cost this
 * exists to avoid; and a nested inline formatting context could be re-centred
 * by `text-align` inherited from an ancestor rather than set on the container
 * itself. Neither has appeared in a panel; both would show as a box left where
 * it was.
 *
 * @param {Element} element
 * @returns {FlowMode}
 */
export function getFlowMode(element) {
  let signal = flowModeCache.get(element);
  if (!signal) {
    signal = probedRead(element, () => {
      const style = getComputedStyleCached(element);
      // A different writing mode or direction moves the start edge, and
      // "before in the document" stops meaning "before on screen". Read
      // defensively: an engine that reports nothing is reporting the initial
      // value, which is the one this wants.
      if (style.writingMode && style.writingMode !== "horizontal-tb") {
        return "none";
      }
      if (style.direction && style.direction !== "ltr") {
        return "none";
      }
      const display = style.display;
      if (display === "flex" || display === "inline-flex") {
        const direction = style.flexDirection || "row";
        if (direction !== "row" && direction !== "column") {
          return "none";
        }
        if ((style.flexWrap || "nowrap") !== "nowrap") {
          return "none";
        }
        return START_PACKED.has(style.justifyContent || "normal") ? "flex" : "none";
      }
      if (display === "block" || display === "flow-root" || display === "list-item") {
        // Inline children inside a block are laid out into line boxes, and a
        // line box that is centred or justified re-flows around anything
        // added to it — including the words already on it.
        return START_ALIGNED.has(style.textAlign || "start") ? "block" : "none";
      }
      return "none";
    });
    flowModeCache.set(element, signal);
  }
  return signal.get();
}

/** The `justify-content` values that pack children against the start edge. */
const START_PACKED = new Set(["normal", "flex-start", "start", "left", "stretch"]);

/** And the `text-align` values that do the same for a line box. */
const START_ALIGNED = new Set(["start", "left", ""]);

/**
 * Whether the element's box hangs off something other than its parent.
 *
 * @param {Element} element
 * @returns {boolean}
 */
function isPositioned(element) {
  return isOutOfFlowPosition(getPositionStyle(element));
}

/** @type {WeakMap<Node, Derived<number>>} */
const reflowContextCache = nodeCache();

/**
 * Everything that can move this node's measured geometry *from above*,
 * folded into one number.
 *
 * Three parts. The node's own `moved` signal, which is `#settleLayout`'s
 * verdict on it: the one channel an ordinary structural change travels on,
 * and the reason it reaches a handful of nodes rather than a panel. The
 * targeted reflow signal of every ancestor-or-self, all the way to the
 * portal — that is how an attribute that toggled a transform re-measures
 * exactly the subtree it moved, and how an inherited font size changing
 * above a list re-breaks the lines inside it, neither of which the walk from
 * a mutation site would find. And the two portal-wide epochs, `globalLayout`
 * for fonts and `layout` for the layout changes nothing can name.
 *
 * The fourth thing that moves a box — the space its parent gives it — is
 * `readParentBox`, deliberately kept out of this number: it is a measured
 * value with an equality gate of its own, and folding a size into a sum of
 * counters would let a box 20 px wider and 20 px shorter read as unchanged.
 *
 * A scroll is absent from all of it: every measurement that depends on this
 * is expressed relative to something that scrolls along with it. Flat for
 * the reason `getStyleContext` gives, and one more per record found for the
 * reason it gives too.
 *
 * @param {Node} node
 * @returns {number}
 */
export function getReflowContext(node) {
  let signal = reflowContextCache.get(node);
  if (!signal) {
    signal = nodeDerived(node, () => {
      let sum = 0;
      const record = readRecordOf(node);
      if (record) {
        sum += record.moved.get();
        sum += record.mirror.globalLayout.get();
        sum += record.mirror.layout.get();
        // A box that hangs off a containing block is not laid out by its
        // parent, so the walk that tells a parent's children they moved has
        // nothing to say about it: what moved it may be anywhere above, on a
        // chain the walk never touched. It keeps the portal-wide answer —
        // the price of being out of flow, and cheap because so few boxes
        // are. The gate is the position itself, so an in-flow element that
        // is restyled without becoming positioned pays nothing.
        if (node.nodeType === Node.ELEMENT_NODE && isPositioned(/** @type {Element} */ (node))) {
          sum += record.mirror.outOfFlowLayout.get();
        }
      }
      for (
        let current = /** @type {Node | null} */ (node);
        current;
        current = getParentElement(current)
      ) {
        const currentRecord = readRecordOf(current);
        if (currentRecord) {
          sum += 1;
          sum += currentRecord.reflow.get();
        }
        if (isPortalRoot(current)) {
          break;
        }
      }
      return sum;
    });
    reflowContextCache.set(node, signal);
  }
  return signal.get();
}

/** @type {WeakMap<HTMLElement, Derived<number>>} */
const inlineSizeCache = nodeCache();

/**
 * The element's border box across the inline axis alone, behind a gate of its
 * own — so that a box which only got taller says nothing to anyone reading
 * this.
 *
 * @param {HTMLElement} element
 * @returns {number}
 */
function getBorderBoxInlineSize(element) {
  let signal = inlineSizeCache.get(element);
  if (!signal) {
    signal = probedRead(element, () => getBorderBoxSize(element).width);
    inlineSizeCache.set(element, signal);
  }
  return signal.get();
}

/**
 * Depend on the space the box this node sits in has to give it.
 *
 * The other half of the bargain `#settleLayout` strikes. The walk tells a
 * container's children that they moved and then stops climbing, which is
 * sound only because a box's interior follows the space it was given — so
 * whenever that space *does* turn out to have changed, everything inside has
 * to hear about it, and the walk is long since over by then.
 *
 * This is that channel, and it is reactive rather than announced: the
 * parent's size is a plain value behind an equality gate, so a parent that
 * re-measured to the numbers it already had says nothing, and a parent that
 * really did resize re-measures every child — which then re-measure theirs,
 * one level per settling, exactly as far down as the sizes actually change.
 *
 * Which axes count is the whole difference between a long list costing
 * nothing and costing everything, because the one thing that always happens
 * when a row is appended is that the list gets taller. In block flow that
 * moves nobody: the container got taller *because* of its children, and
 * stacking them from the top is all it was ever doing — so a block container
 * in document order is followed across the inline axis only, and its rows
 * ignore its height. Anywhere else — flex, where the cross axis is handed out
 * by the container and `stretch` is the default, and everything that made no
 * promises at all — both axes count.
 *
 * The value is deliberately discarded. What is wanted is the dependency; the
 * callers' own equality gates decide what to do with it.
 *
 * @param {Node} node
 * @returns {void}
 */
export function readParentBox(node) {
  // The top of what the portal mirrors has the page around the scene for a
  // parent, whose layout is none of a panel's business.
  if (isPortalRoot(node)) {
    return;
  }
  // Below it, a parent with no record yet is one the portal has not reached
  // or that a plugin's child was adopted ahead of, and the read follows its
  // adoption as every cached read does.
  const parent = getParentElement(node);
  if (!parent || !readRecordOf(parent)) {
    return;
  }
  if (getFlowMode(parent) === "block") {
    getBorderBoxInlineSize(parent);
    return;
  }
  getBorderBoxSize(parent);
}

/**
 * @typedef {object} BorderBoxSize
 * @property {number} width
 * @property {number} height
 */

/**
 * @param {BorderBoxSize} a
 * @param {BorderBoxSize} b
 * @returns {boolean}
 */
function sizeEqual(a, b) {
  return a.width === b.width && a.height === b.height;
}

/**
 * The element's border box off the layout — whole px, transform-free —
 * which is what a box on a transformed chain is measured by, since its
 * client rect would carry the transform a second time.
 *
 * `offsetWidth` is that number for an HTML element. An `<svg>` root has no
 * offset box, though it is laid out as a replaced element like any other,
 * so it is read as its padding box plus the borders around it — the same
 * quantity, from the two halves an element in the SVG namespace does have.
 *
 * @param {HTMLElement} element
 * @returns {BorderBoxSize}
 */
function layoutSize(element) {
  if (typeof element.offsetWidth === "number") {
    return { width: element.offsetWidth, height: element.offsetHeight };
  }
  const style = getComputedStyleCached(element);
  return {
    width: element.clientWidth + pixels(style.borderLeftWidth) + pixels(style.borderRightWidth),
    height: element.clientHeight + pixels(style.borderTopWidth) + pixels(style.borderBottomWidth),
  };
}

/** @type {WeakMap<HTMLElement, Derived<BorderBoxSize>>} */
const borderBoxSizeCache = nodeCache();

/**
 * How big the element's border box is. A client rect includes CSS
 * transforms, and the box the mirror draws must not — its object carries the
 * transform itself and would apply it a second time — so anything on a
 * transformed chain is measured off its layout offsets instead: whole px,
 * but transform-free.
 *
 * A plain value under a plain equality, which is the point: a portal-wide
 * re-layout re-measures everyone, and propagation stops at every element
 * that turned out not to have moved.
 *
 * @param {HTMLElement} element
 * @returns {BorderBoxSize}
 */
export function getBorderBoxSize(element) {
  let signal = borderBoxSizeCache.get(element);
  if (!signal) {
    signal = probedRead(
      element,
      () => {
        getReflowContext(element);
        readParentBox(element);
        if (isTransformed(element)) {
          return layoutSize(element);
        }
        const rect = readClientRect(element);
        return { width: rect.width, height: rect.height };
      },
      sizeEqual,
    );
    borderBoxSizeCache.set(element, signal);
  }
  return signal.get();
}

/**
 * @typedef {object} ContentPosition
 * @property {number} x
 * @property {number} y
 */

/**
 * @param {ContentPosition} a
 * @param {ContentPosition} b
 * @returns {boolean}
 */
function positionEqual(a, b) {
  return a.x === b.x && a.y === b.y;
}

/**
 * Where `node`'s border box sits relative to `ancestor`'s *content* origin —
 * its border-box corner shifted by however far it is currently scrolled.
 * Both rects and the offset are read in one go, so the numbers agree with
 * each other whenever they are taken; and because the content moves with its
 * own scroll, the result is the same whenever that is. This is the
 * invariance the whole scroll design rests on, so it is worth stating: for
 * any node inside a scroller, (rect − scrollerRect + scrollOffset) is a
 * constant of the layout, not of the scroll position.
 *
 * DOM reads, no dependencies — the callers register the reflow context that
 * decides when to come back here.
 *
 * @param {Element} node
 * @param {Element} ancestor
 * @returns {ContentPosition}
 */
function measureOffsetWithin(node, ancestor) {
  const rect = readClientRect(node);
  const ancestorRect = readClientRect(ancestor);
  return {
    x: rect.left - ancestorRect.left + (ancestor.scrollLeft || 0),
    y: rect.top - ancestorRect.top + (ancestor.scrollTop || 0),
  };
}

/** @type {WeakMap<Element, Derived<ContentPosition>>} */
const contentPositionCache = nodeCache();

/**
 * Where the element sits in its parent's content space. Scroll-invariant by
 * construction (see `measureOffsetWithin`), so a scroll leaves this cached
 * value untouched — the scene applies the scroll as a translation of the
 * parent's content group instead.
 *
 * @param {Element} element
 * @returns {ContentPosition}
 */
export function getContentPosition(element) {
  let signal = contentPositionCache.get(element);
  if (!signal) {
    signal = probedRead(
      element,
      () => {
        getReflowContext(element);
        readParentBox(element);
        const parent = getParentElement(element);
        if (!parent) {
          return { x: 0, y: 0 };
        }
        return measureOffsetWithin(element, parent);
      },
      positionEqual,
    );
    contentPositionCache.set(element, signal);
  }
  return signal.get();
}

const ZERO_SCROLL = Object.freeze({ left: 0, top: 0 });

/**
 * How far the element is scrolled, as a dependency. For an element no portal
 * adopted this is a DOM read that follows the element's adoption, as every
 * other cached read does (`readRecordOf`), and is read again once a portal
 * adopts it.
 *
 * @param {Element} element
 * @returns {ScrollOffset}
 */
export function getScrollOffset(element) {
  const record = readRecordOf(element);
  if (!record) {
    return element.scrollLeft || element.scrollTop
      ? { left: element.scrollLeft, top: element.scrollTop }
      : ZERO_SCROLL;
  }
  return record.scroll.get();
}

/** @type {WeakMap<HTMLElement, Derived<HTMLElement | null>>} */
const anchorCache = nodeCache();

/**
 * The containing block of an absolutely positioned element: the nearest
 * positioned ancestor, or the portal's container when there is none. CSS
 * hangs the box off this element, so it decides both where the element goes
 * and who gets to clip it. (A transform or a filter also establishes a
 * containing block; neither is modelled here, the same way neither is
 * modelled anywhere else in the mirror.)
 *
 * @param {HTMLElement} element
 * @returns {HTMLElement | null}
 */
function getAnchorElement(element) {
  let signal = anchorCache.get(element);
  if (!signal) {
    signal = probedRead(element, () => {
      let holder = getParentElement(element);
      while (holder && !isPortalRoot(holder)) {
        if (getPositionStyle(holder) !== "static") {
          return holder;
        }
        holder = getParentElement(holder);
      }
      return holder;
    });
    anchorCache.set(element, signal);
  }
  return signal.get();
}

/**
 * The portal container this element lives under, which is what a
 * `position: fixed` box anchors to.
 *
 * @param {HTMLElement} element
 * @returns {HTMLElement | null}
 */
function getPortalContainer(element) {
  /** @type {HTMLElement | null} */
  let holder = element;
  while (holder && !isPortalRoot(holder)) {
    holder = getParentElement(holder);
  }
  return holder;
}

/**
 * @typedef {object} AnchoredOffset
 * @property {HTMLElement | null} anchor The containing block, or null for an
 *   element in the flow, which has no anchor but its parent.
 * @property {number} x Where the element sits in the anchor's content space.
 * @property {number} y
 */

/** @type {AnchoredOffset} */
const UNANCHORED = Object.freeze({ anchor: null, x: 0, y: 0 });

/**
 * @param {AnchoredOffset} a
 * @param {AnchoredOffset} b
 * @returns {boolean}
 */
function anchoredOffsetEqual(a, b) {
  return a.anchor === b.anchor && a.x === b.x && a.y === b.y;
}

/** @type {WeakMap<HTMLElement, Derived<AnchoredOffset>>} */
const anchoredOffsetCache = nodeCache();

/**
 * For a positioned element: its containing block and where it sits in that
 * block's content space. The measured half of everything positioning needs —
 * held apart from the scroll arithmetic so that a scroll, which cannot
 * change this value, never re-runs the measurement.
 *
 * @param {HTMLElement} element
 * @returns {AnchoredOffset}
 */
function getAnchoredOffset(element) {
  let signal = anchoredOffsetCache.get(element);
  if (!signal) {
    signal = probedRead(
      element,
      () => {
        const position = getPositionStyle(element);
        const anchor =
          position === "fixed"
            ? getPortalContainer(element)
            : position === "absolute"
              ? getAnchorElement(element)
              : null;
        if (!anchor) {
          return UNANCHORED;
        }
        getReflowContext(element);
        const measured = measureOffsetWithin(element, anchor);
        return { anchor, x: measured.x, y: measured.y };
      },
      anchoredOffsetEqual,
    );
    anchoredOffsetCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<HTMLElement, Derived<ContentPosition>>} */
const objectPositionCache = nodeCache();

/**
 * Where the element's object belongs within its parent's content group.
 *
 * For an element in the flow this is `getContentPosition` verbatim. A
 * positioned element is the exception: its box hangs off its containing
 * block, so scrollers *between* the block and the element do not move it —
 * while the scene's content groups, which follow the DOM hierarchy, would.
 * The compensation is exactly those scroll offsets, read reactively: the
 * measured part is scroll-invariant, and when such a scroller scrolls, this
 * recomputes as arithmetic — no DOM reads — to hold the element still, the
 * same frame the content group moves.
 *
 * @param {HTMLElement} element
 * @returns {ContentPosition}
 */
export function getObjectPosition(element) {
  let signal = objectPositionCache.get(element);
  if (!signal) {
    signal = probedRead(
      element,
      () => {
        const parent = getParentElement(element);
        if (!parent) {
          return { x: 0, y: 0 };
        }
        // The position style gates the whole anchored branch, so the
        // overwhelmingly common in-flow element never builds the anchoring
        // machinery at all.
        const position = getPositionStyle(element);
        if (position !== "absolute" && position !== "fixed") {
          return getContentPosition(element);
        }
        const anchored = getAnchoredOffset(element);
        const anchor = anchored.anchor;
        if (!anchor || anchor === parent) {
          // Anchored to its own parent (or nowhere better): the flow path
          // already measures against exactly that box.
          return getContentPosition(element);
        }
        // The element's place in the anchor's border frame: the
        // scroll-invariant measurement plus the anchor's own live offset.
        const anchorScroll = getScrollOffset(anchor);
        let x = anchored.x - anchorScroll.left;
        let y = anchored.y - anchorScroll.top;
        // Walk the DOM chain the content groups will apply, subtracting it:
        // whatever offsets and scrolls the scene stacks between the anchor
        // and the parent must not move this box.
        for (
          let ancestor = /** @type {HTMLElement | null} */ (parent);
          ancestor && ancestor !== anchor;
          ancestor = getParentElement(ancestor)
        ) {
          const step = getContentPosition(ancestor);
          const holder = getParentElement(ancestor);
          const scroll = holder ? getScrollOffset(holder) : ZERO_SCROLL;
          x -= step.x - scroll.left;
          y -= step.y - scroll.top;
        }
        const parentScroll = getScrollOffset(parent);
        return { x: x + parentScroll.left, y: y + parentScroll.top };
      },
      positionEqual,
    );
    objectPositionCache.set(element, signal);
  }
  return signal.get();
}

/**
 * @param {HTMLElement} element
 * @returns {{ x: number, y: number }}
 */
function pageOffset(element) {
  let x = 0;
  let y = 0;
  /** @type {Element | null} */
  let el = element;
  if (!(el instanceof HTMLElement)) {
    // An `<svg>` root has no offset box to read, though the HTML around it
    // does. Its place is taken from the client rects instead — its own
    // against its parent's, the difference added to the parent's layout
    // offset. Under a transformed ancestor those rects carry the transform,
    // so this is the transformed-bounds approximation an `<svg>` viewport's
    // clip makes under a rotation, rather than the exact layout offset an
    // HTML element gets; an `<svg>` in an untransformed chain never comes
    // through here at all.
    const parent = el.parentElement;
    if (!parent) {
      return { x, y };
    }
    const frame = frameFor(el);
    const rect = measureClientRect(el, frame);
    const parentRect = measureClientRect(parent, frame);
    x = rect.left - parentRect.left;
    y = rect.top - parentRect.top;
    el = parent;
  }
  while (el instanceof HTMLElement) {
    x += el.offsetLeft;
    y += el.offsetTop;
    /** @type {Element | null} */
    const parent = el.offsetParent;
    if (parent instanceof HTMLElement) {
      // Offsets are measured to the offset parent's padding edge; crossing
      // into it adds its border.
      x += parent.clientLeft;
      y += parent.clientTop;
    }
    el = parent;
  }
  return { x, y };
}

/**
 * Where the element's border box sits relative to `from`, in layout terms —
 * the offsets the browser worked out before any transform was applied, which
 * is the position a transformed box needs since its object carries the
 * transform itself. Whole px only, and blind to scrolled ancestors (overflow
 * is not mirrored yet); the untransformed path keeps its subpixel client
 * rects.
 *
 * The two offset chains need not run through each other — an absolutely
 * positioned child offsets against an ancestor further up than its parent —
 * so both sides resolve to page coordinates and the difference is taken
 * there.
 *
 * @param {HTMLElement} element
 * @param {HTMLElement | null} from
 * @returns {{ x: number, y: number }}
 */
export function untransformedOffset(element, from) {
  const position = pageOffset(element);
  if (!from) {
    return position;
  }
  const base = pageOffset(from);
  return { x: position.x - base.x, y: position.y - base.y };
}

/**
 * Where the element's object sits in its parent's content group, before its
 * own transform is applied. Client rects are transformed bounds, useless for
 * a box that has to come out untransformed and then carry the CSS transform
 * as its own matrix, so a box on a transformed chain falls back to layout
 * offsets. Everything else takes `getObjectPosition`, which is
 * scroll-invariant.
 *
 * The layout offsets are plain DOM reads with no dependency of their own,
 * so that branch reads `getReflowContext`, which a layout move bumps. The
 * element's size is no stand-in: it is gated on equality, so a move that
 * keeps the size stops there.
 *
 * @param {HTMLElement} element
 * @returns {{ x: number, y: number }}
 */
export function getBoxOffset(element) {
  if (!isTransformed(element)) {
    return getObjectPosition(element);
  }
  getReflowContext(element);
  return untransformedOffset(element, element.parentElement);
}

/**
 * Whether a scroll moves the element against its siblings: it is anchored to
 * a block above its parent, and something from the parent up to, but not
 * including, that block clips its overflow, so `getObjectPosition` holds
 * the element still while the content around it scrolls. The same anchor
 * `getAnchoredOffset` takes, read without the layout or any scroll offset,
 * so the answer does not change while the scroll does.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function movesAgainstScroll(element) {
  const parent = getParentElement(element);
  const position = getPositionStyle(element);
  if (!parent || (position !== "absolute" && position !== "fixed")) {
    return false;
  }
  const anchor = position === "fixed" ? getPortalContainer(element) : getAnchorElement(element);
  if (!anchor || anchor === parent) {
    return false;
  }
  for (
    let ancestor = /** @type {HTMLElement | null} */ (parent);
    ancestor;
    ancestor = getParentElement(ancestor)
  ) {
    // The anchor's own scroll moves the element and its siblings together,
    // so only scrollers strictly between the parent and the anchor count.
    if (ancestor === anchor) {
      break;
    }
    if (clipsOverflow(getComputedStyleCached(ancestor))) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} value
 * @returns {number}
 */
function pixels(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The overflow that applies on one axis. A browser always resolves the
 * longhands, but a headless layout engine may only report the shorthand it
 * was given, and answering "visible" there would quietly switch clipping off
 * in every test that uses one.
 *
 * @param {CSSStyleDeclaration} style
 * @param {"overflowX" | "overflowY"} axis
 * @returns {boolean}
 */
function hidesOverflow(style, axis) {
  const value = style[axis] || style.overflow;
  return !!value && value !== "visible";
}

/**
 * Whether an element clips what overflows it, on either axis — the first half
 * of "does it scroll", and the same answer the clip chain below acts on.
 *
 * @param {CSSStyleDeclaration} style
 * @returns {boolean}
 */
export function clipsOverflow(style) {
  return hidesOverflow(style, "overflowX") || hidesOverflow(style, "overflowY");
}

/** @type {WeakMap<HTMLElement, Derived<ClipBox>>} */
const ownClipWindowCache = nodeCache();

/**
 * What an element confines its descendants to, in the element's *own*
 * border-box frame: its padding box, which is where CSS puts the edge of
 * `overflow: hidden`, on whichever axes are not `visible`, with the corners
 * its border radii round — reduced by the border they sit behind, the same
 * way the box's own inner edge is.
 *
 * The frame is the point. Expressed this way the window never moves when the
 * element scrolls — the *content* moves, which is the content groups'
 * departure — so this stays cached across every frame of a scroll and only
 * changes when the element is restyled or resized.
 *
 * @param {HTMLElement} element
 * @returns {ClipBox}
 */
function getOwnClipWindow(element) {
  let signal = ownClipWindowCache.get(element);
  if (!signal) {
    signal = probedRead(
      element,
      () => {
        const style = getComputedStyleCached(element);
        const clipsX = hidesOverflow(style, "overflowX");
        const clipsY = hidesOverflow(style, "overflowY");
        if (!clipsX && !clipsY) {
          return UNCLIPPED;
        }
        const size = getBorderBoxSize(element);
        const borderLeft = pixels(style.borderLeftWidth);
        const borderRight = pixels(style.borderRightWidth);
        const borderTop = pixels(style.borderTopWidth);
        const borderBottom = pixels(style.borderBottomWidth);
        /**
         * @param {string} radius
         * @param {number} first
         * @param {number} second
         * @returns {number}
         */
        const inset = (radius, first, second) =>
          Math.max(pixels(radius) - Math.max(first, second), 0);
        return {
          left: clipsX ? borderLeft : UNCLIPPED.left,
          right: clipsX ? size.width - borderRight : UNCLIPPED.right,
          top: clipsY ? borderTop : UNCLIPPED.top,
          bottom: clipsY ? size.height - borderBottom : UNCLIPPED.bottom,
          // A corner is only rounded on the axes that are actually being
          // clipped: one that hides overflow in y alone cuts two straight
          // horizontal lines.
          topLeft: clipsX && clipsY ? inset(style.borderTopLeftRadius, borderLeft, borderTop) : 0,
          topRight:
            clipsX && clipsY ? inset(style.borderTopRightRadius, borderRight, borderTop) : 0,
          bottomRight:
            clipsX && clipsY ? inset(style.borderBottomRightRadius, borderRight, borderBottom) : 0,
          bottomLeft:
            clipsX && clipsY ? inset(style.borderBottomLeftRadius, borderLeft, borderBottom) : 0,
        };
      },
      clipBoxEqual,
    );
    ownClipWindowCache.set(element, signal);
  }
  return signal.get();
}

/**
 * @typedef {object} ClipPair
 * @property {ClipBox} local What the ancestors leave of the element, in the
 *   element's own border-box frame.
 * @property {ClipBox} interior What the element's content is confined to —
 *   `local` intersected with the element's own overflow window — in the
 *   same frame.
 */

/** @type {ClipPair} */
const UNCLIPPED_PAIR = Object.freeze({ local: UNCLIPPED, interior: UNCLIPPED });

/**
 * @param {ClipPair} a
 * @param {ClipPair} b
 * @returns {boolean}
 */
function clipPairEqual(a, b) {
  return clipBoxEqual(a.local, b.local) && clipBoxEqual(a.interior, b.interior);
}

/** @type {WeakMap<HTMLElement, Derived<ClipPair>>} */
const clipPairCache = nodeCache();

/**
 * The element's clipping, both halves in one computation: what its
 * ancestors leave of it (`local` — the box its own quad is drawn and
 * raycast in) and what it passes on to its content (`interior` — the box a
 * child inherits and a text node is trimmed by). One derived per element
 * rather than one per half, because the two always move together and a
 * frame of scrolling recomputes every element in the scrolled subtree —
 * at half the computations, half the queue traffic.
 *
 * Each level derives from the level above: the holder's interior window —
 * cached in the holder's frame, where a scroll cannot move it — shifted by
 * where this element currently sits in that frame. That offset is the one
 * place the scroll offset enters, so scrolling recomputes the boxes of the
 * scrolled subtree as plain arithmetic on cached values: no styles are
 * read, nothing is measured, and the equality gate stops the propagation
 * wherever a box came out where it already was.
 *
 * Who does the confining is decided by where the box *lives*, which for a
 * positioned element is not its parent: an absolutely positioned box hangs
 * off its containing block, so `overflow` ancestors below that block never
 * clip it — how a dropdown anchored outside a list stays whole while its
 * trigger row scrolls away — and a fixed box escapes every ancestor there
 * is. The walk stops at the portal's container either way: what the page
 * around the scene does with `body` is none of a panel's business.
 *
 * @param {HTMLElement} element
 * @returns {ClipPair}
 */
function getClipPair(element) {
  let signal = clipPairCache.get(element);
  if (!signal) {
    signal = probedRead(
      element,
      () => {
        const local = evaluateLocalClip(element);
        const own = getOwnClipWindow(element);
        if (own === UNCLIPPED) {
          return local === UNCLIPPED ? UNCLIPPED_PAIR : { local, interior: local };
        }
        const interior = local === UNCLIPPED ? own : intersectClipBoxes(local, own);
        return { local, interior };
      },
      clipPairEqual,
    );
    clipPairCache.set(element, signal);
  }
  return signal.get();
}

/**
 * @param {HTMLElement} element
 * @returns {ClipBox}
 */
function evaluateLocalClip(element) {
  if (isPortalRoot(element)) {
    return UNCLIPPED;
  }
  const position = getPositionStyle(element);
  if (position === "fixed") {
    return UNCLIPPED;
  }
  if (position === "absolute") {
    const anchored = getAnchoredOffset(element);
    const anchor = anchored.anchor;
    if (!anchor || isPortalRoot(anchor)) {
      return UNCLIPPED;
    }
    const base = getClipPair(anchor).interior;
    if (base === UNCLIPPED) {
      return UNCLIPPED;
    }
    const scroll = getScrollOffset(anchor);
    const at = isTransformed(element) ? untransformedAnchorOffset(element, anchor) : anchored;
    return toLocalClipBox(base, at.x - scroll.left, at.y - scroll.top);
  }
  const holder = getParentElement(element);
  if (!holder || isPortalRoot(holder)) {
    return UNCLIPPED;
  }
  const base = getClipPair(holder).interior;
  if (base === UNCLIPPED) {
    return UNCLIPPED;
  }
  // In the flow, the box's object position is its content position, and
  // `getBoxOffset` is the one place that swaps it for the layout offset
  // when the element is on a transformed chain.
  const offset = getBoxOffset(element);
  const scroll = getScrollOffset(holder);
  return toLocalClipBox(base, offset.x - scroll.left, offset.y - scroll.top);
}

/**
 * Where a transformed element's border box sits in its anchor's, from the
 * layout rather than the client rects `getAnchoredOffset` measures. A
 * transformed element's client rect is the bounding box of what the
 * transform made of it, which grows and moves as a rotation turns, and a
 * clip placed by it slides about with the angle. The layout offset is
 * where the box is before its transform, which is the frame its quad is
 * drawn and clipped in.
 *
 * @param {HTMLElement} element
 * @param {HTMLElement} anchor
 * @returns {{ x: number, y: number }}
 */
function untransformedAnchorOffset(element, anchor) {
  getReflowContext(element);
  return untransformedOffset(element, anchor);
}

/**
 * What this element's content is confined to, in the element's border-box
 * frame. `UNCLIPPED` keeps its identity the whole way down a subtree nobody
 * clips, which is what lets everything in it skip the arithmetic.
 *
 * @param {HTMLElement} element
 * @returns {ClipBox}
 */
export function getInteriorClipBox(element) {
  return getClipPair(element).interior;
}

/**
 * The region the element's ancestors confine it to, in the element's own
 * border-box frame — the frame its quad is drawn in, so the same numbers
 * serve the shader uniform and the raycast filter directly.
 *
 * @param {HTMLElement} element
 * @returns {ClipBox}
 */
export function getLocalClipBox(element) {
  return getClipPair(element).local;
}
