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
// exports that name (a type counts in a TypeScript block), or it is `THREE`.
// Then the block has to import it, as a reader copying it would, and an API
// it calls is checked against the real types. tsc itself says which names
// the packages export: see `exportsOf`.
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
import { fileURLToPath } from "node:url";
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
 * @param {Exports} exported what `exportsOf` returns
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
    const name = text.match(unresolved);
    dropped = false;
    // An import of a relative path is of the reader's own module, which is
    // a placeholder too.
    if (/^Cannot find module '\.\.?\//.test(message)) {
      dropped = true;
      continue;
    }
    if (name) {
      // A name exported as a type alone is a placeholder in a JavaScript
      // block, which has no type positions outside its JSDoc.
      const from =
        exported.values.get(name[1] ?? name[2]) ??
        (/\.tsx?$/.test(file) ? exported.types.get(name[1] ?? name[2]) : undefined);
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
 * Namespaces a block refers to by the name the docs import them under, and
 * the module each is. A package's own names come from `entryPoints`.
 */
export const namespaces = new Map([["THREE", "three"]]);

/**
 * Every import path of the site's packages that has types: the site's
 * "workspace:*" dependencies that are not demos, each with the entries in
 * its "exports".
 *
 * @returns {string[]}
 */
export function entryPoints() {
  /** @type {Record<string, string>} */
  const dependencies = readJson(join(site, "package.json")).devDependencies;
  const served = new Set(demos().map((demo) => demo.packageName));
  return Object.entries(dependencies)
    .filter(([name, range]) => range === "workspace:*" && !served.has(name))
    .flatMap(([name]) => {
      /** @type {Record<string, string | { types?: string }>} */
      const entries = readJson(join(site, "node_modules", name, "package.json")).exports;
      return Object.entries(entries)
        .filter(([, target]) => typeof target !== "string" && target.types)
        .map(([path]) => posix.join(name, path));
    });
}

/**
 * The names tsc could not find in the blocks, each once.
 *
 * @param {string} output tsc's stdout
 * @returns {string[]}
 */
export function unresolvedNames(output) {
  const names = new Set();
  for (const match of output.matchAll(new RegExp(unresolved.source, "gm"))) {
    names.add(match[1] ?? match[2]);
  }
  return [...names];
}

/** tsc's message for a name a block uses and nothing declares. */
const unresolved =
  /: error TS\d+: (?:Cannot find name '([^']+)'|No value exists in scope for the shorthand property '([^']+)')/;

/**
 * @typedef {object} Exports
 * @property {Map<string, string[]>} values each name an entry point exports
 *   as a value, and the entry points that do
 * @property {Map<string, string[]>} types each name exported as a type alone
 */

/**
 * Which of `names` the packages export, and from which import paths. tsc
 * answers it: a probe imports every name from every entry point under an
 * alias, one entry point a line, and then uses each alias as a value. tsc
 * reports a name an entry point does not export on that entry point's line,
 * and an alias of a type that is not a value where it is used.
 *
 * @param {string[]} names
 * @param {string} dir a folder of its own under the site, for the probe
 * @returns {Exports}
 */
export function exportsOf(names, dir) {
  /** @type {Exports} */
  const exported = { values: new Map(), types: new Map() };
  for (const name of names) {
    const module = namespaces.get(name);
    if (module) exported.values.set(name, [module]);
  }
  const candidates = names.filter((name) => !namespaces.has(name));
  if (candidates.length === 0) return exported;
  const probe = writeProbe(entryPoints(), candidates);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "probe.ts"), probe.text);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions, files: ["probe.ts"] }, null, 2) + "\n",
  );
  const { values, types } = readProbe(runTsc(dir), probe);
  for (const [name, from] of values) exported.values.set(name, from);
  for (const [name, from] of types) exported.types.set(name, from);
  return exported;
}

/**
 * @typedef {object} Probe
 * @property {string} text the probe's source
 * @property {number} imports how many of its lines are imports, from line 1
 * @property {{ entry: string, line: number, column: number, name: string }[]} aliases
 *   each name as it is imported, as `_` and its index, at a line and a
 *   column from 1
 */

/**
 * The probe `exportsOf` hands to tsc: one import line for each entry point,
 * each name under an alias, then one statement for each alias that uses it
 * as a value, since tsc reports one such error a statement.
 *
 * @param {string[]} entries
 * @param {string[]} names
 * @returns {Probe}
 */
export function writeProbe(entries, names) {
  /** @type {Probe["aliases"]} */
  const aliases = [];
  const lines = entries.map((entry, index) => {
    let text = "import { ";
    names.forEach((name, n) => {
      if (n > 0) text += ", ";
      aliases.push({ entry, line: index + 1, column: text.length + 1, name });
      text += `${name} as _${aliases.length - 1}`;
    });
    return `${text} } from "${entry}";`;
  });
  lines.push(...aliases.map((_, index) => `void _${index};`));
  return { text: lines.join("\n") + "\n", imports: entries.length, aliases };
}

/**
 * What tsc's errors on a probe say each entry point exports. Any error at a
 * name on an import line means the entry point does not export it: tsc
 * words that several ways, such as a member that does not exist, or one the
 * module declares but does not export. An alias that refers to a type alone
 * is reported where it is used as a value. Any other error, such as an
 * entry point that does not resolve, throws, since it would otherwise read
 * as an entry point that exports every name.
 *
 * @param {string} output tsc's stdout for the probe
 * @param {Probe} probe
 * @returns {{ values: Map<string, string[]>, types: Map<string, string[]> }}
 */
export function readProbe(output, { imports, aliases }) {
  const missing = new Set();
  const typeOnly = new Set();
  for (const [text, row, column, message] of output.matchAll(
    /^probe\.ts\((\d+),(\d+)\): error TS\d+: (.*)$/gm,
  )) {
    const line = Number(row);
    if (line <= imports) {
      const index = aliases.findIndex((a) => a.line === line && a.column === Number(column));
      if (index === -1) {
        const entry = aliases.find((a) => a.line === line)?.entry;
        throw new Error(`The probe could not import from ${entry}: ${text}`);
      }
      missing.add(index);
    } else if (/^'_\d+' only refers to a type/.test(message)) {
      typeOnly.add(Number(message.slice(2, message.indexOf("'", 1))));
    } else {
      throw new Error(`The probe failed: ${text}`);
    }
  }
  /** @type {{ values: Map<string, string[]>, types: Map<string, string[]> }} */
  const exported = { values: new Map(), types: new Map() };
  aliases.forEach(({ entry, name }, index) => {
    if (missing.has(index)) return;
    const map = typeOnly.has(index) ? exported.types : exported.values;
    map.set(name, [...(map.get(name) ?? []), entry]);
  });
  return exported;
}

/**
 * Runs tsc on the tsconfig.json in `dir` and returns what it printed. tsc
 * exits with 1 when it reports errors; anything else that stops it throws.
 *
 * @param {string} dir
 */
function runTsc(dir) {
  const tsc = join(site, "node_modules", ".bin", "tsc");
  try {
    execFileSync(tsc, ["--project", join(dir, "tsconfig.json"), "--pretty", "false"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "";
  } catch (error) {
    const { stdout = "" } = /** @type {{ stdout?: string }} */ (error);
    if (!/: error TS\d+:/.test(stdout)) throw error;
    return stdout;
  }
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

/**
 * The packages whose README is checked but which the site does not depend
 * on, so that their own names would be taken for placeholders.
 *
 * @returns {string[]} their names
 */
export function packagesNotDependedOn() {
  /** @type {Record<string, string>} */
  const dependencies = readJson(join(site, "package.json")).devDependencies;
  return sources()
    .filter((source) => source.startsWith("packages/"))
    .map((source) => readJson(join(root, posix.dirname(source), "package.json")).name)
    .filter((name) => dependencies[name] !== "workspace:*");
}

function main() {
  const out = join(site, ".snippets");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  /** @type {Map<string, { source: string, line: number }>} */
  const files = new Map();
  /** @type {string[]} */
  const problems = packagesNotDependedOn().map(
    (name) =>
      `site/package.json: ${name} has a README that is checked, so it has to be a "workspace:*" devDependency`,
  );
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

  const output = runTsc(out);
  // A dot folder, which the blocks' tsconfig.json does not include.
  const exported = exportsOf(unresolvedNames(output), join(out, ".probe"));
  problems.push(...mapDiagnostics(output, files, exported));

  if (problems.length > 0) {
    console.log(problems.join("\n"));
    console.log(
      `\n${problems.length} problem(s). A code block that is not meant to compile can be ` +
        `skipped with ${skipMarker} on the line above its fence.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Type-checked ${files.size} code blocks in ${sources().length} Markdown files.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
