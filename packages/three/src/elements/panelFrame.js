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
 * of the scales from its element up to `<html>`, read once per geometry
 * generation. A rotation, a skew or a perspective has no scale to divide by:
 * the frame then reads at 1, which is how every rect was read before frames
 * existed, and a panel's root warns once, naming the element that carries
 * it.
 *
 * Nothing else in `src` calls `getBoundingClientRect` or `getClientRects`,
 * and `panelFrame.test.js` fails the build when something does, because a
 * read anywhere else skips the frame.
 */

/**
 * Which "moment" of page geometry raw reads belong to. Bumped alongside
 * every dispatch that could move anything, and on the window scrolling or
 * resizing, it lets one settling of the reactive graph share a single
 * client rect per element: a portal-wide re-layout asks about each element
 * three or four times (position, size, a text's parent, a clip window), and
 * each ask past the first is the same numbers again. It also says when a
 * frame's scale is read again. Deliberately a plain counter rather than a
 * signal: the memo spares duplicate reads, it does not schedule anything.
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
 * How many portals are up, so the window is listened to while any is.
 */
let watchers = 0;

/** @type {AddEventListenerOptions} */
const PAGE_LISTENER = { capture: true, passive: true };

/**
 * Start a new geometry generation whenever the page scrolls or the window
 * resizes, for as long as the returned function has not been called. A
 * scroll moves every client rect on the page and a resize may rescale the
 * panel, and neither is a mutation the portal hears, so a rect read before
 * one must not be subtracted from one read after it. Captured, so a scroller
 * on the page around the panel counts as the window does.
 *
 * @returns {() => void}
 */
export function watchPageGeometry() {
  if (watchers === 0) {
    window.addEventListener("scroll", invalidateGeometry, PAGE_LISTENER);
    window.addEventListener("resize", invalidateGeometry, PAGE_LISTENER);
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
      window.removeEventListener("scroll", invalidateGeometry, PAGE_LISTENER);
      window.removeEventListener("resize", invalidateGeometry, PAGE_LISTENER);
    }
  };
}

/**
 * The scale a panel is drawn at on the page, and where its root is.
 *
 * @typedef {object} PanelFrame
 * @property {number} generation The geometry generation the scale was last
 *   read in.
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
    frame = { generation: -1, sx: 1, sy: 1, left: 0, top: 0 };
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
 * The scale a computed `transform` draws at, or null for one that also
 * turns, skews, flips or projects. A 3D matrix counts when it is a 2D scale
 * and translation and a depth: `translateZ` alone moves nothing on a page
 * with no perspective, and a perspective is refused where it is set.
 *
 * @param {string | undefined} value
 * @returns {[number, number] | null}
 */
function transformScale(value) {
  const m = matrixValues(value);
  if (!m) {
    return [1, 1];
  }
  const [a, b, c, d] = m.length === 6 ? m : [m[0], m[1], m[4], m[5]];
  const flat =
    m.length === 6 ||
    (m[2] === 0 &&
      m[3] === 0 &&
      m[6] === 0 &&
      m[7] === 0 &&
      m[8] === 0 &&
      m[9] === 0 &&
      m[11] === 0);
  return flat && b === 0 && c === 0 && a > 0 && d > 0 ? [a, d] : null;
}

/**
 * The scale the CSS `scale` property draws at, or null for a flip.
 *
 * @param {string | undefined} value
 * @returns {[number, number] | null}
 */
function propertyScale(value) {
  if (!value || value === "none") {
    return [1, 1];
  }
  const [x, y = x] = value.trim().split(/\s+/).map(Number.parseFloat);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    return [1, 1];
  }
  return x > 0 && y > 0 ? [x, y] : null;
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isNone(value) {
  return !value || value === "none";
}

/**
 * A short name for an element in a warning: its tag and its id, or its
 * first class.
 *
 * @param {Element} element
 * @returns {string}
 */
function describeElement(element) {
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
    if (!transform || !scale || !isNone(style.rotate)) {
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
  frame.generation = geometryGeneration;
  if (!carrier) {
    frame.sx = sx;
    frame.sy = sy;
    return;
  }
  frame.sx = 1;
  frame.sy = 1;
  if (base !== base.ownerDocument.body && !warned.has(base)) {
    warned.add(base);
    console.warn(
      `freedom: ${describeElement(base)} is mirrored through a transform on ` +
        `${describeElement(carrier)} (${carried}). A panel is measured as the page draws it, ` +
        "and a scale is divided out of that, but a rotation, a skew or a perspective is not, " +
        "so the panel is drawn distorted. Take the transform off while a session runs.",
      base,
      carrier,
    );
  }
}

/**
 * The frame `node` is measured in, its scale read for this geometry
 * generation: its panel root's, or the body's for a node outside any panel.
 *
 * @param {Node} node
 * @returns {PanelFrame}
 */
export function frameFor(node) {
  const base = getPortalRoot(node) ?? /** @type {Document} */ (node.ownerDocument).body;
  const frame = frameRecord(base);
  if (frame.generation !== geometryGeneration) {
    readScale(frame, base);
  }
  return frame;
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
 * A client rect as the browser reports it, in the viewport's px: for
 * something compared with an event's `clientX` and `clientY`, as the
 * renderer's canvas is, and never for a box a panel draws.
 *
 * @param {Element} element
 * @returns {DOMRect}
 */
export function measureViewportRect(element) {
  return element.getBoundingClientRect();
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
