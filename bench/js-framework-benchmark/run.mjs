#!/usr/bin/env node
// Runs the justdom entry and the libraries it is compared with through
// js-framework-benchmark, from a clean checkout of the suite:
//
//   node run.mjs [--chrome <path>] [--headless] [--count <n>]
//                [--benchmark <prefix> ...] [--framework keyed/<name> ...]
//
// The suite is cloned into `work/` at the commit in UPSTREAM_COMMIT, the
// entry in `frameworks/keyed/justdom` is copied into it, every framework is
// installed and built, `isKeyed` checks them, and the result files land in
// `results/<date>/`. Run it again and it reuses the checkout and the installs.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
const env = {
  ...process.env,
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

if (!existsSync(suite)) {
  mkdirSync(work, { recursive: true });
  sh(work, "git", "clone", UPSTREAM, "js-framework-benchmark");
  sh(suite, "git", "checkout", UPSTREAM_COMMIT);
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
  const lock = existsSync(join(dir, "package-lock.json"));
  sh(dir, "npm", lock ? "ci" : "install");
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
  const browser = [
    ...(values.headless ? ["--headless"] : []),
    ...(values.chrome ? ["--chromeBinary", values.chrome] : []),
  ];
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
  const out = join(here, "results", new Date().toISOString().slice(0, 10));
  mkdirSync(out, { recursive: true });
  for (const file of readdirSync(join(driver, "results"))) {
    cpSync(join(driver, "results", file), join(out, file));
  }
  console.log(`\nResults in ${out}. Summarize them with: node summarize.mjs ${out}`);
} finally {
  if (process.platform === "win32") server.kill();
  else process.kill(-server.pid);
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
