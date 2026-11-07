#!/usr/bin/env node
// Prints the results of a js-framework-benchmark run as Markdown tables:
//
//   node summarize.mjs <results dir> [--mean]
//
// Each cell is the median (or with --mean the mean) followed by the slowdown
// factor against the best library in that row, as the suite's own results
// page computes it. The CPU summary row is the weighted geometric mean of the
// factors, with the suite's weights; memory and size use equal weights.
// For a run of some of the CPU benchmarks, the mean divides by the weights of
// the benchmarks present, where the results page divides by all nine, so the
// two disagree on a subset.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

// webdriver-ts-results/src/Common.ts, by benchmark id.
const CPU_WEIGHTS = {
  "01_run1k": 0.64280248137063,
  "02_replace1k": 0.5607178150466176,
  "03_update10th1k_x16": 0.5643800750716564,
  "04_select1k": 0.1925635870170522,
  "05_swap1k": 0.13200612879341714,
  "06_remove-one-1k": 0.5277091212292658,
  "07_create10k": 0.5644449600965534,
  "08_create1k-after1k_x2": 0.5508359820582848,
  "09_clear1k_x8": 0.4225836631419211,
};

const { values, positionals } = parseArgs({
  options: { mean: { type: "boolean", default: false } },
  allowPositionals: true,
});
const dir = positionals[0];
if (!dir) {
  console.error("usage: node summarize.mjs <results dir> [--mean]");
  process.exit(1);
}
const statistic = values.mean ? "mean" : "median";

/** @type {Map<string, Map<string, any>>} type -> benchmark -> framework -> result */
const byType = new Map();
const frameworks = new Set();
for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
  const result = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const name = result.framework.replace(/-keyed$/, "");
  frameworks.add(name);
  const benchmarks = byType.get(result.type) ?? new Map();
  byType.set(result.type, benchmarks);
  const row = benchmarks.get(result.benchmark) ?? new Map();
  benchmarks.set(result.benchmark, row);
  row.set(name, result.values.total ?? result.values.DEFAULT ?? Object.values(result.values)[0]);
}

const columns = [...frameworks].sort(
  (a, b) =>
    (a.startsWith("vanillajs") ? -1 : 0) - (b.startsWith("vanillajs") ? -1 : 0) ||
    a.localeCompare(b),
);
const short = (name) => name.replace(/-v[\d.]+( \+ [\d.]+)?$/, "");

for (const [type, benchmarks] of [...byType].sort()) {
  const ids = [...benchmarks.keys()].sort();
  const logSums = new Map(columns.map((c) => [c, 0]));
  const weightSums = new Map(columns.map((c) => [c, 0]));
  console.log(`\n### ${type}\n`);
  console.log(`| Benchmark | ${columns.map(short).join(" | ")} |`);
  console.log(`| --- | ${columns.map(() => "---:").join(" | ")} |`);
  for (const id of ids) {
    const row = benchmarks.get(id);
    const best = Math.min(...[...row.values()].map((v) => v[statistic]));
    const weight = type === "cpu" ? CPU_WEIGHTS[id] : 1;
    if (weight === undefined) throw new Error(`No weight for the CPU benchmark ${id}`);
    const cells = columns.map((column) => {
      const value = row.get(column);
      if (!value) return "–";
      const factor = value[statistic] / best;
      logSums.set(column, logSums.get(column) + weight * Math.log(factor));
      weightSums.set(column, weightSums.get(column) + weight);
      const spread = value.stddev ? ` ±${value.stddev.toFixed(1)}` : "";
      return `${value[statistic].toFixed(1)}${spread} (${factor.toFixed(2)})`;
    });
    console.log(`| ${id} | ${cells.join(" | ")} |`);
  }
  const means = columns.map((c) => Math.exp(logSums.get(c) / weightSums.get(c)).toFixed(2));
  console.log(`| **geometric mean** | ${means.map((m) => `**${m}**`).join(" | ")} |`);
}
