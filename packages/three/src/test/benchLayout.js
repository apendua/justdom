/**
 * The stand-ins the jsdom benchmarks share, and the scenes they build: no
 * frame source, loaded fonts, a layout engine, a `Range` that measures, a
 * cached `getComputedStyle`, and the rows and cards of `mirror.bench.js`'s
 * tables. Importing this installs the stand-ins on jsdom's `window`, so it
 * goes after `setup-jsdom.js` and before anything that reads a rect.
 *
 * `paintOrderScenes.js` counts the draws of the same scenes for the
 * paint-order experiment, so both build them from here.
 */

/** The reads the stand-ins have answered, which a benchmark resets. */
export const reads = { rects: 0, ranges: 0 };

if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}
if (!document.fonts) {
  Object.defineProperty(document, "fonts", {
    value: {
      status: "loaded",
      ready: Promise.resolve(),
      addEventListener() {},
      removeEventListener() {},
    },
  });
}
// No frame source at all, deliberately: a `requestAnimationFrame` that exists
// but never fires would put the portal on its sliced mounting path and leave
// it waiting for frames forever. Absent, the portal mounts synchronously,
// which is the path the benchmarks measure.
globalThis.requestAnimationFrame = /** @type {never} */ (undefined);
globalThis.cancelAnimationFrame = /** @type {never} */ (undefined);

// jsdom lays nothing out, so a Range measures nothing either. A monospace
// face on one line is enough of a stand-in, and it has to be a function of the
// range's own offsets rather than a constant: the bench's typing table asks
// what a character boundary costs, and a rect that ignored the offsets would
// say it was free. jsdom does implement the offsets themselves.
const GLYPH_WIDTH = 8;
const GLYPH_HEIGHT = 16;
window.Range.prototype.getBoundingClientRect = function () {
  reads.ranges += 1;
  const left = this.startOffset * GLYPH_WIDTH;
  const right = this.endOffset * GLYPH_WIDTH;
  return /** @type {DOMRect} */ ({
    left,
    top: 0,
    right,
    bottom: GLYPH_HEIGHT,
    width: right - left,
    height: GLYPH_HEIGHT,
  });
};
window.Range.prototype.getClientRects = function () {
  return /** @type {any} */ ([this.getBoundingClientRect()]);
};

/**
 * A stand-in layout engine, and it has to be a real one: every interesting
 * question here is about which boxes a change actually moved, so a fixture
 * that hands out fixed boxes answers the wrong question. Appending a row must
 * make the list taller and push down whatever sits below it, exactly as a
 * browser would, or the mirror is being measured against a layout no browser
 * would produce.
 *
 * Block flow, top to bottom: a leaf is 20px tall, a container is as tall as
 * its children, and a box is 200px wide unless its style gives a width in px.
 * A `position: absolute` box is out of the flow: it adds nothing to its
 * parent's height and sits at its `left` and `top` inside its parent, which
 * is all a board of cards needs. Recomputed by `relayout` after each
 * mutation — outside the counters, since a browser does this work in its own
 * layout pass rather than in the reads the mirror is charged for.
 *
 * @type {WeakMap<Element, { left: number, top: number, width: number, height: number }>}
 */
const layoutOf = new WeakMap();

const LEAF_HEIGHT = 20;
const BOX_WIDTH = 200;

/**
 * @param {Element} element
 * @returns {boolean}
 */
function isAbsolute(element) {
  return /** @type {HTMLElement} */ (element).style?.position === "absolute";
}

/**
 * @param {string | undefined} length
 * @returns {number | undefined}
 */
export function pxOf(length) {
  return length?.endsWith("px") ? parseFloat(length) : undefined;
}

/**
 * @param {Element} element
 * @returns {number}
 */
function measureSubtree(element) {
  let height = 0;
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
    const childHeight = measureSubtree(child);
    if (!isAbsolute(child)) {
      height += childHeight;
    }
  }
  const box = layoutOf.get(element) ?? { left: 0, top: 0, width: BOX_WIDTH, height: 0 };
  // A box given a height keeps it, whatever is inside: the bench's clipped
  // table puts the list in a fixed-height scroller, and a stand-in that let
  // the scroller grow with the list would be measuring a wall that is not
  // there — every clip window inside it moving on every row, which no
  // browser would do to a box that said `height: 200px`.
  //
  // This changes what the clipped table reports. Before it, the table was
  // charging the mirror ten evaluations per row for the scroller's own
  // growth, on top of the twenty-five the open list paid: clipping never
  // cost anything extra, and the fixture was the entire difference. A
  // clipped figure from an older run is not comparable with one from here.
  const style = /** @type {HTMLElement} */ (element).style;
  box.height = pxOf(style?.height) ?? (height || LEAF_HEIGHT);
  box.width = pxOf(style?.width) ?? BOX_WIDTH;
  layoutOf.set(element, box);
  return box.height;
}

/**
 * @param {Element} element
 * @param {number} left
 * @param {number} top
 * @returns {void}
 */
function placeSubtree(element, left, top) {
  const box = /** @type {{ left: number, top: number, width: number, height: number }} */ (
    layoutOf.get(element)
  );
  box.left = left;
  box.top = top;
  let offset = top;
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
    if (isAbsolute(child)) {
      const style = /** @type {HTMLElement} */ (child).style;
      placeSubtree(child, left + (pxOf(style.left) ?? 0), top + (pxOf(style.top) ?? 0));
      continue;
    }
    placeSubtree(child, left, offset);
    offset += /** @type {{ height: number }} */ (layoutOf.get(child)).height;
  }
}

/**
 * @param {Element} root
 * @returns {void}
 */
export function relayout(root) {
  measureSubtree(root);
  placeSubtree(root, 0, 0);
}

window.Element.prototype.getBoundingClientRect = function () {
  reads.rects += 1;
  const box = layoutOf.get(this) ?? { left: 0, top: 0, width: BOX_WIDTH, height: LEAF_HEIGHT };
  return /** @type {DOMRect} */ ({
    left: box.left,
    top: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    width: box.width,
    height: box.height,
  });
};

// jsdom's own `getComputedStyle` reparses the cascade on every call, which
// would drown the thing being measured. One declaration per element instead,
// which is what a browser hands back anyway.
const realGetComputedStyle = window.getComputedStyle.bind(window);
/** @type {WeakMap<Element, CSSStyleDeclaration>} */
const styleCache = new WeakMap();
window.getComputedStyle = (element, pseudo) => {
  if (pseudo) {
    return realGetComputedStyle(element, pseudo);
  }
  let style = styleCache.get(element);
  if (!style) {
    style = realGetComputedStyle(element);
    styleCache.set(element, style);
  }
  return style;
};
globalThis.getComputedStyle = window.getComputedStyle;

/**
 * Drop the declaration cached for an element whose style a benchmark is
 * about to change: a browser's is live, and the cached one is not.
 *
 * @param {Element} element
 * @returns {void}
 */
export function forgetStyle(element) {
  styleCache.delete(element);
}

/**
 * @param {number} index
 * @returns {HTMLElement}
 */
export function makeRow(index) {
  const row = document.createElement("div");
  row.className = "row";
  const label = document.createElement("span");
  label.textContent = `row ${index}`;
  row.appendChild(label);
  return row;
}

/**
 * A card of a board: 40 px square, absolutely positioned, labelled.
 * Piled, it sits within a few px of the first card, so it covers every card
 * before it; apart, on a grid with a gap between neighbours.
 *
 * @param {number} index
 * @param {object} options
 * @param {boolean} options.piled
 * @param {boolean} [options.translucent] A half-transparent background.
 * @returns {HTMLElement}
 */
export function makeCard(index, { piled, translucent = false }) {
  const card = document.createElement("div");
  card.style.position = "absolute";
  card.style.width = "40px";
  card.style.height = "40px";
  const left = piled ? (index % 10) * 2 : (index % 20) * 50;
  const top = piled ? (index % 10) * 2 : Math.floor(index / 20) * 50;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  if (translucent) {
    card.style.background = "rgba(255, 255, 255, 0.5)";
  }
  const label = document.createElement("span");
  label.textContent = `card ${index}`;
  card.appendChild(label);
  return card;
}
