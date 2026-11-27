import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareCounts,
  compareTimes,
  countsCell,
  drawsSection,
  mirrorSection,
  parseTables,
} from "./report.js";

test("a count that every round agrees on and that did not move is not flagged", () => {
  assert.deepEqual(compareCounts([829, 829, 829], [829, 829, 829]), {
    base: "829",
    head: "829",
    verdict: "",
    kind: "same",
  });
});

test("a count that moved is flagged with its delta", () => {
  const compared = compareCounts([829, 829, 829], [1658, 1658, 1658]);
  assert.equal(compared.kind, "changed");
  assert.equal(compared.verdict, "**+829**");
  assert.equal(compareCounts([10, 10, 10], [7.5, 7.5, 7.5]).verdict, "**-2.5**");
});

test("a count that differs between rounds is shown as unsteady, not as a median", () => {
  const compared = compareCounts([829, 829, 829], [829, 830, 829]);
  assert.equal(compared.head, "varies 829–830");
  assert.equal(compared.verdict, "**unsteady**");
  assert.equal(compared.kind, "unsteady");
});

test("a count unsteady on both sides is unsteady, even when the spreads match", () => {
  assert.equal(compareCounts([4.2, 6.4, 5], [4.2, 6.4, 5]).kind, "unsteady");
});

test("the summary keeps unsteady counts apart from changed ones", () => {
  const steady = compareCounts([829, 829, 829], [829, 829, 829]);
  const moved = compareCounts([829, 829, 829], [1658, 1658, 1658]);
  const unsteady = compareCounts([829, 829, 829], [829, 830, 829]);
  assert.equal(countsCell([steady, steady]), "same");
  assert.equal(countsCell([steady, unsteady]), "1 unsteady");
  assert.equal(countsCell([moved, unsteady, unsteady]), "**1 changed**, 2 unsteady");
});

const five = (/** @type {number} */ from) => [0, 1, 2, 3, 4].map((i) => from + 3 * i);

test("times whose ranges overlap are no result", () => {
  assert.equal(compareTimes(five(30), five(31)).verdict, "no result");
});

test("times whose ranges stay apart are faster or slower", () => {
  assert.equal(compareTimes(five(30), five(5)).verdict, "faster");
  assert.equal(compareTimes(five(5), five(30)).verdict, "slower");
});

test("times from fewer than five rounds get no verdict, however far apart", () => {
  // Three rounds of the same code fall apart one time in ten.
  assert.equal(compareTimes([30, 33, 36], [9, 10, 12]).verdict, "");
  assert.equal(compareTimes([30, 31, 32, 33], [9, 10, 11, 12]).verdict, "");
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
  assert.doesNotMatch(section, /animated/);
});

test("an animated row that differs is set apart, not called a change", () => {
  // As the desk's Night Ops did with the same code on both sides: 154 a
  // frame in one run, 154.4 in the next, since its charts redraw on timers.
  const section = drawsSection(draws(20, 4), draws(20.4, 4.4));
  assert.doesNotMatch(section, /\*\*/);
  assert.match(section, /no change in the other 0 looks and apps and 1 panels/);
  assert.match(
    section,
    /2 animated, .* not counted as changes: desk \(20 → 20\.4\), desk: a \(4 → 4\.4\)\./,
  );
});

test("a change among animated rows is still listed", () => {
  const base = draws(20.4, 4.4).replace("| desk: b | 3 |", "| desk: b | 5 |");
  const section = drawsSection(base, draws(20, 4));
  assert.match(section, /\| desk: b \| \*\*5 → 3\*\* \|/);
  assert.match(section, /2 animated/);
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
  // Three rounds a side: times without a verdict, and a line saying so.
  assert.match(section, /without a verdict below 5 rounds/);
  // develop is the second side: 1658 reads and 62 - 30 above idle.
  assert.match(
    section,
    /\| `scroll` \| \*\*1 changed\*\* \| median: 32 \(30–34\) → 11 \(10–12\) \|  \|/,
  );
  assert.match(section, /\| `getBoundingClientRect` \| 1658 \| 829 \| \*\*-829\*\* \|/);
  assert.doesNotMatch(section, /WARNING/);
});

test("five rounds a side give times their verdict", () => {
  const data = mirror(825);
  data.repeat = 5;
  data.sides[0].runs = [40, 41, 42, 43, 44].map((gap) => round(825, 829, gap));
  data.sides[1].runs = [60, 61, 62, 63, 64].map((gap) => round(825, 1658, gap));
  const section = mirrorSection(data);
  assert.match(section, /median: 32 \(30–34\) → 12 \(10–14\) \| faster \|/);
  assert.doesNotMatch(section, /without a verdict/);
});

test("two sides that mirrored different workloads are warned about", () => {
  assert.match(mirrorSection(mirror(830)), /825 elements on develop and 830 on this pull request/);
});

test("a scenario whose only moving count is unsteady is not called changed", () => {
  const data = mirror(825);
  // One head round reads one fewer rect: a count that varied, not a change.
  data.sides[0].runs = [829, 828, 829].map((reads, i) => round(825, reads, 40 + i));
  data.sides[1].runs = [60, 62, 64].map((gap) => round(825, 829, gap));
  const section = mirrorSection(data);
  assert.match(section, /\| `scroll` \| 1 unsteady \|/);
  assert.doesNotMatch(section, /changed/);
});

test("a row on one side only is a change, even with a fraction", () => {
  const head = draws(20, 4).replace(
    "| desk: b | 3 | 3 | 0 | 0 |",
    "| desk: b | 3 | 3 | 0 | 0 |\n| desk: c | 4.4 | 4 | 0 | 0 |",
  );
  const section = drawsSection(draws(20, 4), head);
  assert.match(section, /\| desk: c \| \*\*— → 4\.4\*\* \|/);
  assert.doesNotMatch(section, /animated/);
});

test("at five rounds, a scenario short of a round says how many it had", () => {
  const data = mirror(825);
  data.repeat = 5;
  data.sides[0].runs = [40, 41, 42, 43, 44].map((gap) => round(825, 829, gap));
  data.sides[1].runs = [60, 61, 62, 63, 64].map((gap) => round(825, 1658, gap));
  delete data.sides[0].runs[4].scroll;
  assert.match(mirrorSection(data), /\| `scroll` \| .* \| 4 rounds \|/);
});
