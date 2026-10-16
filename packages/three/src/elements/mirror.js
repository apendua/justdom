import {
  addDependency,
  batch,
  Derived,
  fromEvent,
  NoValueError,
  onCleanup,
  Signal,
} from "@apendua/signal";
import { Subject } from "@apendua/signal";
import {
  buildCharacterEdges,
  collapseLineOffsets,
  collapseWhitespace,
  findLineStarts,
  groupLineBoxes,
  preservesWhitespace,
  trimLineRange,
} from "./textLines.js";
import { isSvgElement, isSvgRoot } from "./plugins.js";
import { classify } from "./animationClock.js";
import { clipBoxEqual, intersectClipBoxes, toLocalClipBox, UNCLIPPED } from "./clip.js";
import {
  ACTIVE_ATTRIBUTE,
  ELEMENT_FLAGS,
  FOCUS_ATTRIBUTE,
  HOVER_ATTRIBUTE,
  PORTAL_ATTRIBUTE,
} from "./portalRoot.js";
import { probeChange, probedDerived, probeNoopWrite, probeRipple } from "./outlineProbe.js";
import { holdShared, shadowAccessor } from "./shadowAccessor.js";
import {
  frameFor,
  getGeometryGeneration,
  invalidateGeometry,
  invalidatePanelFrame,
  invalidatePanelFrames,
  measureClientRect,
  measureClientRects,
} from "./panelFrame.js";

/**
 * @import {RevealLayout, RevealLine, TextLine} from './textLines.js';
 * @import {TextBounds} from './textHelpers.js';
 * @import {ClipBox} from './clip.js';
 * @import {FramedRect, PanelFrame} from './panelFrame.js';
 * @import {Subscribable} from '@apendua/signal';
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
 * Whether a computed `position` takes the box out of its parent's flow.
 *
 * @param {string} position
 * @returns {boolean}
 */
function isOutOfFlowPosition(position) {
  return position === "absolute" || position === "fixed";
}

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
 * Whether a computed `transform` value is one the mirror treats as a
 * transform at all. Browsers serialize every computed transform to a single
 * `matrix()`/`matrix3d()`, so under a real engine this is exactly "has a
 * transform"; jsdom passes author values through, and anything unrecognized
 * counts as untransformed everywhere, consistently.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function hasTransform(value) {
  return !!value && value !== "none" && value.startsWith("matrix");
}

/**
 * @typedef {object} ScrollOffset
 * @property {number} left
 * @property {number} top
 */

/**
 * @param {ScrollOffset} a
 * @param {ScrollOffset} b
 * @returns {boolean}
 */
function scrollOffsetEqual(a, b) {
  return a.left === b.left && a.top === b.top;
}

/**
 * Every per-node cache in this module, so that a node can be forgotten.
 *
 * The caches are module-level and keyed by node, which is what lets the
 * element components and the tests read them without a mirror in hand. It
 * also means a node outlives the portal that adopted it: its record still
 * names the first mirror, and every `Derived` cached for it still depends on
 * that mirror's signals. An element the page owns is exactly the node that
 * is claimed again — a second session over the same page — and a second
 * portal that adopted it would find the record already there, leave it, and
 * bump signals nothing under the element depends on: fonts arriving would
 * re-measure no text, a stylesheet swap restyle nothing. So a portal
 * forgets every node it lets go of, and a re-claimed node starts clean.
 *
 * @type {WeakMap<object, unknown>[]}
 */
const nodeCaches = [];

/**
 * A cache keyed by node that `forgetNode` knows about. Exported for the
 * cached reads that live beside the elements they serve, such as a list
 * item's number in `listMarker.js`; anything kept per node has to be one of
 * these, or a re-claimed node keeps the first mirror's signals under it.
 * The exceptions hold nothing of a mirror's, only what the element itself
 * announces, and are kept for the element's life in a plain `WeakMap` that
 * says so where it is declared: `assignmentSources` below and
 * `valueVersions` in `textInput.js`.
 *
 * @template {WeakMap<any, any>} T
 * @returns {T}
 */
export function nodeCache() {
  const cache = new WeakMap();
  nodeCaches.push(cache);
  return /** @type {T} */ (cache);
}

/**
 * Drop everything this module remembers about a node: its record, whether
 * held or let go of, and every cached read. The next `adopt` starts it over
 * under whichever mirror asks.
 *
 * @param {Node} node
 * @returns {void}
 */
export function forgetNode(node) {
  records.delete(node);
  takeDeparted(node);
  for (const cache of nodeCaches) {
    cache.delete(node);
  }
}

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
function readClientRect(element) {
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
 * What one adopted node keeps between mutations: a signal per kind of change
 * that can happen *to it*. Nothing here fans out on its own — each is bumped
 * by the mirror's dispatch when a record names the node, and read by the
 * derived chains below.
 */
class NodeRecord {
  /**
   * This node's own attributes changed (with an actual value change — the
   * ingest dedupes against `oldValue`). What hangs off it: the node's own
   * computed style, and — because an attribute can toggle a CSS transform —
   * the measured geometry of the node's own subtree.
   *
   * @type {Signal<number>}
   */
  self = Signal.of(0);

  /**
   * This node's own computed style moved and nothing under it can have: an
   * animation of a property that does not inherit — a transform, an
   * opacity, a background. Read by this node's style context alone (and by
   * its text children's, whose computed style *is* this node's), where
   * `self` is read by every descendant's.
   *
   * @type {Signal<number>}
   */
  own = Signal.of(0);

  /**
   * Some *child* of this node changed its attributes. Sibling combinators
   * (`~`, `+`) let a mutation restyle the elements after it, so each
   * child's computed style depends on this — one signal on the parent
   * instead of one subscription per sibling pair.
   *
   * @type {Signal<number>}
   */
  members = Signal.of(0);

  /**
   * Client rects of this node's subtree may have moved without any layout
   * happening elsewhere: a transform toggled by an attribute, or a
   * transform animation settling. The portal-wide layout epoch is the
   * coarse cousin for changes that can move anyone.
   *
   * @type {Signal<number>}
   */
  reflow = Signal.of(0);

  /**
   * This node's child list changed. The portal's own reconciliation reads
   * the DOM directly while ingesting; this signal is for reactive reads
   * that follow the list — `getChildNodes` below.
   *
   * @type {Signal<number>}
   */
  childList = Signal.of(0);

  /**
   * This node was added to or removed from a parent. `getParentElement`
   * depends on exactly this, so moving one node rewires the chains that
   * ran through it and disturbs nobody else.
   *
   * @type {Signal<number>}
   */
  reparented = Signal.of(0);

  /**
   * The node's character data changed (text nodes).
   *
   * @type {Signal<number>}
   */
  character = Signal.of(0);

  /**
   * This node's own box — where it sits in its parent, how big it is — may
   * have moved.
   *
   * The one signal a layout change is announced on, and the reason it is
   * per node rather than per portal. `#settleLayout` bumps it on exactly
   * the nodes whose boxes the change could have disturbed: the children of
   * every container the change happened inside, climbing only as far as the
   * first container that kept its own size. An inline or `contents` box does
   * not end the climb, since its size says nothing about where what follows
   * it starts (see `splitsAcrossLines`). Everything *below* those nodes
   * hears nothing, because a box's interior is a function of its own
   * content box and its own subtree — see `readParentBox`.
   *
   * @type {Signal<number>}
   */
  moved = Signal.of(0);

  /**
   * Where the element is scrolled to. The one piece of geometry that a
   * scroll *does* change, and deliberately the only one: everything else
   * is stored relative to something that scrolls along with it.
   *
   * @type {Signal<ScrollOffset>}
   */
  scroll;

  /** @type {DomMirror} */
  mirror;

  /**
   * @param {DomMirror} mirror
   * @param {Node} node
   */
  constructor(mirror, node) {
    this.mirror = mirror;
    const element = node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : null;
    this.scroll = new Signal(
      { value: { left: element?.scrollLeft || 0, top: element?.scrollTop || 0 } },
      scrollOffsetEqual,
    );
  }
}

/**
 * One registry for every portal: which mirror a node belongs to, and its
 * record. Module-level so the cached reads below can be called with a node
 * alone — the way `div`/`text` and the tests want to call them. A node
 * that no portal adopted reads as the DOM has it, and a cache of that read
 * follows the node's adoption (`readRecordOf`), so it is read again once a
 * portal does adopt it. One its portal let go of (`release`) keeps what its
 * reads last said (`keptWhileAway`).
 *
 * @type {WeakMap<Node, NodeRecord>}
 */
const records = new WeakMap();

/**
 * The records of nodes that left a panel and whose objects are still drawn,
 * waiting for the commit that takes them out (see `DomMirror.release`). Out
 * of `records`, so that nothing reaches them, and kept, so that a node put
 * back before the commit picks up the record its cached reads still hang
 * from. A cached read of a node here keeps its value (`keptWhileAway`).
 *
 * @type {WeakMap<Node, NodeRecord>}
 */
const departed = new WeakMap();

/**
 * How many of `departed`'s records each mirror has, so that the ingest of an
 * ordinary arrival, with none to take back, walks nothing (`reclaim`).
 *
 * It can stay above zero. A node let go of that the portal built no object
 * for, a comment or a template's child, and that the page then took out of
 * the departed subtree before the commit, is on neither of the walks the
 * commit forgets by. Its record stays here, and from then on `reclaim` walks
 * every added subtree and finds nothing in it: the cost this count saves,
 * and nothing worse.
 *
 * @type {WeakMap<DomMirror, number>}
 */
const departures = new WeakMap();

/**
 * Take a node's record out of `departed`, keeping its mirror's count.
 *
 * @param {Node} node
 * @returns {NodeRecord | undefined}
 */
function takeDeparted(node) {
  const record = departed.get(node);
  if (record) {
    departed.delete(node);
    departures.set(record.mirror, (departures.get(record.mirror) ?? 1) - 1);
  }
  return record;
}

/**
 * The nodes read before any portal adopted them, each with a signal the
 * adoption sets. See `readRecordOf`.
 *
 * @type {WeakMap<Node, Signal<boolean>>}
 */
const adoptions = new WeakMap();

/**
 * The writes `adopt` asked for since the last microtask, to be made in one
 * batch (see `announceAdoption`).
 *
 * @type {(() => void)[] | null}
 */
let adopted = null;

/**
 * Tell whatever read the node before it had a record to read it again (see
 * `readRecordOf`), or whatever kept its value while the node was away to run
 * in full (`keptWhileAway`): from a microtask, and all the nodes adopted
 * since the last one together. `adopt` is called from readers'
 * computations, by the list marker for an item's first line, and a signal
 * written with no batch open drains the queue then and there, which would
 * run the effects that depend on the adoption in the middle of the
 * computation that adopted, with the `Derived` it is evaluating still
 * empty: a reader of it would meet a cycle. A microtask runs once the stack is empty, so nothing is
 * computing, and the one batch lets a template's subtree, adopted node by
 * node, come round as one update.
 *
 * @param {() => void} write
 * @returns {void}
 */
function announceAdoption(write) {
  if (!adopted) {
    adopted = [];
    queueMicrotask(() => {
      const writes = /** @type {(() => void)[]} */ (adopted);
      adopted = null;
      batch(() => {
        for (const announce of writes) {
          announce();
        }
      });
    });
  }
  adopted.push(write);
}

/**
 * The node's record, or none for a node no portal has adopted. A lookup
 * and nothing else, for the writers: the mirror's own methods, which bump
 * what a record has when there is one and have nothing to do when there
 * is not.
 *
 * @param {Node} node
 * @returns {NodeRecord | undefined}
 */
function recordOf(node) {
  return records.get(node);
}

/**
 * The node's record for a cached read, or none for a node no portal has
 * adopted, which then reads the DOM as it is.
 *
 * Not none for good, though, and the read is cached. A portal builds what
 * it mirrors a budget at a time, so something drawn early can read a node
 * that is built, and adopted, a few frames later: a `<text>`'s runs asked
 * for its children before the `<text>` had a record. A cache made then
 * depended on nothing and stayed as it was read, and whatever the page did
 * to the node afterwards never reached it, so a `<text>` the page emptied
 * as it tore a board down was measured with the run it had taken out, and
 * threw. So a read with no record depends on the node's adoption instead,
 * and comes round again once there is a record to depend on, a microtask
 * after the adoption (see `announceAdoption`), for every cache that reads
 * through here. Only the caches do: a writer looks a record up with
 * `recordOf` and hangs nothing on a node it finds none for.
 *
 * @param {Node} node
 * @returns {NodeRecord | undefined}
 */
function readRecordOf(node) {
  const record = records.get(node);
  if (record) {
    return record;
  }
  let adoption = adoptions.get(node);
  if (!adoption) {
    adoption = Signal.of(false);
    adoptions.set(node, adoption);
  }
  adoption.get();
  return undefined;
}

/**
 * A cached read of a node, which keeps what it last said once the node is
 * away from the panel it was read in.
 *
 * A node the mirror let go of (`DomMirror.release`) has left the panel, and
 * its objects are drawn as they were until the commit takes them out, which
 * can be frames away: an atomic panel commits once its channel is drained.
 * After the commit they wait for their teardowns, frames more under the
 * scene's scheduler (`portalTeardown.js`). In all that time it is read as it
 * was read before it left. The rules:
 *
 * 1. **A read knows the record it was made under.** Each full run of a read
 *    remembers the node's record at the time, or that it had none.
 * 2. **Away, a read keeps its value.** A read that runs again, for whatever
 *    reason, and finds the node no longer has the record it was made under,
 *    returns the value it had and depends on that record's `reparented`
 *    alone. The node has none while the mirror has let go of it, after the
 *    commit forgot it (`forget`), and a different one once another panel
 *    adopts it. The read lets go of every other signal of the panel, so
 *    nothing the panel does afterwards reaches it, and its readers hear no
 *    change, so nothing they draw from it runs again. Read as the document
 *    has it, a node out of the document measures as nothing and styles as
 *    nothing, and every box, run and raster under it was drawn again from
 *    that, for objects about to be taken out.
 * 3. **A read with nothing to keep runs in full.** One made before the node
 *    had a record follows its adoption (`readRecordOf`), and one made for
 *    the first time while the node is away reads it as the document has it.
 * 4. **Taken back, a read runs in full.** `adopt` gives the node back the
 *    record it had, whether `reclaim` asks for it or a build does, and bumps
 *    that record's `reparented` from a microtask (`announceAdoption`), so
 *    every kept read runs again under it, as the document has the node now.
 * 5. **Nothing else ends it.** A record that is not given back is bumped by
 *    nobody, and a read kept under it keeps its value until the objects
 *    holding it are taken down. A portal building the node again runs those
 *    teardowns first (rule 6 of `portalTeardown.js`), and the build reads it
 *    through fresh caches, since `forget` dropped the old ones.
 *
 * A kept run is equal to the run before it whatever the read's own equality
 * says, so a read that always tells its readers, the computed style, tells
 * them nothing while it keeps.
 *
 * @template T
 * @param {Node} node
 * @param {() => T} evaluate
 * @param {(a: T, b: T) => boolean} isEqual
 * @returns {{
 *   evaluate: (ctx: { hasValue: () => boolean, getValue: () => T }) => T,
 *   isEqual: (a: T, b: T) => boolean,
 * }}
 */
function keptWhileAway(node, evaluate, isEqual) {
  /** @type {NodeRecord | undefined} */
  let madeUnder;
  let kept = false;
  return {
    evaluate: (ctx) => {
      const record = records.get(node);
      const before = madeUnder;
      if (before !== undefined && before !== record && ctx.hasValue()) {
        kept = true;
        before.reparented.get();
        return ctx.getValue();
      }
      kept = false;
      madeUnder = record;
      return evaluate();
    },
    isEqual: (a, b) => kept || isEqual(a, b),
  };
}

/**
 * A `Derived` cached for a node, which keeps its value once the node is
 * away from its panel (`keptWhileAway`). Every cache of a node read builds
 * through here or through `probedRead`, the mirror's and the ones beside it
 * (`elevation.js`, `listMarker.js`), so that the rules hold for each of them.
 *
 * @template T
 * @param {Node} node
 * @param {() => T} evaluate
 * @param {{ isEqual?: (a: T, b: T) => boolean }} [options]
 * @returns {Derived<T>}
 */
export function nodeDerived(node, evaluate, options) {
  const read = keptWhileAway(node, evaluate, options?.isEqual ?? Object.is);
  return new Derived(read.evaluate, { isEqual: read.isEqual });
}

/**
 * `nodeDerived` for a read the outline probe tallies (`probedDerived`).
 *
 * @template T
 * @param {Node} node
 * @param {() => T} evaluate
 * @param {(a: T, b: T) => boolean} [isEqual]
 * @returns {Derived<T>}
 */
function probedRead(node, evaluate, isEqual = Object.is) {
  const read = keptWhileAway(node, evaluate, isEqual);
  return probedDerived(node, read.evaluate, read.isEqual);
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
    if (records.has(node)) {
      return;
    }
    let record = takeDeparted(node);
    if (record) {
      if (record.mirror !== this) {
        // Another panel's, on its way out of it, and everything cached for
        // it hangs off that panel's signals.
        forgetNode(node);
        record = undefined;
      } else {
        // Taken back: what its reads kept while it was away is read again
        // (rule 4 of `keptWhileAway`).
        const reparented = record.reparented;
        announceAdoption(() => bump(reparented));
      }
    }
    records.set(node, record ?? new NodeRecord(this, node));
    const adoption = adoptions.get(node);
    if (adoption) {
      adoptions.delete(node);
      announceAdoption(() => adoption.set(true));
    }
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
   * let go of (`release`), now that the panel has them again (`adopt`). The
   * whole
   * subtree is walked, not only from a node that was let go of: while out
   * of the document the page may have put one inside an element the panel
   * has never seen, and the flush then names that element. A mirror with
   * nothing let go of walks nothing.
   *
   * @param {Node} node
   * @returns {void}
   */
  reclaim(node) {
    if (!departures.get(this)) {
      return;
    }
    if (departed.get(node)?.mirror === this) {
      this.adopt(node);
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
        if (!isSelfScoped(element, name)) {
          selfScoped = false;
        }
      }
      if (changed) {
        probeChange(element);
        this.attributeChanged(element, { presentational, selfScoped, contained });
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
   * panel (`outOfFlowLayout`). That is the scope the restyle above already
   * has, since an author's attribute can restyle its siblings.
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
   * @returns {void}
   */
  attributeChanged(
    element,
    { presentational = false, selfScoped = false, contained = false } = {},
  ) {
    batch(() => {
      this.#restyleScope(element, { reachesSiblings: !selfScoped });
      if (presentational) {
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
   * own memoized style, which this still invalidates.
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
   *   verdict on a sibling, an animation (`animatedStyles`), and for the
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
function getFlowMode(element) {
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
 * @returns {DomMirror}
 */
export function createMirror() {
  return new DomMirror();
}

/**
 * `Node.parentElement` is an `HTMLElement`, and `Derived` is invariant in its
 * value, so the cache has to say so rather than widening to `Element`.
 *
 * @type {WeakMap<Node, Derived<HTMLElement | null>>}
 */
const parentElementCache = nodeCache();

/**
 * The node's parent, as a dependency. Invalidated by exactly the childList
 * mutations that added or removed *this* node — the chains that run through
 * the parent (style, layout, clipping) rewire themselves when it changes,
 * and a list growing elsewhere disturbs none of them.
 *
 * @param {Node} node
 * @returns {HTMLElement | null}
 */
export function getParentElement(node) {
  let signal = parentElementCache.get(node);
  if (!signal) {
    signal = nodeDerived(node, () => {
      const record = readRecordOf(node);
      if (record) {
        record.reparented.get();
      }
      return node.parentElement;
    });
    parentElementCache.set(node, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Node, Derived<Node[]>>} */
const childNodesCache = nodeCache();

/**
 * The element's child nodes, as a dependency of its own: the parent is the
 * one who knows its list of children changed, and this is where dependents
 * come to hear it.
 *
 * @param {Node} node
 * @returns {Node[]}
 */
export function getChildNodes(node) {
  let signal = childNodesCache.get(node);
  if (!signal) {
    signal = nodeDerived(node, () => {
      const record = readRecordOf(node);
      if (record) {
        record.childList.get();
      }
      return /** @type {Node[]} */ (Array.from(node.childNodes));
    });
    childNodesCache.set(node, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Node, Derived<number>>} */
const styleContextCache = nodeCache();

/**
 * Everything that can invalidate this node's computed style, folded into one
 * number. A counter rather than a value on purpose: computed style is a live
 * object the browser mutates in place, so there is nothing to compare — the
 * context's job is purely to carry the invalidation to the right nodes.
 *
 * The shape of the sum is the scope: the node's own attribute signal covers
 * the node and its subtree (every descendant folds it in), the parent's
 * member signal covers the mutated element's siblings — `~`, `+` and the
 * structural pseudo-classes reach exactly that far — so a mutation reaches
 * the parent-of-target subtree and nothing else. `:has()`, which lets a
 * mutation restyle its ancestors, is knowingly not modelled — the same
 * bargain the previous implementation struck.
 *
 * The two halves are bumped separately, so a change that provably cannot
 * move a selector's verdict on a sibling can pay for the subtree alone: see
 * `#restyleScope`, and its callers for which changes those are.
 *
 * One more is added for every record the walk finds. A node read before any
 * portal adopted it (`readRecordOf`) is walked again once one does, and its
 * fresh record's signals all read 0, so without the one the sum would come
 * out as it was and the style cached on it would stay as read before the
 * record, deaf to what the page did to the node in between. A node that has
 * its records at creation has them at flush too, so the sum stays flat for
 * the reason below.
 *
 * The sum reads the ancestors' *signals* directly rather than chaining
 * through their memoized contexts, and the flatness is load-bearing, not a
 * style choice. A node created inside the very batch that bumped an epoch
 * would read a pre-bump number out of a cached ancestor context — the
 * ancestor only catches up when the queue flushes — and the flush would
 * then hand every freshly mounted node a "changed" context: one whole
 * second evaluation of every style, measurement and texture the mount had
 * just produced. Read flat, the sum is built from the same signal values at
 * creation and at flush, compares equal, and the flush stops here.
 *
 * @param {Node} node
 * @returns {number}
 */
function getStyleContext(node) {
  let signal = styleContextCache.get(node);
  if (!signal) {
    signal = nodeDerived(node, () => {
      let sum = 0;
      const record = readRecordOf(node);
      if (record) {
        sum += record.mirror.restyle.get();
      }
      for (
        let current = /** @type {Node | null} */ (node), depth = 0;
        current;
        current = getParentElement(current), depth += 1
      ) {
        const currentRecord = readRecordOf(current);
        if (currentRecord) {
          sum += 1;
          sum += currentRecord.self.get();
          if (depth > 0) {
            sum += currentRecord.members.get();
          }
          if (depth === 0 || (depth === 1 && node.nodeType === Node.TEXT_NODE)) {
            sum += currentRecord.own.get();
          }
        }
        if (isPortalRoot(current)) {
          break;
        }
      }
      return sum;
    });
    styleContextCache.set(node, signal);
  }
  return signal.get();
}

/**
 * Whether the node is the top of what a portal mirrors: the container the
 * portal made, or the page's element it claimed, either of which carries
 * `PORTAL_ATTRIBUTE`. Above it is the page around the scene, which no portal
 * adopts and no walk up from a panel node goes on into. The one check for
 * it: the walks here, `findScroller`, `findDragSource` and the portal's
 * claim all ask it. Only the portal's selectors, which find a root rather
 * than test one, spell the attribute themselves.
 *
 * @param {Node} node
 * @returns {boolean}
 */
export function isPortalRoot(node) {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    /** @type {Element} */ (node).hasAttribute(PORTAL_ATTRIBUTE)
  );
}

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

/** @type {WeakMap<Text, Derived<string>>} */
const textDataCache = nodeCache();

/**
 * A text node's characters, as a dependency on its own character data, for a
 * reader that measures the text some other way than `getTextLayout` does.
 *
 * @param {Text} text
 * @returns {string}
 */
export function getTextDataCached(text) {
  let signal = textDataCache.get(text);
  if (!signal) {
    signal = probedRead(text, () => {
      readRecordOf(text)?.character.get();
      return text.data;
    });
    textDataCache.set(text, signal);
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
function readParentBox(node) {
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

/** @type {WeakMap<Element | Text, Map<string | null, Derived<CSSStyleDeclaration>>>} */
const computedStyleCache = nodeCache();

/**
 * @param {Element | Text} element
 * @param {string | null} [pseudoElement]
 * @returns {CSSStyleDeclaration}
 */
export function getComputedStyleCached(element, pseudoElement = null) {
  let signalMap = computedStyleCache.get(element);
  if (!signalMap) {
    signalMap = new Map();
    computedStyleCache.set(element, signalMap);
  }
  let signal = signalMap.get(pseudoElement);
  if (!signal) {
    signal = nodeDerived(
      element,
      () => {
        getStyleContext(element);
        if (element.nodeType === Node.TEXT_NODE) {
          const parent = getParentElement(element);
          if (!parent) {
            throw new NoValueError("Text node has no parent element");
          }
          return window.getComputedStyle(parent, pseudoElement);
        }
        return window.getComputedStyle(/** @type {Element} */ (element), pseudoElement);
      },
      {
        // Browsers hand back a *live* CSSStyleDeclaration with a stable
        // identity, so the default Object.is equality would treat every
        // recompute as "unchanged" and swallow the invalidation — leaving
        // dependents (hover restyles, class swaps) reading stale values
        // forever. Always propagate; dependents that derive plain values
        // gate on their own equality. A run that kept its value because the
        // node is away propagates nothing (`keptWhileAway`).
        isEqual: () => false,
      },
    );
    signalMap.set(pseudoElement, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Element, Map<string, Derived<string | null>>>} */
const attributeCache = nodeCache();

/**
 * An attribute's value, as a dependency on the element's own attribute
 * signal. Unlike computed style this is a plain string, so a write to some
 * other attribute on the element re-reads it and stops here when the value
 * did not change.
 *
 * For an attribute with no CSS form (`viewBox`, `preserveAspectRatio`,
 * `points`, `x1` and the others the browser does not expose as a property),
 * this is the only way to follow it: reading computed style would pick up
 * the same signal, but only as a side effect.
 *
 * @param {Element} element
 * @param {string} name
 * @returns {string | null}
 */
export function getAttributeCached(element, name) {
  let signalMap = attributeCache.get(element);
  if (!signalMap) {
    signalMap = new Map();
    attributeCache.set(element, signalMap);
  }
  let signal = signalMap.get(name);
  if (!signal) {
    signal = probedRead(element, () => {
      readRecordOf(element)?.self.get();
      return element.getAttribute(name);
    });
    signalMap.set(name, signal);
  }
  return signal.get();
}

/** @type {WeakMap<HTMLElement, Derived<boolean>>} */
const transformedCache = nodeCache();

/**
 * Whether the element, or anything above it inside the portal, carries a CSS
 * transform — the question every measurement asks before trusting a client
 * rect, because an ancestor's transform pollutes the rects of the whole
 * subtree under it.
 *
 * Memoized per element and phrased recursively rather than as a walk, which
 * is what makes it usable as a dependency: the styles it reads are
 * invalidated by every attribute mutation in scope, and a boolean behind its
 * own signal absorbs all of that, propagating only when the answer actually
 * flips.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isTransformed(element) {
  let signal = transformedCache.get(element);
  if (!signal) {
    signal = probedRead(element, () => {
      if (isPortalRoot(element)) {
        return false;
      }
      if (hasTransform(getComputedStyleCached(element).transform)) {
        return true;
      }
      const parent = getParentElement(element);
      return parent ? isTransformed(parent) : false;
    });
    transformedCache.set(element, signal);
  }
  return signal.get();
}

/** @type {WeakMap<Element, Derived<string>>} */
const positionCache = nodeCache();

/**
 * The element's computed `position`, behind its own equality gate: the clip
 * and anchoring decisions below read it constantly, and a hover restyle that
 * did not move it must not re-run them.
 *
 * @param {Element} element
 * @returns {string}
 */
function getPositionStyle(element) {
  let signal = positionCache.get(element);
  if (!signal) {
    signal = probedRead(element, () => {
      return getComputedStyleCached(element).position || "static";
    });
    positionCache.set(element, signal);
  }
  return signal.get();
}

/**
 * Whether a computed `visibility` hides what it applies to. `collapse` does,
 * for anything that is not a table row or column — and a panel has no table
 * layout to collapse, so it is `hidden` by another name here.
 *
 * @param {string} visibility
 * @returns {boolean}
 */
export function hidesVisibility(visibility) {
  return visibility === "hidden" || visibility === "collapse";
}

/** @type {WeakMap<Element | Text, Derived<boolean>>} */
const hiddenCache = nodeCache();

/**
 * Whether CSS says this node paints nothing of its own: computed
 * `visibility` is `hidden` or `collapse`. For a text node that is its
 * parent's answer, which is where a text node's style comes from.
 *
 * What it does *not* say is anything about the node's descendants, and the
 * whole difference from `display: none` is there: `visibility` is inherited,
 * so a child of a hidden element is hidden only until it says `visible`
 * for itself — and then it is drawn, and pointable, as if nothing above it
 * were hidden. So this is asked per node, of the node's own meshes, and
 * never turned into an object's `visible`, which would prune the subtree.
 *
 * Behind its own equality gate, like `getPositionStyle`: the computed style
 * is invalidated by every hover, and the answer almost never flips.
 *
 * @param {Element | Text} node
 * @returns {boolean}
 */
export function isVisibilityHidden(node) {
  let signal = hiddenCache.get(node);
  if (!signal) {
    signal = probedRead(node, () => hidesVisibility(getComputedStyleCached(node).visibility));
    hiddenCache.set(node, signal);
  }
  return signal.get();
}

/**
 * Forgotten with the node, since the product ends at whichever panel's top
 * the node is under, and a node claimed again may be under another.
 *
 * @type {WeakMap<Element, Derived<number>>}
 */
const opacityCache = nodeCache();

/**
 * How opaque this element is drawn: its own `opacity` times every
 * ancestor's, up to and including the panel's top. A run of text is drawn
 * as opaque as its parent element, which is where its style comes from;
 * `text.js` asks the parent rather than giving each run a signal of its
 * own that would only forward the parent's.
 *
 * `opacity` does not inherit, but it fades everything inside the element
 * all the same: a browser paints the subtree into a layer of its own and
 * fades the layer. A panel has no layer to fade, so each box and each run
 * of text is faded by the product instead. That is the page wherever what
 * is inside does not overlap. Where it does, the two show through each
 * other, which on the page they would not.
 *
 * Stops at the panel's top, as every root-scoped question here does: an
 * opacity the page puts on a wrapper around the panel is the page's
 * business, not the panel's.
 *
 * One signal per element, reading its own style and its parent's product, so
 * the product is worked out once per element rather than once per element
 * per ancestor. It is behind an equality gate like `isVisibilityHidden`:
 * the computed style is invalidated by every hover, and a hover that does
 * not change an opacity stops here rather than re-running the subtree.
 *
 * @param {Element} element
 * @returns {number}
 */
export function getOpacity(element) {
  let signal = opacityCache.get(element);
  if (!signal) {
    signal = probedRead(element, () => {
      const own = parseFloat(getComputedStyleCached(element).opacity);
      const opacity = Number.isNaN(own) ? 1 : own;
      if (isPortalRoot(element)) {
        return opacity;
      }
      const parent = getParentElement(element);
      return parent ? opacity * getOpacity(parent) : opacity;
    });
    opacityCache.set(element, signal);
  }
  return signal.get();
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
 * A detached, untransformed copy of `element` to measure instead of the real
 * thing, parked off-screen outside the portal's observed subtree.
 *
 * Touching the live elements is not an option: masking a transform with an
 * !important rule interacts with `transition: transform` at the browser's
 * pace, not ours — a synchronous flush updates the transition *baseline*
 * while transitions themselves are only generated at frames — so any
 * mask-and-restore protocol either swallows a transition the mutation meant
 * to start or manufactures one out of the restore. A clone has no
 * transitions to disturb.
 *
 * The clone's layout reproduces the original's because every resolved style
 * — the used width included — is copied onto its root; descendants keep
 * their classes and the document's stylesheets apply as usual. The one
 * blind spot: a descendant selector that reaches *above* the cloned element
 * (`.card[data-state] p`) has no ancestors to match against and falls back
 * to base styling.
 *
 * The clone is appended to the body, or, given a `host`, to the host, which
 * is appended to the body in its place and parked instead: an SVG `<text>`
 * is laid out only inside an `<svg>` (`measureRuns` in `svg/text.js`). The
 * clone's own `visibility` hides it either way, since the style copied onto
 * it says `visible`; what is parked is only moved off-screen, and marked
 * `inert` and `aria-hidden`, which keep it out of focus and the
 * accessibility tree. A clone of a panel's root drops `PORTAL_ATTRIBUTE`, so
 * that it is measured in the body's frame rather than taken for a panel of
 * its own. The caller removes what was appended, the host if it gave one.
 *
 * @template {HTMLElement | SVGElement} T
 * @param {T} element
 * @param {HTMLElement | SVGElement | null} [host] What the clone is laid out
 *   in, if not the body.
 * @returns {T}
 */
export function createMeasurementClone(element, host = null) {
  return parkMeasurementClone(element, /** @type {T} */ (element.cloneNode(true)), host);
}

/**
 * The second half of `createMeasurementClone`, for a copy of `element` the
 * caller has made itself: dress it in the element's resolved style, with
 * its transform, transitions and animations switched off (`copyStillStyle`),
 * and park it.
 *
 * @template {HTMLElement | SVGElement} T
 * @param {T} element
 * @param {T} clone
 * @param {HTMLElement | SVGElement | null} host
 * @returns {T}
 */
function parkMeasurementClone(element, clone, host) {
  copyStillStyle(element, clone);
  clone.removeAttribute(PORTAL_ATTRIBUTE);
  clone.style.setProperty("visibility", "hidden", "important");
  const parked = host ?? clone;
  parked.style.setProperty("position", "absolute", "important");
  parked.style.setProperty("top", "0", "important");
  parked.style.setProperty("left", "-99999px", "important");
  parked.setAttribute("inert", "");
  parked.setAttribute("aria-hidden", "true");
  if (host) {
    host.appendChild(clone);
  }
  document.body.appendChild(parked);
  return clone;
}

/**
 * Write every resolved style of `element` onto `clone` inline, so that the
 * clone is laid out as the element is wherever it is put, and switch its
 * transform, transitions and animations off. An animation would start
 * again on the clone at its first keyframe, and an animated value beats an
 * inline one that is not `!important`.
 *
 * @param {HTMLElement | SVGElement} element
 * @param {HTMLElement | SVGElement} clone
 * @param {CSSStyleDeclaration} [computed] The element's computed style, if
 *   the caller has it already.
 * @returns {void}
 */
function copyStillStyle(element, clone, computed = window.getComputedStyle(element)) {
  // Written as one declaration list, which the browser parses once, rather
  // than a `setProperty` per property: a computed style has some 350.
  /** @type {string[]} */
  const declarations = [];
  for (let i = 0; i < computed.length; i++) {
    const property = computed[i];
    declarations.push(`${property}: ${computed.getPropertyValue(property)}`);
  }
  // The custom properties the clone's own inline style sets go after them,
  // since Chromium enumerates none in a computed style, and a child styled
  // with `var(--gap)` would lose the `--gap` the element sets. Those alone:
  // the rest of the inline style is in the computed values already, and an
  // `!important` on it would outrank them. A custom property keeps its
  // priority, since nothing in the computed list can be outranked by it, and
  // an inline `!important` is what beats a stylesheet's.
  for (let i = 0; i < clone.style.length; i++) {
    const property = clone.style[i];
    if (property.startsWith("--")) {
      const priority = clone.style.getPropertyPriority(property);
      declarations.push(
        `${property}: ${clone.style.getPropertyValue(property)}${priority ? ` !${priority}` : ""}`,
      );
    }
  }
  declarations.push(
    "transform: none !important",
    "transition: none !important",
    "animation: none !important",
  );
  clone.style.cssText = declarations.join("; ");
}

/**
 * A text node's layout, measured with every transform on the chain switched
 * off — line boxes read back under a rotation would group by *screen* rows,
 * which is not where the browser broke the lines.
 *
 * @typedef {object} TextLayout
 * @property {TextBounds} bounds How big the union of the text node's line
 *   boxes is. Deliberately a size and not a rectangle — see
 *   `measureTextRects`.
 * @property {number} left Where `bounds` sits in the parent element's
 *   *content* space — relative to the border box plus however far the parent
 *   is scrolled — in layout px. Content space is what makes the number a
 *   constant of the layout: text sliding through its own parent's window
 *   measures to exactly what it measured before.
 * @property {number} top Same, vertically.
 * @property {TextLine[]} lines Line boxes, positioned relative to `bounds`.
 * @property {RevealLayout | null} reveal Character boundaries, for a node that
 *   asked for them with `trackCharacterEdges`, and `null` — always the same
 *   `null` — for every other node in the scene. Opt-in because it costs a
 *   range read per character, which is the right price for a letter being
 *   typed out and quite the wrong one for a label.
 */

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
 * The one Range every text measurement is made with.
 *
 * A Range is live: the document keeps every one it hands out and updates
 * its boundary points on every mutation — a removed node moves them to the
 * parent, rewritten character data shifts the offsets. Creating one per
 * measurement and dropping it, still pointing into the text it measured,
 * left a mount of eight hundred labels with up to eight hundred stale
 * ranges for every mutation to walk until the collector got to them — the
 * hover writes a moving ray makes at frame rate included. One shared range
 * makes that one.
 *
 * It also closes a small leak on the transformed path: a measurement clone
 * is appended to the body and removed, and the floating range kept the
 * removed subtree reachable until it was collected. After each measurement
 * the range is pointed at the document itself, where nothing in a panel can
 * move it and nothing is held.
 *
 * Safe to share because every measurement is synchronous: nothing between
 * `selectNodeContents` and the last rect read yields to anything that could
 * measure.
 *
 * @type {Range | null}
 */
let measuringRange = null;

/**
 * @returns {Range}
 */
function getMeasuringRange() {
  if (!measuringRange) {
    measuringRange = document.createRange();
  }
  return measuringRange;
}

/**
 * Tests only: forget the shared range, so a test that stands in for
 * `document.createRange` is handed the stand-in on the next measurement
 * rather than a real range made before the stand-in was installed.
 *
 * @returns {void}
 */
export function resetMeasuringRangeForTests() {
  measuringRange = null;
}

/**
 * Measure with the shared range (`getMeasuringRange`), and let go of what it
 * measured afterwards. Every text measurement goes through this, an SVG
 * `<text>`'s included (`measureRuns` in `svg/text.js`).
 *
 * @template R
 * @param {(range: Range) => R} measure Synchronous, and making no
 *   measurement of its own through this.
 * @returns {R}
 */
export function withMeasuringRange(measure) {
  const range = getMeasuringRange();
  try {
    return measure(range);
  } finally {
    // Let go of the node. The document has children, so offset 0 is a valid
    // point in it, and it is one that nothing inside a panel can disturb.
    range.setStart(document, 0);
    range.setEnd(document, 0);
  }
}

/**
 * @param {Text} text
 * @param {HTMLElement} parentElement
 * @param {string} whiteSpace
 * @param {boolean} scrolled
 * @param {boolean} revealed
 * @returns {TextLayout}
 */
function measureTextRects(text, parentElement, whiteSpace, scrolled, revealed) {
  return withMeasuringRange((range) =>
    measureTextRectsWith(range, text, parentElement, whiteSpace, scrolled, revealed),
  );
}

/**
 * The measuring core: line boxes and parent-relative position of one text
 * node, read off whatever tree the node currently sits in.
 *
 * A range already knows where the browser broke the text — `getClientRects`
 * reports the line boxes, wrapping and all — and what it does not say is
 * which characters landed on each of them. That is recovered by bisection
 * rather than by measuring every character: see `findLineStarts`. What it
 * costs is a handful of measurements per line, where a walk cost one per
 * character; on a wrapped paragraph in Chromium the difference was 2.2ms and
 * 0.5ms, per measurement.
 *
 * @param {Range} range The shared range — see `getMeasuringRange`.
 * @param {Text} text
 * @param {HTMLElement} parentElement
 * @param {string} whiteSpace
 * @param {boolean} scrolled Whether to fold the parent's scroll offset in —
 *   true against the live tree, false against a clone, which is never
 *   scrolled and already reports layout positions.
 * @param {boolean} revealed Whether to measure character boundaries too.
 * @returns {TextLayout}
 */
function measureTextRectsWith(range, text, parentElement, whiteSpace, scrolled, revealed) {
  const content = text.textContent || "";
  // The live tree's frame is its panel's; a clone's is the body it is
  // appended to.
  const frame = frameFor(parentElement);
  // Against the live tree the parent's rect is shareable. A copy is none of
  // the panel's nodes, so its rect is read directly, once for each text
  // measured in it, even though a line box copy stands for many of them.
  const parentRect = scrolled
    ? readClientRect(parentElement)
    : measureClientRect(parentElement, frame);
  range.selectNodeContents(text);
  const boundsRect = measureClientRect(range, frame);
  const left = boundsRect.left - parentRect.left + (scrolled ? parentElement.scrollLeft || 0 : 0);
  const top = boundsRect.top - parentRect.top + (scrolled ? parentElement.scrollTop || 0 : 0);
  // Size alone: where the text sits is already said by `left` and `top`, in
  // the content-space terms the mirror draws in, and a fresh identity per
  // measurement would re-run the rasterizer for every visible label on
  // every frame that moved anything.
  const bounds = { width: boundsRect.width, height: boundsRect.height };

  const boxes = groupLineBoxes(measureClientRects(range, frame));
  if (boxes.length === 0) {
    // Empty, or not laid out at all. Either way there is nothing to draw,
    // and in particular nothing that should be drawn at the origin instead.
    return { bounds, left, top, lines: [], reveal: revealed ? EMPTY_REVEAL : null };
  }

  // The overwhelmingly common case is a label on a single line, which the
  // bounding box already describes — and describes for free, the rectangle
  // having been read already.
  if (boxes.length === 1) {
    const single = revealed
      ? collapseLineOffsets(content, 0, content.length, whiteSpace)
      : { text: collapseWhitespace(content, whiteSpace), offsets: [] };
    const lines = single.text
      ? [{ text: single.text, left: 0, top: 0, width: bounds.width, height: bounds.height }]
      : [];
    return {
      bounds,
      left,
      top,
      lines,
      reveal: revealed
        ? measureRevealLayout(
            text,
            range,
            frame,
            boundsRect,
            lines,
            lines.length ? [single.offsets] : [],
          )
        : null,
    };
  }

  const preserved = preservesWhitespace(whiteSpace);
  const starts = findLineStarts(content.length, boxes.length, (index) => {
    range.setStart(text, index);
    range.setEnd(text, index + 1);
    const rect = measureClientRect(range, frame);
    if (rect.width <= 0 && rect.height <= 0) {
      // Whitespace the layout collapsed away occupies no space and sits on
      // no line box.
      return null;
    }
    // Compared at the character's middle rather than its top: a line mixing
    // sizes or scripts leaves its shorter glyphs sitting inside the band
    // rather than at the top of it.
    const middle = (rect.top + rect.bottom) / 2;
    for (let line = boxes.length - 1; line > 0; line--) {
      if (middle >= boxes[line].top) {
        return line;
      }
    }
    return 0;
  });

  const lines = [];
  /** @type {number[][]} */
  const offsets = [];
  for (let line = 0; line < starts.length; line++) {
    const until = line + 1 < starts.length ? starts[line + 1] : content.length;
    const [from, to] = trimLineRange(content, starts[line], until, preserved);
    if (from >= to) {
      // A line with nothing on it but the whitespace that ended the one
      // before it, or the blank line a `pre` block is entitled to.
      continue;
    }
    const collapsed = revealed
      ? collapseLineOffsets(content, from, to, whiteSpace)
      : { text: collapseWhitespace(content.slice(from, to), whiteSpace), offsets: [] };
    const value = collapsed.text;
    if (!value) {
      continue;
    }
    if (revealed) {
      offsets.push(collapsed.offsets);
    }
    // One rectangle per line, over the text the line actually draws, so the
    // extent is the browser's own shaping — kerning included — rather than a
    // union of per-character boxes.
    range.setStart(text, from);
    range.setEnd(text, to);
    const rect = measureClientRect(range, frame);
    lines.push({
      text: value,
      left: rect.left - boundsRect.left,
      top: rect.top - boundsRect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  return {
    bounds,
    left,
    top,
    lines,
    reveal: revealed ? measureRevealLayout(text, range, frame, boundsRect, lines, offsets) : null,
  };
}

/** @type {RevealLayout} */
const EMPTY_REVEAL = { length: 0, lines: [] };

/**
 * The second half of a revealed run's measurement: for each line, the x of
 * every boundary between the characters drawn on it.
 *
 * One range read per character, which is the honest cost of the thing and the
 * reason it is opt-in — but paid once per *layout*, not once per keystroke,
 * which is the whole point. Everything a cursor moving does afterwards is
 * arithmetic over what this returned.
 *
 * @param {Text} text
 * @param {Range} range Reused, and left pointing wherever the last read put it.
 * @param {PanelFrame} frame What the text is measured in.
 * @param {FramedRect} boundsRect What the other positions are relative to.
 * @param {TextLine[]} lines The lines actually drawn, in document order.
 * @param {number[][]} offsets Where each line's rendered characters sit in
 *   the node's data, one array per line of `lines`.
 * @returns {RevealLayout}
 */
function measureRevealLayout(text, range, frame, boundsRect, lines, offsets) {
  /** @type {RevealLine[]} */
  const revealLines = [];
  let start = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineOffsets = offsets[index];
    const count = lineOffsets.length;
    const edges = buildCharacterEdges(count, (at) => {
      range.setStart(text, lineOffsets[at]);
      range.setEnd(text, lineOffsets[at] + 1);
      const rect = measureClientRect(range, frame);
      if (rect.width <= 0 && rect.height <= 0) {
        return null;
      }
      return [rect.left - boundsRect.left, rect.right - boundsRect.left];
    });
    revealLines.push({
      start,
      length: count,
      top: line.top,
      bottom: line.top + line.height,
      edges,
    });
    start += count;
  }
  return { length: start, lines: revealLines };
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
 * `!important`. `p[inert] .chip` also matches inside it, and restyles an
 * element laid out in a box of its own, which keeps only its classes.
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
 * attribute change bumps unless it is presentational, and the portal-wide
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
 * unless the portal declares the attribute presentational, and which waits
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
 * does not change what the others are measured against. Everything else is
 * copied as `createMeasurementClone` copies descendants, with its classes
 * only: a selector that reaches above the box does not style it, and its
 * animations start again, either of which can move a text in a centred or
 * flex line box.
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
    if (displaySplitsAcrossLines(element, computed.display)) {
      copyStillStyle(element, /** @type {HTMLElement} */ (childCopy), computed);
      dressLaidOut(element, childCopy);
    }
  }
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
