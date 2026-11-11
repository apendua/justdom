/**
 * Everything a panel draws moves through `place.js`: `place`, `placeAndScale`,
 * or a matrix composed by hand and then `markMoved`. An object moved any
 * other way keeps the matrix the panel's walk last gave it, since an idle
 * walk stops at the panel's edge (`keepSubtreeMatrices`).
 *
 * The test reads every module under `src/` except `place.js` and the tests,
 * and finds each line that moves an object: a call or an assignment on its
 * `.position`, `.scale`, `.rotation` or `.quaternion`, a call on its
 * `.matrix` other than a reader's, `.updateMatrix()`, or an assignment to
 * `.matrixWorldNeedsUpdate`. Such a line passes in one of three ways:
 *
 * - `markMoved`, `place` or `placeAndScale` on the same object follows it,
 *   before the next blank line. The scan reads this from the code, so the
 *   test fails when the call is removed.
 * - `noteMatrixChange()` is on the next line, as it is in the modules below
 *   the panel layer, which `place.js` is above.
 * - A comment above it, before the next blank line up, starts with
 *   `// Not placed:` and says why, such as an object that is under no panel
 *   or a record that is not an object. The scan cannot check this reason, so
 *   it is kept for what the code cannot show.
 *
 * What a line scan cannot see is a matrix or a vector handed to a callee to
 * write, as `contentMatrix(contentGroup.matrix)` in `div.js` or
 * `matrix.decompose(object.position, …)` in `interactions.js` do. Those are
 * left to the call that follows them, and to whoever reads the code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * The methods that read a vector, an Euler, a quaternion or a matrix and
 * leave it as it was. `.matrix` is sometimes a CSS matrix's array of
 * numbers, hence the array readers.
 */
const READERS = [
  "clone",
  "equals",
  "toArray",
  "decompose",
  "determinant",
  "getMaxScaleOnAxis",
  "extractBasis",
  "distanceTo",
  "distanceToSquared",
  "length",
  "lengthSq",
  "manhattanLength",
  "dot",
  "angleTo",
  "getComponent",
  "every",
  "some",
].join("|");

const PARTS = "position|scale|rotation|quaternion";
const OBJECT = String.raw`([\w$#]+(?:\.[\w$#]+)*)`;
const WRITES = [
  new RegExp(String.raw`${OBJECT}\.(?:${PARTS}|matrix)\.(?!(?:${READERS})\b)\w+\s*\(`),
  new RegExp(String.raw`${OBJECT}\.(?:${PARTS})\.\w+\s*[-+*/]?=(?!=)`),
  new RegExp(String.raw`${OBJECT}\.updateMatrix\(\)`),
  new RegExp(String.raw`${OBJECT}\.matrixWorldNeedsUpdate\s*=(?!=)`),
];
const MARKER = /^\s*\/\/ Not placed: \S/;

/** @returns {string[]} The modules under `src/`, as paths from it. */
function sources(directory = SRC) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "test" ? [] : sources(path);
    }
    return entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")
      ? [relative(SRC, path)]
      : [];
  });
}

/**
 * @param {string} text
 * @returns {string}
 */
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The lines, counted from 1, that move an object and neither commit the move
 * through `place.js` nor say why not.
 *
 * @param {string} source
 * @returns {number[]}
 */
function unmarkedWrites(source) {
  const lines = source.split("\n");
  /** @type {number[]} */
  const found = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) {
      return;
    }
    const object = WRITES.map((write) => write.exec(line)?.[1]).find(Boolean);
    if (object === undefined) {
      return;
    }
    const commit = new RegExp(String.raw`\b(?:markMoved|place|placeAndScale)\(${escape(object)}\b`);
    for (let next = i + 1; next < lines.length && lines[next].trim() !== ""; next++) {
      if (commit.test(lines[next])) {
        return;
      }
    }
    if (/noteMatrixChange\(\)/.test(lines[i + 1] ?? "")) {
      return;
    }
    for (let above = i - 1; above >= 0 && lines[above].trim() !== ""; above--) {
      if (MARKER.test(lines[above])) {
        return;
      }
    }
    found.push(i + 1);
  });
  return found;
}

test("the scan finds each way to move an object, and each way to commit it", () => {
  const source = [
    "object.matrixWorldNeedsUpdate = true;",
    "if (object.matrixWorldNeedsUpdate === true) {}",
    "mesh.position.copy(at);",
    "mesh.scale.x = 2;",
    "mesh.rotation.set(0, 1, 0);",
    "group.matrix.premultiply(other);",
    "group.updateMatrix();",
    "if (group.matrix.equals(other) && at.position.distanceTo(b) > 0) {}",
    "",
    "obj.matrix.copy(next);",
    "markMoved(other);",
    "",
    "obj.matrix.copy(next);",
    "wrote = true;",
    "markMoved(obj);",
    "",
    "pivot.rotation.set(-tilt, 0, 0);",
    "place(pivot, 0, 1, 0);",
    "",
    "object.updateMatrix();",
    "noteMatrixChange();",
    "",
    "// Not placed: a reason that covers",
    "// the lines below it.",
    "hit.position.set(0, 0, 0);",
    "hit.scale.set(1, 1, 1);",
    "",
    "bar.position.set(0, 0, 0);",
    " * `.position.set(` in a doc comment",
  ].join("\n");
  assert.deepEqual(unmarkedWrites(source), [1, 3, 4, 5, 6, 7, 10, 28]);
});

test("an object a panel draws moves through place.js, or says why not", () => {
  const found = sources()
    .filter((file) => file !== join("elements", "place.js"))
    .flatMap((file) =>
      unmarkedWrites(readFileSync(join(SRC, file), "utf8")).map((line) => `${file}:${line}`),
    );
  assert.deepEqual(found, [], "use place(), placeAndScale() or markMoved(), or say why not");
});
