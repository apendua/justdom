import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The files a user's TypeScript reads: the sources tsconfig.types.json turns
// into lib-types/, which are every file under src/ except the tests and their
// helpers, and the hand-written .d.ts files that ship beside them in src/.
const src = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(join(src, "..", "package.json"), "utf8"));

/** @param {string} dir @returns {string[]} */
function publishedFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    const rel = relative(src, path);
    if (rel === "test" || rel === "testUtils") return [];
    if (entry.isDirectory()) return publishedFiles(path);
    const source = entry.name.endsWith(".js") || entry.name.endsWith(".d.ts");
    return source && !entry.name.includes(".test.") ? [path] : [];
  });
}

// An import or export statement, a JSDoc `@import ... from`, and an
// `import("…")` type all become an import in the declaration file. The first
// three are anchored at the start of a line, so prose that happens to read
// `from "…"` in a comment does not count.
const specifiers = [
  /^\s*(?:import|export)\s[^;]*?\bfrom\s+["']([^"'.][^"']*)["']/gm,
  /^\s*import\s+["']([^"'.][^"']*)["']/gm,
  /^\s*\*\s*@import\s[^*]*?\bfrom\s+["']([^"'.][^"']*)["']/gm,
  /\bimport\(\s*["']([^"'.][^"']*)["']\s*\)/g,
];

/** @param {string} spec */
const packageOf = (spec) =>
  spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");

test("the published code and types import only packages this one declares", () => {
  const declared = new Set([
    pkg.name,
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  const undeclared = publishedFiles(src).flatMap((file) =>
    specifiers
      .flatMap((pattern) => [...readFileSync(file, "utf8").matchAll(pattern)])
      .map((match) => packageOf(match[1]))
      .filter((name) => !name.startsWith("node:") && !declared.has(name))
      .map((name) => `${relative(src, file)} imports ${name}`),
  );
  assert.deepEqual(undeclared, []);
});
