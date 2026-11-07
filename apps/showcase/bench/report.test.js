import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCounts, compareTimes, drawsSection, mirrorSection, parseTables } from "./report.js";

test("a count that every round agrees on and that did not move is not flagged", () => {
  assert.deepEqual(compareCounts([829, 829, 829], [829, 829, 829]), {
    base: "829",
    head: "829",
    verdict: "",
    changed: false,
  });
});

test("a count that moved is flagged with its delta", () => {
  const compared = compareCounts([829, 829, 829], [1658, 1658, 1658]);
  assert.equal(compared.changed, true);
  assert.equal(compared.verdict, "**+829**");
  assert.equal(compareCounts([10, 10, 10], [7.5, 7.5, 7.5]).verdict, "**-2.5**");
});

test("a count that differs between rounds is shown as unsteady, not as a median", () => {
  const compared = compareCounts([829, 829, 829], [829, 830, 829]);
  assert.equal(compared.head, "varies 829–830");
  assert.equal(compared.verdict, "**unsteady**");
});

test("times whose ranges overlap are no result", () => {
  assert.equal(compareTimes([30, 33, 36], [31, 34, 40]).verdict, "no result");
});

test("times whose ranges stay apart are faster or slower", () => {
  assert.equal(compareTimes([30, 33, 36], [9, 10, 12]).verdict, "faster");
  assert.equal(compareTimes([9, 10, 12], [30, 33, 36]).verdict, "slower");
});

test("times from too few rounds get no verdict, however far apart", () => {
  assert.equal(compareTimes([30], [9]).verdict, "fewer than 3 rounds");
  assert.equal(compareTimes([30], [9]).base, "30");
  assert.equal(compareTimes([30, 33, 36], [9, 10, 12]).base, "33 (30–36)");
});

test("a bench's tables are read by the first cell of their header", () => {
  const tables = parseTables(
    [
      "| Panel | Draws |",
      "| ----- | ----- |",
      "| desk: a | 4 |",
      "",
      "| Look or app | A frame |",
      "| ----------- | ------- |",
      "| desk | 12.5 |",
    ].join("\n"),
  );
  assert.deepEqual(tables.get("Panel"), [["desk: a", "4"]]);
  assert.deepEqual(tables.get("Look or app"), [["desk", "12.5"]]);
});

const draws = (/** @type {number} */ frame, /** @type {number} */ panel) =>
  [
    "| Panel | Draws | Counted, one batch by node | Blank | Re-packed |",
    "| ----- | ----- | -------------------------- | ----- | --------- |",
    `| desk: a | ${panel} | ${panel} | 0 | 0 |`,
    "| desk: b | 3 | 3 | 0 | 0 |",
    "",
    "| Look or app | A frame | Panels, one eye |",
    "| ----------- | ------- | --------------- |",
    `| desk | ${frame} | ${panel + 3} |`,
  ].join("\n");

test("draw calls the same on both sides say so in one line", () => {
  assert.equal(
    drawsSection(draws(20, 4), draws(20, 4)),
    "Draw calls: the same on both sides, in all 1 looks and apps and all 2 panels.",
  );
});

test("draw calls list only the rows that moved", () => {
  const section = drawsSection(draws(20, 4), draws(18, 3));
  assert.match(section, /\| desk \| \*\*20 → 18\*\* \| \*\*7 → 6\*\* \|/);
  assert.match(section, /\| desk: a \| \*\*4 → 3\*\* \| \*\*4 → 3\*\* \| 0 \| 0 \|/);
  assert.doesNotMatch(section, /desk: b/);
  assert.match(section, /0 looks or apps and 1 panels did not change/);
});

/**
 * @param {number} rows
 * @param {number} reads
 * @param {number} gap
 */
const round = (rows, reads, gap) => ({
  scroll: {
    rows,
    counts: { getBoundingClientRect: reads, thrash: 0, fillText: 1, canvasCreated: 0 },
    timing: { median: gap, p90: gap, worst: gap },
  },
  idle: {
    rows,
    counts: { getBoundingClientRect: 0, thrash: 0, fillText: 1, canvasCreated: 0 },
    timing: { median: 30, p90: 30, worst: 30 },
  },
});

const mirror = (/** @type {number} */ headRows) => ({
  app: "todo",
  repeat: 3,
  scenarios: [
    { name: "scroll", what: "one scroll per frame", bursts: 0 },
    { name: "idle", what: "no stimulus at all", bursts: 0 },
  ],
  sides: [
    { label: "working tree", runs: [40, 41, 42].map((gap) => round(headRows, 829, gap)) },
    { label: "origin/develop", runs: [60, 62, 64].map((gap) => round(825, 1658, gap)) },
  ],
});

test("the mirror section reads the first side as this pull request, net of idle", () => {
  const section = mirrorSection(mirror(825));
  // develop is the second side: 1658 reads and 62 - 30 above idle.
  assert.match(
    section,
    /\| `scroll` \| \*\*1 changed\*\* \| median: 32 \(30–34\) → 11 \(10–12\) \| faster \|/,
  );
  assert.match(section, /\| `getBoundingClientRect` \| 1658 \| 829 \| \*\*-829\*\* \|/);
  assert.doesNotMatch(section, /WARNING/);
});

test("two sides that mirrored different workloads are warned about", () => {
  assert.match(mirrorSection(mirror(830)), /825 elements on develop and 830 on this pull request/);
});
