#!/usr/bin/env node
// Runs the justdom entry and the libraries it is compared with through
// js-framework-benchmark, from a clean checkout of the suite:
//
//   node run.mjs [--chrome <path>] [--headless] [--count <n>]
//                [--benchmark <prefix>]... [--framework keyed/<name>]...
//
// `--benchmark` and `--framework` take one value each; repeat them for more.
// The suite is fetched into `work/` at the commit in UPSTREAM_COMMIT, the
// entry in `frameworks/keyed/justdom` is copied into it, every framework is
// installed and built, `isKeyed` checks them, and the result files land in a
// folder of their own under `results/`. Run it again and it reuses the
// checkout and the harness, as long as the checkout is still at the pin; the
// frameworks are installed and built on every run.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const UPSTREAM = "https://github.com/krausest/js-framework-benchmark";
const UPSTREAM_COMMIT = "fa510a76ffe066af1d30f3e75fa51d3fcbc14009";

export const FRAMEWORKS = [
  "keyed/vanillajs",
  "keyed/justdom",
  "keyed/solid",
  "keyed/svelte",
  "keyed/vue",
  "keyed/preact-signals",
  "keyed/react-hooks",
  "keyed/lit",
];

const here = dirname(fileURLToPath(import.meta.url));
const work = join(here, "work");
const suite = join(work, "js-framework-benchmark");

const { values } = parseArgs({
  options: {
    chrome: { type: "string" },
    headless: { type: "boolean", default: false },
    count: { type: "string" },
    benchmark: { type: "string", multiple: true },
    framework: { type: "string", multiple: true },
  },
});
const frameworks = values.framework ?? FRAMEWORKS;

// The suite's installs download a chromedriver and a Chrome of their own.
// Puppeteer drives the Chrome named by --chrome, or the installed one.
// `work/` sits inside this repository, so Babel's browserslist lookup would
// walk up to the repository's own `.browserslistrc` and build the entries for
// its targets, or fail on a version the entry's browserslist has no data for.
// BROWSERSLIST_ROOT_PATH stops the lookup at the suite, as in a checkout of
// the suite on its own.
const env = {
  ...process.env,
  BROWSERSLIST_ROOT_PATH: suite,
  CHROMEDRIVER_SKIP_DOWNLOAD: "true",
  PUPPETEER_SKIP_DOWNLOAD: "1",
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
};

function sh(cwd, command, ...args) {
  console.log(`\n$ (${cwd}) ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

// The Chrome the suite will open: --chrome, or the path `browserPath()` in
// the suite's `puppeteerAccess.ts` falls back to. Checked before the long
// installs, so a missing Chrome stops the run at once.
const chrome =
  values.chrome ??
  {
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    linux: "/snap/bin/chromium",
    win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  }[platform()];
if (!chrome || !existsSync(chrome)) {
  console.error(`No Chrome at ${chrome ?? "a default path"}. Name one with --chrome <path>.`);
  process.exit(1);
}

const head = existsSync(suite)
  ? spawnSync("git", ["rev-parse", "HEAD"], { cwd: suite, encoding: "utf8" }).stdout.trim()
  : undefined;
if (head !== UPSTREAM_COMMIT) {
  // Only the pinned commit, not the suite's whole history.
  if (!existsSync(suite)) {
    mkdirSync(suite, { recursive: true });
    sh(suite, "git", "init", "--quiet");
    sh(suite, "git", "remote", "add", "origin", UPSTREAM);
  }
  sh(suite, "git", "fetch", "--depth", "1", "origin", UPSTREAM_COMMIT);
  sh(suite, "git", "checkout", "--force", "FETCH_HEAD");
  // The root package.json only holds the suite's lint tooling, whose peer
  // ranges conflict at this commit.
  sh(suite, "npm", "ci", "--legacy-peer-deps");
  sh(suite, "npm", "run", "install-local");
}

const entry = join(suite, "frameworks/keyed/justdom");
rmSync(entry, { recursive: true, force: true });
cpSync(join(here, "frameworks/keyed/justdom"), entry, {
  recursive: true,
  filter: (src) => !/[/\\](node_modules|dist)$/.test(src),
});

for (const framework of frameworks) {
  const dir = join(suite, "frameworks", framework);
  sh(dir, "npm", "ci");
  sh(dir, "npm", "run", "build-prod");
}

const server = spawn("npm", ["start"], {
  cwd: suite,
  env,
  stdio: "ignore",
  shell: process.platform === "win32",
  // Its own process group, so that stopping it stops the server npm started.
  detached: process.platform !== "win32",
});
try {
  await waitForServer("http://localhost:8080/index.html");
  const browser = [...(values.headless ? ["--headless"] : []), "--chromeBinary", chrome];
  const driver = join(suite, "webdriver-ts");
  sh(driver, "npm", "run", "isKeyed", "--", ...browser, ...frameworks);
  rmSync(join(driver, "results"), { recursive: true, force: true });
  sh(
    driver,
    "npm",
    "run",
    "bench",
    "--",
    ...browser,
    ...(values.count ? ["--count", values.count] : []),
    ...(values.benchmark ? ["--benchmark", ...values.benchmark] : []),
    "--framework",
    ...frameworks,
  );
  // One folder per run, so that a narrowed run never mixes with an earlier one.
  const out = join(here, "results", new Date().toISOString().slice(0, 19).replace(/:/g, "-"));
  mkdirSync(out);
  for (const file of readdirSync(join(driver, "results"))) {
    cpSync(join(driver, "results", file), join(out, file));
  }
  console.log(`\nResults in ${out}. Summarize them with: node summarize.mjs ${out}`);
} finally {
  stop(server);
}

/**
 * Stops the server and the processes `npm start` started under it. A server
 * that already exited, with port 8080 taken say, is left alone, so the error
 * that says why reaches the console.
 */
function stop(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${url} did not answer within a minute`);
}
