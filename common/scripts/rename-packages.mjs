// Renames the imported packages and apps from their apendua.dev names to the
// names they publish under here. This is step 3 of docs/migration-plan.md.
//
//   node common/scripts/rename-packages.mjs
//
// It rewrites every package specifier and every path to a renamed directory in
// the tracked files under packages/ and apps/, then sets each package.json's
// version, publishConfig and repository from the table below and lists the
// packages in rush.json. Running it again changes nothing, so it can follow
// each re-run of import-apendua-dev.sh.
//
// The CHANGELOG files are left alone apart from the "name" in CHANGELOG.json:
// they record what each package was called when the entry was written.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

/**
 * Every imported package, by the folder it lives in here. "publish" is the
 * version a package that has never been published starts at, or true to keep
 * the version it has.
 *
 * @type {{ folder: string, from: string, to: string, publish?: true | string }[]}
 */
const packages = [
  { folder: "packages/justdom", from: "@apendua/justdom", to: "justdom", publish: true },
  { folder: "packages/signal", from: "@apendua/signal", to: "justdom-signal", publish: true },
  { folder: "packages/three", from: "@apendua/freedom", to: "justdom-three", publish: true },
  { folder: "packages/three-ui", from: "@apendua/justui", to: "justdom-three-ui", publish: true },
  { folder: "packages/vite-hmr", from: "@apendua/vite-hmr", to: "justdom-vite-hmr", publish: true },
  { folder: "packages/xr", from: "@apendua.dev/headset", to: "justdom-xr", publish: "0.1.0" },
  { folder: "packages/geometry", from: "@apendua.dev/geometry", to: "@apendua/geometry", publish: "0.1.0" },
  { folder: "packages/sound", from: "@apendua.dev/sound", to: "@apendua/sound", publish: "0.1.0" },
  { folder: "packages/jsdom-env", from: "@apendua/jsdom-env", to: "@apendua/jsdom-env" },
  { folder: "packages/euclid-core", from: "@apendua.dev/euclid-core", to: "@apendua/euclid-core" },
  { folder: "packages/euclid-lang", from: "@apendua.dev/euclid-lang", to: "@apendua/euclid-lang" },
  { folder: "apps/bricks-xr", from: "@apendua.dev/bricks-xr", to: "bricks-xr" },
  { folder: "apps/castle-xr", from: "@apendua.dev/castle-xr", to: "castle-xr" },
  { folder: "apps/desk", from: "@apendua.dev/desk", to: "desk" },
  { folder: "apps/euclid", from: "@apendua.dev/euclid", to: "euclid" },
  { folder: "apps/knights", from: "@apendua.dev/knights", to: "knights" },
  { folder: "apps/minesweeper", from: "@apendua.dev/minesweeper", to: "minesweeper" },
  { folder: "apps/showcase-xr", from: "@apendua.dev/showcase-xr", to: "showcase-xr" },
  { folder: "apps/todo-ssr", from: "@apendua.dev/signal-ssr", to: "todo-ssr" },
  { folder: "apps/todo-vanilla", from: "@apendua.dev/todo-vanilla", to: "todo-vanilla" },
];

/** The directories import-apendua-dev.sh renamed, as a path names them. */
const folders = [
  ["packages/freedom", "packages/three"],
  ["packages/justui", "packages/three-ui"],
  ["packages/headset", "packages/xr"],
  ["apps/signal-ssr", "apps/todo-ssr"],
];

const escape = (/** @type {string} */ text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const names = new Map(packages.map((p) => [p.from, p.to]));
// One alternation, longest first, so a name is never rewritten twice and
// "@apendua.dev/euclid" does not match the start of "@apendua.dev/euclid-core".
// A name also matches as a regular expression literal spells it, with "\." and
// "\/", and is written back the same way.
const nameRe = new RegExp(
  `(${[...names.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => escape(name).replace(/\\([./])/g, "\\\\?\\$1"))
    .join("|")})(?![\\w-])`,
  "g",
);

/** @param {string} match */
function rename(match) {
  const name = /** @type {string} */ (names.get(match.replaceAll("\\", "")));
  return match.includes("\\") ? name.replace(/[./]/g, "\\$&") : name;
}

const paths = new Map();
for (const [from, to] of folders) {
  paths.set(from, to);
  // A relative path from a sibling: "../headset/driver", "../../headset/src".
  paths.set(`../${from.split("/")[1]}`, `../${to.split("/")[1]}`);
}
const pathRe = new RegExp(
  `(?<![\\w-])(${[...paths.keys()].map(escape).join("|")})(?![\\w-])`,
  "g",
);

const text = /\.(?:[cm]?[jt]sx?|json|md|html|css|scss|svg|txt|yml|yaml)$/;

const files = execFileSync("git", ["ls-files", "packages", "apps"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((file) => text.test(file) && !/(^|\/)CHANGELOG\.(md|json)$/.test(file));

let rewritten = 0;
for (const file of files) {
  const path = join(root, file);
  const before = readFileSync(path, "utf8");
  const after = before
    .replace(nameRe, rename)
    .replace(pathRe, (from) => paths.get(from));
  if (after !== before) {
    writeFileSync(path, after);
    rewritten += 1;
  }
}

for (const { folder, to, publish } of packages) {
  const manifest = join(root, folder, "package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (publish) {
    delete pkg.private;
    if (typeof publish === "string") pkg.version = publish;
    pkg.repository = {
      type: "git",
      url: "git+https://github.com/apendua/justdom.git",
      directory: folder,
    };
    pkg.publishConfig = { access: "public" };
  } else {
    pkg.private = true;
    delete pkg.publishConfig;
    if (pkg.repository) pkg.repository.directory = folder;
  }
  pkg.name = to;
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);

  const changelog = join(root, folder, "CHANGELOG.json");
  try {
    const log = JSON.parse(readFileSync(changelog, "utf8"));
    log.name = to;
    writeFileSync(changelog, `${JSON.stringify(log, null, 2)}\n`);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
}

// The apps are listed once their dependencies on apendua.dev's media package
// are gone, which is step 4 of the plan.
const rushJson = join(root, "rush.json");
const rush = readFileSync(rushJson, "utf8");
const projects = packages
  .filter(({ folder }) => folder.startsWith("packages/"))
  .map(({ folder, to, publish }) =>
    JSON.stringify({
      packageName: to,
      projectFolder: folder,
      ...(publish ? { versionPolicyName: "publishable" } : {}),
    }),
  );
writeFileSync(
  rushJson,
  rush.replace(/"projects": \[[^\]]*\]/, `"projects": [\n    ${projects.join(",\n    ")}\n  ]`),
);

console.log(`Rewrote ${rewritten} files and ${packages.length} package.json files.`);
