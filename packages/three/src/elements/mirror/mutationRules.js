import { isSvgElement, isSvgRoot } from "../plugins.js";
import { classify } from "../animationClock.js";
import { getSiblingReach } from "../css/documentStyles.js";
import {
  ACTIVE_ATTRIBUTE,
  ELEMENT_FLAGS,
  FOCUS_ATTRIBUTE,
  HOVER_ATTRIBUTE,
  PORTAL_ATTRIBUTE,
} from "../portalRoot.js";
import { isOutOfFlowPosition } from "./geometryReads.js";

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
export const PORTAL_BOOKKEEPING_ATTRIBUTES = new Set([
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
 * costs a client rect per element and, far worse, a Range measurement per text
 * node in the hovered subtree, which is the most expensive read the mirror
 * makes. Under a moving hand, at frame rate. Declaring hover presentational
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
export const PRESENTATIONAL_ATTRIBUTES = new Set(ELEMENT_FLAGS);

/**
 * Of those, the ones that may only style the element they match and its
 * subtree. `[data-xr-hover] ~ .row` and `[data-xr-active] + .row` are not
 * mirrored: the sibling keeps the styling it had. Descendants are fine —
 * `.button[data-xr-hover] .label` restyles, as does anything the hovered
 * element's subtree inherits from it.
 *
 * This is what keeps hover off the rest of the panel. A restyle scope is a
 * claim about how far a selector's verdict could have moved, so the sibling
 * half of the ordinary scope (see `#restyleScope` in `mirror.js`) puts every
 * element sharing a parent — and everything under those — in the path of one
 * hover. Hover lands on whatever the ray hits, which in a list is a row, whose
 * parent is the list: the entire list restyles on every row the ray crosses, at
 * frame rate. Ruling out the sibling combinators makes hovering a row cost the
 * row.
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
export function isSelfScoped(element, name) {
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
export function reachesSibling(name) {
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
export function movesOnlyItsFrame(element, name) {
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
export function keepsToOwnBox(element, before, after) {
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
