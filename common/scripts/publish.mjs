#!/usr/bin/env node
// Publishes the packages of the "publishable" version policy whose current
// version is not on npm yet, then tags each one it published.
//
//   npm login
//   node common/scripts/publish.mjs            # build, publish, tag, push tags
//   node common/scripts/publish.mjs --dry-run  # say what would be published
//
// It replaces `rush publish`, which ran npm with a home directory of its own,
// so the publisher's `npm login` was not read, and which decided what was
// already published by reading `npm view <name> time --json` as an object.
// npm 11 prints that as an array, so Rush saw no versions at all and tried to
// publish over the ones already there. This script asks npm about the exact
// version instead, which every npm answers the same way, and runs `pnpm
// publish` with the publisher's own login. npm asks for the second factor
// once per package, in this terminal.
//
// Rush still owns the versions: `rush version --bump`, run by the Release
// workflow, writes them, and this script only publishes what is committed.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const registry = "https://registry.npmjs.org/";
const policy = "publishable";
const branch = "develop";
const dryRun = process.argv.includes("--dry-run");
const pnpm = join(root, "common", "temp", "pnpm-local", "node_modules", ".bin", "pnpm");
const rush = join(root, "common", "scripts", "install-run-rush.js");

/** @param {string} path */
function readJson(path) {
  // rush.json holds comments.
  const text = readFileSync(path, "utf8").replace(/^\s*\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
  return JSON.parse(text);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 */
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
}

/** @param {string[]} args */
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

/**
 * Whether npm has this exact version. `npm view <name>@<version> version`
 * prints the version when it exists, prints nothing when the package exists
 * without it, and fails with E404 when the package does not exist at all.
 *
 * @param {string} name
 * @param {string} version
 */
function isPublished(name, version) {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "version", "--registry", registry],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status === 0) return result.stdout.trim() !== "";
  if (/E404|404 Not Found/.test(result.stderr)) return false;
  throw new Error(`npm view ${name}@${version} failed:\n${result.stderr}`);
}

/**
 * The packages of the policy, each after the ones of the policy it depends
 * on, so that no package reaches npm before a version it requires.
 *
 * @returns {{ name: string, version: string, folder: string }[]}
 */
function packagesInOrder() {
  const projects = readJson(join(root, "rush.json")).projects.filter(
    (/** @type {{ versionPolicyName?: string }} */ p) => p.versionPolicyName === policy,
  );
  const byName = new Map(
    projects.map((/** @type {{ packageName: string, projectFolder: string }} */ p) => {
      const folder = join(root, p.projectFolder);
      const json = readJson(join(folder, "package.json"));
      const needs = Object.keys({ ...json.dependencies, ...json.peerDependencies });
      return [p.packageName, { name: p.packageName, version: json.version, folder, needs }];
    }),
  );
  /** @type {{ name: string, version: string, folder: string }[]} */
  const ordered = [];
  const seen = new Set();
  /** @param {string} name */
  const visit = (name) => {
    const entry = byName.get(name);
    if (!entry || seen.has(name)) return;
    seen.add(name);
    entry.needs.forEach(visit);
    ordered.push({ name: entry.name, version: entry.version, folder: entry.folder });
  };
  [...byName.keys()].forEach(visit);
  return ordered;
}

function checkCheckout() {
  if (git(["status", "--porcelain"]) !== "") {
    throw new Error("The working tree has changes. Publish from a clean checkout.");
  }
  git(["fetch", "--quiet", "origin", branch]);
  if (git(["rev-parse", "HEAD"]) !== git(["rev-parse", `origin/${branch}`])) {
    throw new Error(`HEAD is not origin/${branch}. Check out an up-to-date ${branch} first.`);
  }
}

function main() {
  if (!existsSync(pnpm)) {
    throw new Error("pnpm is not installed yet. Run `node common/scripts/install-run-rush.js install`.");
  }
  if (!dryRun) {
    checkCheckout();
    run("node", [rush, "build", "--to", `version-policy:${policy}`]);
  }

  const pending = packagesInOrder().filter((p) => {
    const published = isPublished(p.name, p.version);
    console.log(`${published ? "on npm  " : "pending "} ${p.name}@${p.version}`);
    return !published;
  });
  if (pending.length === 0) {
    console.log("Every version is on npm already. Nothing to publish.");
    return;
  }
  if (dryRun) {
    console.log(`\nWould publish ${pending.length}: ${pending.map((p) => p.name).join(", ")}`);
    return;
  }

  /** @type {string[]} */
  const tags = [];
  try {
    for (const p of pending) {
    console.log(`\nPublishing ${p.name}@${p.version}`);
    // pnpm rewrites `workspace:*` to the versions it points at. The registry
    // flags override anything in the publisher's ~/.npmrc, such as an
    // "@apendua" scope mapped to GitHub Packages.
    run(
      pnpm,
      ["publish", "--no-git-checks", "--registry", registry, `--@apendua:registry=${registry}`],
      p.folder,
    );
    const tag = `${p.name}_v${p.version}`;
    if (git(["tag", "--list", tag]) === "") {
      git(["tag", "-a", tag, "-m", `${p.name} v${p.version}`]);
    }
    tags.push(tag);
    }
  } finally {
    // Even when a later package fails, the ones already on npm keep their
    // tags: a rerun skips them, so it would never tag them again.
    if (tags.length > 0) run("git", ["push", "origin", ...tags]);
  }
  console.log(`\nPublished and tagged ${tags.length}: ${tags.join(", ")}`);
}

try {
  main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
