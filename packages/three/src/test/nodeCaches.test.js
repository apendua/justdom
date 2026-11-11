/**
 * Every cache the package keeps per node is a `nodeCache()` (`mirror.js`),
 * so that `forgetNode` empties it when a node passes to another panel, and
 * the second panel does not find the first one's signals under it.
 *
 * The test reads the sources under `src/elements/` and `src/svg/` for a
 * `new WeakMap` whose type, in the comment block straight above it, is keyed
 * by `Node`, `Element`, `HTMLElement`, `HTMLInputElement`, `Text` or
 * `PaintNode`, and fails on each one. A map that is right to be plain says
 * why on the line just above its declaration, in a comment that starts
 * `// Not a nodeCache:`, such as a map that lives inside one call, or one
 * its owner empties itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const DIRECTORIES = ["elements", "svg"];
const NODE_KEYS = /@type \{WeakMap<(Node|Element|HTMLElement|HTMLInputElement|Text|PaintNode),/;
const MARKER = /^\s*\/\/ Not a nodeCache: \S/;

/** @returns {string[]} */
function sources() {
  return DIRECTORIES.flatMap((directory) =>
    readdirSync(join(SRC, directory))
      .filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
      .map((name) => join(directory, name)),
  );
}

test("a cache kept per node is a nodeCache, or says why not", () => {
  /** @type {string[]} */
  const found = [];
  for (const file of sources()) {
    const lines = readFileSync(join(SRC, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("new WeakMap(")) {
        return;
      }
      // The comment block straight above the declaration, which is where
      // its type is written.
      let start = i;
      while (start > 0 && /^\s*(\/\*\*|\*|\/\/)/.test(lines[start - 1])) {
        start -= 1;
      }
      const block = lines.slice(start, i);
      if (block.some((text) => NODE_KEYS.test(text)) && !MARKER.test(lines[i - 1] ?? "")) {
        found.push(`${file}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(found, [], "use nodeCache(), or say why not above the declaration");
});
