/**
 * Every cache the package keeps per node is a `nodeCache()` (`mirror.js`),
 * so that `forgetNode` empties it when a node passes to another panel, and
 * the second panel does not find the first one's signals under it.
 *
 * The test reads the sources under `src/elements/` and `src/svg/` for a
 * `new WeakMap` whose type, in the comment block straight above it, has a key
 * that names a node (`Node`, `Text`, any `…Node` or `…Element`, alone or in
 * a union), and fails on each one. A type written as a cast on the
 * initialiser is not read. A map that is right to be plain says why in the
 * run of `//` lines just above its declaration, whose first line starts
 * `// Not a nodeCache:`, such as a map that lives inside one call, or one its
 * owner empties itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const DIRECTORIES = ["elements", "svg"];
const NODE_KEYS = /@type \{WeakMap<[^,]*\b(\w*Node|\w*Element|Text)\b/;
const MARKER = /^\s*\/\/ Not a nodeCache: \S/;

/** @returns {string[]} */
function sources() {
  return DIRECTORIES.flatMap((directory) =>
    readdirSync(join(SRC, directory))
      .filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
      .map((name) => join(directory, name)),
  );
}

/**
 * The lines, counted from 1, of each map in `source` that is keyed by a node
 * and neither a `nodeCache()` nor marked.
 *
 * @param {string} source
 * @returns {number[]}
 */
function unmarkedNodeMaps(source) {
  const lines = source.split("\n");
  /** @type {number[]} */
  const found = [];
  lines.forEach((line, i) => {
    if (!line.includes("new WeakMap(")) {
      return;
    }
    // The run of `//` lines just above the declaration, where a marker is.
    let reason = i;
    while (reason > 0 && /^\s*\/\//.test(lines[reason - 1])) {
      reason -= 1;
    }
    // The comment block above that, which is where the type is written.
    let start = reason;
    while (start > 0 && /^\s*(\/\*\*|\*)/.test(lines[start - 1])) {
      start -= 1;
    }
    const block = lines.slice(start, i);
    if (block.some((text) => NODE_KEYS.test(text)) && !MARKER.test(lines[reason] ?? "")) {
      found.push(i + 1);
    }
  });
  return found;
}

test("the scan finds an unmarked map keyed by a node, in each form the package writes", () => {
  const source = [
    "/** @type {WeakMap<Element | Text, Derived<boolean>>} */",
    "const union = new WeakMap();",
    "/** @type {WeakMap<SVGElement, Derived<boolean>>} */",
    "const svg = new WeakMap();",
    "/**",
    " * A map with a doc.",
    " *",
    " * @type {WeakMap<PaintNode, number>}",
    " */",
    "const documented = new WeakMap();",
    "/** @type {WeakMap<Element, number>} */",
    "// Not a nodeCache: a reason that runs on",
    "// to a second line.",
    "const marked = new WeakMap();",
    "/** @type {WeakMap<Element, number>} */",
    "// A comment that is not a marker.",
    "// Not a nodeCache: on the second line, which does not count.",
    "const misplaced = new WeakMap();",
    "/** @type {WeakMap<THREE.Object3D, number>} */",
    "const object = new WeakMap();",
  ].join("\n");
  assert.deepEqual(unmarkedNodeMaps(source), [2, 4, 10, 18]);
});

test("a cache kept per node is a nodeCache, or says why not", () => {
  const found = sources().flatMap((file) =>
    unmarkedNodeMaps(readFileSync(join(SRC, file), "utf8")).map((line) => `${file}:${line}`),
  );
  assert.deepEqual(found, [], "use nodeCache(), or say why not above the declaration");
});
