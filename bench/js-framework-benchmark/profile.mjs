#!/usr/bin/env node
// Measures what the justdom entry does for each of the suite's CPU cases:
// script time, DOM calls, where the script time goes and what is allocated.
// The suite answers "how long, against the others". This answers "doing
// what", for one build of justdom or for two side by side.
//
//   cd frameworks/keyed/justdom && npm ci && cd ../../..
//   npm ci && npx playwright install chromium
//   node profile.mjs                          the published packages
//   node profile.mjs --source ../..           this checkout's packages
//   node profile.mjs --mode calls --only 01,09
//
// Options:
//
//   --source <dir>   Build the entry against `packages/core/src` and
//                    `packages/signal/src` of a justdom checkout, in place
//                    of the published packages the entry installs. Repeat
//                    the flag to measure several checkouts in one run.
//   --published      With `--source`, measure the published packages too,
//                    first, for a before and after in one run.
//   --mode <mode>    `time` (the default), `calls`, `cpu` or `alloc`.
//   --only <list>    Case prefixes, comma separated: `--only 01,07`.
//   --runs <n>       Pages per case in `time` mode (9) and `cpu` mode (3).
//   --top <n>        Rows per table in `cpu` and `alloc` mode (20).
//   --dev            Build without minifying, so `cpu` and `alloc` name
//                    functions as the source does.
//
// The page opens from disk with no stylesheet, so nothing here measures
// layout or paint: a row is laid out as bare inline text. Read the numbers
// against each other, between two builds on one machine, not against the
// suite's.

import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "frameworks/keyed/justdom");

const { values: options } = parseArgs({
  options: {
    source: { type: "string", multiple: true },
    published: { type: "boolean", default: false },
    mode: { type: "string", default: "time" },
    only: { type: "string" },
    runs: { type: "string" },
    top: { type: "string", default: "20" },
    dev: { type: "boolean", default: false },
  },
});
const MODES = ["time", "calls", "cpu", "alloc"];
if (!MODES.includes(options.mode)) {
  throw new Error(`--mode is one of ${MODES.join(", ")}`);
}

const click = (/** @type {string} */ id) => `document.getElementById("${id}").click()`;
const clickRow = (/** @type {number} */ row, /** @type {number} */ column) =>
  `document.querySelector("tbody>tr:nth-of-type(${row})>td:nth-of-type(${column})>a").click()`;

/**
 * The suite's nine CPU cases, as it drives them: what warms the page up and
 * how often, what puts the table in place, and the one action that is
 * measured.
 *
 * @type {Record<string, { warm: string[]; times: number; setup: string[]; act: string }>}
 */
const CASES = {
  "01_run1k": { warm: [click("run"), click("clear")], times: 5, setup: [], act: click("run") },
  "02_replace1k": { warm: [click("run")], times: 5, setup: [], act: click("run") },
  "03_update10th1k": {
    warm: [click("update")],
    times: 3,
    setup: [click("run")],
    act: click("update"),
  },
  "04_select1k": {
    warm: [clickRow(5, 2), clickRow(9, 2), clickRow(3, 2)],
    times: 2,
    setup: [click("run")],
    act: clickRow(2, 2),
  },
  "05_swap1k": {
    warm: [click("swaprows")],
    times: 4,
    setup: [click("run")],
    act: click("swaprows"),
  },
  "06_remove-one-1k": {
    warm: [clickRow(9, 3), clickRow(8, 3), clickRow(7, 3)],
    times: 1,
    setup: [click("run")],
    act: clickRow(4, 3),
  },
  "07_create10k": {
    warm: [click("run"), click("clear")],
    times: 5,
    setup: [],
    act: click("runlots"),
  },
  "08_create1k-after1k_x2": {
    warm: [click("run"), click("clear")],
    times: 5,
    setup: [click("run")],
    act: click("add"),
  },
  "09_clear1k": {
    warm: [click("run"), click("clear")],
    times: 5,
    setup: [click("run")],
    act: click("clear"),
  },
};

/** Cases whose table has to be there before the warm-up can click a row. */
const SETUP_FIRST = new Set(["03_update10th1k", "04_select1k", "05_swap1k", "06_remove-one-1k"]);

/** Resolves once the page has had a frame and a task to finish in. */
const SETTLED = `new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)))`;

/**
 * Counts, in `window.__calls`, the DOM calls that build, move and remove
 * nodes, and the writes of the three properties the entry binds.
 */
const COUNT_CALLS = `(() => {
  const calls = (window.__calls = {});
  const count = (name) => { calls[name] = (calls[name] || 0) + 1; };
  const wrap = (owner, name) => {
    const original = owner[name];
    owner[name] = function () { count(name); return original.apply(this, arguments); };
  };
  for (const name of ["insertBefore", "appendChild", "removeChild", "replaceChild", "cloneNode"]) {
    wrap(Node.prototype, name);
  }
  for (const name of ["createElement", "createElementNS", "createComment", "createTextNode",
    "createDocumentFragment"]) {
    wrap(Document.prototype, name);
  }
  for (const name of ["setAttribute", "remove", "replaceChildren", "append"]) {
    wrap(Element.prototype, name);
  }
  for (const name of ["addEventListener", "removeEventListener"]) {
    wrap(EventTarget.prototype, name);
  }
  const written = (owner, name) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    Object.defineProperty(owner, name, {
      ...descriptor,
      set(value) { count("set " + name); descriptor.set.call(this, value); },
    });
  };
  written(Element.prototype, "className");
  written(Node.prototype, "textContent");
  written(CharacterData.prototype, "data");
})()`;

/**
 * Runs `act` and reports how long the click handler took, in milliseconds.
 * The entry does its work inside the handler, so this is its script time.
 */
const timed = (/** @type {string} */ act) =>
  `(() => { const start = performance.now(); ${act}; return performance.now() - start; })()`;

/**
 * Builds the entry into `work/profile/<label>` and gives the page's URL.
 * With a `source`, `justdom-core` and `justdom-signal` resolve to that
 * checkout's sources, for the entry and for each other.
 *
 * @param {string} label
 * @param {string | undefined} source
 * @returns {Promise<string>}
 */
async function build(label, source) {
  const require = createRequire(join(entry, "package.json"));
  const { rollup } = require("rollup");
  const nodeResolve = require("@rollup/plugin-node-resolve");
  const terser = require("@rollup/plugin-terser");
  const out = join(here, "work/profile", label);
  mkdirSync(join(out, "dist"), { recursive: true });
  /** @type {Record<string, string>} */
  const sources = source
    ? {
        "justdom-core": join(source, "packages/core/src/index.js"),
        "justdom-signal": join(source, "packages/signal/src/index.js"),
      }
    : {};
  for (const file of Object.values(sources)) {
    if (!existsSync(file)) {
      throw new Error(`--source ${source} has no ${file}`);
    }
  }
  const bundle = await rollup({
    input: join(entry, "src/main.js"),
    // The packages import each other in two circles that are safe, and
    // Rollup reports them on every build.
    onwarn: (warning, warn) => {
      if (warning.code !== "CIRCULAR_DEPENDENCY") {
        warn(warning);
      }
    },
    plugins: [
      { name: "justdom-sources", resolveId: (id) => sources[id] ?? null },
      nodeResolve({ rootDir: entry }),
      // The entry's own settings, from its `rollup.config.js`.
      !options.dev && terser({ module: true, compress: { passes: 3 }, mangle: true }),
    ].filter(Boolean),
  });
  await bundle.write({ file: join(out, "dist/main.js"), format: "iife" });
  await bundle.close();
  cpSync(join(entry, "index.html"), join(out, "index.html"));
  return pathToFileURL(join(out, "index.html")).href;
}

/** @param {number[]} values */
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];

/**
 * Opens a page, brings it to the point where `name`'s action is next, and
 * hands it to `measure`.
 *
 * @template T
 * @param {import("playwright").Browser} browser
 * @param {string} url
 * @param {string} name
 * @param {(tab: import("playwright").Page, cdp: import("playwright").CDPSession, act: () => Promise<void>) => Promise<T>} measure
 * @returns {Promise<T>}
 */
async function withCase(browser, url, name, measure) {
  const { warm, times, setup, act } = CASES[name];
  const tab = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  try {
    const cdp = await tab.context().newCDPSession(tab);
    await tab.goto(url);
    await tab.waitForSelector("#run");
    const run = async (/** @type {string} */ code) => {
      await tab.evaluate(code);
      await tab.evaluate(SETTLED);
    };
    const setUp = async () => {
      for (const step of setup) {
        await run(step);
      }
    };
    if (SETUP_FIRST.has(name)) {
      await setUp();
    }
    for (let i = 0; i < times; i++) {
      for (const step of warm) {
        await run(step);
      }
    }
    if (!SETUP_FIRST.has(name)) {
      await setUp();
    }
    await tab.evaluate("window.gc()");
    await tab.evaluate(SETTLED);
    return await measure(tab, cdp, () => run(act));
  } finally {
    await tab.close();
  }
}

/**
 * @param {Map<string, number>} totals
 * @param {(value: number) => string} format
 * @returns {string[]}
 */
function topRows(totals, format) {
  return [...totals]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Number(options.top))
    .map(([name, value]) => `  ${format(value).padStart(10)}  ${name}`);
}

/**
 * One case in one build, measured in the mode asked for. Gives the lines
 * to print under the case's heading.
 *
 * @param {import("playwright").Browser} browser
 * @param {string} url
 * @param {string} name
 * @returns {Promise<string[]>}
 */
async function measureCase(browser, url, name) {
  const { act } = CASES[name];
  if (options.mode === "time") {
    const runs = Number(options.runs ?? 9);
    /** @type {number[]} */
    const times = [];
    for (let i = 0; i < runs; i++) {
      times.push(await withCase(browser, url, name, (tab) => tab.evaluate(timed(act))));
    }
    return [`  script ${median(times).toFixed(1)} ms (fastest ${Math.min(...times).toFixed(1)})`];
  }
  if (options.mode === "calls") {
    /** @type {Record<string, number>} */
    const calls = await withCase(browser, url, name, async (tab, _cdp, run) => {
      await tab.evaluate(COUNT_CALLS);
      await run();
      return tab.evaluate("window.__calls");
    });
    return Object.entries(calls)
      .sort((a, b) => b[1] - a[1])
      .map(([call, count]) => `  ${String(count).padStart(10)}  ${call}`);
  }
  if (options.mode === "cpu") {
    const runs = Number(options.runs ?? 3);
    /** @type {Map<string, number>} */
    const self = new Map();
    let total = 0;
    for (let i = 0; i < runs; i++) {
      const profile = await withCase(browser, url, name, async (_tab, cdp, run) => {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 50 });
        await cdp.send("Profiler.start");
        await run();
        return (await cdp.send("Profiler.stop")).profile;
      });
      const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
      (profile.samples ?? []).forEach((id, index) => {
        const frame = nodes.get(id)?.callFrame;
        const label = `${frame?.functionName || "(anonymous)"}${frame?.url ? `:${frame.lineNumber + 1}` : ""}`;
        if (/^\((idle|program)\)$/.test(label)) {
          return;
        }
        const ms = (profile.timeDeltas?.[index] ?? 0) / 1000;
        self.set(label, (self.get(label) ?? 0) + ms / runs);
        total += ms / runs;
      });
    }
    return [
      `  script ${total.toFixed(1)} ms, self time by function`,
      ...topRows(self, (ms) => `${ms.toFixed(2)} ms`),
    ];
  }
  const profile = await withCase(browser, url, name, async (_tab, cdp, run) => {
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.startSampling", {
      samplingInterval: 512,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await run();
    return (await cdp.send("HeapProfiler.stopSampling")).profile;
  });
  /** @type {Map<string, number>} */
  const allocated = new Map();
  let total = 0;
  /** @param {typeof profile.head} node */
  const walk = (node) => {
    if (node.selfSize) {
      const label = `${node.callFrame.functionName || "(anonymous)"}:${node.callFrame.lineNumber + 1}`;
      allocated.set(label, (allocated.get(label) ?? 0) + node.selfSize);
      total += node.selfSize;
    }
    node.children.forEach(walk);
  };
  walk(profile.head);
  return [
    `  allocated ${(total / 1024 / 1024).toFixed(1)} MB, by the function that allocated`,
    ...topRows(allocated, (bytes) => `${(bytes / 1024).toFixed(0)} kB`),
  ];
}

const sources = options.source ?? [];
/** @type {Array<{ label: string; name: string; source: string | undefined }>} */
const builds = [
  ...(sources.length === 0 || options.published
    ? [{ label: "published", name: "the published packages", source: undefined }]
    : []),
  ...sources.map((source, index) => ({
    label: `source-${index + 1}`,
    name: resolve(source),
    source: resolve(source),
  })),
];
const names = Object.keys(CASES).filter(
  (name) => !options.only || options.only.split(",").some((prefix) => name.startsWith(prefix)),
);

const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
try {
  const urls = [];
  for (const { label, source } of builds) {
    urls.push(await build(label, source));
  }
  /** @type {string[]} */
  const report = [];
  for (const name of names) {
    report.push(`## ${name}`);
    for (const [index, { name: buildName }] of builds.entries()) {
      report.push(``, `${buildName}:`, ...(await measureCase(browser, urls[index], name)));
    }
    report.push(``);
  }
  const text = report.join("\n");
  console.log(text);
  writeFileSync(join(here, "work/profile", `${options.mode}.md`), `${text}\n`);
} finally {
  await browser.close();
}
