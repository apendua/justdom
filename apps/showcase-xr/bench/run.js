/**
 * The runner.
 *
 * Two things it does that a simpler script would not, both learned the hard
 * way on this codebase:
 *
 * It compares two *revisions*, in git worktrees, **interleaved** — A, B, A,
 * B — rather than measuring one, checking out the other and measuring again.
 * A machine that is getting busier over the course of a run will otherwise
 * hand the whole trend to whichever side went last, and a checkout in the
 * middle of a measurement session is also how one comes to measure the same
 * code twice by mistake, which has happened here.
 *
 * And it reports counts first and time second. See `metrics.js` and
 * `frames.js` for why.
 *
 * Usage:
 *   node bench/run.js                          # working tree only
 *   node bench/run.js --against origin/develop # A/B against a revision
 *   node bench/run.js --against develop --repeat 4 --scenario scroll,burst
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { installCounters } from "./metrics.js";
import { installFrameDriver, summarize } from "./frames.js";
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
    against: flags.against ?? null,
    repeat: Number(flags.repeat ?? 3),
    app: flags.app ?? "todo-xr",
    rounds: Number(flags.rounds ?? 20),
    only: flags.scenario ? flags.scenario.split(",") : null,
    styleReads: flags["style-reads"] === "true",
  };
}

function findChromium() {
  const named = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (named) {
    return named;
  }
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsers || !existsSync(browsers)) {
    return undefined;
  }
  return readdirSync(browsers)
    .filter((entry) => entry.startsWith("chromium-"))
    .sort()
    .reverse()
    .map((entry) => join(browsers, entry, "chrome-linux", "chrome"))
    .find((candidate) => existsSync(candidate));
}

/**
 * A second checkout of the repository at `revision`, sharing this one's
 * installed dependencies through the symlinks rush already put in the
 * working tree — so a comparison costs a checkout, not an install.
 *
 * @param {string} revision
 * @returns {{ root: string, dispose: () => void }}
 */
function worktree(revision) {
  const path = mkdtempSync(join(tmpdir(), "freedom-bench-"));
  execFileSync("git", ["worktree", "add", "--detach", path, revision], {
    cwd: REPO,
    stdio: "pipe",
  });
  // Every project's `node_modules` is a directory of relative symlinks of two
  // kinds, and the difference between them is the whole reason this works.
  //
  // Third-party packages point at `../../../common/temp/node_modules/.pnpm/…`
  // — pnpm's store, which is gitignored and so absent from a fresh worktree.
  // One symlink at the root lends it the installed one, and no dependency has
  // to be installed twice.
  //
  // Workspace packages point at `../../../../packages/freedom` — and because
  // that is *relative*, a copy of the directory inside the worktree resolves
  // to the **worktree's** copy of the package. That is precisely what an A/B
  // needs, and it is why these are copied rather than symlinked wholesale:
  // symlinking `node_modules` itself would resolve those relative links back
  // in the main checkout, and both sides would silently measure the same code.
  execFileSync("ln", ["-s", join(REPO, "common", "temp"), join(path, "common", "temp")]);
  // Driven by what the *worktree* contains rather than by what this checkout
  // does. The two need not agree: the revision under test may predate a
  // project, or postdate one, and a working tree happily keeps the untracked
  // remains of a branch that had others. Copying into a directory the
  // revision does not have is an error, and copying nothing into a project it
  // does have is worse — vite would fail to resolve and the side would not
  // run at all.
  for (const group of /** @type {const} */ (["apps", "packages"])) {
    for (const project of readdirSync(join(path, group))) {
      const from = join(REPO, group, project, "node_modules");
      if (existsSync(from) && existsSync(join(path, group, project))) {
        execFileSync("cp", ["-a", from, join(path, group, project, "node_modules")]);
      }
    }
  }
  // A project the revision has but this checkout never installed would fail
  // to resolve at serve time, several minutes into a run. Say so now.
  const target = join(path, "apps", "todo-xr", "node_modules");
  if (!existsSync(target)) {
    throw new Error(
      `${revision} has apps that this checkout has not installed; run \`rush install\` first`,
    );
  }
  return {
    root: path,
    dispose: () => {
      execFileSync("git", ["worktree", "remove", "--force", path], { cwd: REPO, stdio: "pipe" });
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/**
 * One measured session: a browser in an emulated headset, driving one
 * scenario, reporting its counts and its frame gaps.
 *
 * @param {{ root: string, app: string, rounds: number, styleReads: boolean }} options
 * @param {import('./scenarios.js').Scenario[]} list
 */
async function measure({ root, app, rounds, styleReads }, list) {
  const appRoot = join(root, "apps", app);
  const server = await createServer({
    root: appRoot,
    configFile: join(appRoot, "vite.config.mts"),
    logLevel: "error",
    // HMR off. A benchmark run takes minutes, and the natural thing to do
    // while one is going is to work on the code it is measuring — at which
    // point vite reloads the page mid-run, the execution context is destroyed
    // and the run dies. Worse would be an edit that landed *between* two
    // sides of an A/B and quietly changed what was being compared. A run
    // measures the tree as it stood when it started, and nothing else.
    server: { port: 0, strictPort: false, hmr: false, watch: null },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: [
      // The renderer is pinned for the same reason the visual baselines pin
      // it: a machine with a GPU would otherwise be measuring a different
      // program.
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--force-color-profile=srgb",
    ],
  });

  /** @type {Record<string, {counts: Record<string, number>, timing: object, coherence: object, rows: number}>} */
  const results = {};
  try {
    for (const scenario of list) {
      const page = await browser.newPage({
        ignoreHTTPSErrors: true,
        viewport: { width: 1024, height: 640 },
      });
      await page.addInitScript(installCounters, { styleReads });
      await page.addInitScript(installFrameDriver);
      await page.goto(`${url}?emulator`, { waitUntil: "load", timeout: 60_000 });
      await page.waitForSelector("#ARButton, #VRButton", { timeout: 30_000 });
      await page.click("#ARButton, #VRButton");
      await page.waitForFunction(() => document.querySelectorAll("canvas").length > 0, undefined, {
        timeout: 30_000,
      });

      await page.evaluate(`(async () => { ${scenario.setup} })()`);
      const rows = await page.evaluate("globalThis.__rows ?? 0");

      const measurement = await page.evaluate(
        async ({ step, frames }) => {
          // eslint-disable-next-line no-new-func
          const make = new Function(step);
          const run = make();
          // A few frames of the stimulus before the clock starts, so that
          // what is measured is the steady state rather than the JIT still
          // making up its mind.
          await globalThis.__drive(run, 20);
          const before = globalThis.__bench.snapshot();
          const gaps = await globalThis.__drive(run, frames);
          return {
            gaps,
            counts: globalThis.__bench.since(before),
            coherence: globalThis.__bench.coherence(),
          };
        },
        { step: scenario.step, frames: scenario.frames },
      );

      const per = Math.max(scenario.frames, 1);
      results[scenario.name] = {
        rows,
        counts: Object.fromEntries(
          Object.entries(measurement.counts).map(([k, v]) => [k, Math.round((v / per) * 10) / 10]),
        ),
        timing: summarize(measurement.gaps),
        coherence: measurement.coherence,
      };
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return results;
}

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const options = parse(process.argv.slice(2));
const list = scenarios(options.rounds).filter(
  (scenario) => !options.only || options.only.includes(scenario.name),
);

/** @type {{label: string, root: string, dispose?: () => void}[]} */
const sides = [{ label: "working tree", root: REPO }];
if (options.against) {
  const tree = worktree(options.against);
  sides.push({ label: options.against, root: tree.root, dispose: tree.dispose });
  // A `finally` covers a run that ends, and a benchmark run is exactly the
  // sort of thing one gives up on halfway. Killed without this, the worktree
  // survives — and the next run's `git worktree add` is then working around
  // the corpse of the last one.
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    process.on(signal, () => {
      try {
        tree.dispose();
      } finally {
        process.exit(130);
      }
    });
  }
}

/** @type {Map<string, Record<string, any>[]>} */
const collected = new Map(sides.map((side) => [side.label, []]));

try {
  for (let round = 0; round < options.repeat; round += 1) {
    // Interleaved, so that a machine drifting over the session drifts through
    // both sides equally instead of handing the trend to whichever went last.
    for (const side of sides) {
      process.stderr.write(`round ${round + 1}/${options.repeat}  ${side.label}\n`);
      collected.get(side.label)?.push(
        await measure(
          {
            root: side.root,
            app: options.app,
            rounds: options.rounds,
            styleReads: options.styleReads,
          },
          list,
        ),
      );
    }
  }
} finally {
  for (const side of sides) {
    side.dispose?.();
  }
}

/**
 * What a frame costs with the mirror doing nothing — the renderer, the
 * emulator's overlay and the browser's own bookkeeping. Every other scenario
 * is reported net of it, per side, since the two sides may not even have the
 * same floor.
 *
 * @type {Map<string, number> | null}
 */
const idleFloor = list.some((scenario) => scenario.name === "idle")
  ? new Map(
      sides.map((side) => [
        side.label,
        median((collected.get(side.label) ?? []).map((run) => run.idle?.timing.median ?? 0)),
      ]),
    )
  : null;

for (const scenario of list) {
  console.log(`\n${scenario.name} — ${scenario.what}`);
  // Both sides must have ended up mirroring the same number of elements, or
  // the comparison below is between two different workloads and every figure
  // in it is meaningless. Not hypothetical: the app supplies the list, and an
  // app whose bulk-add button became a keyboard adds items at a different
  // rate on either side of that change.
  const counts = sides.map((side) => collected.get(side.label)?.[0]?.[scenario.name]?.rows ?? 0);
  const rows = counts[0];
  if (new Set(counts).size > 1) {
    console.log(
      `  !! different workloads — ${sides
        .map((side, i) => `${side.label} ${counts[i]}`)
        .join(", ")} elements. Not comparable.`,
    );
  } else if (rows) {
    console.log(`  (${rows} elements in the scroller)`);
  }
  const keys = ["getBoundingClientRect", "thrash", "fillText", "canvasCreated", "styleProperty"];
  console.log("  per frame:");
  for (const key of keys) {
    const line = sides
      .map((side) => {
        const runs = collected.get(side.label) ?? [];
        const values = runs.map((run) => run[scenario.name]?.counts[key] ?? 0);
        return `${side.label} ${median(values)}`;
      })
      .join("   vs   ");
    console.log(`    ${key.padEnd(22)} ${line}`);
  }
  console.log("  frame gap (ms):");
  for (const key of /** @type {const} */ (["median", "p90", "worst"])) {
    const line = sides
      .map((side) => {
        const runs = collected.get(side.label) ?? [];
        const values = runs.map((run) => run[scenario.name]?.timing[key] ?? 0);
        return `${side.label} ${median(values)}`;
      })
      .join("   vs   ");
    console.log(`    ${String(key).padEnd(22)} ${line}`);
  }
  // A frame under a software rasterizer costs tens of milliseconds before the
  // mirror does anything at all, and no scheduler can win that back. Counting
  // frames over 16.7ms therefore says "yes" to everything and discriminates
  // nothing; subtracting the idle scenario's own median leaves what the
  // stimulus actually cost, which is the part under test.
  if (idleFloor !== null && scenario.name !== "idle") {
    const line = sides
      .map((side) => {
        const runs = collected.get(side.label) ?? [];
        const values = runs.map((run) => run[scenario.name]?.timing.median ?? 0);
        const floor = idleFloor.get(side.label) ?? 0;
        return `${side.label} ${Math.round((median(values) - floor) * 10) / 10}`;
      })
      .join("   vs   ");
    console.log(`    ${"above idle".padEnd(22)} ${line}`);
  }
  for (const side of sides) {
    const runs = collected.get(side.label) ?? [];
    const bad = runs.flatMap((run) => run[scenario.name]?.coherence?.mismatches ?? []);
    if (bad.length) {
      console.log(`  !! ${side.label}: the mirror disagrees with the DOM`);
      for (const entry of bad.slice(0, 5)) {
        console.log(`     ${entry.tag} held ${entry.held} live ${entry.live}`);
      }
    }
  }
}
