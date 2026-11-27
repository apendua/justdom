/**
 * The Benchmarks workflow's pull request comment, from what the two benches
 * printed and wrote: the mirror suite's `--json` file, and the tables
 * `packages/three/bench/paintOrderDraws.browser.mjs` printed on either side.
 *
 *   node bench/report.js --mirror mirror.json \
 *     --draws-base draws-develop.md --draws-head draws-head.md \
 *     --base <sha> --head <sha>
 *
 * Prints Markdown. Either half may be missing, and the comment then says so
 * rather than leaving the reader to wonder.
 *
 * The comment follows the mirror suite's README on what to believe. Counts
 * are the same run to run, so any change in one is real and is flagged.
 * Times are not: measuring identical code twice has differed by 17%, so a
 * time is given as a median with the range of its rounds. It is called
 * faster or slower only when both sides had `MIN_ROUNDS` rounds and the two
 * ranges stay apart; overlapping ranges are no result, not a small one.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fewest rounds a side needs before its times get a verdict. Two sets
 * of rounds of the same code fall wholly apart by chance one time in ten at
 * 3 rounds, about once a run across the report's rows, and one time in 126
 * at 5. The label's run takes 3 rounds and so shows times without verdicts;
 * a dispatch with `repeat` 5 is the timing check.
 */
export const MIN_ROUNDS = 5;

/** The mirror suite's counters, in the order its README explains them. */
const COUNTERS = ["getBoundingClientRect", "thrash", "fillText", "canvasCreated", "styleProperty"];

/**
 * @typedef {{ name: string, what: string, bursts: number }} Scenario
 * @typedef {{
 *   rows: number,
 *   counts: Record<string, number>,
 *   timing: { median: number, p90: number, worst: number },
 *   coherence?: { mismatches?: { tag: string, held: string, live: string }[] },
 * }} Measured
 * @typedef {{ label: string, runs: Record<string, Measured>[] }} Side
 * @typedef {{ app: string, repeat: number, scenarios: Scenario[], sides: Side[] }} Mirror
 */

/** @param {number[]} values */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** @param {number} n */
const fixed = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * A count, which every round should agree on. A count that differs between
 * rounds is shown as the spread it had, since the median of a disagreement
 * is not a count.
 *
 * @param {number[]} values
 */
function countCell(values) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? fixed(low) : `varies ${fixed(low)}–${fixed(high)}`;
}

/**
 * Two counts, and what became of them: `same` and `changed` when every round
 * of both sides agreed, and `unsteady` when any round disagreed with another,
 * which says the count cannot tell a change from noise on this runner.
 *
 * @param {number[]} base
 * @param {number[]} head
 * @returns {{ base: string, head: string, verdict: string, kind: "same" | "changed" | "unsteady" }}
 */
export function compareCounts(base, head) {
  const before = countCell(base);
  const after = countCell(head);
  if (before.startsWith("varies") || after.startsWith("varies")) {
    return { base: before, head: after, verdict: "**unsteady**", kind: "unsteady" };
  }
  if (before === after) {
    return { base: before, head: after, verdict: "", kind: "same" };
  }
  const delta = median(head) - median(base);
  return {
    base: before,
    head: after,
    verdict: `**${delta > 0 ? "+" : ""}${fixed(delta)}**`,
    kind: "changed",
  };
}

/**
 * A scenario's counts in one cell of the summary, which says what the rows
 * below it say: changed and unsteady counts apart, and `same` only when
 * every count was steady and did not move.
 *
 * @param {{ kind: "same" | "changed" | "unsteady" }[]} compared
 */
export function countsCell(compared) {
  const changed = compared.filter((c) => c.kind === "changed").length;
  const unsteady = compared.filter((c) => c.kind === "unsteady").length;
  const parts = [changed ? `**${changed} changed**` : "", unsteady ? `${unsteady} unsteady` : ""];
  return parts.filter(Boolean).join(", ") || "same";
}

/**
 * Two sets of times, one a round: medians with their ranges, and a verdict
 * only where both sides had `MIN_ROUNDS` rounds and the ranges stay apart.
 *
 * @param {number[]} base
 * @param {number[]} head
 * @returns {{ base: string, head: string, verdict: string }}
 */
export function compareTimes(base, head) {
  /** @param {number[]} values */
  const cell = (values) =>
    values.length > 1
      ? `${fixed(median(values))} (${fixed(Math.min(...values))}–${fixed(Math.max(...values))})`
      : fixed(values[0]);
  let verdict;
  if (Math.min(base.length, head.length) < MIN_ROUNDS) {
    verdict = "";
  } else if (Math.max(...head) < Math.min(...base)) {
    verdict = "faster";
  } else if (Math.min(...head) > Math.max(...base)) {
    verdict = "slower";
  } else {
    verdict = "no result";
  }
  return { base: cell(base), head: cell(head), verdict };
}

/**
 * The idle scenario's median frame, per round, which every other scenario is
 * reported net of — as `run.js` does, with the floor taken as the median of
 * the rounds so that one slow idle round does not move every line.
 *
 * @param {Side} side
 * @returns {number}
 */
function idleFloor(side) {
  return median(side.runs.map((run) => run.idle?.timing.median ?? 0));
}

/**
 * @param {Mirror} mirror
 * @returns {string}
 */
export function mirrorSection(mirror) {
  const [head, base] = mirror.sides;
  if (!head || !base) {
    return "The mirror suite ran on one side only, so there is nothing to compare.";
  }
  const hasIdle = mirror.scenarios.some((scenario) => scenario.name === "idle");
  const floors = hasIdle ? { base: idleFloor(base), head: idleFloor(head) } : null;

  /** @type {string[]} */
  const summary = [];
  /** @type {string[]} */
  const details = [];
  /** @type {string[]} */
  const alarms = [];

  for (const scenario of mirror.scenarios) {
    /** @param {Side} side */
    const of = (side) => side.runs.map((run) => run[scenario.name]).filter(Boolean);
    const before = of(base);
    const after = of(head);
    if (!before.length || !after.length) {
      alarms.push(`\`${scenario.name}\` did not run on both sides.`);
      continue;
    }

    const rows = [before[0].rows, after[0].rows];
    if (rows[0] !== rows[1]) {
      alarms.push(
        `\`${scenario.name}\` mirrored ${rows[0]} elements on develop and ${rows[1]} on this ` +
          "pull request: two different workloads, so none of its figures compare.",
      );
    }
    for (const [label, runs] of /** @type {const} */ ([
      ["develop", before],
      ["this pull request", after],
    ])) {
      const bad = runs.flatMap((run) => run.coherence?.mismatches ?? []);
      if (bad.length) {
        alarms.push(
          `On ${label}, \`${scenario.name}\` ended with the mirror disagreeing with the DOM: ` +
            bad
              .slice(0, 3)
              .map((entry) => `\`${entry.tag}\` held ${entry.held}, live ${entry.live}`)
              .join("; ") +
            ".",
        );
      }
    }

    const lines = [];
    /** @type {ReturnType<typeof compareCounts>[]} */
    const counted = [];
    for (const key of COUNTERS) {
      const b = before.map((run) => run.counts[key] ?? 0);
      const h = after.map((run) => run.counts[key] ?? 0);
      // Off unless --style-reads was passed, and a row of zeros says nothing.
      if (key === "styleProperty" && b.every((v) => v === 0) && h.every((v) => v === 0)) {
        continue;
      }
      const compared = compareCounts(b, h);
      counted.push(compared);
      lines.push(`| \`${key}\` | ${compared.base} | ${compared.head} | ${compared.verdict} |`);
    }

    // As in run.js: a steady stimulus is read off the median frame and a
    // burst off the worst one, and both net of what an idle frame costs.
    const net = floors !== null && scenario.name !== "idle";
    const headline = scenario.bursts ? "worst" : "median";
    /** @type {Record<string, { base: string, head: string, verdict: string }>} */
    const times = {};
    for (const key of /** @type {const} */ (["median", "worst"])) {
      const b = before.map((run) => run.timing[key] - (net ? (floors?.base ?? 0) : 0));
      const h = after.map((run) => run.timing[key] - (net ? (floors?.head ?? 0) : 0));
      times[key] = compareTimes(
        b.map((v) => Math.round(v * 10) / 10),
        h.map((v) => Math.round(v * 10) / 10),
      );
      // The header promises verdicts at this repeat; a scenario that missed
      // a round on either side says why it has none.
      if (mirror.repeat >= MIN_ROUNDS && !times[key].verdict) {
        times[key].verdict = `${Math.min(b.length, h.length)} rounds`;
      }
      const name = net ? `${key} frame gap above idle (ms)` : `${key} frame gap (ms)`;
      lines.push(`| ${name} | ${times[key].base} | ${times[key].head} | ${times[key].verdict} |`);
    }

    const per = scenario.bursts ? `per burst (${scenario.bursts})` : "per frame";
    summary.push(
      `| \`${scenario.name}\` | ${countsCell(counted)} | ` +
        `${headline}: ${times[headline].base} → ${times[headline].head} | ` +
        `${times[headline].verdict} |`,
    );
    details.push(
      [
        `**\`${scenario.name}\`** — ${scenario.what}. Counts are ${per}.`,
        "",
        "| | develop | this pull request | |",
        "| - | - | - | - |",
        ...lines,
      ].join("\n"),
    );
  }

  return [
    `Mirror suite on \`${mirror.app}\`, ${mirror.repeat} ${mirror.repeat === 1 ? "round" : "rounds"} a side, interleaved.` +
      (floors
        ? ` An idle frame costs ${fixed(floors.base)} ms on develop and ` +
          `${fixed(floors.head)} ms here; the times below are net of it.`
        : " Without `idle` the times are raw.") +
      (mirror.repeat < MIN_ROUNDS
        ? ` Times are shown without a verdict below ${MIN_ROUNDS} rounds a side; run the ` +
          `workflow by hand with \`repeat\` ${MIN_ROUNDS} to have them called faster or slower.`
        : ""),
    alarms.map((alarm) => `> [!WARNING]\n> ${alarm}`).join("\n\n"),
    [
      "| Scenario | Counts | Frame gap (ms), develop → here | |",
      "| -------- | ------ | ------------------------------ | - |",
      ...summary,
    ].join("\n"),
    `<details><summary>Every scenario</summary>\n\n${details.join("\n\n")}\n\n</details>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The Markdown tables a bench printed, by the first cell of their header.
 *
 * @param {string} text
 * @returns {Map<string, string[][]>}
 */
export function parseTables(text) {
  /** @type {Map<string, string[][]>} */
  const tables = new Map();
  /** @type {string[][] | null} */
  let current = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) {
      current = null;
      continue;
    }
    const cells = line
      .slice(1, line.trimEnd().endsWith("|") ? line.trimEnd().length - 1 : undefined)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^-+$/.test(cell))) {
      continue;
    }
    if (current === null) {
      current = [];
      tables.set(cells[0], current);
    } else {
      current.push(cells);
    }
  }
  return tables;
}

/**
 * Two of the draw-call bench's tables, as one: develop's figure beside this
 * pull request's in each column, and only the rows in which something moved.
 *
 * Each figure is an average over the bench's frames. A fraction on either
 * side drew differently from frame to frame: the panel animates (the desk's
 * charts redraw on timers, from random data), and the frames a run happened
 * to catch decide its figure. Such a row is counted apart as animated, with
 * its figures, and is not called a change. A row on one side only is a
 * change whatever its figures.
 *
 * The fraction is a hint, not a proof. An animating panel's average is
 * whole whenever its frames' draws add up to a multiple of the frame count:
 * the desk's Night Ops printed 154 in one same-code run and 154.4 in the
 * other. A row whole on both sides that differs is listed as a change, so
 * an animated one can still turn up there.
 *
 * @param {string[][]} base
 * @param {string[][]} head
 * @param {string[]} columns The value columns, after the row's name.
 */
function compareRows(base, head, columns) {
  const before = new Map(base.map(([name, ...values]) => [name, values]));
  const after = new Map(head.map(([name, ...values]) => [name, values]));
  const names = [...new Set([...before.keys(), ...after.keys()])];
  const differ = names.filter(
    (name) => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)),
  );
  const whole = (/** @type {string[] | undefined} */ values) =>
    (values ?? []).every((value) => !/\.\d/.test(value));
  const moved = differ.filter(
    (name) =>
      !before.has(name) || !after.has(name) || (whole(before.get(name)) && whole(after.get(name))),
  );
  const animated = differ
    .filter((name) => !moved.includes(name))
    .map((name) => `${name} (${before.get(name)?.[0]} → ${after.get(name)?.[0]})`);
  const rows = moved.map((name) => {
    const cells = columns.map((_, i) => {
      const b = before.get(name)?.[i] ?? "—";
      const h = after.get(name)?.[i] ?? "—";
      return b === h ? b : `**${b} → ${h}**`;
    });
    return `| ${name} | ${cells.join(" | ")} |`;
  });
  return { rows, animated, unchanged: names.length - differ.length };
}

/**
 * @param {string} baseText What the draw-call bench printed on develop.
 * @param {string} headText What it printed on this pull request.
 * @returns {string}
 */
export function drawsSection(baseText, headText) {
  const base = parseTables(baseText);
  const head = parseTables(headText);
  const looks = compareRows(base.get("Look or app") ?? [], head.get("Look or app") ?? [], [
    "A frame",
    "Panels, one eye",
  ]);
  const panels = compareRows(base.get("Panel") ?? [], head.get("Panel") ?? [], [
    "Draws",
    "Counted",
    "Blank",
    "Re-packed",
  ]);
  const animated = [...looks.animated, ...panels.animated];
  const aside = animated.length
    ? `${animated.length} animated, whose average depends on the frames a run caught, ` +
      `differ and are not counted as changes: ${animated.join(", ")}.`
    : "";
  if (!looks.rows.length && !panels.rows.length) {
    return [
      animated.length
        ? `Draw calls: no change in the other ${looks.unchanged} looks and apps and ` +
          `${panels.unchanged} panels.`
        : `Draw calls: the same on both sides, in all ${looks.unchanged} looks and apps and all ` +
          `${panels.unchanged} panels.`,
      aside,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    "Draw calls a frame, develop → this pull request. Only what moved is listed.",
    looks.rows.length
      ? [
          "| Look or app | A frame | Panels, one eye |",
          "| ----------- | ------- | --------------- |",
          ...looks.rows,
        ].join("\n")
      : "",
    panels.rows.length
      ? [
          "| Panel | Draws | Counted, one batch by node | Blank | Re-packed |",
          "| ----- | ----- | -------------------------- | ----- | --------- |",
          ...panels.rows,
        ].join("\n")
      : "",
    `${looks.unchanged} looks or apps and ${panels.unchanged} panels did not change.`,
    aside,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** @param {string[]} args */
function parse(args) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    flags[args[i].replace(/^--/, "")] = args[i + 1];
  }
  return flags;
}

/** @param {string | undefined} path */
const read = (path) => (path && existsSync(path) ? readFileSync(path, "utf8") : null);

/**
 * @param {Record<string, string>} flags
 * @returns {string}
 */
export function report(flags) {
  const mirror = read(flags.mirror);
  const drawsBase = read(flags["draws-base"]);
  const drawsHead = read(flags["draws-head"]);
  const short = (/** @type {string | undefined} */ sha) => (sha ? sha.slice(0, 7) : "?");
  return [
    `### Benchmarks against develop`,
    `This pull request at \`${short(flags.head)}\`, against develop at ` +
      `\`${short(flags.base)}\`, both measured on the same runner.`,
    "#### Layout reads and frame gaps",
    mirror
      ? mirrorSection(JSON.parse(mirror))
      : "_The mirror suite wrote no results; the log says why._",
    "#### Draw calls",
    drawsBase && drawsHead
      ? drawsSection(drawsBase, drawsHead)
      : "_The draw-call bench did not finish on both sides; the log says why._",
  ].join("\n\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(report(parse(process.argv.slice(2))));
}
