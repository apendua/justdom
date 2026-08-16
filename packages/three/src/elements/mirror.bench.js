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
 * A stand-in layout engine: every element keeps a stable, non-degenerate box,
 * so `resized()` and the equality gates behave the way they would against a
 * real one — and every read is counted.
 *
 * @type {WeakMap<Element, { left: number, top: number, width: number, height: number }>}
 */
const layoutOf = new WeakMap();
let rectReads = 0;
let nextTop = 0;
window.Element.prototype.getBoundingClientRect = function () {
  rectReads += 1;
  let box = layoutOf.get(this);
  if (!box) {
    box = { left: 0, top: nextTop, width: 200, height: 20 };
    nextTop += 20;
    layoutOf.set(this, box);
  }
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
  await nextMacrotask();

  const mount = await sample(async () => {
    for (let i = 0; i < rows; i++) {
      list.appendChild(makeRow(i));
      if (perFlush) {
        await nextMacrotask();
      }
    }
  });

  // One more row, on a panel that already has `rows` of them.
  const one = await sample(() => {
    list.appendChild(makeRow(rows));
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
