// Type-checks the TypeScript and JavaScript code blocks in the docs against
// the packages in this repository, so that a snippet calling an API the way
// the types refuse fails the build instead of reaching a reader.
//
// The docs are the site's own pages, the repository's README and each
// package's README. Every ```js, ```ts, ```jsx or ```tsx block in them is
// written to .snippets/ as a module of its own and checked by tsc with the
// options in `compilerOptions` below; the site's "workspace:*" dependencies
// are what an import of a package resolves to. A block is not run.
//
// Most blocks are fragments: they use a `ctx`, a `board` or a `tick` that the
// page has explained in prose, and declaring each one would bury the point of
// the block. So a name a block uses and never declares is taken to be such a
// placeholder, and tsc's error for it is dropped, unless one of the packages
// exports that name. Then the block has to import it, as a reader copying it
// would, and an API it calls is checked against the real types.
//
// A block that is not meant to compile, such as a sketch with gaps in it,
// is skipped by putting this comment on the line above its fence:
//
//   <!-- snippet: skip -->
//
// Run it after `rush build --to justdom-site`, which builds the packages'
// types; the site's `build` runs it before VitePress.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { splitFences } from "./pages.mjs";
import { demos, readJson, root, site } from "./projects.mjs";

/** The comment that skips the code block under it. */
export const skipMarker = "<!-- snippet: skip -->";

/** The file extension a block is checked as, by its fence's language. */
const extensions = /** @type {Record<string, string>} */ ({
  js: "js",
  javascript: "js",
  mjs: "js",
  jsx: "jsx",
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
});

/** What tsc checks the blocks with, written to .snippets/tsconfig.json. */
export const compilerOptions = {
  target: "es2022",
  lib: ["ES2023", "DOM", "DOM.Iterable"],
  module: "esnext",
  moduleResolution: "bundler",
  // Each block is a module even when it imports nothing, so that two blocks
  // on a page may declare the same name.
  moduleDetection: "force",
  allowJs: true,
  checkJs: true,
  strict: true,
  // A block that mounts on `document.querySelector(…)` would otherwise have
  // to show a reader a null check that is not the point of it.
  strictNullChecks: false,
  // A callback's parameters carry no annotation in a JavaScript block, and
  // one passed to a placeholder has no type to take them from.
  noImplicitAny: false,
  jsx: "preserve",
  noEmit: true,
  skipLibCheck: true,
  types: ["node"],
};

/**
 * Declarations an app makes for `on` to know an element's or an object's
 * events: each demo has a copy under src/types/. The packages do not ship
 * them, so a block is checked with justdom-three's own, relative to
 * .snippets/.
 */
export const augmentations = [
  "../../packages/three/src/types/dom.d.ts",
  "../../packages/three/src/types/three.d.ts",
];

/**
 * @typedef {object} Snippet
 * @property {number} line the line of the block's opening fence, from 1
 * @property {string} extension what the block is checked as
 * @property {string} code the block's contents, without its fences
 */

/**
 * The blocks in a Markdown file that are checked, and the lines of any skip
 * marker that has no code block under it.
 *
 * @param {string} markdown
 * @returns {{ snippets: Snippet[], stray: number[] }}
 */
export function extractSnippets(markdown) {
  /** @type {Snippet[]} */
  const snippets = [];
  /** @type {number[]} */
  const stray = [];
  let line = 1;
  /** The line of a skip marker that waits for its block. */
  let marker = 0;
  for (const { code, text } of splitFences(markdown)) {
    if (code) {
      const [fence, ...rest] = text.split("\n");
      const language = fence
        .replace(/^(```|~~~)/, "")
        .trim()
        .split(/\s+/)[0]
        .toLowerCase();
      const extension = extensions[language];
      if (extension && !marker) {
        snippets.push({ line, extension, code: rest.slice(0, -1).join("\n") + "\n" });
      }
      marker = 0;
    } else {
      const lines = text.split("\n");
      lines.forEach((content, index) => {
        if (content.trim() !== skipMarker) return;
        // A marker skips the block whose fence follows it, blank lines
        // aside; one with anything else in between is stray.
        const after = lines.slice(index + 1);
        if (after.every((l) => l.trim() === "")) marker = line + index;
        else stray.push(line + index);
      });
    }
    line += text.split("\n").length - 1;
  }
  // A marker at the end of the file has no block to skip.
  if (marker) stray.push(marker);
  return { snippets, stray };
}

/**
 * Turns tsc's output into messages that name the Markdown file and line each
 * error is on. tsc prints one line per error, `path(line,col): error TS…`,
 * and indents what a message continues with.
 *
 * @param {string} output tsc's stdout, run with `--pretty false`
 * @param {Map<string, { source: string, line: number }>} files each written
 *   file, relative to .snippets/ with `/` separators, and where its block is
 * @param {Map<string, string[]>} exported what `packageExports` returns
 * @returns {string[]}
 */
export function mapDiagnostics(output, files, exported) {
  /** @type {string[]} */
  const messages = [];
  /** The names already reported missing, by file. */
  const reported = new Set();
  /** Whether the lines that continue the last error belong to a dropped one. */
  let dropped = false;
  for (const text of output.split("\n")) {
    const match = text.match(/^(.+?)\((\d+),(\d+)\): (error TS\d+: (.*))$/);
    if (!match) {
      if (text.trim() === "" || dropped) continue;
      if (messages.length > 0) messages[messages.length - 1] += `\n${text}`;
      else messages.push(text);
      continue;
    }
    const [, file, row, column, error, message] = match;
    const block = files.get(file.split(sep).join("/").replace(/^\.\//, ""));
    const where = block
      ? `${block.source}:${block.line + Number(row)}:${column}`
      : `${file}(${row},${column})`;
    const name = message.match(
      /^Cannot find name '([^']+)'|^No value exists in scope for the shorthand property '([^']+)'/,
    );
    dropped = false;
    // An import of a relative path is of the reader's own module, which is
    // a placeholder too.
    if (/^Cannot find module '\.\.?\//.test(message)) {
      dropped = true;
      continue;
    }
    if (name) {
      const from = exported.get(name[1] ?? name[2]);
      if (!from) {
        dropped = true;
        continue;
      }
      // One message for each name a block leaves out, at its first use.
      const missing = `${file}:${name[1] ?? name[2]}`;
      if (!reported.has(missing)) {
        reported.add(missing);
        messages.push(
          `${where}: '${name[1] ?? name[2]}' is not imported, from ${from.join(" or ")}`,
        );
      }
      continue;
    }
    messages.push(`${where}: ${error}`);
  }
  return messages;
}

/**
 * Every name the site's packages export, and the import paths that export
 * it. The packages are the site's "workspace:*" dependencies that are not
 * demos, and each entry point in a package's "exports" that has types is
 * imported to list its names.
 *
 * @returns {Promise<Map<string, string[]>>}
 */
export async function packageExports() {
  /** @type {Record<string, string>} */
  const dependencies = readJson(join(site, "package.json")).devDependencies;
  const served = new Set(demos().map((demo) => demo.packageName));
  /** @type {Map<string, string[]>} */
  const exported = new Map();
  for (const [name, range] of Object.entries(dependencies)) {
    if (range !== "workspace:*" || served.has(name)) continue;
    const folder = join(site, "node_modules", name);
    /** @type {Record<string, string | { types?: string, import?: string }>} */
    const entries = readJson(join(folder, "package.json")).exports;
    for (const [path, target] of Object.entries(entries)) {
      if (typeof target === "string" || !target.types || !target.import) continue;
      const specifier = posix.join(name, path);
      const module = await import(pathToFileURL(join(folder, target.import)).href);
      for (const key of Object.keys(module)) {
        exported.set(key, [...(exported.get(key) ?? []), specifier]);
      }
    }
  }
  return exported;
}

/** The Markdown files whose code blocks are checked, relative to the root. */
export function sources() {
  /** @param {string} dir relative to the root */
  const walk = (dir) =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith(".md") ? [path] : [];
    });
  const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/README.md`)
    .filter((path) => existsSync(join(root, path)));
  // The site's own pages, without the folders scripts/pages.mjs generates
  // from the READMEs checked here, and without its README, which is about
  // working on the site rather than a page of it.
  const pages = ["site/guide", "site/api"].flatMap(walk);
  return ["README.md", ...packages, "site/index.md", ...pages];
}

async function main() {
  const out = join(site, ".snippets");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  /** @type {Map<string, { source: string, line: number }>} */
  const files = new Map();
  /** @type {string[]} */
  const problems = [];
  for (const source of sources()) {
    const { snippets, stray } = extractSnippets(readFileSync(join(root, source), "utf8"));
    for (const line of stray) {
      problems.push(`${source}:${line}: ${skipMarker} is not on the line above a code block`);
    }
    for (const { line, extension, code } of snippets) {
      const file = `${source.replace(/\.md$/, "")}/${line}.${extension}`;
      mkdirSync(join(out, posix.dirname(file)), { recursive: true });
      writeFileSync(join(out, file), code);
      files.set(file, { source, line });
    }
  }
  writeFileSync(
    join(out, "tsconfig.json"),
    JSON.stringify({ compilerOptions, include: ["**/*", ...augmentations] }, null, 2) + "\n",
  );

  const tsc = join(site, "node_modules", ".bin", "tsc");
  try {
    execFileSync(tsc, ["--project", join(out, "tsconfig.json"), "--pretty", "false"], {
      cwd: out,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const { stdout = "", stderr = "" } = /** @type {{ stdout?: string, stderr?: string }} */ (
      error
    );
    // tsc exits with 1 on errors that may all be placeholders; anything else
    // that stops it is a failure of its own.
    if (!/: error TS\d+:/.test(stdout)) throw error;
    problems.push(...mapDiagnostics(stdout + stderr, files, await packageExports()));
  }

  if (problems.length > 0) {
    console.log(problems.join("\n"));
    console.log(
      `\n${problems.length} problem(s) in the docs' code blocks. Fix the block, or put ` +
        `${skipMarker} on the line above one that is not meant to compile.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Type-checked ${files.size} code blocks in ${sources().length} Markdown files.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
