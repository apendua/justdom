import { NoValueError, onCleanup } from "justdom-signal";
import { GENERATED_COPY_ATTRIBUTE, withGeneratedCopyRule } from "../css/documentStyles.js";
import {
  buildCharacterEdges,
  collapseLineOffsets,
  collapseWhitespace,
  findLineStarts,
  groupLineBoxes,
  preservesWhitespace,
  trimLineRange,
} from "../textLines.js";
import { frameFor, measureClientRect, measureClientRects, measureRunRect } from "../panelFrame.js";
import { copyStillStyle, parkMeasurementClone } from "./measurementClones.js";
import { nodeCache } from "./nodeCaches.js";
import { nodeDerived, probedRead, readRecordOf } from "./records.js";
import {
  displaySplitsAcrossLines,
  getBorderBoxSize,
  getObjectPosition,
  getReflowContext,
  getScrollOffset,
  readClientRect,
  readParentBox,
  splitsAcrossLines,
} from "./geometryReads.js";
import { PORTAL_BOOKKEEPING_ATTRIBUTES, PRESENTATIONAL_ATTRIBUTES } from "./mutationRules.js";
import {
  getChildNodes,
  getComputedStyleCached,
  getParentElement,
  getPositionStyle,
  getTextDataCached,
  isPortalRoot,
  isTransformed,
} from "./styleReads.js";

/**
 * @import {RevealLayout, RevealLine, TextLine} from '../textLines.js';
 * @import {FramedRect, PanelFrame} from '../panelFrame.js';
 * @import {TextBounds} from '../textHelpers.js';
 * @import {Derived} from 'justdom-signal';
 */

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
export function measureTextRects(text, parentElement, whiteSpace, scrolled, revealed) {
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
    const rect = measureRunRect(range, frame);
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
    const rect = measureRunRect(range, frame);
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
      const rect = measureRunRect(range, frame);
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
