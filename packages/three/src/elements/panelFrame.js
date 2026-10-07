import { getPortalRoot } from "./portalRoot.js";

/**
 * Every client rect freedom reads, and the frame it is read in.
 *
 * The browser reports a client rect through every transform above the
 * element, the panel's root and the page around it included. The mirror
 * draws a panel in the root's layout px, so a rect read as it is comes out
 * scaled wherever the page scales the panel, which is what a page that
 * scales itself to fit its window does to every box, line of text and point
 * a ray meets. So each read here is divided by the scale its frame is drawn
 * at, and the ray's mapping back onto the page multiplies by the same
 * scale: the box, the text and the ray read one value and cannot disagree.
 *
 * A frame belongs to a panel's root, and to `document.body` for what is
 * measured outside any panel, the clones and probes appended there, which
 * only a transform on `<body>` or `<html>` reaches. Its scale is the product
 * of the scales from its element up to `<html>`. Most of what the portal
 * hears cannot reach above the root, so the chain is not read on every
 * mutation inside the panel. It is read at the next measurement after a
 * portal claims a root, the window resizes, the document's stylesheets
 * change, or the root's own reflow signal moves (a change to its
 * attributes, or a transition the clock samples on it), and at once when
 * the ray probes the root. A rotation, a skew, a flip or a perspective has
 * no scale to divide by: the frame then reads at 1, which is how every rect
 * was read before frames existed, and a panel's root warns once, naming the
 * element that carries it.
 *
 * Nothing else in `src` calls `getBoundingClientRect` or `getClientRects`,
 * and `panelFrame.test.js` fails the build when something does, because a
 * read anywhere else skips the frame.
 */

/**
 * Which "moment" of page geometry raw reads belong to. Bumped alongside
 * every dispatch that could move anything, and on the page scrolling or the
 * window resizing, it lets one settling of the reactive graph share a
 * single client rect per element: a portal-wide re-layout asks about each
 * element three or four times (position, size, a text's parent, a clip
 * window), and each ask past the first is the same numbers again.
 * Deliberately a plain counter rather than a signal: the memo spares
 * duplicate reads, it does not schedule anything.
 */
let geometryGeneration = 0;

/**
 * Start a new geometry generation: whatever was read before it may have
 * moved.
 *
 * @returns {void}
 */
export function invalidateGeometry() {
  geometryGeneration += 1;
}

/**
 * @returns {number}
 */
export function getGeometryGeneration() {
  return geometryGeneration;
}

/**
 * Which reading of the chains above the frames is current. A frame whose
 * own count differs reads its chain again on its next use.
 */
let chainEpoch = 0;

/**
 * How many portals are up, so the window is listened to while any is.
 */
let watchers = 0;

/** @type {AddEventListenerOptions} */
const PAGE_LISTENER = { capture: true, passive: true };

/**
 * A scroll on the page around the panels. One inside a panel is the
 * mirror's, which starts its own generation (`DomMirror.scrolled`).
 *
 * @param {Event} event
 * @returns {void}
 */
function onPageScroll(event) {
  if (event.target instanceof Node && getPortalRoot(event.target)) {
    return;
  }
  invalidateGeometry();
}

/**
 * The window resized, which may rescale a page that fits itself to it.
 *
 * @returns {void}
 */
function onResize() {
  invalidateGeometry();
  invalidatePanelFrames();
}

/**
 * Start a new geometry generation whenever the page scrolls or the window
 * resizes, for as long as the returned function has not been called, and
 * read every frame's chain again on a resize and now, since the caller is a
 * portal claiming a root. A scroll moves every client rect on the page and
 * a resize may rescale the panel, and neither is a mutation the portal
 * hears, so a rect read before one must not be subtracted from one read
 * after it. Captured, so a scroller on the page around the panel counts as
 * the window does.
 *
 * @returns {() => void}
 */
export function watchPageGeometry() {
  invalidatePanelFrames();
  if (watchers === 0) {
    window.addEventListener("scroll", onPageScroll, PAGE_LISTENER);
    window.addEventListener("resize", onResize, PAGE_LISTENER);
  }
  watchers += 1;
  let watching = true;
  return () => {
    if (!watching) {
      return;
    }
    watching = false;
    watchers -= 1;
    if (watchers === 0) {
      window.removeEventListener("scroll", onPageScroll, PAGE_LISTENER);
      window.removeEventListener("resize", onResize, PAGE_LISTENER);
    }
  };
}

/**
 * The scale a panel is drawn at on the page, and where its root is.
 *
 * @typedef {object} PanelFrame
 * @property {number} epoch The `chainEpoch` the scale was last read in, or
 *   -1 when it is to be read again.
 * @property {number} sx Client px per layout px, across.
 * @property {number} sy Client px per layout px, down.
 * @property {number} left The root's client corner, as last probed (see
 *   `probePanelFrame`); 0,0 until it has been.
 * @property {number} top
 */

/**
 * A client rect divided by its frame's scale, as a plain object: a
 * `DOMRect` is not one, and the selector proxy cannot look inside it.
 *
 * @typedef {object} FramedRect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 * @property {number} width
 * @property {number} height
 */

/** @type {WeakMap<Element, PanelFrame>} */
const frames = new WeakMap();

/** The roots that have warned, so each warns once. */
const warned = new WeakSet();

/**
 * @param {Element} base
 * @returns {PanelFrame}
 */
function frameRecord(base) {
  let frame = frames.get(base);
  if (!frame) {
    frame = { epoch: -1, sx: 1, sy: 1, left: 0, top: 0 };
    frames.set(base, frame);
  }
  return frame;
}

/**
 * The six or sixteen numbers of a computed `matrix()` or `matrix3d()`, or
 * null for anything else. A browser computes every transform to one of the
 * two; jsdom passes the author's value through, which counts as none here
 * as it does for `hasTransform`.
 *
 * @param {string | undefined} value
 * @returns {number[] | null}
 */
export function matrixValues(value) {
  const match = value?.match(/^matrix(3d)?\(([^)]*)\)/);
  if (!match) {
    return null;
  }
  const values = match[2].split(",").map((part) => Number.parseFloat(part));
  if (values.some(Number.isNaN) || values.length !== (match[1] ? 16 : 6)) {
    return null;
  }
  return values;
}

/**
 * The factors a frame divides by for a scale of `x` across and `y` down,
 * or null for a flip. A scale of 0 draws nothing, so there is nothing to
 * divide and nothing to warn about: it counts as 1.
 *
 * @param {number} x
 * @param {number} y
 * @returns {[number, number] | null}
 */
function scaleFactors(x, y) {
  if (x < 0 || y < 0) {
    return null;
  }
  return [x || 1, y || 1];
}

/**
 * The scale a computed `transform` draws at, or null for one that also
 * turns, skews, flips or projects. A 3D matrix counts when it is a 2D scale
 * and translation and a depth: `translateZ` alone moves nothing on a page
 * with no perspective, and a perspective is refused where it is set. Its
 * last entry is the projective weight every point is divided by, so a
 * weight of 2 draws at half size.
 *
 * @param {string | undefined} value
 * @returns {[number, number] | null}
 */
function transformScale(value) {
  const m = matrixValues(value);
  if (!m) {
    return [1, 1];
  }
  if (m.length === 6) {
    const [a, b, c, d] = m;
    return b === 0 && c === 0 ? scaleFactors(a, d) : null;
  }
  const flat =
    m[1] === 0 &&
    m[2] === 0 &&
    m[3] === 0 &&
    m[4] === 0 &&
    m[6] === 0 &&
    m[7] === 0 &&
    m[8] === 0 &&
    m[9] === 0 &&
    m[11] === 0 &&
    m[15] > 0;
  return flat ? scaleFactors(m[0] / m[15], m[5] / m[15]) : null;
}

/**
 * The scale the CSS `scale` property draws at, or null for a flip.
 *
 * @param {string | undefined} value
 * @returns {[number, number] | null}
 */
function propertyScale(value) {
  if (isNone(value)) {
    return [1, 1];
  }
  const [x, y = x] = /** @type {string} */ (value).trim().split(/\s+/).map(Number.parseFloat);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    return [1, 1];
  }
  return scaleFactors(x, y);
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isNone(value) {
  return !value || value === "none";
}

/**
 * Whether a computed `rotate` turns anything. An element at rest after a
 * `rotate` animation, or set to `0deg` to be ready for one, computes to an
 * angle of zero, in any of its forms (`0deg`, `x 0deg`, `1 1 1 0deg`):
 * the angle is the last word, and a zero there is no rotation, as `scale:
 * 1` is no scale.
 *
 * @param {string | undefined} value
 * @returns {boolean}
 */
function rotates(value) {
  if (isNone(value)) {
    return false;
  }
  const words = /** @type {string} */ (value).trim().split(/\s+/);
  return Number.parseFloat(words[words.length - 1]) !== 0;
}

/**
 * A short name for an element in a warning: its tag and its id, or its
 * first class.
 *
 * @param {Element} element
 * @returns {string}
 */
export function describeElement(element) {
  if (element.id) {
    return `${element.localName}#${element.id}`;
  }
  const first = element.classList?.[0];
  return first ? `${element.localName}.${first}` : element.localName;
}

/**
 * Read the scale of `base`'s chain into `frame`: the product of every scale
 * from `base` up to `<html>`, or 1 where the chain carries something a
 * scale cannot undo, with a warning the first time a panel's root does.
 *
 * A `perspective` counts only above `base`. On the root it projects what is
 * inside the panel, which the mirror measures off layout offsets and draws
 * as real depth.
 *
 * @param {PanelFrame} frame
 * @param {Element} base
 * @returns {void}
 */
function readScale(frame, base) {
  let sx = 1;
  let sy = 1;
  /** @type {Element | null} */
  let carrier = null;
  let carried = "";
  for (
    let element = /** @type {Element | null} */ (base);
    element;
    element = element.parentElement
  ) {
    const style = window.getComputedStyle(element);
    const transform = transformScale(style.transform);
    const scale = propertyScale(style.scale);
    if (!transform || !scale || rotates(style.rotate)) {
      carrier = element;
      carried = !transform
        ? style.transform
        : !scale
          ? `scale: ${style.scale}`
          : `rotate: ${style.rotate}`;
      break;
    }
    if (element !== base && !isNone(style.perspective)) {
      carrier = element;
      carried = `perspective: ${style.perspective}`;
      break;
    }
    sx *= transform[0] * scale[0];
    sy *= transform[1] * scale[1];
  }
  frame.epoch = chainEpoch;
  if (!carrier) {
    frame.sx = sx;
    frame.sy = sy;
    return;
  }
  frame.sx = 1;
  frame.sy = 1;
  if (getPortalRoot(base) === base && !warned.has(base)) {
    warned.add(base);
    console.warn(
      `freedom: ${describeElement(base)} is mirrored through a transform on ` +
        `${describeElement(carrier)} (${carried}). A panel is measured as the page draws it, ` +
        "and a scale is divided out of that, but a rotation, a skew, a flip or a perspective is not, " +
        "so the panel is drawn distorted. Take the transform off while a session runs.",
      base,
      carrier,
    );
  }
}

/**
 * The frame of a node in a document with nothing to key a frame on, one
 * with no root element, as a `<template>`'s content is. Nothing in such a
 * document is drawn, so there is no scale to divide by.
 *
 * @type {PanelFrame}
 */
const UNDRAWN_FRAME = Object.freeze({ epoch: -1, sx: 1, sy: 1, left: 0, top: 0 });

/**
 * The frame `node` is measured in, its chain read if it is due: its panel
 * root's, or for a node outside any panel its document's body, or its root
 * element in a document with no body.
 *
 * @param {Node} node
 * @returns {PanelFrame}
 */
export function frameFor(node) {
  const document = node.ownerDocument;
  const base = getPortalRoot(node) ?? document?.body ?? document?.documentElement;
  if (!base) {
    return UNDRAWN_FRAME;
  }
  const frame = frameRecord(base);
  if (frame.epoch !== chainEpoch) {
    readScale(frame, base);
  }
  return frame;
}

/**
 * Have a panel root's frame read its chain again on its next use: the
 * root's reflow signal moved, and a `style`, a class or a transition may
 * have transformed it.
 *
 * @param {Element} root
 * @returns {void}
 */
export function invalidatePanelFrame(root) {
  frameRecord(root).epoch = -1;
}

/**
 * Have every frame read its chain again on its next use, after an event
 * that can transform anything above a root: a portal claiming a root, the
 * window resizing, or the document's stylesheets changing.
 *
 * @returns {void}
 */
export function invalidatePanelFrames() {
  chainEpoch += 1;
}

/**
 * A panel root's frame as last read, without reading anything: what a ray
 * moving every frame maps its point through. The record is the root's one
 * frame, so a caller may keep it and read it again after a probe.
 *
 * @param {Element} root
 * @returns {PanelFrame}
 */
export function getPanelFrame(root) {
  return frameRecord(root);
}

/**
 * Read where the page lays a panel's root out, and its scale, now. A client
 * rect is a layout read, and a forced one whenever the page has touched the
 * DOM since the last, so the ray's events that are one each probe, and its
 * moves take the frame as last probed (see `probePanel` in
 * `dragAndDrop.js`).
 *
 * @param {Element} root
 * @returns {PanelFrame}
 */
export function probePanelFrame(root) {
  const frame = frameRecord(root);
  readScale(frame, root);
  const rect = root.getBoundingClientRect();
  frame.left = rect.left;
  frame.top = rect.top;
  return frame;
}

/**
 * A client rect, divided by its frame's scale: in the frame's layout px,
 * with its origin at the viewport's, scaled the same way. Differences
 * between two rects read in one frame are layout distances, which is what
 * every reader takes.
 *
 * @param {Element | Range} target
 * @param {PanelFrame} frame From `frameFor`, for the node the target is in.
 * @returns {FramedRect}
 */
export function measureClientRect(target, frame) {
  return divide(target.getBoundingClientRect(), frame);
}

/**
 * A range's line boxes, as `getClientRects` reports them, divided as
 * `measureClientRect` divides.
 *
 * @param {Range} range
 * @param {PanelFrame} frame
 * @returns {FramedRect[]}
 */
export function measureClientRects(range, frame) {
  return Array.from(range.getClientRects(), (rect) => divide(rect, frame));
}

/**
 * @param {DOMRectReadOnly} rect
 * @param {PanelFrame} frame
 * @returns {FramedRect}
 */
function divide(rect, { sx, sy }) {
  return {
    left: rect.left / sx,
    top: rect.top / sy,
    right: rect.right / sx,
    bottom: rect.bottom / sy,
    width: rect.width / sx,
    height: rect.height / sy,
  };
}
