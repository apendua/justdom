/**
 * Where a hover's time actually goes.
 *
 * The suite next door answers "did that change help?" — a constant stimulus,
 * frame gaps, counts. This answers a different question, the one you ask
 * before choosing what to change: *what is the biggest thing in the frame?*
 * It drives a hover sweep across a long list — one real hover transition per
 * frame, which is what a ray crossing a panel does — and takes a V8 CPU
 * profile while it does, then reports self time by function.
 *
 * Three sources, because no one of them is trustworthy alone:
 *
 *   - The CPU profile attributes *script* time to functions. It is the only
 *     thing here that can say "the raycast" rather than "something".
 *   - `Performance.getMetrics` gives the engine's own recalc/layout totals,
 *     which the sampler cannot see: style resolution happens in C++ and lands
 *     in whichever JS frame forced it.
 *   - Page-side wrappers time the DOM calls we already suspect by name.
 *     `getAnimations()` is native, so a sampling profiler tends to bill it to
 *     its caller; a wrapper is the only way to price it honestly.
 *
 * Run at several list sizes — what matters is not the number but whether it
 * grows with the panel.
 *
 *   node bench/profile.js
 *   node bench/profile.js --sizes 5,20,60 --frames 120 --app todo-vanilla
 *
 * Two things to know before reading the output.
 *
 * **The inclusive categories overlap, deliberately.** A sample is credited to
 * every category on its stack, so the mirror's restyle work is counted again
 * inside `signal graph` — the mirror invalidates, the graph recomputes, and
 * they are the same milliseconds seen at two altitudes. Read them as nested
 * envelopes, not as a partition, and do not add them up.
 *
 * **SwiftShader is pinned, as everywhere else here, and it dominates the
 * absolute frame.** `(program)` and `(idle)` come to fifty-odd milliseconds
 * before anything under test runs. They cancel in the idle-hover difference,
 * which is why every number that matters is reported as a difference — but it
 * does mean the *share* of a real frame these costs represent is larger than
 * it looks here, not smaller, since a GPU would take the rasterization away
 * and leave this behind.
 */

import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { installCounters } from "./metrics.js";
import { scenarios } from "./scenarios.js";

const REPO = resolve(import.meta.dirname, "../../..");

/** @param {string[]} args */
function parse(args) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1] ?? "true";
      i += 1;
    }
  }
  return {
    app: flags.app ?? "todo-vanilla",
    frames: Number(flags.frames ?? 120),
    repeat: Number(flags.repeat ?? 3),
    sizes: (flags.sizes ?? "5,20,60").split(",").map(Number),
  };
}

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function findChromium() {
  const named = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (named) {
    return named;
  }
  return "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
}

/**
 * Time the native calls a sampling profiler will misattribute. Installed
 * before any application code, so nothing escapes the wrapper.
 */
function installProbes() {
  /** @type {Record<string, { calls: number, ms: number }>} */
  const probes = {};
  const track = (name, target, key) => {
    const original = target[key];
    if (typeof original !== "function") {
      return;
    }
    probes[name] = { calls: 0, ms: 0 };
    target[key] = function (...args) {
      const started = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        probes[name].calls += 1;
        probes[name].ms += performance.now() - started;
      }
    };
  };
  track("getAnimations", Element.prototype, "getAnimations");
  track("getAnimations(document)", Document.prototype, "getAnimations");
  track("getBoundingClientRect", Element.prototype, "getBoundingClientRect");
  track("getComputedStyle", window, "getComputedStyle");
  globalThis.__probes = {
    snapshot: () => Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, { ...v }])),
    since: (before) =>
      Object.fromEntries(
        Object.entries(probes).map(([k, v]) => [
          k,
          { calls: v.calls - (before[k]?.calls ?? 0), ms: v.ms - (before[k]?.ms ?? 0) },
        ]),
      ),
  };
}

/** Drive one callback per real animation frame. */
function installDriver() {
  globalThis.__drive = (step, count) =>
    new Promise((done) => {
      let i = 0;
      const tick = () => {
        if (i >= count) {
          done();
          return;
        }
        step(i);
        i += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
}

/**
 * Fold a `Profiler.stop()` result into self time per function. The profile is
 * a node tree plus a sample stream; a node's self time is its share of the
 * samples, and `timeDeltas` gives what each sample was worth.
 *
 * @param {{nodes: any[], samples: number[], timeDeltas: number[]}} profile
 */
function selfTimeByFunction(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  /** @type {Map<number, number>} */
  const microsById = new Map();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i];
    // `timeDeltas[i]` is the gap *before* sample i, which is the interval
    // sample i-1 was responsible for. Bill it to the sample that ran.
    const delta = profile.timeDeltas[i] ?? 0;
    microsById.set(id, (microsById.get(id) ?? 0) + Math.max(delta, 0));
  }
  /** @type {Map<string, {ms: number, url: string}>} */
  const byFunction = new Map();
  for (const [id, micros] of microsById) {
    const node = byId.get(id);
    if (!node) {
      continue;
    }
    const frame = node.callFrame;
    const name = frame.functionName || "(anonymous)";
    const url = (frame.url || "").split("/").slice(-2).join("/");
    const key = `${name} @ ${url}`;
    const entry = byFunction.get(key) ?? { ms: 0, url };
    entry.ms += micros / 1000;
    byFunction.set(key, entry);
  }
  return [...byFunction.entries()]
    .map(([key, v]) => ({ what: key, ms: v.ms }))
    .sort((a, b) => b.ms - a.ms);
}

/**
 * Inclusive time for the functions we came to ask about. Self time cannot
 * answer "what does the raycast cost" — the work is spread over the
 * recursion and its callees, and none of them need be in a top-15 list.
 *
 * @param {{nodes: any[], samples: number[], timeDeltas: number[]}} profile
 * @param {Record<string, (frame: any) => boolean>} matchers
 */
function inclusiveFor(profile, matchers) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  /** @type {Map<number, number>} */
  const parentOf = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      parentOf.set(child, node.id);
    }
  }
  /** @type {Map<number, number>} */
  const microsById = new Map();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i];
    const d = profile.timeDeltas[i] ?? 0;
    microsById.set(id, (microsById.get(id) ?? 0) + Math.max(d, 0));
  }
  /** @type {Record<string, number>} */
  const totals = Object.fromEntries(Object.keys(matchers).map((k) => [k, 0]));
  // A sample belongs to a matcher if any frame on its stack matches. Walking
  // up from the sampled node is what makes this inclusive rather than self.
  for (const [id, micros] of microsById) {
    /** @type {Set<string>} */
    const credited = new Set();
    let current = /** @type {number | undefined} */ (id);
    while (current !== undefined) {
      const node = byId.get(current);
      if (node) {
        for (const [name, match] of Object.entries(matchers)) {
          if (!credited.has(name) && match(node.callFrame)) {
            totals[name] += micros / 1000;
            credited.add(name);
          }
        }
      }
      current = parentOf.get(current);
    }
  }
  return totals;
}

/**
 * What we came to price, by name. Kept as predicates over the call frame
 * because minification is not in play here but bundling is: the raycast and
 * the mirror live in `packages/three/src`, three.js arrives as a vite dep
 * chunk, and only the function name distinguishes them.
 */
const SUSPECTS = {
  "raycast (freedom)": (f) =>
    f.functionName === "intersectVisible" || f.functionName === "getIntersection",
  "raycast (three)": (f) => f.functionName === "raycast" || f.functionName === "intersectObject",
  "animation sweep": (f) => f.functionName === "sweep" || f.functionName === "buildBatches",
  "mirror restyle": (f) =>
    f.url?.includes("elements/mirror.js") || f.url?.includes("VisualProperties.js"),
  "signal graph": (f) => f.url?.includes("packages/signal/src"),
  "text batching": (f) => f.url?.includes("textBatch.js") || f.url?.includes("textHelpers.js"),
  "three render": (f) =>
    f.functionName === "render" ||
    f.functionName === "updateMatrixWorld" ||
    f.functionName === "projectObject",
  "diagnostics overlay": (f) => f.url?.includes("diagnostics") || f.functionName === "getImageData",
};

/**
 * The stimulus: a hover transition per frame, walking down the list and back.
 * This is what a ray crossing a panel produces — `pointerenter` on the row
 * arriving, `pointerleave` on the one being left.
 */
const HOVER_SWEEP = `
  return (i) => {
    const rows = globalThis.__rows_els;
    if (!rows.length) return;
    const n = rows.length;
    const at = i % n;
    const prev = (at - 1 + n) % n;
    delete rows[prev].dataset.xrHover;
    rows[at].dataset.xrHover = "true";
  }
`;

/**
 * The control. Same frames, same renderer, same everything — no hover. The
 * subtrahend: a frame costs tens of milliseconds under a software rasterizer
 * before anything here does a thing, and reporting that as the price of a
 * hover would be the whole measurement's undoing.
 */
const IDLE = `return () => {}`;

async function main() {
  const options = parse(process.argv.slice(2));
  const appRoot = join(REPO, "apps", options.app);
  const server = await createServer({
    root: appRoot,
    configFile: join(appRoot, "vite.config.mts"),
    logLevel: "error",
    server: { port: 0, strictPort: false, hmr: false, watch: null },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--force-color-profile=srgb",
    ],
  });

  try {
    for (const rounds of options.sizes) {
      const page = await browser.newPage({
        ignoreHTTPSErrors: true,
        viewport: { width: 1024, height: 640 },
      });
      // The suite's own counters ride along: `fillText` and `canvasCreated`
      // are how you tell a text re-rasterization from a cheap restyle, and
      // they are invisible to both the sampler and the engine metrics.
      await page.addInitScript(installCounters, { styleReads: false });
      await page.addInitScript(installProbes);
      await page.addInitScript(installDriver);
      await page.goto(`${url}?emulator`, { waitUntil: "load", timeout: 60_000 });
      await page.waitForSelector("#ARButton, #VRButton", { timeout: 30_000 });
      await page.click("#ARButton, #VRButton");
      await page.waitForFunction(() => document.querySelectorAll("canvas").length > 0, undefined, {
        timeout: 30_000,
      });

      // Borrow the suite's long-list setup so this measures the same panel
      // the benchmarks do.
      const setup = scenarios(rounds)[0].setup;
      await page.evaluate(`(async () => { ${setup} })()`);
      const nodes = await page.evaluate(`
        // The rows, not the scroller's single list child: hovering a row is
        // the case under test, and a row's siblings are what the restyle
        // scope decides to visit or not.
        globalThis.__rows_els = [...globalThis.__scroller.querySelectorAll("li")];
        if (!globalThis.__rows_els.length) throw new Error("no rows found");
        globalThis.__scroller.querySelectorAll("*").length
      `);
      const rowCount = await page.evaluate("globalThis.__rows_els.length");

      const session = await page.context().newCDPSession(page);
      await session.send("Profiler.enable");
      await session.send("Profiler.setSamplingInterval", { interval: 100 });
      await session.send("Performance.enable");

      /** Drive one arm and collect everything about it. */
      const arm = async (step) => {
        // Warm up: let the JIT settle and the panel reach a steady state.
        await page.evaluate((s) => globalThis.__drive(new Function(s)(), 30), step);
        const metricsBefore = await session.send("Performance.getMetrics");
        const probesBefore = await page.evaluate("globalThis.__probes.snapshot()");
        const countsBefore = await page.evaluate("globalThis.__bench.snapshot()");
        await session.send("Profiler.start");
        const wall = Date.now();
        await page.evaluate(({ s, frames }) => globalThis.__drive(new Function(s)(), frames), {
          s: step,
          frames: options.frames,
        });
        const elapsed = Date.now() - wall;
        const { profile } = await session.send("Profiler.stop");
        const probes = await page.evaluate(
          (before) => globalThis.__probes.since(before),
          probesBefore,
        );
        const metricsAfter = await session.send("Performance.getMetrics");
        const metric = (name, list) => list.metrics.find((m) => m.name === name)?.value ?? 0;
        const counts = await page.evaluate(
          (before) => globalThis.__bench.since(before),
          countsBefore,
        );
        return {
          elapsed,
          probes,
          counts,
          profile,
          inclusive: inclusiveFor(profile, SUSPECTS),
          self: selfTimeByFunction(profile),
          delta: (name) => metric(name, metricsAfter) - metric(name, metricsBefore),
        };
      };

      // Interleaved idle-hover-idle-hover rather than all the idles then all
      // the hovers, for the reason the suite next door interleaves its two
      // revisions: a machine getting busier over a run otherwise hands the
      // whole trend to whichever arm went last.
      /** @type {any[]} */
      const idles = [];
      /** @type {any[]} */
      const hovers = [];
      for (let round = 0; round < options.repeat; round += 1) {
        idles.push(await arm(IDLE));
        hovers.push(await arm(HOVER_SWEEP));
      }

      const per = (ms) => ms / options.frames;
      const fmt = (n) => (n >= 0 ? " " : "") + n.toFixed(3);
      /** Median across rounds of some per-frame quantity, for each arm. */
      const pair = (pick) => {
        const i = median(idles.map((a) => per(pick(a))));
        const h = median(hovers.map((a) => per(pick(a))));
        return { i, h, d: h - i };
      };
      /** The spread of the hover arm, so a delta inside it can be called noise. */
      const spread = (pick) => {
        const vs = hovers.map((a) => per(pick(a)));
        return Math.max(...vs) - Math.min(...vs);
      };
      const idle = idles[0];
      const hover = hovers[0];

      console.log(`\n${"=".repeat(80)}`);
      console.log(
        `list: ${rowCount} rows / ${nodes} nodes   frames: ${options.frames}   ` +
          `rounds: ${options.repeat}   (medians)`,
      );
      console.log("=".repeat(80));

      // Counts first, and on purpose. They are identical run to run, so a
      // change of one is a real change; the times below cannot say that.
      console.log("\nper hover transition, COUNTS         idle     hover     hover-idle");
      const countRows = [
        ["RecalcStyleCount", (a) => a.delta("RecalcStyleCount")],
        ["getComputedStyle calls", (a) => a.probes["getComputedStyle"].calls],
        ["getBoundingClientRect", (a) => a.probes["getBoundingClientRect"].calls],
        ["getAnimations calls", (a) => a.probes["getAnimations"].calls],
        ["fillText", (a) => a.counts.fillText ?? 0],
        ["canvasCreated", (a) => a.counts.canvasCreated ?? 0],
      ];
      for (const [name, pick] of countRows) {
        const { i, h, d } = pair(pick);
        console.log(
          `  ${name.padEnd(22)} ${i.toFixed(2).padStart(9)} ${h.toFixed(2).padStart(9)} ${d.toFixed(2).padStart(11)}`,
        );
      }

      console.log(
        "\nper hover transition, ms             idle     hover     hover-idle    ±spread",
      );
      const timeRows = [
        ["RecalcStyleDuration", (a) => a.delta("RecalcStyleDuration") * 1000],
        ["LayoutDuration", (a) => a.delta("LayoutDuration") * 1000],
        ["ScriptDuration", (a) => a.delta("ScriptDuration") * 1000],
        ["getAnimations ms", (a) => a.probes["getAnimations"].ms],
        ...Object.keys(SUSPECTS).map((name) => [name, (a) => a.inclusive[name]]),
      ];
      for (const [name, pick] of timeRows) {
        const { i, h, d } = pair(pick);
        const s = spread(pick);
        // A delta smaller than the arm's own round-to-round spread is not a
        // result. Saying so in the output beats hoping the reader remembers.
        const verdict = Math.abs(d) < s ? "  << noise" : "";
        console.log(
          `  ${name.padEnd(22)} ${fmt(i).padStart(9)} ${fmt(h).padStart(9)} ${fmt(d).padStart(11)} ${fmt(s).padStart(10)}${verdict}`,
        );
      }

      console.log("\ntop self time under hover, ms/frame (round 1; idle alongside)");
      const idleSelf = new Map(idle.self.map((r) => [r.what, r.ms]));
      for (const row of hover.self.slice(0, 10)) {
        const i = per(idleSelf.get(row.what) ?? 0);
        console.log(`  ${fmt(per(row.ms)).padStart(9)} ${fmt(i).padStart(9)}   ${row.what}`);
      }

      await session.detach();
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
