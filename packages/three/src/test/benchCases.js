/**
 * The cases `mirror.bench.js` measures, built here so that the bench and the
 * count gate (`elements/mirrorCounts.test.js`) run the same code: a list of
 * rows and a board of positioned cards, each mounted on a fresh portal and
 * then changed one way at a time, with what each change cost.
 *
 * Importing this counts every reactive evaluation in the process from then
 * on, and installs `benchLayout.js`'s stand-ins, so it goes after
 * `setup-jsdom.js`. The counts it reports are exact on any machine for a
 * given lockfile; its milliseconds are jsdom's, and comparable only on one
 * machine.
 */

import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal } from "../elements/portal.js";
import { LOADING_ATTRIBUTE } from "../elements/mirror.js";
import { PORTAL_ATTRIBUTE } from "../elements/portalRoot.js";
import { countEvaluations } from "./evaluations.js";
import { forgetStyle, makeCard, makeRow, pxOf, reads, relayout } from "./benchLayout.js";

// Every reactive evaluation in the process, counted. The wall-clock below is
// jsdom's; this number is the library's own and is what scales.
const evaluations = countEvaluations();

// --------------------------------------------------------------------------

/** @returns {Promise<void>} */
export function nextMacrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
export async function sample(fn) {
  evaluations.count = 0;
  reads.rects = 0;
  reads.ranges = 0;
  const started = performance.now();
  await fn();
  await nextMacrotask();
  return {
    evaluations: evaluations.count,
    rectReads: reads.rects,
    rangeReads: reads.ranges,
    ms: performance.now() - started,
  };
}

/**
 * @param {object} options
 * @param {number} options.rows
 * @param {boolean} [options.clipped] Put the list inside a fixed-height
 *   `overflow: hidden` box — the wall the layout boundary is supposed to be.
 * @param {boolean} [options.perFlush] Append each row in a flush of its own,
 *   the way a list that streams in does.
 */
export async function measureList({ rows, clipped = false, perFlush = false }) {
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

  // And one at the top, which moves every row after it: a row's place in the
  // walk is what its draw holds, so this re-packs the list where "+1 row"
  // re-packs nothing.
  const insert = await sample(() => {
    list.insertBefore(makeRow(-1), list.firstChild);
    relayout(containerElement);
  });

  // And one hover flag, which the portal declares presentational: no
  // re-measure is owed, so whatever this costs is the restyle fan-out alone.
  const hover = await sample(() => {
    /** @type {HTMLElement} */ (list.firstChild).dataset.xrHover = "true";
  });

  const appAttribute = await sample(() => {
    /** @type {HTMLElement} */ (list.firstChild).dataset.on = "true";
  });

  // As for the board's slides below: the snapshot is dropped for the row
  // whose style moves.
  const transform = await sample(() => {
    const first = /** @type {HTMLElement} */ (list.firstChild);
    forgetStyle(first);
    first.style.transform = "scaleX(0.5)";
  });

  const loadingFlag = await sample(async () => {
    containerElement.setAttribute(LOADING_ATTRIBUTE, "");
    await nextMacrotask();
    containerElement.removeAttribute(LOADING_ATTRIBUTE);
  });

  portal.disconnect();
  containerElement.remove();
  return { mount, one, insert, hover, appAttribute, transform, loadingFlag };
}

/**
 * A board of absolutely positioned cards, the case a list in flow never
 * reaches. A page paints positioned siblings over each other in tree order,
 * and the scene has to step a later card in front of each earlier one it
 * overlaps, which is a scan of the earlier siblings per card. This table is
 * what that scan costs.
 *
 * Three boards of the same cards. "apart" lays them out on a grid with a gap
 * between neighbours, so no card covers another and the scan finds nothing.
 * "piled" puts every card within a few px of the first, so each covers all
 * the cards before it. That is the worst case, where every comparison finds
 * an overlap. Each card also draws after every card under it
 * (`getDrawLevel` in elevation.js), a level of its own per card.
 * "translucent" is the same pile with a half-transparent background on
 * every card, which draws in the same order.
 *
 * The columns are one more card appended on top; the first card moved by a
 * pixel, which every later card's scan has read; the first card slid off
 * every card it covers by a `transform: translate`, and back on, which
 * changes what it clears and so the order of the cards after it without
 * moving its box; the first card re-appended, which is how a page brings a
 * card to the front; a hover flag on the last
 * card, which by then is the raised one; and the press flag on the same card,
 * which a stylesheet fades to half opacity. The hover moves nothing, and nor
 * does the fade's draw level: no card on these boards is opaque, faded or
 * not, so the fade costs only its restyle. Read them against `cards`: a
 * column that grows with the board is the scan.
 *
 * @param {object} options
 * @param {number} options.cards
 * @param {boolean} options.piled
 * @param {boolean} [options.translucent]
 */
export async function measureBoard({ cards, piled, translucent = false }) {
  addFadeRule();
  const manager = new InteractionManager();
  const ctx = InteractionContext.set({}, manager);
  const portal = createPortal(ctx);
  portal.addTo(new THREE.Group());
  const containers = document.querySelectorAll(`[${PORTAL_ATTRIBUTE}]`);
  const containerElement = /** @type {HTMLElement} */ (containers[containers.length - 1]);

  const board = document.createElement("div");
  board.className = "board";
  board.style.position = "relative";
  board.style.width = "1000px";
  board.style.height = "1000px";
  containerElement.appendChild(board);
  relayout(containerElement);
  await nextMacrotask();

  const mount = await sample(() => {
    for (let i = 0; i < cards; i++) {
      board.appendChild(makeCard(i, { piled, translucent }));
    }
    relayout(containerElement);
  });

  const one = await sample(() => {
    board.appendChild(makeCard(cards, { piled, translucent }));
    relayout(containerElement);
  });

  const first = /** @type {HTMLElement} */ (board.firstElementChild);
  const move = await sample(() => {
    first.style.left = `${(pxOf(first.style.left) ?? 0) + 1}px`;
    relayout(containerElement);
  });

  // The declaration a browser hands back is live; the snapshot is not, so
  // it is dropped for the card whose style moves, as for the fade below.
  const slideOff = await sample(() => {
    forgetStyle(first);
    first.style.transform = "translate(2000px, 2000px)";
  });

  const slideOn = await sample(() => {
    forgetStyle(first);
    first.style.transform = "";
  });

  const raise = await sample(() => {
    board.appendChild(first);
    relayout(containerElement);
  });

  const hover = await sample(() => {
    first.dataset.xrHover = "true";
  });

  const fade = await sample(() => {
    // The declaration a browser hands back is live; the snapshot above is
    // not, so it is dropped for the one element whose style moves.
    forgetStyle(first);
    first.dataset.xrActive = "true";
  });

  portal.disconnect();
  containerElement.remove();
  return { mount, one, move, slideOff, slideOn, raise, hover, fade };
}

/** What a board's fade column toggles, on its cards and nowhere else. */
let fadeRule = false;

/** @returns {void} */
function addFadeRule() {
  if (fadeRule) {
    return;
  }
  fadeRule = true;
  const rule = document.createElement("style");
  rule.textContent = ".board > [data-xr-active] { opacity: 0.5; }";
  document.head.appendChild(rule);
}
