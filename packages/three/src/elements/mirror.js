import {
  addDependency,
  batch,
  Derived,
  fromEvent,
  NoValueError,
  onCleanup,
  Signal,
} from "justdom-signal";
import { Subject } from "justdom-signal";
import { isSvgElement, isSvgRoot } from "./plugins.js";
import { classify } from "./animationClock.js";
import {
  GENERATED_COPY_ATTRIBUTE,
  getSiblingReach,
  withGeneratedCopyRule,
} from "./documentStyles.js";
import {
  ACTIVE_ATTRIBUTE,
  ELEMENT_FLAGS,
  FOCUS_ATTRIBUTE,
  HOVER_ATTRIBUTE,
  PORTAL_ATTRIBUTE,
} from "./portalRoot.js";
import { probeChange, probeNoopWrite, probeRipple } from "./outlineProbe.js";
import { holdShared, shadowAccessor } from "./shadowAccessor.js";
import {
  frameFor,
  invalidateGeometry,
  invalidatePanelFrame,
  invalidatePanelFrames,
  measureClientRect,
} from "./panelFrame.js";
import { copyStillStyle, parkMeasurementClone } from "./mirror/measurementClones.js";
import { nodeCache } from "./mirror/nodeCaches.js";
import {
  adoptions,
  announceAdoption,
  departed,
  departures,
  forgetNode,
  NodeRecord,
  nodeDerived,
  probedRead,
  readRecordOf,
  recordOf,
  records,
  takeDeparted,
} from "./mirror/records.js";
import {
  getBorderBoxSize,
  getFlowMode,
  getObjectPosition,
  getReflowContext,
  getScrollOffset,
  isOutOfFlowPosition,
  readParentBox,
} from "./mirror/geometryReads.js";
import { measureTextRects } from "./mirror/textLayout.js";
import {
  getChildNodes,
  getComputedStyleCached,
  getParentElement,
  getPositionStyle,
  getTextDataCached,
  isPortalRoot,
  isTransformed,
} from "./mirror/styleReads.js";

/**
 * @import {TextLayout} from './mirror/textLayout.js';
 * @import {BorderBoxSize} from './mirror/geometryReads.js';
 * @import {Subscribable} from 'justdom-signal';
 */

/**
 * The reactive mirror of a portal's DOM: what the portal knows about its
 * tree, kept as fine-grained reactive state instead of asked of the browser
 * on every change.
 *
 * The previous design broadcast every mutation to everyone — one subject
 * shared by the whole portal, with each cached read running a heuristic
 * filter (`affectsStyle`, `affectsRect`, …) over every batch to decide
 * whether it was addressed. That put the routing decision at the wrong end:
 * O(listeners) filter runs per mutation, and any filter that could not
 * prove innocence re-measured. Scrolling was the worst case — every client
 * rect in the scroller moved, so every element in it re-read rects that
 * recomputed to the numbers they already had.
 *
 * Here the routing happens where the knowledge is: the mutation is applied
 * to exactly the signals it invalidates, and everything downstream is an
 * ordinary reactive computation hanging off those signals. Concretely:
 *
 *   - Every node adopted by a portal gets a small record of signals — its
 *     attributes changed, its child list changed, its text changed, it was
 *     reparented, it scrolled. The observer's records are buffered by the
 *     portal and ingested inside one `batch()`, deduplicated against
 *     `oldValue`, and each record bumps only the signals of the nodes it
 *     names. A `data-xr-hover` write that did not change the value bumps
 *     nothing at all.
 *
 *   - Style and layout dependencies are *chained* rather than filtered:
 *     `styleContext(E)` sums E's own signal with its parent's member signal
 *     and the parent's context, so a mutation at X reaches exactly the
 *     parent-of-X subtree — the same scope the old heuristic modelled — by
 *     construction, at the cost of the affected chain rather than of every
 *     registered listener.
 *
 *   - Geometry is stored scroll-invariantly. An element's position is kept
 *     relative to its parent's *content* origin (border-box corner plus
 *     scroll offset), and a clip window relative to its owner's border box
 *     — numbers a scroll provably cannot change, so a scroll invalidates
 *     nothing here. The scroll offset itself is one signal per scroller,
 *     and the correction is applied at the scene-graph level: each box
 *     carries a content group translated by minus the offset (see div.js),
 *     so a scroll is one position write however long the list is. What
 *     does derive from the offset — the clip boxes of the scrolled
 *     subtree, and the culling that follows them — recomputes as plain
 *     arithmetic on cached values, without touching the DOM.
 *
 *   - Layout is scoped by the geometry itself. CSS layout is non-local —
 *     a sibling growing moves you — but it is not unbounded, and what
 *     bounds it is the same parent-relative storage above: CSS lays a box
 *     out from the space it was given, so a box that came out the size it
 *     was has not moved anything inside it. `#settleLayout` climbs from
 *     each change telling every level's children they moved, and stops at
 *     the first level that kept its own size, an inline box excepted: its
 *     size is the union of its line fragments, which text rewritten on its
 *     last line can leave alone while moving what follows it. Everything
 *     below an unchanged box hears nothing at all, and what it is spared is
 *     mostly text: a `Range` measurement is the most expensive read in this
 *     file, and on a list there is one per row.
 *
 *     Two things reach past that. `readParentBox` is how a box that *did*
 *     resize reaches its own contents, one level per settling and no
 *     further than the sizes actually change. And a handful of signals stay
 *     portal-wide for the changes no walk could find: fonts, which re-break
 *     lines without moving a single box; a rule rewritten in the document's
 *     stylesheets, which is not in the tree at all; an animating layout
 *     property, which moves elements nobody named; and out-of-flow boxes,
 *     which are not on the parent chain the walk follows.
 *
 * Under all of it is the equality gate — every measurement is a plain value
 * compared by value, so a re-measure stops propagating at the first element
 * that did not actually move, and the walk above is what keeps the count of
 * elements asked to re-measure proportional to the change rather than to
 * the panel.
 */

/**
 * Set on a portal's container element while its initial mount is running,
 * from the first content the observer reports to the load, and taken off
 * when it is done. `document.querySelector("[data-xr-loading]")` then asks
 * whether any panel is still on its way, for a caller that has the page and
 * not the handles. A portal that has been given nothing to mount never
 * carries it: it is not on its way anywhere, and a harness waiting on the
 * attribute must not wait on that.
 */
export const LOADING_ATTRIBUTE = "data-xr-loading";

/**
 * Set on a portal's container element while the panel has work it will do
 * on a coming frame: an animation the clock is sampling, or an update the
 * pump has yet to bring into the scene. Taken off on the frame that finds
 * neither, which is the frame that draws the last of it. A harness that
 * freezes the page's animations and then photographs the scene waits for
 * `document.querySelector("[data-xr-busy]")` to come back empty, where a
 * fixed number of frames is a guess at how long a slow machine takes. A
 * panel holding an animation that runs forever is busy for as long as it
 * runs.
 */
export const BUSY_ATTRIBUTE = "data-xr-busy";

/**
 * The portal's own markers on its container. The portal observes every
 * attribute in its tree, and these are the three it writes there itself, to
 * tell the page where a panel is, whether it has loaded and whether it has
 * work left to draw. No stylesheet is meant to key on them, so the ingest
 * drops them like a value written again unchanged. The container is an
 * ancestor of every element in the panel, and treating any of them as an
 * author's attribute would restyle and re-measure the whole panel twice for
 * every mount, and twice for every animation.
 */
const PORTAL_BOOKKEEPING_ATTRIBUTES = new Set([
  PORTAL_ATTRIBUTE,
  LOADING_ATTRIBUTE,
  BUSY_ATTRIBUTE,
]);

/**
 * Whether an observer record is one of the portal's own markers being
 * written. A flush of nothing else changes nothing in the panel, and the
 * portal answers it with nothing: answering it as a change would ask the
 * animation clock to look again, which marks the panel busy, which is
 * another such write.
 *
 * @param {MutationRecord} mutation
 * @returns {boolean}
 */
export function isBookkeepingMutation(mutation) {
  return (
    mutation.type === "attributes" &&
    mutation.attributeName !== null &&
    PORTAL_BOOKKEEPING_ATTRIBUTES.has(mutation.attributeName)
  );
}

/**
 * The attributes the portal writes onto elements itself, to say what the ray
 * and the keyboard are doing to them: hovering, pressing, typing into, and —
 * for a checkbox, whose state no mutation would otherwise report — ticked.
 *
 * **A rule that follows one of these may restyle, but may not re-lay-out.**
 * Colour, background, border colour, opacity and `transform` are all fair
 * game; a width, a padding or a font size that changes on hover is not
 * mirrored, and the mirror will go on drawing the boxes at the size they had.
 *
 * A second, narrower contract applies to some of them but not all — see
 * `SELF_SCOPED_ATTRIBUTES` below, and `isSelfScoped`, which is where the
 * sibling combinators are decided.
 *
 * The contract is worth the narrowness because of what it buys. These are by
 * far the most frequent mutations a panel sees — the ray writes one on every
 * element it crosses, twice per element on a press — and re-measuring on each
 * costs a client rect per element and, far worse, a Range measurement per
 * text node in the hovered subtree, which is the most expensive read in this
 * file. Under a moving hand, at frame rate. Declaring hover presentational
 * takes all of that to zero, and does it without giving anything up in
 * practice: layout that moves under the cursor is a thing interfaces avoid
 * anyway, because it slides the target out from under the pointer that was
 * reaching for it.
 *
 * `transform` deliberately still works, and needs no re-measurement to do so:
 * a transformed element carries the matrix on its object and takes its size
 * and position from layout offsets, and *whether* it is transformed is a
 * style-derived signal — so a hover that swaps a transform reaches the scene
 * entirely through the restyle path. See `isTransformed` and `div.js`.
 *
 * `class` and `style` are pointedly not in this set: they are the author's
 * own, and an inline width or a swapped class is exactly how a panel does
 * move its layout on purpose.
 *
 * @type {ReadonlySet<string>}
 */
const PRESENTATIONAL_ATTRIBUTES = new Set(ELEMENT_FLAGS);

/**
 * Of those, the ones that may only style the element they match and its
 * subtree. `[data-xr-hover] ~ .row` and `[data-xr-active] + .row` are not
 * mirrored: the sibling keeps the styling it had. Descendants are fine —
 * `.button[data-xr-hover] .label` restyles, as does anything the hovered
 * element's subtree inherits from it.
 *
 * This is what keeps hover off the rest of the panel. A restyle scope is a
 * claim about how far a selector's verdict could have moved, so the sibling
 * half of the ordinary scope (see `#restyleScope`) puts every element sharing
 * a parent — and everything under those — in the path of one hover. Hover
 * lands on whatever the ray hits, which in a list is a row, whose parent is
 * the list: the entire list restyles on every row the ray crosses, at frame
 * rate. Ruling out the sibling combinators makes hovering a row cost the row.
 *
 * **`data-xr-checked` is deliberately not here**, and the asymmetry is the
 * point rather than an oversight. The case above is an argument from
 * frequency, and a checkbox is not frequent: it toggles once, at the speed of
 * a hand, where hover is written on every element a moving ray crosses. The
 * blast radius is smaller too, and for the same reason read the other way —
 * the flag is written on the `<input>`, whose parent is the row rather than
 * the list, so its siblings are a label and a button rather than a hundred
 * rows. Narrowing it would save two elements a click.
 *
 * Against that, the sibling combinator is *the* idiom for a checkbox:
 * `input:checked + label` is how the flat web has always struck through a
 * completed item, and mirroring `:checked` faithfully is the whole reason
 * `data-xr-checked` exists. Charging it the same narrowness as hover would be
 * cost without benefit.
 *
 * `data-xr-focus` is here with hover, though it is written at a press's
 * frequency rather than a hover's, because what a focus ring styles is the
 * field: `:focus` on a page reaches no sibling either, and `:focus-within`,
 * which does, reaches upward, where no mutation here is followed anyway.
 */
const SELF_SCOPED_ATTRIBUTES = new Set([HOVER_ATTRIBUTE, ACTIVE_ATTRIBUTE, FOCUS_ATTRIBUTE]);

/**
 * The attributes that place and size what SVG draws, self-scoped on any
 * element inside an `<svg>` root by contract, as hover is. An attribute
 * selector on the value itself, `[cx="3"] ~ circle`, would carry one to a
 * sibling, and the mirror does not follow it. A drawing that moves writes
 * these on every frame, on many shapes at once, and under the ordinary
 * scope each write restyled every shape and label under the same parent.
 * `dx`, `dy` and `rotate` place the characters of a `<text>`, and
 * `transform` is how a group or a shape usually moves.
 *
 * Not on the root: its `width` and `height` size a CSS box in the page's
 * flow, as they do an `<img>`'s, and on HTML they are an author's
 * attributes like any other. An `<svg>` directly inside a `<foreignObject>`
 * is laid out the same way, but the portal draws nothing under a
 * `<foreignObject>`, so what its siblings would restyle is never drawn.
 */
const SVG_GEOMETRY_ATTRIBUTES = new Set([
  "x",
  "y",
  "width",
  "height",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "dx",
  "dy",
  "rotate",
  "transform",
]);

/**
 * Whether a change of `name` on `element` is declared, by contract, unable
 * to restyle a sibling. See `SELF_SCOPED_ATTRIBUTES` and
 * `SVG_GEOMETRY_ATTRIBUTES`.
 *
 * @param {Element} element
 * @param {string} name
 * @returns {boolean}
 */
function isSelfScoped(element, name) {
  if (SELF_SCOPED_ATTRIBUTES.has(name)) {
    return true;
  }
  return SVG_GEOMETRY_ATTRIBUTES.has(name) && isSvgElement(element) && !isSvgRoot(element);
}

/**
 * Whether some rule of the document could restyle an element's sibling for
 * a change of `name` (`getSiblingReach`). An attribute no sibling rule
 * names, which is most of them on most pages, `style` included, restyles
 * the element's own subtree and leaves its siblings alone.
 *
 * @param {string} name
 * @returns {boolean}
 */
function reachesSibling(name) {
  const reach = getSiblingReach();
  return reach === null || reach.has(name.toLowerCase());
}

/**
 * Whether a change of `name` on `element` only moves the frame the element
 * and its subtree are drawn in, and so changes no measurement under it: a
 * `transform` on an SVG element below the `<svg>` root.
 *
 * Everything under such an element is laid out in its own user space, and
 * the transform takes that space where it is drawn without changing it. A
 * `<text>` keeps its runs, a percentage keeps its viewport, and the panel
 * takes the new transform as a matrix write (`svgNode`). The one thing
 * that measures a subtree in place, a `<text>` laid out in a measurement
 * clone (`measureRuns` in `svg/text.js`), measures it in its own user
 * space, with the transform switched off. So the element's subtree is
 * restyled, for a selector that keys on the attribute, and not measured
 * again. The root is a box, placed by layout, and is not one of these.
 *
 * Without this, a stack walking across the Knights board re-measured the
 * count under it on every step: a deep clone, its computed style copied
 * and a forced layout, ten times a second.
 *
 * @param {Element} element
 * @param {string} name
 * @returns {boolean}
 */
function movesOnlyItsFrame(element, name) {
  return name === "transform" && isSvgElement(element) && !isSvgRoot(element);
}

/**
 * An inline style's declarations, by property name. A declaration with no
 * colon keeps its text as its name, which `classify` reads as layout. So a
 * value the split cuts in two, a `data:` URL with a `;` in it say, reads as
 * a change that moves boxes when the cut part changed, and as no change when
 * it is the same before and after.
 *
 * @param {string | null} text
 * @returns {Map<string, string>}
 */
function readDeclarations(text) {
  /** @type {Map<string, string>} */
  const declarations = new Map();
  for (const declaration of (text ?? "").split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) {
      if (declaration.trim()) {
        declarations.set(declaration.trim(), "");
      }
      continue;
    }
    declarations.set(
      declaration.slice(0, colon).trim().toLowerCase(),
      declaration.slice(colon + 1).trim(),
    );
  }
  return declarations;
}

/**
 * The properties that place and size a box, and so move nothing but that box
 * when the box is out of the flow: an absolutely positioned box adds nothing
 * to its parent's flow, so its siblings and its parent's size do not depend
 * on them. The set holds the physical and logical offsets, sizes and margins
 * an author writes, and the longhands a browser serializes a logical write
 * as.
 *
 * One case escapes it. An out-of-flow box still counts towards its
 * containing block's scrollable overflow, so where scrollbars take room, a
 * desktop browser's classic ones, a box grown past the bottom of a scroller
 * brings a scrollbar in and narrows what the boxes in the flow lay out in.
 * A headset draws overlay scrollbars and a panel hides its overflow, so the
 * rule holds where a session runs; a box left stale beside a positioned one
 * on a desktop page is that case.
 */
const OUT_OF_FLOW_GEOMETRY = new Set([
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "inset-block",
  "inset-inline",
  "inset-block-start",
  "inset-block-end",
  "inset-inline-start",
  "inset-inline-end",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "block-size",
  "inline-size",
  "min-block-size",
  "max-block-size",
  "min-inline-size",
  "max-inline-size",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "margin-block",
  "margin-inline",
  "margin-block-start",
  "margin-block-end",
  "margin-inline-start",
  "margin-inline-end",
]);

/**
 * Whether an inline style that went from `before` to `after` moved no box but
 * the element's own, across every declaration added, removed or rewritten.
 * Each one either moves no box at all, as `movesLayout` decides, or places or
 * sizes an element that is positioned absolutely or fixed, which moves that
 * element alone. This is what keeps a gauge that writes `style.transform`
 * every frame, and a scrollbar thumb that writes `top` and `height` on every
 * scroll, at the cost of their own subtrees, where a width written on a box
 * in the flow settles the panel. A custom property moves layout, since a
 * `var()` may feed a width, and so does `position`, which is how a box joins
 * or leaves the flow.
 *
 * A `relative` or `sticky` box is left out although its offsets move it
 * alone, because its `width` and `height` do move the flow and the gate reads
 * the position, not the property: its offsets climb, which costs work and
 * nothing else.
 *
 * The position is read from the browser rather than from the mirror's cache,
 * because an ancestor's class changed in the same flush may not have reached
 * the cache yet. It is read only when a geometry declaration changed, so a
 * write of paint alone costs no style read.
 *
 * @param {Element} element
 * @param {string | null} before
 * @param {string | null} after
 * @returns {boolean}
 */
function keepsToOwnBox(element, before, after) {
  const was = readDeclarations(before);
  const now = readDeclarations(after);
  let placesItself = false;
  for (const name of new Set([...was.keys(), ...now.keys()])) {
    const old = was.get(name);
    const value = now.get(name);
    if (old === value || (!movesLayout(name, old) && !movesLayout(name, value))) {
      continue;
    }
    if (!OUT_OF_FLOW_GEOMETRY.has(name)) {
      return false;
    }
    placesItself = true;
  }
  return !placesItself || isOutOfFlowPosition(window.getComputedStyle(element).position);
}

/**
 * Whether one declaration can move a box. The name decides, through the
 * animation clock's `classify`, with its default: an unknown property moves
 * layout. The exception is `visibility: collapse`, which takes a table row or a
 * flex item out of the layout where every other `visibility` only paints. The
 * value is read as CSS reads a keyword, in any case and with an `!important`
 * after it, which is how `setProperty` with a priority writes it.
 *
 * @param {string} name
 * @param {string | undefined} value
 * @returns {boolean}
 */
function movesLayout(name, value) {
  return (
    classify(name) === "layout" ||
    (name === "visibility" && /^collapse\s*(!\s*important)?$/i.test(value ?? ""))
  );
}

/**
 * The last border box each overflow container was seen at, as raw numbers
 * outside the reactive graph.
 *
 * This is the ledger `#settleLayout` decides against: whether a change
 * inside a container left the container itself the size it was, and so
 * whether the panel around it needs to hear about it at all. Deliberately
 * not the `getBorderBoxSize` signal — the question is asked mid-dispatch,
 * before the graph has run, and the answer wanted is what the browser says
 * *now* against what the outside was last told.
 *
 * @type {WeakMap<Element, BorderBoxSize>}
 */
const lastSettledSize = nodeCache();

/**
 * Whether the element's border box differs from the last size recorded for
 * it, recording the new one either way. An element never seen before counts
 * as changed: nothing outside has been told anything about it yet.
 *
 * @param {Element} element
 * @returns {boolean}
 */
function resized(element) {
  const rect = measureClientRect(element, frameFor(element));
  const previous = lastSettledSize.get(element);
  if (previous && previous.width === rect.width && previous.height === rect.height) {
    return false;
  }
  lastSettledSize.set(element, { width: rect.width, height: rect.height });
  return true;
}

/**
 * HTML elements whose inline box is atomic whatever their computed `display`
 * says. Replaced elements and form controls are laid out as one box on one
 * line, so their size is a true measure of what they moved, and whatever is
 * inside them is laid out inside that box rather than on the lines around
 * it.
 */
const ATOMIC_INLINE_TAGS = new Set([
  "audio",
  "button",
  "canvas",
  "embed",
  "iframe",
  "img",
  "input",
  "object",
  "select",
  "textarea",
  "video",
]);

/**
 * Whether the element's box is laid out in pieces across line boxes, so that
 * its size is no measure of what it moved. An inline box's border box is the
 * union of its fragments, and text rewritten on its last line moves where it
 * ends, and the inline content after it, without changing that union. A box
 * with `display: contents` has no box at all. Either way the change belongs
 * to the element the line boxes are in, and the climb goes on to it.
 *
 * Read defensively, as `getFlowMode` reads: an engine that reports no
 * `display` is reporting the initial value, `inline`.
 *
 * An atomic inline box never splits, and some compute to `inline` all the
 * same. Every SVG element does: an `<svg>` root is one box in the HTML flow,
 * and what is inside it is placed in user space rather than on lines. So do
 * the replaced elements in `ATOMIC_INLINE_TAGS`. A browser gives the form
 * controls there `inline-block`, so they need the list only where an engine
 * reports no `display` or the page sets `display: inline` on one. A label
 * rewritten every frame inside an SVG gauge ends the climb at the `<svg>`,
 * as it would at any box that kept its size.
 *
 * `display: contents` is read first, because it removes the box from any of
 * those. Its children flow in the parent's line boxes, as a `<button>`'s do,
 * and on the other tags it renders as `none`, with no box to measure.
 *
 * @param {Element} element
 * @returns {boolean}
 */
function splitsAcrossLines(element) {
  return displaySplitsAcrossLines(element, getComputedStyleCached(element).display);
}

/**
 * `splitsAcrossLines` for a `display` the caller has read itself, as the
 * line box copy does without subscribing to it (`dressLaidOut`).
 *
 * @param {Element} element
 * @param {string} display
 * @returns {boolean}
 */
function displaySplitsAcrossLines(element, display) {
  if (display === "contents") {
    return true;
  }
  if (isSvgElement(element) || ATOMIC_INLINE_TAGS.has(element.localName)) {
    return false;
  }
  return display === "" || display === "inline";
}

/**
 * Tell `node`'s subtree that something above it may have moved it: its
 * own reflow signal. A panel's root is also where a transform its frame
 * divides by can arrive, from a class swap or a transition sampled by the
 * clock alike, so the root's frame reads its chain again too (see
 * `panelFrame.js`).
 *
 * @param {Node} node
 * @param {NodeRecord} record
 * @returns {void}
 */
function bumpReflow(node, record) {
  bump(record.reflow);
  if (isPortalRoot(node)) {
    invalidatePanelFrame(/** @type {Element} */ (node));
  }
}

/**
 * @param {Signal<number>} signal
 */
function bump(signal) {
  invalidateGeometry();
  signal.setFn(
    (value) => value + 1,
    () => 1,
  );
}

/**
 * The dispatch side of the mirror: the portal (or a test standing in for
 * one) feeds changes in, each lands on the signals of the nodes it names.
 * Everything is meant to be called inside a signal `batch()`, so however
 * many nodes one observer flush touches, the reactive graph settles once.
 */
export class DomMirror {
  /**
   * Layout happened somewhere, and there is no node to blame it on. The
   * escape hatch, not the ordinary path: an animating layout property moves
   * elements nobody named, and a caller that lost track of which pictures
   * landed has nothing better to say. Everything that *can* name where it
   * happened goes through `#settleLayout` instead and reaches a bounded set
   * of nodes.
   *
   * @type {Signal<number>}
   */
  layout = Signal.of(0);

  /**
   * Layout happened somewhere, for the benefit of the boxes that are not
   * where they live: an absolutely positioned element hangs off a containing
   * block that may be anywhere above it, so the walk from the mutation site
   * — which follows the parent chain — can miss it entirely. Out-of-flow
   * boxes are few, so they keep the portal-wide answer rather than a
   * containing-block-indexed one.
   *
   * @type {Signal<number>}
   */
  outOfFlowLayout = Signal.of(0);

  /**
   * Everything restyled at once: fonts arriving and the document's
   * stylesheets changing are the events with no node to blame.
   *
   * @type {Signal<number>}
   */
  restyle = Signal.of(0);

  /**
   * Layout that reaches everywhere, walls or no walls. Fonts arriving are
   * the case this exists for: a face landing re-breaks the lines inside a
   * scroller without changing the scroller's size by so much as a pixel, so
   * it is a layout event no boundary may hold back. A rule rewritten under
   * the panel is the same: nothing bounds what a stylesheet may have said.
   * Rare enough that making every measurement in the portal depend on it
   * costs nothing.
   *
   * @type {Signal<number>}
   */
  globalLayout = Signal.of(0);

  /**
   * Bring a node under this mirror's management. Idempotent; the portal
   * calls it for every node it projects, before the first cached read.
   *
   * @param {Node} node
   * @returns {void}
   */
  adopt(node) {
    const record = this.#takeBack(node);
    if (record) {
      // Taken back by a build, or by a read from inside its computation,
      // where a write would drain the queue mid-run: what the node's reads
      // kept while it was away is read again from a microtask (rule 4 of
      // `keptWhileAway`).
      announceAdoption(() => bump(record.reparented));
    }
  }

  /**
   * `adopt`, saying which record of this mirror's it gave back to a node
   * that was let go of, if it did, for the caller to bump.
   *
   * @param {Node} node
   * @returns {NodeRecord | undefined}
   */
  #takeBack(node) {
    if (records.has(node)) {
      return undefined;
    }
    let record = takeDeparted(node);
    if (record && record.mirror !== this) {
      // Another panel's, on its way out of it, and everything cached for
      // it hangs off that panel's signals.
      forgetNode(node);
      record = undefined;
    }
    records.set(node, record ?? new NodeRecord(this, node));
    const adoption = adoptions.get(node);
    if (adoption) {
      adoptions.delete(node);
      announceAdoption(() => adoption.set(true));
    }
    return record;
  }

  /**
   * Let go of a node that left the panel, and of everything under it, while
   * the portal keeps drawing their objects until its commit. From here on
   * the mirror bumps nothing for them, and a read cached for one of them
   * keeps the value it has (`keptWhileAway`): one that runs again, for the
   * removal's bump of `reparented` or for anything the panel does before the
   * commit, returns that value and lets go of the panel's other signals, and
   * nothing drawn from it runs again. A font arriving, or a stylesheet
   * changing, before the commit reaches each such read once at most.
   *
   * Their records are kept to one side rather than dropped. A node put back
   * before the commit was moved, not removed, keeps its objects, and takes
   * its record back (`reclaim`), so the reads its objects hold, which still
   * hang from that record, hear it again, and a read that kept its value
   * runs in full. What else the page did to the subtree while it was out is
   * not heard, since the observer stops reporting a node once it has
   * reported the node's removal.
   *
   * @param {Node} node
   * @returns {void}
   */
  release(node) {
    this.#putAside(node);
  }

  /**
   * @param {Node} node
   * @returns {void}
   */
  #putAside(node) {
    const record = records.get(node);
    if (record?.mirror === this) {
      records.delete(node);
      departed.set(node, record);
      departures.set(this, (departures.get(this) ?? 0) + 1);
    }
    node.childNodes.forEach((child) => {
      this.#putAside(child);
    });
  }

  /**
   * Take back every node under `node`, itself included, that this mirror
   * let go of (`release`), now that the panel has them again, and bump each
   * one's `reparented` at once (rule 4 of `keptWhileAway`). Called from the
   * ingest's batch alone, so the sweep that follows, in the same pump tick
   * when the tick took the flush in itself, reads the whole subtree as the
   * page has it. The whole subtree is walked, not only from a node that was
   * let go of: while out of the document the page may have put one inside
   * an element the panel has never seen, and the flush then names that
   * element. A mirror with nothing let go of walks nothing.
   *
   * @param {Node} node
   * @returns {void}
   */
  reclaim(node) {
    if (!departures.get(this)) {
      return;
    }
    if (departed.get(node)?.mirror === this) {
      const record = this.#takeBack(node);
      if (record) {
        bump(record.reparented);
      }
    }
    node.childNodes.forEach((child) => {
      this.reclaim(child);
    });
  }

  /**
   * Drop everything remembered about a node this mirror let go of, its
   * record and every read cached for it, once its objects are gone, so that
   * a portal claiming it later, such as a second session over an element
   * the page owns, is not left with this mirror's signals under it. See
   * `forgetNode`. A node another panel has adopted since is that panel's,
   * and is left to it.
   *
   * @param {Node} node
   * @returns {void}
   */
  forget(node) {
    // Held or let go of: one another panel has let go of since is still
    // that panel's, waiting for its own commit or to be taken back.
    const owner = (records.get(node) ?? departed.get(node))?.mirror;
    if (owner && owner !== this) {
      return;
    }
    forgetNode(node);
  }

  /**
   * Apply one MutationObserver flush. Records are buffered by the caller
   * exactly as the observer delivered them; this routes each to the signals
   * it invalidates, deduplicating against `oldValue` so a write that did
   * not change anything — the hover handlers re-asserting `data-xr-*` —
   * invalidates nothing.
   *
   * Call within `batch()`.
   *
   * @param {MutationRecord[]} mutationList
   * @returns {void}
   */
  ingest(mutationList) {
    batch(() => {
      // One flush, one verdict per container. Collecting first means a
      // flush of fifty records measures each enclosing container once
      // rather than fifty times.
      /** @type {Map<Element, Node | null>} */
      const pending = new Map();
      this.#pendingLayout = pending;
      try {
        this.#ingest(mutationList);
      } finally {
        this.#pendingLayout = null;
        if (pending.size) {
          this.#settleLayout(pending);
        }
      }
    });
  }

  /**
   * Where layout changes gather while one observer flush is being ingested,
   * so that how far each travels is worked out once at the end. Null outside
   * a flush, where a change is settled as it arrives.
   *
   * Each container maps to the earliest of its children the flush could have
   * disturbed — `null` meaning "no idea, assume the first". Two records
   * naming one container keep the earlier of the two, so fifty rows arriving
   * at fifty places settle from the topmost of them.
   *
   * @type {Map<Element, Node | null> | null}
   */
  #pendingLayout = null;

  /**
   * @param {MutationRecord[]} mutationList
   * @returns {void}
   */
  #ingest(mutationList) {
    /**
     * The first-seen old value per (element, attribute), so a value that
     * went A → B → A across one flush counts as unchanged.
     *
     * @type {Map<Node, Map<string, string | null>>}
     */
    const attributeBaselines = new Map();
    /** @type {Map<Node, string | null>} */
    const characterBaselines = new Map();
    const kept = keptThrough(mutationList);
    for (const mutation of mutationList) {
      switch (mutation.type) {
        case "childList": {
          probeChange(mutation.target);
          this.childListChanged(
            /** @type {Element} */ (mutation.target),
            firstDisturbedChild(mutation),
            childListHint(mutation, kept(mutation.target)),
          );
          mutation.addedNodes.forEach((node) => {
            // Back before the commit took it out: taken back first, so that
            // the arrival's bump below finds the record its reads hang from.
            this.reclaim(node);
            const record = recordOf(node);
            if (record) {
              bump(record.reparented);
            }
          });
          mutation.removedNodes.forEach((node) => {
            const record = recordOf(node);
            if (record) {
              bump(record.reparented);
            }
          });
          break;
        }
        case "attributes": {
          const name = mutation.attributeName ?? "";
          let names = attributeBaselines.get(mutation.target);
          if (!names) {
            names = new Map();
            attributeBaselines.set(mutation.target, names);
          }
          if (!names.has(name)) {
            names.set(name, mutation.oldValue);
          }
          break;
        }
        case "characterData": {
          if (!characterBaselines.has(mutation.target)) {
            characterBaselines.set(mutation.target, mutation.oldValue);
          }
          break;
        }
      }
    }
    for (const [node, names] of attributeBaselines) {
      const element = /** @type {Element} */ (node);
      let changed = false;
      // The two claims a flush can make about itself, each true only if every
      // attribute that actually changed makes it. A flush that is nothing but
      // a hover measures nothing and restyles only the hovered subtree; one
      // that is nothing but a tick measures nothing but may still reach the
      // input's siblings, which is where a checkbox's label lives.
      let presentational = true;
      let selfScoped = true;
      let contained = true;
      let placedOnly = true;
      for (const [name, oldValue] of names) {
        if (PORTAL_BOOKKEEPING_ATTRIBUTES.has(name)) {
          continue;
        }
        const value = element.getAttribute(name);
        if (value === oldValue) {
          probeNoopWrite(element);
          continue;
        }
        changed = true;
        if (!PRESENTATIONAL_ATTRIBUTES.has(name)) {
          presentational = false;
          if (name !== "style" || !keepsToOwnBox(element, oldValue, value)) {
            contained = false;
          }
        }
        if (!isSelfScoped(element, name) && reachesSibling(name)) {
          selfScoped = false;
        }
        if (!movesOnlyItsFrame(element, name)) {
          placedOnly = false;
        }
      }
      if (changed) {
        probeChange(element);
        this.attributeChanged(element, { presentational, selfScoped, contained, placedOnly });
      }
    }
    for (const [node, oldValue] of characterBaselines) {
      if (node.nodeValue !== oldValue) {
        probeChange(node);
        this.characterDataChanged(node);
      } else {
        probeNoopWrite(node);
      }
    }
  }

  /**
   * An attribute on `element` actually changed value. Restyles the
   * parent-of-target subtree (descendants through the element's own
   * signal, siblings through the parent's member signal — `:has()` alone
   * is not modelled), re-measures the element's own subtree, and settles
   * the layout around it as a child arriving at its place would.
   *
   * The climb is what lets a class swap or a `hidden` resize the panel. It
   * starts at the parent, telling the element and the children after it
   * that they moved, and goes on past a parent that changed size or whose
   * size says nothing, an inline box (see `#settleLayout`). Each child told
   * re-measures its own box and stops there when the box came out where it
   * was. So a swap that moved nothing costs a rect for the element and for
   * each element after it, a text measurement for each text node after it,
   * a rect for the parent's size, and a rect for each positioned box in the
   * panel (`outOfFlowLayout`). That is the scope the restyle above has when
   * a sibling rule names the attribute (`reachesSibling`).
   *
   * In a flex row every child is told, the ones before the element too:
   * the items share the row, so an item that grows shrinks the items
   * before it as well as moving the ones after it.
   *
   * Three changes start no climb. An inline `style` that moved no box but
   * the element's own (`contained`, see `keepsToOwnBox`) is the motion a
   * page writes every frame: a transform, a fade, a positioned thumb sliding
   * along its track. The panel's root has nothing above it in the panel,
   * and its own size is in the subtree re-measured above. An SVG element
   * under an `<svg>` root is placed in user space, so an attribute on it
   * moves none of its siblings; the root's own attributes, its `width` say,
   * are a box's and climb.
   *
   * Two changes re-measure nothing at all, and only restyle: the portal's
   * own flags (`presentational`), and a `transform` on an SVG element under
   * the root, which moves the user space its subtree is laid out in without
   * changing it (`placedOnly`, see `movesOnlyItsFrame`).
   *
   * @param {Node} element
   * @param {object} [options]
   * @param {boolean} [options.presentational] Whether the change is one of
   *   the portal's own `data-xr-*` flags, and so declared unable to have
   *   moved anything measurable. False by default, which is the answer for
   *   every attribute an author writes. See `PRESENTATIONAL_ATTRIBUTES`.
   * @param {boolean} [options.selfScoped] Whether the change is declared
   *   unable to restyle a sibling, so the restyle can stop at this element's
   *   own subtree. False by default. Independent of `presentational` because
   *   the two claims are: `data-xr-checked` moves no layout but may still
   *   style the label beside it. See `isSelfScoped`.
   * @param {boolean} [options.contained] Whether the change is an inline
   *   style that moved no box but the element's own, so the element's subtree
   *   re-measures and the layout around it is not settled. False by default.
   *   See `keepsToOwnBox`.
   * @param {boolean} [options.placedOnly] Whether the change only moved
   *   an SVG element's frame, so its subtree is restyled and nothing is
   *   re-measured. False by default. See `movesOnlyItsFrame`.
   * @returns {void}
   */
  attributeChanged(
    element,
    { presentational = false, selfScoped = false, contained = false, placedOnly = false } = {},
  ) {
    batch(() => {
      this.#restyleScope(element, { reachesSiblings: !selfScoped });
      if (presentational || placedOnly) {
        return;
      }
      const record = recordOf(element);
      if (record) {
        bumpReflow(element, record);
      }
      const parent = element.parentElement;
      if (
        parent &&
        !contained &&
        !isPortalRoot(element) &&
        (!isSvgElement(element) || isSvgRoot(element))
      ) {
        this.#layoutChangedAt(parent, getFlowMode(parent) === "flex" ? null : element);
      }
    });
  }

  /**
   * `element`'s child list changed. The arriving row moves the rows after
   * it, which is a change in this element's own layout and travels from
   * here; and the structural pseudo-classes can restyle the rows around it,
   * which is `#restyleAround`'s business and reaches exactly as far as the
   * selectors do.
   *
   * @param {Element} element
   * @param {Node | null} [from] The earliest child the change could have
   *   disturbed — the arriving row, or whatever took a departing one's
   *   place. Omitted, the whole child list is assumed disturbed, which is
   *   the answer for a caller holding no mutation record.
   * @param {ChildListHint} [hint] What else the mutation record says about
   *   where the change happened; see `ChildListHint`. Omitted, the restyle
   *   falls back to the list, its subtree and its siblings.
   * @returns {void}
   */
  childListChanged(
    element,
    from = null,
    { previous = from ? from.previousSibling : null, kinds = null, kept = false } = {},
  ) {
    batch(() => {
      const record = recordOf(element);
      if (record) {
        bump(record.childList);
      }
      this.#restyleAround(element, from, previous, kinds, kept);
      this.#layoutChangedAt(element, from);
    });
  }

  /**
   * Restyle whatever a change in `element`'s child list could have changed
   * the styling of, and nothing else.
   *
   * A child-list change moves no attribute, so the only selectors whose
   * verdict on an *existing* element it can move are the ones that look at
   * an element's position among its siblings — and CSS is precise about
   * which way each of them looks:
   *
   *   - Forward. `~`, `+`, `:nth-child`, `:nth-of-type`, `:first-child`,
   *     `:first-of-type` match an element by what comes *before* it. A
   *     change at one point in the list can move them only on the children
   *     from that point on — which is the same tail `#settleLayout` tells
   *     it moved — and on nothing before it. For a row appended at the end,
   *     that tail is the row itself.
   *
   *   - Backward, one element. `:last-child` and `:only-child` can change
   *     on exactly one existing element: the one that was last before the
   *     change, which is the surviving sibling the change happened after.
   *
   *   - Backward, one element per kind. `:last-of-type` and `:only-of-type`
   *     can change on the last earlier sibling of each element name that
   *     arrived or left — one node per kind, found by a walk back that
   *     costs nothing reactive.
   *
   *   - `:empty`, on the list itself, and through it on the list's own
   *     siblings via the combinators above. It held when the list kept,
   *     through the whole observer flush, a node that counts toward it
   *     (`kept`; see `keptThrough`). Otherwise the list, its subtree and
   *     its siblings restyle. A comment does not count, so an empty list
   *     that is one comment anchor, as Lit, Svelte and Solid leave, flips
   *     when its first row arrives, wherever the row lands. A log that
   *     drops its oldest row as each new one arrives keeps its other rows,
   *     and restyles them and nothing around the list.
   *
   * What is knowingly not modelled is the `:nth-last-child` and
   * `:nth-last-of-type` family: a row appended at the end shifts the
   * position-from-the-end of every row before it, so following them would
   * mean restyling the whole list on every append — which is precisely the
   * cost this scoping exists to remove, and the cost the mirror paid before
   * it. It is the same bargain `getStyleContext` strikes over `:has()`, and
   * the README states it alongside the hover contract.
   *
   * The narrowness is what makes a list that streams in linear in its own
   * length. Before this, a child-list change was scoped like an attribute
   * change on the list — its whole subtree, and its siblings' — so every
   * row already on a panel restyled for every row that arrived, and
   * mounting eight hundred one at a time cost forty-seven times what
   * mounting them together did.
   *
   * @param {Element} element
   * @param {Node | null} from The first child after the change, if known.
   * @param {Node | null} previous The surviving child before the change,
   *   if known.
   * @param {Iterable<string> | null} kinds The element names that arrived
   *   or left, or null when there is no telling. `ingest` always knows.
   *   A caller that passes a hint with `kept` and no `kinds` gets the
   *   whole list before the change restyled behind the tail, which is
   *   O(N) where the full hint is O(kinds).
   * @param {boolean} kept Whether the list kept a node that counts toward
   *   `:empty` through the flush, so that `:empty` did not flip.
   * @returns {void}
   */
  #restyleAround(element, from, previous, kinds, kept) {
    // `:empty` may have flipped: the list, its subtree and its siblings.
    if (!kept) {
      this.#restyleScope(element);
      return;
    }
    // A change at the start of the list, or one whose place is lost:
    // every child's position from the start may have moved, so the tail
    // is the whole list and there is nothing before it.
    const atStart = !previous || previous.parentNode !== element;
    // Forward: the tail, from the change to the end.
    for (
      let child = atStart ? element.firstChild : from;
      child && child.parentNode === element;
      child = child.nextSibling
    ) {
      this.#restyleScope(child, { reachesSiblings: false });
    }
    if (atStart) {
      return;
    }
    // Backward: the element that was last, and the last of each kind.
    this.#restyleScope(previous, { reachesSiblings: false });
    if (kinds === null) {
      for (let child = previous.previousSibling; child; child = child.previousSibling) {
        this.#restyleScope(child, { reachesSiblings: false });
      }
      return;
    }
    const pending = new Set(kinds);
    pending.delete(previous.nodeName);
    for (
      let child = previous.previousSibling;
      child && pending.size > 0;
      child = child.previousSibling
    ) {
      if (pending.delete(child.nodeName)) {
        this.#restyleScope(child, { reachesSiblings: false });
      }
    }
  }

  /**
   * A text node's data changed: its own layout, and — text takes part in
   * layout — the layout of the element it sits in.
   *
   * @param {Node} text
   * @returns {void}
   */
  characterDataChanged(text) {
    batch(() => {
      const record = recordOf(text);
      if (record) {
        bump(record.character);
      }
      // The text's own box changed, so everything after it in its parent
      // moved and everything before it did not.
      if (text.parentElement) {
        this.#layoutChangedAt(text.parentElement, text);
      }
    });
  }

  /**
   * `element` scrolled. Reads the offset off the element; everything else
   * about a scroll follows reactively from this one signal.
   *
   * @param {Node} node
   * @returns {void}
   */
  scrolled(node) {
    const record = recordOf(node);
    if (!record || node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const element = /** @type {Element} */ (node);
    // Client rects move with a scroll even though nothing reactive depends
    // on them for it — the raw-read memo must not serve pre-scroll numbers
    // to whoever measures next.
    invalidateGeometry();
    record.scroll.set({ left: element.scrollLeft || 0, top: element.scrollTop || 0 });
  }

  /**
   * The animation clock sampled: the computed styles of these elements'
   * subtrees may have moved.
   *
   * Narrower than an attribute mutation, and for a reason that does not
   * hold there. What a sibling's scope models is a selector changing its
   * verdict — `~`, `+` and the structural pseudo-classes all match on
   * attributes, classes and position, and a mutation can move any of them.
   * A transition or a keyframe moves none: it changes the resolved values
   * on the element it runs on, and nothing about which rules match whom.
   * So the subtree — where inherited properties carry the new values — is
   * the whole of it, and a neighbour that is animating too is separately in
   * `targets` anyway.
   *
   * This is load-bearing for hover. Hover styling is conventionally
   * transitioned, so the clock re-reports the hovered element on every
   * frame the transition runs; at the old scope each of those frames
   * restyled every sibling in the list and everything under them.
   *
   * `subtree: false` narrows it once more, to the element alone, for an
   * animation of nothing a child inherits. A transform on a card's root
   * moves no computed value under it, and at the subtree scope every frame
   * of it restyled the whole card — which, on an atomic channel, was more
   * than a frame's budget could re-resolve, so the tilt never reached the
   * scene until it had finished. Whatever a descendant does derive from an
   * ancestor's style — `isTransformed` — reads it through the ancestor's
   * own memoized reads, which this still invalidates. A transform animating
   * alone on an HTML element goes narrower still, to `transformed`.
   *
   * @param {Iterable<Node>} targets
   * @param {{ subtree?: boolean }} [options]
   * @returns {void}
   */
  animatedStyles(targets, { subtree = true } = {}) {
    batch(() => {
      for (const target of targets) {
        if (subtree) {
          this.#restyleScope(target, { reachesSiblings: false });
        } else {
          const record = recordOf(target);
          if (record) {
            bump(record.own);
          }
        }
      }
    });
  }

  /**
   * The animation clock sampled: the transforms of these elements may have
   * moved, and nothing else about them. Narrower than `animatedStyles` with
   * `subtree: false`, which re-reads the element's whole computed style; this
   * reaches only what reads the transform (`getTransformStyle`).
   *
   * @param {Iterable<Node>} targets
   * @returns {void}
   */
  transformed(targets) {
    batch(() => {
      for (const target of targets) {
        const record = recordOf(target);
        if (record) {
          bump(record.transform);
        }
      }
    });
  }

  /**
   * The animation clock says client rects moved without a mutation: a
   * transform settling re-measures its own subtree; an animating layout
   * property moves elements nobody named, which is the portal-wide case.
   *
   * @param {Iterable<Node> | null} targets
   * @returns {void}
   */
  reflowed(targets) {
    batch(() => {
      if (!targets) {
        bump(this.layout);
        return;
      }
      for (const target of targets) {
        const record = recordOf(target);
        if (record) {
          bumpReflow(target, record);
        }
      }
    });
  }

  /**
   * Fonts arrived: everything restyles and everything re-measures, and
   * there is no node to scope that to — nor any wall it may be held behind,
   * since a face lands without moving any container's size.
   *
   * @returns {void}
   */
  fontsLoaded() {
    this.#everythingChanged();
  }

  /**
   * The document's stylesheets changed: a rule was rewritten, or a sheet
   * arrived or went away. The same shape of event as fonts arriving, and for
   * the same reason — the rules are not in the tree, so no node can be
   * blamed for what they did, and a rule may equally well have restyled one
   * element or re-laid-out the panel.
   *
   * This is what a styling library that keeps a class name stable and
   * rewrites the rule behind it looks like from in here: the `class`
   * attribute the panel wears never changes, so nothing else in this file
   * ever hears about the change. See `documentStyles.js`.
   *
   * **It costs a whole-panel restyle and re-measure**, which is the honest
   * price of an event that names nothing. A change whose rules all start
   * from classes names what it styles, and goes to `classRulesChanged`
   * instead. Fine for a theme swap or a state-driven rule; expensive for a
   * value animated at frame rate. Animate through an inline `style` instead
   * — that is a mutation on the element that moved, and it is scoped to it.
   *
   * A rule may also transform something above the panel's root, which is
   * the one place the portal hears about that, so every frame reads its
   * chain again too.
   *
   * @returns {void}
   */
  documentStylesChanged() {
    invalidatePanelFrames();
    this.#everythingChanged();
  }

  /**
   * The document's stylesheets changed, and every rule that changed starts
   * from one of `classes` (see `scopeOfSheet` in `documentStyles.js`). Such
   * a rule matches only an element wearing the class, its subtree, and what
   * comes after it among its siblings. So a panel the classes cannot reach
   * restyles nothing, and one they can reach restyles and re-measures
   * everything, as `documentStylesChanged` does. That is the usual case for
   * a sheet a styling library writes as the elements it dresses arrive, such
   * as a keyboard's when the keyboard opens: the keyboard's panel pays, and
   * the others do not.
   *
   * The classes reach the panel from an element wearing one inside it, the
   * root included; from above the root, passing what the rule says down to
   * all of it; and from before the root or one of its ancestors among their
   * siblings, through a rule's `~` or `+`.
   *
   * A panel that is reached restyles as a whole rather than only its
   * wearers, because the wearers are usually being adopted as their sheet
   * arrives, and restyling only them, as a change to their `class` would,
   * left a panel's construction picker with options the ray passed through.
   *
   * @param {Element} root The panel's root.
   * @param {ReadonlySet<string>} classes Names `leadingClass` read, which
   *   need no escaping in a selector.
   * @returns {void}
   */
  classRulesChanged(root, classes) {
    if (classes.size === 0) {
      return;
    }
    const wears = (/** @type {Element} */ element) =>
      [...classes].some((name) => element.classList.contains(name));
    let reaches = root.querySelector([...classes].map((name) => `.${name}`).join(", ")) !== null;
    for (
      let current = /** @type {Element | null} */ (root);
      current && !reaches;
      current = current.parentElement
    ) {
      reaches = wears(current);
      for (
        let before = current.previousElementSibling;
        before && !reaches;
        before = before.previousElementSibling
      ) {
        reaches = wears(before);
      }
    }
    if (reaches) {
      this.documentStylesChanged();
    }
  }

  /**
   * Everything restyles and everything re-measures, walls or no walls.
   *
   * @returns {void}
   */
  #everythingChanged() {
    batch(() => {
      bump(this.restyle);
      bump(this.layout);
      bump(this.globalLayout);
    });
  }

  /**
   * Images arrived: an `<img>` given no size of its own takes the one the
   * picture turned out to have, and everything after it in the flow moves.
   * A layout event, not a style one — and one that starts at the pictures
   * themselves, so it reaches out of them exactly as far as any other
   * layout change does.
   *
   * @param {Iterable<Node>} [elements] The images that landed. Omitted, the
   *   announcement is portal-wide, which is what a caller that did not keep
   *   track has to settle for.
   * @returns {void}
   */
  contentLoaded(elements) {
    batch(() => {
      if (!elements) {
        bump(this.layout);
        bump(this.globalLayout);
        return;
      }
      for (const element of elements) {
        // What changed is the picture's own box, which is a change in the
        // layout of the element it sits in — the same thing a row growing is
        // to the list around it, and it moves the same neighbours.
        if (element.parentElement) {
          this.#layoutChangedAt(element.parentElement, element);
        }
      }
    });
  }

  /**
   * The layout inside `container` changed: a child arrived or left, a text
   * node was rewritten, a picture turned out to have a size, an attribute
   * changed a child.
   *
   * @param {Element} container
   * @param {Node | null} from The earliest child the change could have
   *   disturbed, or null for "assume the first".
   * @returns {void}
   */
  #layoutChangedAt(container, from) {
    if (this.#pendingLayout) {
      const pending = this.#pendingLayout;
      if (!pending.has(container)) {
        pending.set(container, from);
      } else {
        pending.set(container, earlierOf(pending.get(container) ?? null, from));
      }
      return;
    }
    this.#settleLayout(new Map([[container, from]]));
  }

  /**
   * Work out whose boxes each change could have disturbed, and tell exactly
   * those.
   *
   * The walk rests on one property, which the mirror gets from storing every
   * measurement relative to its parent: **a box's interior is a function of
   * its own content box and its own subtree.** CSS lays a box out from the
   * space it was given; nothing outside reaches in except by changing that
   * space. So a change inside a container can disturb the container's own
   * children — they moved, or were given different room — and, if it changed
   * the container's size, whatever the container sits among. Nothing else.
   *
   * That is the same argument `overflow: hidden` used to be asked to supply,
   * and it never needed the overflow: a block formatting context is not what
   * makes a box's interior its own business. So the climb applies it at every
   * level. From the container, each level has its children told and then is
   * asked whether it kept its own size; the first one that did ends the
   * climb, because a box that did not move cannot have moved anything it
   * sits among. An inline box is the exception (`splitsAcrossLines`): it is
   * not one box but its fragments on each line, and a prompt as wide as its
   * widest line keeps that width while the caret after it moves on with every
   * key. So the climb goes on past it to the box the lines are in. A list of
   * a fixed height can have rows added to it all day without the panel around
   * it hearing a word — and so can a list that merely happens not to have
   * changed height, which is the case the overflow test could not see.
   *
   * What the children hear is `moved`, and what they do with it is the other
   * half: they re-measure, and — being plain values behind equality gates —
   * the ones that came out where they already were stop there, taking their
   * whole subtrees with them. A row that did not move does not re-measure its
   * label, and re-measuring a label is the most expensive read in this file.
   *
   * The sizes are read here rather than derived, because the answer is needed
   * *while deciding what to invalidate* — before any of the reactive graph
   * has run. It is one rect per level of the climb, and it is not an extra
   * layout: whatever re-reads next would have forced the same one moments
   * later.
   *
   * An element whose size is not known yet, or whose stored size has drifted
   * — a font arriving resizes it without coming through here — simply reads
   * as changed and the news travels further. Wrong in the direction of doing
   * too much, which is the only direction that is safe.
   *
   * The second saving is *which* children hear it. Where the container lays
   * its children out in document order from a fixed start edge — see
   * `getFlowMode` — a change at one child cannot have moved the children
   * before it, so the news starts there and runs to the end. That is
   * what makes appending to a list cost the same whether the list has ten
   * rows or a thousand: the arriving row is the last child, and there is
   * nothing after it to tell. Prepending still costs the whole list, which is
   * right — everything in it moved. A flex row does not keep the claim: an
   * item that grows can shrink and move the items before it. So an attribute
   * change there names no child and the whole row hears it; a child-list or
   * text change in one does not yet (see `FlowMode`).
   *
   * @param {Map<Element, Node | null>} containers
   * @returns {void}
   */
  #settleLayout(containers) {
    batch(() => {
      // A flush that appended fifty rows names one container fifty times, and
      // fifty climbs from the same place would ask the same questions and —
      // `resized` keeping a ledger — get different answers after the first.
      // One visit each, and a climb that reaches a level someone else has
      // already settled stops there, its own answer having been decided.
      //
      // Its *size* answer, that is — not which children it owes. Each level
      // remembers the earliest child it told, and a later arrival with an
      // earlier one tells the difference before stopping. Without that, a
      // level first reached by a climb from further down ("from row 3") and
      // then named directly by its own change ("from row 1") dropped the
      // second entry whole, and rows 1 and 2 were never told.
      /** @type {Map<Element, Node | null>} */
      const settled = new Map();
      for (const [container, disturbed] of containers) {
        let from = disturbed;
        for (
          let current = /** @type {Element | null} */ (container);
          current;
          current = current.parentElement
        ) {
          if (settled.has(current)) {
            const told = /** @type {Node | null} */ (settled.get(current));
            const earlier = earlierOf(told, from);
            if (earlier !== told) {
              settled.set(current, earlier);
              this.#childrenMoved(current, earlier);
            }
            break;
          }
          settled.set(current, from);
          this.#childrenMoved(current, from);
          if (isPortalRoot(current)) {
            // The top of what this portal mirrors. Nothing above is projected
            // and there is nobody to tell, but the panel's own size follows
            // its contents and the scene has to hear about that.
            const record = recordOf(current);
            if (record) {
              bump(record.moved);
            }
            break;
          }
          if (!splitsAcrossLines(current) && !resized(current)) {
            break;
          }
          // Climbing one level, the box that changed is the one we came from,
          // and it is that box's neighbours who are next to hear.
          from = current;
        }
      }
      // Boxes that hang off a containing block rather than off their parent
      // are not on any of those chains. See `outOfFlowLayout`.
      bump(this.outOfFlowLayout);
    });
  }

  /**
   * Say that the children of `element` from `from` onward may have moved or
   * been given a different amount of room.
   *
   * Everything is read off the live DOM rather than through `getChildNodes`,
   * because this runs while the invalidation is being routed, before the
   * graph the cached reads belong to has run.
   *
   * `from` is a hint the container has to be able to honour: it is only obeyed
   * where the children are laid out in document order from a fixed start
   * edge, and a `from` that is no longer a child of the element — the node
   * that named it having been removed by a later record in the same flush —
   * is no hint at all. Either way the fallback is the whole list, which is
   * what this always did. A flex row obeys the hint although an item that
   * grows can shrink and move the items before it, which leaves them stale
   * after a child-list or text change (see `FlowMode`).
   *
   * @param {Element} element
   * @param {Node | null} from
   * @returns {void}
   */
  #childrenMoved(element, from) {
    const start =
      from && from.parentNode === element && getFlowMode(element) !== "none"
        ? from
        : element.firstChild;
    for (let child = start; child; child = child.nextSibling) {
      const record = recordOf(child);
      if (record) {
        probeRipple(child);
        bump(record.moved);
      }
    }
  }

  /**
   * @param {Node} node
   * @param {object} [options]
   * @param {boolean} [options.reachesSiblings] Whether the change could
   *   restyle `node`'s siblings as well as its own subtree. True by
   *   default: an author's mutation can change which rules match across
   *   `~`, `+` and the structural pseudo-classes, and those reach exactly
   *   that far. False for the changes that cannot move a selector's
   *   verdict on a sibling: an animation (`animatedStyles`), an attribute
   *   no sibling rule of the document names (`reachesSibling`), and the
   *   ones declared not to by contract (`isSelfScoped`), whose sibling
   *   rules are not followed. That is what keeps hovering one row in a
   *   long list off every other row in it, and moving one shape of a
   *   drawing off every other shape in it.
   * @returns {void}
   */
  #restyleScope(node, { reachesSiblings = true } = {}) {
    const record = recordOf(node);
    if (record) {
      bump(record.self);
    }
    if (!reachesSiblings) {
      return;
    }
    const parent = node.parentNode;
    const parentRecord = parent ? recordOf(parent) : undefined;
    if (parentRecord) {
      bump(parentRecord.members);
    }
  }
}

/**
 * The earliest child of a childList record's target that the record could
 * have disturbed, or null when there is no telling.
 *
 * A record names the sibling the change happened *after*, which survives the
 * change and is exactly what is wanted: whatever now follows it is the first
 * box that could have moved. Nodes added or removed at the very start have no
 * such sibling, and then the first child is the answer — which is to say the
 * whole list.
 *
 * The one case with no answer is a previous sibling that has itself left the
 * tree, a later record in the same flush having removed it. Its old position
 * is unrecoverable, so the whole list it is.
 *
 * @param {MutationRecord} mutation
 * @returns {Node | null}
 */
function firstDisturbedChild(mutation) {
  const previous = mutation.previousSibling;
  if (!previous) {
    return mutation.target.firstChild;
  }
  return previous.parentNode === mutation.target ? previous.nextSibling : null;
}

/**
 * What a childList record says about where the change happened, for the
 * restyle's benefit. The layout hint above answers "who moved"; a restyle
 * also needs to know who stayed put just before the change, and what kind
 * of thing came or went.
 *
 * @typedef {object} ChildListHint
 * @property {Node | null} [previous] The surviving child the change
 *   happened after — the sibling that was last before an append, or that
 *   now precedes the gap a removal left. Null for a change at the start, or
 *   when there is no telling.
 * @property {Iterable<string> | null} [kinds] The `nodeName`s of the
 *   elements added and removed, or null when unknown.
 * @property {boolean} [kept] Whether the list kept a node that counts
 *   toward `:empty` through the whole flush; see `keptThrough`. False when
 *   unknown, which leaves `:empty` free to have flipped.
 */

/**
 * For each list a flush's child-list records name, whether the list holds,
 * once the flush is over, a node that counts toward `:empty` and that no
 * record of the flush added to it. Such a node was in the list before the
 * flush too: it could not have left and come back without a record adding
 * it. So the list was empty neither before the flush nor after it, and
 * `:empty` held, whatever happened in between.
 *
 * Asked per record, of the record's own neighbours, the question would be
 * blind to a comment: a list whose rows end in a framework's comment anchor
 * takes every append after the comment, and the comment says nothing about
 * the rows before it. Asked of the whole list, the first node that counts
 * usually answers it, and a list whose every node is new this flush is one
 * being built, where the wide restyle is right anyway.
 *
 * A text node's data changing is not followed: a text node emptied or
 * filled in the same flush is judged by the data it has now.
 *
 * @param {MutationRecord[]} mutationList
 * @returns {(list: Node) => boolean}
 */
function keptThrough(mutationList) {
  /** @type {Map<Node, Set<Node>>} */
  const arrivals = new Map();
  for (const mutation of mutationList) {
    if (mutation.type !== "childList") {
      continue;
    }
    let arrived = arrivals.get(mutation.target);
    if (!arrived) {
      arrived = new Set();
      arrivals.set(mutation.target, arrived);
    }
    mutation.addedNodes.forEach((node) => arrived.add(node));
  }
  /** @type {Map<Node, boolean>} */
  const answers = new Map();
  return (list) => {
    let answer = answers.get(list);
    if (answer === undefined) {
      const arrived = arrivals.get(list);
      answer = false;
      for (let child = list.firstChild; child && !answer; child = child.nextSibling) {
        answer = countsForEmpty(child) && !arrived?.has(child);
      }
      answers.set(list, answer);
    }
    return answer;
  };
}

/**
 * Whether `node` makes its parent fail `:empty`: an element, or a text node
 * with any data, whitespace included. Comments and processing instructions
 * do not count.
 *
 * @param {Node} node
 * @returns {boolean}
 */
function countsForEmpty(node) {
  if (node.nodeType === Node.ELEMENT_NODE) {
    return true;
  }
  return node.nodeType === Node.TEXT_NODE && /** @type {Text} */ (node).length > 0;
}

/**
 * @param {MutationRecord} mutation
 * @param {boolean} kept See `ChildListHint`.
 * @returns {ChildListHint}
 */
function childListHint(mutation, kept) {
  const previous = mutation.previousSibling;
  /** @type {Set<string>} */
  const kinds = new Set();
  for (const nodes of [mutation.addedNodes, mutation.removedNodes]) {
    nodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        kinds.add(node.nodeName);
      }
    });
  }
  return {
    previous: previous && previous.parentNode === mutation.target ? previous : null,
    kinds,
    kept,
  };
}

/**
 * Whichever of two disturbed-child hints is the earlier, `null` — "no idea,
 * assume the first" — beating both.
 *
 * Both hints are assumed to be current children of the one container they
 * were named for, which is what makes document order the right question.
 * Every caller today keeps that true: `firstDisturbedChild` reads the child
 * off the live tree (or answers `null` when the sibling it would start from
 * has left), and the character-data and image paths pass a node with the
 * parent it has *now*. The observer delivers its records after the DOM has
 * reached its final shape, and the settle runs in the same synchronous
 * ingest, so nothing can move a hint between naming it and comparing it.
 *
 * That assumption is not checked, and it is the one thing to check before
 * adding a caller that names a child it did not just read off the tree —
 * a node remembered from an earlier flush, say, or one found by a walk over
 * geometry rather than over the DOM. A hint that has since been removed or
 * moved would still compare, and `compareDocumentPosition` between a
 * disconnected node and a connected one is implementation-specific: the
 * container could keep the *later* hint and never tell the rows the earlier
 * one stood for. `#childrenMoved` guards its own end by treating a `from`
 * that is not a child of the element as the whole list; the matching guard
 * here is to answer `null` when `a.parentNode !== b.parentNode` (or when
 * either has no parent at all), so the container assumes the first child.
 * Left out for now because no path can reach it, and a guard nothing can
 * exercise is a guard nothing can keep honest.
 *
 * @param {Node | null} a
 * @param {Node | null} b
 * @returns {Node | null}
 */
function earlierOf(a, b) {
  if (!a || !b) {
    return null;
  }
  if (a === b) {
    return a;
  }
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? b : a;
}

/**
 * @returns {DomMirror}
 */
export function createMirror() {
  return new DomMirror();
}

/** @type {WeakMap<HTMLInputElement, Derived<boolean>>} */
const checkedCache = nodeCache();

/**
 * The assignments to each checkbox's `checked`, one source per element
 * however many readers follow it. Not a `nodeCache()`, and on purpose: it
 * holds no signal of any mirror's, only what the element's own accessor
 * announces, so a release has nothing in it to forget. Kept for the
 * element's life, which is what lets a reader built before a release and
 * one built after it share the one accessor (see `checkedAssignments`).
 *
 * @type {WeakMap<HTMLInputElement, Subscribable<void>>}
 */
// Not a nodeCache: the element's own accessor's, see above.
const assignmentSources = new WeakMap();

/**
 * Every assignment to the element's `checked` that moved it, for as long as
 * something listens. The first listener installs an own accessor that calls
 * through to the browser's and then says so (`shadowAccessor`), the last
 * one to leave takes it off again, and every listener between shares it
 * (`holdShared`), as `trackValue` holds a field's `value`: a reader that
 * installed its own accessor over another's would leave the first deaf, and
 * one that took the accessor away would leave the rest deaf. An element
 * that already carries an own `checked`, an app's or a library's, is left
 * with it and followed through `change` alone.
 *
 * @param {HTMLInputElement} element
 * @returns {Subscribable<void>}
 */
function checkedAssignments(element) {
  let source = assignmentSources.get(element);
  if (!source) {
    /** @type {Subject<void>} */
    const assigned = new Subject();
    const install = () =>
      shadowAccessor(
        element,
        "checked",
        /**
         * @param {boolean} value
         * @param {(value: boolean) => void} write
         * @param {() => boolean} read
         */
        (value, write, read) => {
          const before = read();
          write(value);
          if (read() !== before) {
            assigned.next();
          }
        },
      ) ?? (() => {});
    source = {
      subscribe(observer) {
        const release = holdShared(element, "checked", install);
        const subscription = assigned.subscribe(observer);
        return {
          unsubscribe() {
            subscription.unsubscribe();
            release();
          },
        };
      },
    };
    assignmentSources.set(element, source);
  }
  return source;
}

/**
 * Whether a checkbox is ticked, as something the scene can be drawn from.
 *
 * This is the one piece of state here that a MutationObserver cannot report.
 * Ticking a box touches no attribute — the `checked` attribute says what the
 * box starts out as, not what it is now — and code that assigns
 * `input.checked = …` moves a property, which mutates nothing whatsoever. So
 * the two ways it can move are watched one each: `change`, which the browser
 * fires for the user's own toggles and for the synthetic click a ray sends,
 * and the property itself, instrumented so that an assignment announces
 * itself the way an attribute mutation would (`checkedAssignments`).
 *
 * The instrumentation is an own accessor that delegates to the one it shadows,
 * so the element goes on behaving exactly as it did — including for anything
 * else holding a reference to it. It is on the element while something reads
 * this, and taken off once nothing does, so a page that mirrored a box and
 * ended its session is left with the box as it was.
 *
 * @param {HTMLInputElement} element
 * @returns {boolean}
 */
export function getCheckedCached(element) {
  let signal = checkedCache.get(element);
  if (!signal) {
    // Two edges rather than one `merge` of them: a dependency is anything with
    // a `subscribe`, and a node reading both is told by either. Both are built
    // outside the derivation so that each evaluation reads the *same*
    // dependency and keeps the edge it already has, rather than making a fresh
    // one to attach and dropping the old.
    const changed = fromEvent(element, "change");
    const assigned = checkedAssignments(element);
    signal = probedRead(element, () => {
      addDependency(changed);
      addDependency(assigned);
      return element.checked;
    });
    checkedCache.set(element, signal);
  }
  return signal.get();
}

/**
 * The text nodes whose character boundaries are measured along with their
 * line boxes.
 *
 * A weak set and not a flag on the layout for the same reason the layout is
 * cached per node: the mirror never owns the nodes it measures. It is asked
 * before the measurement rather than after, so a node has to say so before it
 * is first laid out — which is what `reveal.text` does, at the moment it
 * creates the node.
 *
 * @type {WeakSet<Text>}
 */
const characterEdgeNodes = new WeakSet();

/**
 * Measure this text node's character boundaries from now on.
 *
 * @param {Text} text
 * @returns {() => void} Stop measuring them.
 */
export function trackCharacterEdges(text) {
  characterEdgeNodes.add(text);
  return () => {
    characterEdgeNodes.delete(text);
  };
}

/**
 * @param {Text} text
 * @returns {boolean}
 */
export function tracksCharacterEdges(text) {
  return characterEdgeNodes.has(text);
}

/** @type {WeakMap<HTMLElement, Derived<string>>} */
const whiteSpaceCache = nodeCache();

/**
 * The computed `white-space` that applies to text inside `element`, behind
 * its own equality gate: text measurement is the most expensive read in this
 * file, and a hover restyle that did not change how whitespace collapses
 * must not re-run it.
 *
 * @param {HTMLElement} element
 * @returns {string}
 */
function getWhiteSpace(element) {
  let signal = whiteSpaceCache.get(element);
  if (!signal) {
    signal = probedRead(element, () => {
      return getComputedStyleCached(element).whiteSpace || "normal";
    });
    whiteSpaceCache.set(element, signal);
  }
  return signal.get();
}

/**
 * Read back the line boxes the browser laid a text node out into, along with
 * the text that landed on each one.
 *
 * Under a transform anywhere on the chain, the real tree's client rects are
 * screen-space bounds — a rotation would group lines by screen rows, which
 * is not where the browser broke them — so the measurement runs against a
 * detached untransformed copy instead.
 *
 * The copy is of the box the text's lines are laid out in: the parent, or
 * the nearest ancestor that does not split across lines
 * (`splitsAcrossLines`), since a box that does has no width of its own for
 * the lines to break against. The climb stops at the panel's root, whatever
 * its `display`. One copy of a box serves every text measured in it, for as
 * long as `getLineBoxCopy` keeps it. The copy is never scrolled, so what it
 * reports is already the content-space position the live path computes.
 *
 * @param {Text} text
 * @returns {TextLayout}
 */
function measureTextLayout(text) {
  const parentElement = text.parentElement;
  if (!parentElement) {
    throw new NoValueError("Text node has no parent element");
  }
  const whiteSpace = getWhiteSpace(parentElement);
  // Asked of the live node, always: under a transform the measurement runs
  // against a clone, and the clone is not the node anybody registered.
  const revealed = characterEdgeNodes.has(text);
  if (!isTransformed(parentElement)) {
    return measureTextRects(text, parentElement, whiteSpace, true, revealed);
  }
  let lineBox = parentElement;
  while (!isPortalRoot(lineBox) && lineBox.parentElement && splitsAcrossLines(lineBox)) {
    lineBox = lineBox.parentElement;
  }
  const cloneText = findInCopy(getLineBoxCopy(lineBox), lineBox, text);
  const cloneParent = /** @type {HTMLElement} */ (cloneText.parentElement);
  return measureTextRects(cloneText, cloneParent, whiteSpace, false, revealed);
}

/**
 * The node at the same place under `to` as `node` is under `from`, which a
 * deep clone keeps, or nothing when `to` has no node there: a copy made
 * before the change that put `node` where it is.
 *
 * @param {Node} node
 * @param {Node} from An ancestor of `node`.
 * @param {Node} to
 * @returns {Node | undefined}
 */
export function counterpart(node, from, to) {
  /** @type {number[]} */
  const path = [];
  for (let current = node; current !== from; current = /** @type {Node} */ (current.parentNode)) {
    path.unshift(Array.prototype.indexOf.call(current.parentNode?.childNodes ?? [], current));
  }
  return path.reduce(
    (/** @type {Node | undefined} */ current, index) => current?.childNodes[index],
    to,
  );
}

/**
 * The copy of `text` in `copy`, a copy of `lineBox`: the node at the same
 * place under it (`counterpart`).
 *
 * Found by place rather than kept by identity, because the copy follows the
 * box's shape, not its nodes: a text replaced by one with the same
 * characters, as setting `textContent` to what it was does, leaves the shape
 * and the copy as they were, and the new node is still the node at that
 * place.
 *
 * The copy can also lack the text for a moment. A text inserted into an
 * element the portal has not adopted yet reaches the shape only once the
 * adoption is announced, a microtask after the portal builds the text and
 * may measure it (see `announceAdoption`). Until then the place holds
 * something else or nothing, and the measurement waits, as a read that has
 * no value yet does.
 *
 * @param {HTMLElement} copy
 * @param {HTMLElement} lineBox An ancestor of `text`.
 * @param {Text} text
 * @returns {Text}
 */
function findInCopy(copy, lineBox, text) {
  const found = counterpart(text, lineBox, copy);
  if (!(found instanceof Text) || found.data !== text.data) {
    throw new NoValueError("The line box copy does not hold this text yet");
  }
  return found;
}

/** @type {WeakMap<HTMLElement, Derived<HTMLElement>>} */
const lineBoxCopyCache = nodeCache();

/**
 * The copy of `lineBox` the texts laid out in its lines are measured in under
 * a transform. One copy serves them all, because measuring each of the `n`
 * texts of a paragraph in a copy of its own copies the paragraph `n` times,
 * and a browser lays out each copy (`bench/lineBoxCopy.bench.mjs`). Its
 * rules are the rules of a cached read:
 *
 * - **Made** when the first text in the box is measured, and parked in the
 *   body as `createMeasurementClone` parks one.
 * - **Shared** by every text measured in the box while it lasts, whichever
 *   task or frame measures it: a portal measures a panel a frame budget at a
 *   time.
 * - **Rebuilt** when what it was copied from changes: the box's shape
 *   (`getLineBoxShape`), what can restyle it from above
 *   (`readRestyledFromAbove`), or its size. Between them they cover a
 *   stylesheet, a font, the viewport and an ancestor's attributes, and
 *   nothing a text in the box would not be re-measured for: a box moved by
 *   its siblings, or out of flow and so told of every layout in the panel,
 *   keeps its copy.
 *   The portal's presentational flags, hover and press, change none of them
 *   (`PRESENTATIONAL_ATTRIBUTES`), just as they re-measure no text. Nor does
 *   a text replaced by one with the same characters: `findInCopy` finds it
 *   by its place. A font that finished loading does rebuild it, through the
 *   layout epochs `readRestyledFromAbove` reads, as it re-measures every
 *   text.
 * - **Removed** when it is rebuilt, and when the last text reading it lets
 *   go of it.
 *
 * While it stands it is in the page, a child of the body, with the box's
 * attributes, its `id` and `name` among them, so a query the page makes
 * finds it beside the box. It is marked `inert` and `aria-hidden`, as every
 * measurement clone is (`parkMeasurementClone`), which keeps it out of focus
 * and the accessibility tree, not out of the page's own queries. They are
 * the marks the portal's container carries, so a stylesheet rule keyed on
 * an `[inert]` or `[aria-hidden]` ancestor matches inside the copy as it
 * matches inside the box. Without them the copy would differ from the box
 * there. Where they do differ is a rule that needs the mark on the box
 * itself, which nothing in the box carries. `p[inert]` matches the copy's
 * root, whose resolved style is inline and wins over any rule that is not
 * `!important`. `p[inert] .chip` also matches inside it, and restyles what
 * is inside an element laid out in a box of its own, where only classes
 * are kept.
 *
 * A reader that is not itself read by anything, as a test may be, builds the
 * copy afresh on every read, and the build it leaves stays parked until the
 * next read of the same box removes it: after the last one, for good. Every
 * reader in the mirror is read by an effect.
 *
 * @param {HTMLElement} lineBox
 * @returns {HTMLElement} The copy, parked.
 */
function getLineBoxCopy(lineBox) {
  let signal = lineBoxCopyCache.get(lineBox);
  if (!signal) {
    signal = nodeDerived(lineBox, () => {
      getLineBoxShape(lineBox);
      readRestyledFromAbove(lineBox);
      getBorderBoxSize(lineBox);
      const copy = /** @type {HTMLElement} */ (lineBox.cloneNode(true));
      dressLaidOut(lineBox, copy);
      const root = parkMeasurementClone(lineBox, copy, null);
      onCleanup(() => root.remove());
      return root;
    });
    lineBoxCopyCache.set(lineBox, signal);
  }
  return signal.get();
}

/**
 * Depend on what can restyle `lineBox`, or what is in it, from above: its
 * own `reflow` signal and its ancestors' up to the panel's root, which an
 * attribute change bumps unless it is presentational or only moves an SVG
 * element's frame (`movesOnlyItsFrame`), and the portal-wide
 * epochs a stylesheet, a font and the viewport bump.
 *
 * A narrower read than `getReflowContext(lineBox)`, which also follows the
 * box's `moved` signal and, for a box out of flow, every settling in the
 * panel. Both say where the box is, not what is in it, and its texts are
 * measured relative to it.
 *
 * @param {HTMLElement} lineBox
 * @returns {void}
 */
function readRestyledFromAbove(lineBox) {
  const record = readRecordOf(lineBox);
  if (record) {
    record.mirror.layout.get();
    record.mirror.globalLayout.get();
  }
  for (
    let current = /** @type {Node | null} */ (lineBox);
    current;
    current = getParentElement(current)
  ) {
    readRecordOf(current)?.reflow.get();
    if (isPortalRoot(current)) {
      break;
    }
  }
}

/** @type {WeakMap<HTMLElement, Derived<string>>} */
const lineBoxShapeCache = nodeCache();

/**
 * What a copy of `lineBox` is made of, as one string: the elements and texts
 * in it, in order, with the characters of every text and the attributes of
 * every element, the portal's presentational and bookkeeping ones aside.
 *
 * The string is the copy's equality gate. Reading the box node by node
 * depends on each node's adoption as well as on its content, and a portal
 * adopts a panel a node at a time, frame after frame: built straight from
 * those reads, the copy was rebuilt for every node adopted while it was
 * mounting. Compared as a string, an adoption reads the box again for the
 * same answer and stops there. The presentational attributes are left out
 * so that the answer is the same when a hover flag happens to be set on
 * something in the box at the time; a hover alone reads nothing here.
 *
 * @param {HTMLElement} lineBox
 * @returns {string}
 */
function getLineBoxShape(lineBox) {
  let signal = lineBoxShapeCache.get(lineBox);
  if (!signal) {
    signal = probedRead(lineBox, () => {
      /** @type {string[]} */
      const parts = [];
      describeShape(lineBox, parts);
      return parts.join("");
    });
    lineBoxShapeCache.set(lineBox, signal);
  }
  return signal.get();
}

/**
 * Append `node`'s children to the description `getLineBoxShape` builds,
 * depending on each: on the child list, on a text's characters, and on an
 * element's own reflow signal, which a change to one of its attributes bumps
 * unless the portal declares the attribute presentational or the change only
 * moves an SVG element's frame (`movesOnlyItsFrame`), and which waits
 * for the element's adoption when it has no record yet. The box's own, its
 * ancestors' and the portal-wide ones reach the copy through
 * `readRestyledFromAbove`. Every length is written before what it measures,
 * so that no text can pass for markup. Any other node, a comment a
 * framework anchors to most of all, is written as a marker: `counterpart`
 * counts it on the way to a text, so the description has to count it too.
 *
 * @param {Node} node
 * @param {string[]} parts
 * @returns {void}
 */
function describeShape(node, parts) {
  for (const child of getChildNodes(node)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const data = getTextDataCached(/** @type {Text} */ (child));
      parts.push(`#${data.length}:${data}`);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const element = /** @type {Element} */ (child);
      readRecordOf(element)?.reflow.get();
      parts.push(`<${element.localName}`);
      for (const { name, value } of element.attributes) {
        if (!PRESENTATIONAL_ATTRIBUTES.has(name) && !PORTAL_BOOKKEEPING_ATTRIBUTES.has(name)) {
          parts.push(` ${name}=${value.length}:${value}`);
        }
      }
      parts.push(">");
      describeShape(element, parts);
      parts.push("</>");
    } else {
      parts.push("<!>");
    }
  }
}

/**
 * Walk `live` and its copy side by side, and dress each element whose
 * content is laid out in the line box's lines.
 *
 * The box and every element whose content is laid out in its lines (one that
 * splits across lines, inside others that do) keep their resolved style,
 * with their transforms, transitions and animations off, so a selector that
 * reaches above the box still sizes them, and which text was measured first
 * does not change what the others are measured against.
 *
 * An element laid out in a box of its own keeps its resolved style too,
 * since its `display`, its size and its margins decide where the line's
 * texts break. A `<small>` that `.stub small` makes a block ends the line
 * in the box; restyled by its classes alone it would be inline again, and
 * its words would join the line. What is inside it is not dressed. It is
 * copied as `createMeasurementClone` copies descendants, with its classes
 * only, and its resolved width and height hold its size, and so where the
 * line's texts break. They do not hold an `inline-block`'s baseline, which
 * a restyle inside it can still move.
 *
 * Nothing here is a dependency. The copy depends on what `getLineBoxCopy`
 * reads, and `display` is read straight from the computed style: through
 * `splitsAcrossLines` every element's style would be one, and a hover flag
 * restyles the element it lands on.
 *
 * @param {Node} live The line box, or an element whose content is laid out
 *   in its lines.
 * @param {Node} copy `live.cloneNode(true)`, or a part of one.
 * @returns {void}
 */
function dressLaidOut(live, copy) {
  for (
    let child = live.firstChild, childCopy = copy.firstChild;
    child && childCopy;
    child = child.nextSibling, childCopy = childCopy.nextSibling
  ) {
    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    const element = /** @type {HTMLElement} */ (child);
    const computed = window.getComputedStyle(element);
    copyStillStyle(element, /** @type {HTMLElement} */ (childCopy), computed);
    if (displaySplitsAcrossLines(element, computed.display)) {
      dressLaidOut(element, childCopy);
    }
  }
}

/**
 * Where an element's `::before` or `::after` is laid out, and its text.
 *
 * @typedef {object} GeneratedLayout
 * @property {number} x The left of the generated box's border box, in the
 *   element's border-box frame and before any scroll: the frame a box's
 *   content is drawn in, less the scroll the caller takes off.
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {TextLayout | null} text The generated text, placed relative to
 *   the generated box's border box (`left`, `top`), or null for a box with
 *   no text.
 * @property {ClientBox | null} picture Where the `content: url()` picture is
 *   laid out, relative to the generated box's border box: inline, on the
 *   baseline of the line it is on, not at the content box's corner. Null
 *   for a box with no picture.
 */

/**
 * @typedef {object} ClientBox
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * Measure an element's `::before` or `::after`, which has no client rect of
 * its own, by laying it out as a real element: a span dressed in the
 * pseudo-element's resolved style, first or last among the children of a
 * copy of the element, with the generated text in it, or a picture of
 * `picture`'s size for a `content: url()`. The copy's own generated boxes
 * are switched off while it stands (`withGeneratedCopyRule`). The span's
 * place in the copy is the box's place in the element.
 *
 * The copy is of the box the element is laid out in, as a text's line box
 * copy is (`measureTextLayout`): the element itself, or, for an element
 * that splits across lines, the nearest ancestor that does not. An inline
 * element copied on its own would be parked as an absolutely positioned
 * box, which makes it a block, and its line would be laid out anew: a
 * `::before` on a link in a paragraph would land some pixels off the line
 * the link is on.
 *
 * The element's copy is the containing block of whatever is absolutely
 * positioned in it only when the element is positioned, so a positioned
 * pseudo-element is placed right only when the element is its containing
 * block on the page too; the caller asks that.
 *
 * It depends on what a line box copy does (`getLineBoxCopy`) for the box it
 * copies: its shape, what restyles it from above, and its size; and on the
 * element's size. The copy is taken down before this returns.
 *
 * @param {HTMLElement} element
 * @param {"before" | "after"} kind
 * @param {string} declarations The pseudo-element's style
 *   (`describeStillStyle`).
 * @param {string} text
 * @param {{ width: number, height: number } | null} picture
 * @returns {GeneratedLayout}
 */
export function measureGeneratedBox(element, kind, declarations, text, picture) {
  let lineBox = element;
  while (!isPortalRoot(lineBox) && lineBox.parentElement && splitsAcrossLines(lineBox)) {
    lineBox = lineBox.parentElement;
  }
  getLineBoxShape(lineBox);
  readRestyledFromAbove(lineBox);
  getBorderBoxSize(lineBox);
  getBorderBoxSize(element);
  const copy = /** @type {HTMLElement} */ (lineBox.cloneNode(true));
  dressLaidOut(lineBox, copy);
  const host = lineBox === element ? copy : counterpart(element, lineBox, copy);
  if (!(host instanceof HTMLElement)) {
    throw new NoValueError("The copy does not hold the element yet");
  }
  host.setAttribute(GENERATED_COPY_ATTRIBUTE, "");
  const stand = document.createElement("span");
  // A `content` on an element, not a pseudo-element, would make the span a
  // picture of its own in Chromium.
  stand.style.cssText = `${declarations}; content: normal`;
  /** @type {HTMLImageElement | null} */
  let image = null;
  if (picture) {
    image = document.createElement("img");
    image.width = picture.width;
    image.height = picture.height;
    stand.append(image);
  } else if (text) {
    stand.append(text);
  }
  if (kind === "before") {
    host.prepend(stand);
  } else {
    host.append(stand);
  }
  return withGeneratedCopyRule(() => {
    const root = parkMeasurementClone(lineBox, copy, null);
    try {
      const frame = frameFor(root);
      const origin = measureClientRect(host, frame);
      const rect = measureClientRect(stand, frame);
      const content = stand.firstChild;
      const placed = image ? measureClientRect(image, frame) : null;
      return {
        x: rect.left - origin.left,
        y: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
        text:
          content instanceof Text
            ? measureTextRects(content, stand, stand.style.whiteSpace || "normal", false, false)
            : null,
        picture: placed && {
          x: placed.left - rect.left,
          y: placed.top - rect.top,
          width: placed.width,
          height: placed.height,
        },
      };
    } finally {
      root.remove();
    }
  });
}

/** @type {WeakMap<Text, Derived<TextLayout>>} */
const textLayoutCache = nodeCache();

/**
 * @param {Text} text
 * @returns {TextLayout}
 */
export function getTextLayout(text) {
  let signal = textLayoutCache.get(text);
  if (!signal) {
    signal = probedRead(text, () => {
      const record = readRecordOf(text);
      if (record) {
        record.character.get();
      }
      // The reflow chain, not the style chain: what re-breaks lines is the
      // text changing, layout happening, or a transform toggling somewhere
      // above — never a scroll, whose absence from the chain is the whole
      // cost model of a long list. Style enters only through `getWhiteSpace`
      // inside the measurement, behind its own equality gate.
      getReflowContext(text);
      // And the box the lines are broken into: the widest thing a label
      // depends on, and the reason a row that did not resize does not pay
      // for a Range measurement when the panel around it changes.
      readParentBox(text);
      return measureTextLayout(text);
    });
    textLayoutCache.set(text, signal);
  }
  return signal.get();
}

/**
 * Where an element's first line box is: the top of the first line of text
 * inside it, in the element's content space, and that line's height. Null
 * for an element with no text in it, or whose text is laid out somewhere
 * else (an absolutely positioned child, an SVG).
 *
 * It is what a list item's marker sits on. A browser puts the marker on
 * the item's first line, which is below the top of the content box
 * whenever the item opens with a block that has a margin or padding of its
 * own, as `<li><p>` does in a loose list.
 *
 * The walk reaches nodes the portal has not built yet: a marker is placed
 * when its item is built, and the item's children come after. A cached
 * read of a node no mirror has adopted follows its adoption
 * (`readRecordOf`), so the node's own run, handed that cache later, would
 * have it read again once the portal got there. The walk adopts what it
 * visits instead, into the mirror its element belongs to, which is what
 * the portal does when it gets there, so the cache has its record from
 * the first read.
 *
 * @param {HTMLElement} element
 * @returns {{ top: number, height: number } | null}
 */
export function getFirstLine(element) {
  const mirror = readRecordOf(element)?.mirror;
  for (const child of getChildNodes(element)) {
    mirror?.adopt(child);
    if (child.nodeType === Node.TEXT_NODE) {
      const { top, lines } = getTextLayout(/** @type {Text} */ (child));
      if (lines.length > 0) {
        return { top: top + lines[0].top, height: lines[0].height };
      }
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    const childElement = /** @type {HTMLElement} */ (child);
    if (childElement.namespaceURI !== "http://www.w3.org/1999/xhtml") {
      continue;
    }
    const position = getPositionStyle(childElement);
    if (position === "absolute" || position === "fixed") {
      continue;
    }
    const inner = getFirstLine(childElement);
    if (inner) {
      const at = getObjectPosition(childElement);
      const scroll = getScrollOffset(childElement);
      return { top: at.y + inner.top - scroll.top, height: inner.height };
    }
  }
  return null;
}
