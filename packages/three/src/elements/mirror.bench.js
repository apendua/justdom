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
 * The "app attr" column is an attribute the portal does not know the name
 * of, toggled on the first row. It costs what a class swap on the row costs,
 * since a stylesheet may select on it through `+` or `~`. The "transform"
 * column is an inline `style.transform` written on the first row, the motion
 * a gauge writes every frame, which moves no box and so should measure the
 * row and not the list: its rects stay at 3. Its evals still grow with the
 * list, because a `style` write restyles the row's siblings, as any author's
 * attribute does. The "loading" column is the portal's own flag toggled on
 * its container, above every element in the panel, and should cost nothing:
 * the mirror drops it.
 *
 * Run with:
 *   node --import ./src/test/setup-jsdom.js src/elements/mirror.bench.js
 *
 * Its "insert top" column on the list and "slide off" and "slide on" on
 * the boards are the two bench cases of phase 3 of
 * `docs/freedom-paint-order-plan.md`.
 *
 * `bench/mirror.baseline.txt` is what it printed on `develop` when the
 * architecture plan's regression net landed. Its counts are exact and can be
 * compared from any machine; its milliseconds only from the same one. It
 * predates the "insert top" column, which leaves the list one row longer,
 * with a new first row, for the columns after it, and the "transform"
 * sample's dropped style snapshot, without which it measured the
 * attribute's fan-out alone. The list's "app attr", "transform" and
 * "loading" columns, and "hover", compare with it only once it is taken
 * again.
 */

import * as THREE from "three";
import { Derived, Signal } from "@apendua/signal";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal } from "./portal.js";
import { LOADING_ATTRIBUTE } from "./mirror.js";
import { PORTAL_ATTRIBUTE } from "./portalRoot.js";
import { makeReveal } from "./reveal.js";
import { forgetStyle, makeCard, makeRow, pxOf, reads, relayout } from "../test/benchLayout.js";

// Every reactive evaluation in the process, counted. The wall-clock below is
// jsdom's; this number is the library's own and is what scales.
//
// `track` is the one funnel every evaluation goes through — it is what opens
// the scope a run's reads are recorded against — and it lives on the base
// class every signal and derived shares. This used to patch `run`, which is
// not a method of anything: the column read 0 in every row of every table
// below, which looks exactly like a portal that costs nothing.
let evaluations = 0;
/** @type {any} */
const nodePrototype = Object.getPrototypeOf(Derived.prototype);
const originalTrack = nodePrototype.track;
if (typeof originalTrack !== "function") {
  throw new Error("Cannot count evaluations: the reactive node has no `track`.");
}
/**
 * @this {unknown}
 * @param {...unknown} args
 * @returns {unknown}
 */
nodePrototype.track = function countingTrack(...args) {
  evaluations += 1;
  return originalTrack.apply(this, args);
};

// --------------------------------------------------------------------------

function nextMacrotask() {
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
async function sample(fn) {
  evaluations = 0;
  reads.rects = 0;
  reads.ranges = 0;
  const started = performance.now();
  await fn();
  await nextMacrotask();
  return {
    evaluations,
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

const SIZES = [100, 200, 400, 800];

// Warm-up: the first size must not also pay for module init and JIT.
await measure({ rows: 50 });

for (const clipped of [false, true]) {
  console.log(
    clipped
      ? "\n=== the list inside a fixed-height overflow:hidden box ==="
      : "=== the list in normal flow ===",
  );
  console.log(
    "rows\t| mount: evals\trects\tms\t| +1 row: evals\trects\tms\t| insert top: evals\trects\tms" +
      "\t| hover: evals\trects" +
      "\t| app attr: evals\trects\t| transform: evals\trects\t| loading: evals\trects",
  );
  for (const rows of SIZES) {
    const { mount, one, insert, hover, appAttribute, transform, loadingFlag } = await measure({
      rows,
      clipped,
    });
    console.log(
      `${rows}\t| ${mount.evaluations}\t${mount.rectReads}\t${mount.ms.toFixed(0)}\t| ` +
        `${one.evaluations}\t${one.rectReads}\t${one.ms.toFixed(1)}\t| ` +
        `${insert.evaluations}\t${insert.rectReads}\t${insert.ms.toFixed(1)}\t| ` +
        `${hover.evaluations}\t${hover.rectReads}\t| ` +
        `${appAttribute.evaluations}\t${appAttribute.rectReads}\t| ` +
        `${transform.evaluations}\t${transform.rectReads}\t| ` +
        `${loadingFlag.evaluations}\t${loadingFlag.rectReads}`,
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
async function measureBoard({ cards, piled, translucent = false }) {
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

// What the fade column toggles, on a board's cards and nowhere else.
const fadeRule = document.createElement("style");
fadeRule.textContent = ".board > [data-xr-active] { opacity: 0.5; }";
document.head.appendChild(fadeRule);

for (const [title, options] of /** @type {const} */ ([
  ["a board of positioned cards, apart", { piled: false }],
  ["a board of positioned cards, piled on each other", { piled: true }],
  ["a board of translucent cards, piled on each other", { piled: true, translucent: true }],
])) {
  console.log(`\n=== ${title} ===`);
  console.log(
    "cards\t| mount: evals\trects\tms\t| +1 card: evals\trects\tms" +
      "\t| move first: evals\trects\tms\t| slide off: evals\trects\tms\t| slide on: evals\trects\tms" +
      "\t| raise first: evals\trects\tms\t| hover: evals\trects" +
      "\t| fade: evals\trects",
  );
  for (const cards of [25, 50, 100, 200]) {
    const { mount, one, move, slideOff, slideOn, raise, hover, fade } = await measureBoard({
      cards,
      ...options,
    });
    console.log(
      `${cards}\t| ${mount.evaluations}\t${mount.rectReads}\t${mount.ms.toFixed(0)}\t| ` +
        `${one.evaluations}\t${one.rectReads}\t${one.ms.toFixed(1)}\t| ` +
        `${move.evaluations}\t${move.rectReads}\t${move.ms.toFixed(1)}\t| ` +
        `${slideOff.evaluations}\t${slideOff.rectReads}\t${slideOff.ms.toFixed(1)}\t| ` +
        `${slideOn.evaluations}\t${slideOn.rectReads}\t${slideOn.ms.toFixed(1)}\t| ` +
        `${raise.evaluations}\t${raise.rectReads}\t${raise.ms.toFixed(1)}\t| ` +
        `${hover.evaluations}\t${hover.rectReads}\t| ` +
        `${fade.evaluations}\t${fade.rectReads}`,
    );
  }
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
