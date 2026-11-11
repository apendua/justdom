// Points packages at another `three`, for testing the ends of its peer
// range: installs `three` at the version given, and `@types/three` at the
// newest version of the same minor (it does not publish every version
// `three` does), into a scratch folder, and links each package's
// `node_modules/three` and `node_modules/@types/three` to them in place of
// the ones Rush installed.
//
//   node common/scripts/swap-three.mjs <version> [package folder...]
//   node common/scripts/swap-three.mjs --ends
//
// The folder is `packages/three` unless one is given. Every folder's
// `peerDependencies.three` must be the same range, and the version must be
// inside it; the script stops otherwise, so a range raised in one place
// and not another fails the job rather than shipping untested.
//
// `--ends` prints the two versions to test, as a JSON array: the floor of
// `packages/three`'s range, and the newest `three` on npm inside it. The
// CI matrix is read from it, so it moves with the range.
//
// For CI, where the checkout is thrown away after the job. Locally,
// `rush install` puts the pinned version back. A `rush build` after a swap
// restores each project from the build cache, which keys on the lockfile
// the swap leaves as it was, and reports a build against the pinned three;
// build with `RUSH_BUILD_CACHE_ENABLED=0` to build against the swapped one.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * @param {string} folder
 * @returns {string}
 */
function peerRange(folder) {
  const manifest = JSON.parse(readFileSync(resolve(folder, "package.json"), "utf8"));
  const range = manifest.peerDependencies?.three;
  if (!range) {
    throw new Error(`${folder} has no peer dependency on three`);
  }
  return range;
}

/**
 * Orders two `x.y.z` versions, oldest first.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

/**
 * The versions of `name` on npm inside `range`, oldest first. npm lists
 * them in the order they were published, which is not this order once an
 * older line is patched after a newer one came out.
 *
 * @param {string} name
 * @param {string} range
 * @returns {string[]}
 */
function published(name, range) {
  const out = execFileSync("npm", ["view", `${name}@${range}`, "version", "--json"], {
    encoding: "utf8",
  });
  const found = out.trim() ? JSON.parse(out) : [];
  return (Array.isArray(found) ? found : [found]).sort(byVersion);
}

const [first, ...rest] = process.argv.slice(2);

if (first === "--ends") {
  const range = peerRange("packages/three");
  const floor = /^>=\s*(\d+\.\d+\.\d+)/.exec(range)?.[1];
  if (!floor) {
    throw new Error(`cannot read a floor from three's range ${range}`);
  }
  const newest = published("three", range).at(-1);
  console.log(JSON.stringify(newest && newest !== floor ? [floor, newest] : [floor]));
  process.exit(0);
}

const version = first;
const folders = rest.length ? rest : ["packages/three"];
if (!version) {
  console.error("usage: node common/scripts/swap-three.mjs <version> [package folder...]");
  process.exit(1);
}

const ranges = new Set(folders.map(peerRange));
if (ranges.size > 1) {
  console.error(`the folders disagree on three's range: ${[...ranges].join(", ")}`);
  process.exit(1);
}
const [range] = ranges;
if (!published("three", range).includes(version)) {
  console.error(`three ${version} is not a published version inside ${range}`);
  process.exit(1);
}
const minor = version.split(".").slice(0, 2).join(".");
const types = published("@types/three", `~${minor}.0`).at(-1);
if (!types) {
  console.error(`@types/three has no ${minor} release`);
  process.exit(1);
}

const scratch = join(tmpdir(), `three-${version}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
writeFileSync(join(scratch, "package.json"), JSON.stringify({ private: true }));
execFileSync(
  "npm",
  [
    "install",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    `three@${version}`,
    `@types/three@${types}`,
  ],
  { cwd: scratch, stdio: "inherit" },
);

for (const folder of folders) {
  const modules = resolve(folder, "node_modules");
  for (const name of ["three", "@types/three"]) {
    const link = join(modules, name);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(join(scratch, "node_modules", name), link, "dir");
  }
  console.log(`${folder} now builds against three ${version} (@types/three ${types})`);
}
