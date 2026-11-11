/**
 * Everything a panel draws moves through `place.js`: `place`, `placeAndScale`,
 * or a matrix composed by hand and then `markMoved`. An object moved any
 * other way keeps the matrix the panel's walk last gave it, since an idle
 * walk stops at the panel's edge (`keepSubtreeMatrices`).
 *
 * The test reads the sources under `src/elements/` and `src/svg/`, but for
 * `place.js`, for a line that assigns `.matrixWorldNeedsUpdate`, calls
 * `.position.set(` or calls `.matrix.copy(`, and fails on each one. A line
 * that is right says why in the run of `//` lines just above it, whose first
 * line starts `// Not placed:`, such as a matrix that `markMoved` follows,
 * or an object that is not under a panel.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const DIRECTORIES = ["elements", "svg"];
const WRITES = /\.matrixWorldNeedsUpdate\s*=(?!=)|\.position\.set\(|\.matrix\.copy\(/;
const MARKER = /^\s*\/\/ Not placed: \S/;

/** @returns {string[]} */
function sources() {
  return DIRECTORIES.flatMap((directory) =>
    readdirSync(join(SRC, directory))
      .filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
      .filter((name) => !(directory === "elements" && name === "place.js"))
      .map((name) => join(directory, name)),
  );
}

/**
 * The lines, counted from 1, that move an object outside `place.js` and are
 * not marked.
 *
 * @param {string} source
 * @returns {number[]}
 */
function unmarkedWrites(source) {
  const lines = source.split("\n");
  /** @type {number[]} */
  const found = [];
  lines.forEach((line, i) => {
    if (!WRITES.test(line) || /^\s*(\/\/|\*)/.test(line)) {
      return;
    }
    let reason = i;
    while (reason > 0 && /^\s*\/\//.test(lines[reason - 1])) {
      reason -= 1;
    }
    if (!MARKER.test(lines[reason] ?? "")) {
      found.push(i + 1);
    }
  });
  return found;
}

test("the scan finds each way to move an object, and takes a marker that wraps", () => {
  const source = [
    "object.matrixWorldNeedsUpdate = true;",
    "if (object.matrixWorldNeedsUpdate === true) {}",
    "mesh.position.set(1, 2, 3);",
    "group.matrix.copy(other);",
    "// Not placed: a reason that runs on",
    "// to a second line.",
    "hit.position.set(0, 0, 0);",
    "// A comment that is not a marker.",
    "// Not placed: on the second line, which does not count.",
    "mesh.matrix.copy(other);",
    " * `.position.set(` in a doc comment",
  ].join("\n");
  assert.deepEqual(unmarkedWrites(source), [1, 3, 4, 10]);
});

test("an object a panel draws moves through place.js, or says why not", () => {
  const found = sources().flatMap((file) =>
    unmarkedWrites(readFileSync(join(SRC, file), "utf8")).map((line) => `${file}:${line}`),
  );
  assert.deepEqual(found, [], "use place(), placeAndScale() or markMoved(), or say why not");
});
