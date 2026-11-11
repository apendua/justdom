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
 * of, toggled on the first row. No rule of the bench's document names it in
 * a sibling selector, so it restyles the row alone (`getSiblingReach` in
 * `documentStyles.js`); its rects grow with the list, since the rows after
 * it re-measure where they are. The "transform" column is an inline
 * `style.transform` written on the first row, the motion a gauge writes
 * every frame, which moves no box and so measures the row and not the list,
 * in evals as in rects. The "loading" column is the portal's own flag
 * toggled on its container, above every element in the panel, and should
 * cost nothing: the mirror drops it.
 *
 * Run with:
 *   node --import ./src/test/setup-jsdom.js src/elements/mirror.bench.js
 *
 * The list and board cases are built in `test/benchCases.js`, which
 * `mirrorCounts.test.js` shares: that test holds the counts at 100 rows and
 * 100 cards to ceilings on every build.
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
import { Signal } from "justdom-signal";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal } from "./portal/portal.js";
import { PORTAL_ATTRIBUTE } from "./portal/portalRoot.js";
import { makeReveal } from "./reveal.js";
import { relayout } from "../test/benchLayout.js";
import { measureBoard, measureList, nextMacrotask, sample } from "../test/benchCases.js";

const SIZES = [100, 200, 400, 800];

// Warm-up: the first size must not also pay for module init and JIT.
await measureList({ rows: 50 });

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
    const { mount, one, insert, hover, appAttribute, transform, loadingFlag } = await measureList({
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
  const { mount } = await measureList({ rows, perFlush: true });
  console.log(`${rows}\t${mount.evaluations}\t${mount.rectReads}\t${mount.ms.toFixed(0)}`);
}

// The boards and their columns are described at `measureBoard`.
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
