/**
 * The count gate: what `mirror.bench.js` measures at 100 rows and 100 cards,
 * held to ceilings on every build.
 *
 * Reactive evaluations and layout reads are exact for a given lockfile, so
 * each case asserts both against the number in `CEILINGS`. A count over its
 * ceiling fails: either the change made a case dearer, which the pull request
 * explains as it raises the ceiling, or it is a bug. A count more than 5%
 * under its ceiling fails too, so an improvement lowers its ceiling in the
 * pull request that makes it and cannot be spent later without anyone
 * seeing. CONTRIBUTING.md says how to update a ceiling.
 *
 * A bump of jsdom, or of anything else the counts run through, can move a
 * count with no change to the package. The failure message is the same, and
 * so is the remedy.
 *
 * The cases run in one process, one after another, and each one mounts its
 * own portal and resets the counters (`sample` in `benchCases.js`), so no
 * count depends on what ran before it.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { measureBoard, measureList } from "../test/benchCases.js";

/**
 * @typedef {object} Ceiling
 * @property {number} evaluations
 * @property {number} rectReads
 */

/**
 * The counts measured on develop at 291de63, and lowered since by the
 * change that says so. The list's are its table "in normal flow" at 100
 * rows; the board's, the piled board at 100 cards. "app attr", "transform"
 * and the board's three came down when an author's attribute stopped
 * restyling the siblings no rule could carry it to (`getSiblingReach`).
 * "mount", "+1 row" and "insert top" rose by one evaluation a box when a
 * box that paints nothing stopped taking an instance: the
 * `VisualProperties.paints` memo that decides it.
 */
const CEILINGS = {
  list: {
    mount: { evaluations: 30332, rectReads: 203 },
    "+1 row": { evaluations: 356, rectReads: 5 },
    "insert top": { evaluations: 4562, rectReads: 106 },
    hover: { evaluations: 36, rectReads: 0 },
    "app attr": { evaluations: 381, rectReads: 106 },
    transform: { evaluations: 78, rectReads: 3 },
  },
  board: {
    "move first": { evaluations: 183, rectReads: 3 },
    "slide off": { evaluations: 79, rectReads: 3 },
    "slide on": { evaluations: 79, rectReads: 3 },
  },
};

/** How far under its ceiling a count may fall before the ceiling must move. */
const SLACK = 0.05;

/**
 * @param {string} name
 * @param {number} measured
 * @param {number} ceiling
 * @returns {void}
 */
function assertCeiling(name, measured, ceiling) {
  assert.ok(
    measured <= ceiling,
    `${name}: ${measured}, over its ceiling of ${ceiling}. If the rise is meant, ` +
      `explain it in the pull request and raise the ceiling to ${measured} in CEILINGS.`,
  );
  assert.ok(
    measured >= ceiling * (1 - SLACK),
    `${name}: ${measured}, more than ${SLACK * 100}% under its ceiling of ${ceiling}. ` +
      `If this is an improvement, lower the ceiling to ${measured} in CEILINGS.`,
  );
}

/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, Ceiling>} ceilings
 * @param {Record<string, Ceiling>} measured
 * @returns {Promise<void>}
 */
async function assertCases(t, ceilings, measured) {
  for (const [name, ceiling] of Object.entries(ceilings)) {
    await t.test(name, () => {
      const sample = measured[name];
      assertCeiling(`${name}, evaluations`, sample.evaluations, ceiling.evaluations);
      assertCeiling(`${name}, layout reads`, sample.rectReads, ceiling.rectReads);
    });
  }
}

describe("the bench's counts stay under their ceilings", () => {
  test("a list of 100 rows", async (t) => {
    const { mount, one, insert, hover, appAttribute, transform } = await measureList({
      rows: 100,
    });
    await assertCases(t, CEILINGS.list, {
      mount,
      "+1 row": one,
      "insert top": insert,
      hover,
      "app attr": appAttribute,
      transform,
    });
  });

  test("a board of 100 piled cards", async (t) => {
    const { move, slideOff, slideOn } = await measureBoard({ cards: 100, piled: true });
    await assertCases(t, CEILINGS.board, {
      "move first": move,
      "slide off": slideOff,
      "slide on": slideOn,
    });
  });
});
