// Points packages at another `three`, for testing the ends of its peer
// range: installs `three` and `@types/three` at the version given into a
// scratch folder, and links the package's `node_modules/three` and
// `node_modules/@types/three` to them in place of the ones Rush installed.
// For CI, where the checkout is thrown away after the job. Locally,
// `rush install` puts the pinned version back.
//
//   node common/scripts/swap-three.mjs <version> [package folder...]
//
// The folder is `packages/three` unless one is given.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [version, ...given] = process.argv.slice(2);
const folders = given.length ? given : ["packages/three"];
if (!version) {
  console.error("usage: node common/scripts/swap-three.mjs <version> [package folder...]");
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
    `@types/three@${version}`,
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
  console.log(`${folder} now builds against three ${version}`);
}
