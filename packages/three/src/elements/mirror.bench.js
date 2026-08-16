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
import { Derived } from "@apendua/signal";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal } from "./portal.js";
import { PORTAL_ATTRIBUTE } from "./mirror.js";

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
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// jsdom lays nothing out, so a Range measures nothing either: one line box
// per text node, the size a label would have had.
window.Range.prototype.getBoundingClientRect = function () {
  return /** @type {DOMRect} */ ({
    left: 0,
    top: 0,
    right: 100,
    bottom: 16,
    width: 100,
    height: 16,
  });
};
window.Range.prototype.getClientRects = function () {
  return /** @type {any} */ ([{ left: 0, top: 0, right: 100, bottom: 16, width: 100, height: 16 }]);
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
 * @property {number} rectReads
 * @property {number} ms
 */

/**
 * @param {() => void | Promise<void>} fn
 * @returns {Promise<Sample>}
 */
async function sample(fn) {
  evaluations = 0;
  rectReads = 0;
  const started = performance.now();
  await fn();
  await nextMacrotask();
  return { evaluations, rectReads, ms: performance.now() - started };
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
