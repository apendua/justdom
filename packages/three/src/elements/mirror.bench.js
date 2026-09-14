/**
 * What one mutation costs a portal, as a function of how much the portal is
 * already mirroring.
 *
 * The mirror's cost model says a structural change is portal-wide: layout is
 * non-local, so everything re-measures and the equality gates stop the
 * propagation wherever nothing moved. This measures the other half of that
 * sentence — the part the gates do *not* stop, which is the re-measurement
 * itself. Each row of the tables below is one panel of `rows` rows, and the
 * numbers are what a single flush costs on it: reactive evaluations,
 * `getBoundingClientRect` calls, and wall-clock.
 *
 * Read the "+1 row" and "hover" columns against `rows`: if they grow with the
 * panel, then mounting a panel one flush at a time is quadratic in its size.
 *
 * Run with:
 *   node --import ./src/test/setup-jsdom.js src/elements/mirror.bench.js
 */

import * as THREE from "three";
import { Derived, Signal } from "@apendua/signal";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal } from "./portal.js";
import { PORTAL_ATTRIBUTE } from "./mirror.js";
import { makeReveal } from "./reveal.js";

// --- jsdom stand-ins for the pieces of a browser the portal reaches for ----

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
// which is the path this benchmark measures.
globalThis.requestAnimationFrame = /** @type {never} */ (undefined);
globalThis.cancelAnimationFrame = /** @type {never} */ (undefined);

// jsdom lays nothing out, so a Range measures nothing either. A monospace
// face on one line is enough of a stand-in, and it has to be a function of the
// range's own offsets rather than a constant: the last table below asks what a
// character boundary costs, and a rect that ignored the offsets would say it
// was free. jsdom does implement the offsets themselves.
const GLYPH_WIDTH = 8;
const GLYPH_HEIGHT = 16;
let rangeReads = 0;
window.Range.prototype.getBoundingClientRect = function () {
  rangeReads += 1;
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
 * its children, everything is 200px wide. Recomputed by `relayout` after each
 * mutation — outside the counters, since a browser does this work in its own
 * layout pass rather than in the reads the mirror is charged for.
 *
 * @type {WeakMap<Element, { left: number, top: number, width: number, height: number }>}
 */
const layoutOf = new WeakMap();
let rectReads = 0;

const LEAF_HEIGHT = 20;
const BOX_WIDTH = 200;

/**
 * @param {Element} element
 * @returns {number}
 */
function measureSubtree(element) {
  let height = 0;
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
    height += measureSubtree(child);
  }
  const box = layoutOf.get(element) ?? { left: 0, top: 0, width: BOX_WIDTH, height: 0 };
  box.height = height || LEAF_HEIGHT;
  box.width = BOX_WIDTH;
  layoutOf.set(element, box);
  return box.height;
}

/**
 * @param {Element} element
 * @param {number} top
 * @returns {void}
 */
function placeSubtree(element, top) {
  const box = /** @type {{ left: number, top: number, width: number, height: number }} */ (
    layoutOf.get(element)
  );
  box.left = 0;
  box.top = top;
  let offset = top;
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
    placeSubtree(child, offset);
    offset += /** @type {{ height: number }} */ (layoutOf.get(child)).height;
  }
}

/**
 * @param {Element} root
 * @returns {void}
 */
function relayout(root) {
  measureSubtree(root);
  placeSubtree(root, 0);
}

window.Element.prototype.getBoundingClientRect = function () {
  rectReads += 1;
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

// Every reactive evaluation in the process, counted. The wall-clock below is
// jsdom's; this number is the library's own and is what scales. `run` is the
// one funnel every evaluation goes through, and it lives on the base class
// every signal and derived shares.
let evaluations = 0;
/** @type {any} */
const computationPrototype = Object.getPrototypeOf(Derived.prototype);
const originalRun = computationPrototype.run;
/**
 * @this {unknown}
 * @param {...unknown} args
 * @returns {unknown}
 */
computationPrototype.run = function (...args) {
  evaluations += 1;
  return originalRun.apply(this, args);
};

// --------------------------------------------------------------------------

function nextMacrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param {number} index
 * @returns {HTMLElement}
 */
function makeRow(index) {
  const row = document.createElement("div");
  row.className = "row";
  const label = document.createElement("span");
  label.textContent = `row ${index}`;
  row.appendChild(label);
  return row;
}

/**
 * @typedef {object} Sample
 * @property {number} evaluations
 * @property {number} rectReads Element rects. Range reads are counted
 *   separately, since only the typing table below is about them.
 * @property {number} rangeReads
 * @property {number} ms
 */

/**
 * @param {() => void | Promise<void>} fn
 * @returns {Promise<Sample>}
 */
async function sample(fn) {
  evaluations = 0;
  rectReads = 0;
  rangeReads = 0;
  const started = performance.now();
  await fn();
  await nextMacrotask();
  return { evaluations, rectReads, rangeReads, ms: performance.now() - started };
}

/**
 * @param {object} options
 * @param {number} options.rows
 * @param {boolean} [options.clipped] Put the list inside a fixed-height
 *   `overflow: hidden` box — the wall the layout boundary is supposed to be.
 * @param {boolean} [options.perFlush] Append each row in a flush of its own,
 *   the way a list that streams in does.
 */
async function measure({ rows, clipped = false, perFlush = false }) {
  const manager = new InteractionManager();
  const ctx = InteractionContext.set({}, manager);
  const portal = createPortal(ctx);
  portal.addTo(new THREE.Group());
  const containers = document.querySelectorAll(`[${PORTAL_ATTRIBUTE}]`);
  const containerElement = /** @type {HTMLElement} */ (containers[containers.length - 1]);

  const list = document.createElement("div");
  if (clipped) {
    const scroller = document.createElement("div");
    scroller.style.overflow = "hidden";
    scroller.style.height = "200px";
    scroller.appendChild(list);
    containerElement.appendChild(scroller);
  } else {
    containerElement.appendChild(list);
  }
  relayout(containerElement);
  await nextMacrotask();

  /**
   * @param {number} index
   * @returns {void}
   */
  const appendRow = (index) => {
    list.appendChild(makeRow(index));
    // The browser would have re-laid-out before anyone could read a rect;
    // the fixture has to do the same, or the list never gets taller and the
    // measurement is of a layout that could not happen.
    relayout(containerElement);
  };

  const mount = await sample(async () => {
    for (let i = 0; i < rows; i++) {
      appendRow(i);
      if (perFlush) {
        await nextMacrotask();
      }
    }
  });

  // One more row, on a panel that already has `rows` of them.
  const one = await sample(() => {
    appendRow(rows);
  });

  // And one hover flag, which the portal declares presentational: no
  // re-measure is owed, so whatever this costs is the restyle fan-out alone.
  const hover = await sample(() => {
    /** @type {HTMLElement} */ (list.firstChild).dataset.xrHover = "true";
  });

  portal.disconnect();
  containerElement.remove();
  return { mount, one, hover };
}

const SIZES = [100, 200, 400, 800];

// Warm-up: the first size must not also pay for module init and JIT.
await measure({ rows: 50 });

for (const clipped of [false, true]) {
  console.log(
    clipped
      ? "\n=== the list inside a fixed-height overflow:hidden box ==="
      : "=== the list in normal flow ===",
  );
  console.log("rows\t| mount: evals\trects\tms\t| +1 row: evals\trects\tms\t| hover: evals\trects");
  for (const rows of SIZES) {
    const { mount, one, hover } = await measure({ rows, clipped });
    console.log(
      `${rows}\t| ${mount.evaluations}\t${mount.rectReads}\t${mount.ms.toFixed(0)}\t| ` +
        `${one.evaluations}\t${one.rectReads}\t${one.ms.toFixed(1)}\t| ` +
        `${hover.evaluations}\t${hover.rectReads}`,
    );
  }
}

console.log("\n=== the same panel, built one row per flush ===");
console.log("rows\tevals\trects\tms");
for (const rows of SIZES) {
  const { mount } = await measure({ rows, perFlush: true });
  console.log(`${rows}\t${mount.evaluations}\t${mount.rectReads}\t${mount.ms.toFixed(0)}`);
}

/**
 * The other thing a portal is asked to do with text: draw a little more of it
 * every tick.
 *
 * Two ways of asking, on the same panel. The first is the one that needs no
 * help from the renderer — a text node whose data grows by a character — and
 * it pays for a mutation, a re-measurement, a rasterization and an upload,
 * every tick, in proportion to how long the text already is. The second is
 * `reveal`: the node holds the whole text from the first frame, and the tick
 * moves a cursor. What that costs is the point of the exercise.
 *
 * The mount column is the price of the second one: a range read per
 * character, once. Read it against the per-character cost beside it to see
 * how many characters have to be typed before it has paid for itself.
 *
 * @param {object} options
 * @param {number} options.characters
 */
async function measureTyping({ characters }) {
  const manager = new InteractionManager();
  const ctx = InteractionContext.set({}, manager);
  const portal = createPortal(ctx);
  portal.addTo(new THREE.Group());
  const containers = document.querySelectorAll(`[${PORTAL_ATTRIBUTE}]`);
  const containerElement = /** @type {HTMLElement} */ (containers[containers.length - 1]);

  const body = "x".repeat(characters);

  // The letter as it is written today.
  const rewritten = document.createElement("p");
  const growing = document.createTextNode(body.slice(0, characters - 1));
  rewritten.appendChild(growing);

  // And as a reveal.
  const cursor = Signal.of(characters - 1);
  const reveal = makeReveal(() => cursor.get());
  const revealed = document.createElement("p");
  const placeholder = document.createComment("");
  revealed.appendChild(placeholder);
  /** @type {import('../core.js').Mountable | undefined} */
  let mountable;
  const subscription = reveal.text`${body}`.subscribe({
    next: (value) => {
      mountable = value;
    },
  });
  /** @type {import('../core.js').Mountable} */ (mountable).replace([placeholder, placeholder]);

  const mount = await sample(async () => {
    containerElement.appendChild(rewritten);
    containerElement.appendChild(revealed);
    relayout(containerElement);
    await nextMacrotask();
  });

  const rewrite = await sample(() => {
    growing.data = body;
    relayout(containerElement);
  });

  const move = await sample(() => {
    cursor.set(characters);
  });

  subscription.unsubscribe();
  portal.disconnect();
  containerElement.remove();
  return { mount, rewrite, move };
}

console.log("\n=== one more character of a letter, rewritten versus revealed ===");
console.log(
  "chars\t| mount: evals\tranges\tms\t| rewrite: evals\tranges\trects\tms\t| reveal: evals\tranges\trects\tms",
);
for (const characters of [100, 400, 1600]) {
  const { mount, rewrite, move } = await measureTyping({ characters });
  console.log(
    `${characters}\t| ${mount.evaluations}\t${mount.rangeReads}\t${mount.ms.toFixed(0)}\t| ` +
      `${rewrite.evaluations}\t${rewrite.rangeReads}\t${rewrite.rectReads}\t${rewrite.ms.toFixed(1)}\t| ` +
      `${move.evaluations}\t${move.rangeReads}\t${move.rectReads}\t${move.ms.toFixed(1)}`,
  );
}
