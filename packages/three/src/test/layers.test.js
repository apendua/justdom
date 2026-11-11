/**
 * The package's layers, and a check that every import runs down them.
 *
 * Each module under `src/` belongs to one layer, by the table below. A
 * module may import from its own layer and the ones under it. An import
 * from a layer above is a failure, and so is a cycle of imports, whatever
 * the layers. Both are read from the source: every `import … from`,
 * `export … from`, `import "…"` and `import(…)` outside a comment, with
 * the path in any of the three quotes. A type named in a JSDoc comment is
 * not an import at run time and is not read. A path built at run time is
 * not read either; the package has none.
 *
 * The layers, from the bottom:
 *
 * - `base`: what knows nothing of a scene, such as the operators, the
 *   draw order constants and the XR button.
 * - `scene`: the renderer, its loop, the interaction manager, what points
 *   and grabs, and what the scene keeps for its panels: the contexts it
 *   fills from its options and the host the panels make their services on.
 * - `panel`: the DOM mirrored into the scene, `elements/` and what reaches
 *   it from outside it.
 * - `plugin`: what a scene opts into for its panels, the SVG plugin.
 * - `entry`: the package's entry points.
 *
 * `KNOWN` lists the imports that break the rule today. Each is a debt with
 * a plan (item 8 of the justdom-three strategy), and a PR that pays one
 * takes its line out. A line here that no longer matches an import fails
 * too, so the list cannot outlive what it excuses.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {readonly string[]} */
const ORDER = ["base", "scene", "panel", "plugin", "entry"];

/**
 * The layer of each module, by its path under `src/`. A folder ends in
 * `/` and takes everything under it.
 *
 * @type {Record<string, string>}
 */
const LAYERS = {
  "anchor.js": "base",
  "button.js": "base",
  "core.js": "base",
  "crash.js": "base",
  "drawOrder.js": "base",
  "htmlTexture.js": "base",
  "limits.js": "base",
  "matrixEpoch.js": "base",
  "operators.js": "base",
  "viewport.js": "base",
  "xr.js": "base",
  "carry.js": "scene",
  "drag.js": "scene",
  "hold.js": "scene",
  "interactions.js": "scene",
  "mouse.js": "scene",
  "panelContexts.js": "scene",
  "pointers.js": "scene",
  "render.js": "scene",
  "scene.js": "scene",
  "sceneServices.js": "scene",
  "bakery.js": "panel",
  "dom.js": "panel",
  "page.js": "panel",
  "elements/": "panel",
  "svg/": "plugin",
  "index.js": "entry",
};

/**
 * The imports that break the rule today, as `from -> to`, and the imports
 * that close a cycle, as `cycle: from -> to`. An import closes a cycle when
 * its two ends import each other, directly or through other modules, so
 * every import inside a group of such modules has its own line, and a new
 * one into the group fails even where the group is known.
 *
 * @type {readonly string[]}
 */
const KNOWN = [
  "cycle: elements/VisualProperties.js -> elements/elevation.js",
  "cycle: elements/elevation.js -> elements/pseudoElements.js",
  "cycle: elements/pseudoElements.js -> elements/VisualProperties.js",
];

/**
 * Every module under `src/` that is not a test or test support.
 *
 * @returns {string[]} Paths under `src/`, with `/`.
 */
function modules() {
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "test" && entry.name !== "types") {
          walk(path);
        }
      } else if (
        entry.name.endsWith(".js") &&
        !entry.name.endsWith(".test.js") &&
        !entry.name.endsWith(".bench.js")
      ) {
        found.push(relative(SRC, path).split("\\").join("/"));
      }
    }
  };
  walk(SRC);
  return found.sort();
}

/**
 * The modules under `src/` that `file` imports at run time.
 *
 * @param {string} file A path under `src/`.
 * @returns {string[]}
 */
function importsOf(file) {
  const source = readFileSync(join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  /** @type {Set<string>} */
  const found = new Set();
  const pattern = /(?:\bfrom|\bimport\s*\(?)\s*["'`](\.{1,2}\/[^"'`]+)["'`]/g;
  for (const match of source.matchAll(pattern)) {
    found.add(posix.normalize(posix.join(posix.dirname(file), match[1])));
  }
  return [...found].sort();
}

/**
 * @param {string} file
 * @returns {string}
 */
function layerOf(file) {
  const exact = LAYERS[file];
  if (exact) {
    return exact;
  }
  const folder = Object.keys(LAYERS)
    .filter((key) => key.endsWith("/") && file.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  assert.ok(folder, `${file} has no layer; add it to LAYERS in layers.test.js`);
  return LAYERS[folder];
}

/**
 * The imports that close a cycle: those whose two ends import each other,
 * directly or through other modules. They are the imports inside a
 * strongly connected component of the graph, found by Tarjan's algorithm.
 *
 * @param {Map<string, string[]>} graph
 * @returns {string[]} As `cycle: from -> to`, sorted.
 */
function cycleImports(graph) {
  /** @type {Map<string, number>} */
  const index = new Map();
  /** @type {Map<string, number>} */
  const low = new Map();
  /** @type {Map<string, number>} */
  const component = new Map();
  /** @type {string[]} */
  const stack = [];
  /** @param {string} node */
  const visit = (node) => {
    index.set(node, index.size);
    low.set(node, index.size - 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(
          node,
          Math.min(/** @type {number} */ (low.get(node)), /** @type {number} */ (low.get(next))),
        );
      } else if (!component.has(next)) {
        low.set(
          node,
          Math.min(/** @type {number} */ (low.get(node)), /** @type {number} */ (index.get(next))),
        );
      }
    }
    if (low.get(node) === index.get(node)) {
      const id = index.get(node);
      let member;
      do {
        member = /** @type {string} */ (stack.pop());
        component.set(member, /** @type {number} */ (id));
      } while (member !== node);
    }
  };
  for (const node of [...graph.keys()].sort()) {
    if (!index.has(node)) {
      visit(node);
    }
  }
  /** @type {string[]} */
  const found = [];
  for (const [from, imports] of graph) {
    for (const to of imports) {
      if (component.get(from) === component.get(to)) {
        found.push(`cycle: ${from} -> ${to}`);
      }
    }
  }
  return found.sort();
}

describe("finding the imports that close a cycle", () => {
  test("an import into a known cycle through a module already walked is found", () => {
    // a and b import each other; a -> c -> b closes a second cycle through
    // them, reached from a after b is done.
    const graph = new Map([
      ["a", ["b", "c"]],
      ["b", ["a"]],
      ["c", ["b"]],
      ["d", ["a"]],
    ]);
    assert.deepEqual(cycleImports(graph), [
      "cycle: a -> b",
      "cycle: a -> c",
      "cycle: b -> a",
      "cycle: c -> b",
    ]);
  });

  test("a module importing itself closes a cycle", () => {
    assert.deepEqual(cycleImports(new Map([["a", ["a"]]])), ["cycle: a -> a"]);
  });
});

describe("the package's layers", () => {
  const files = modules();
  const graph = new Map(files.map((file) => [file, importsOf(file)]));

  test("every module has a layer and every import resolves", () => {
    for (const [file, imports] of graph) {
      layerOf(file);
      for (const target of imports) {
        assert.ok(graph.has(target), `${file} imports ${target}, which is not a module here`);
      }
    }
  });

  test("an import runs down the layers or stays in one, and nothing imports in a cycle", () => {
    /** @type {string[]} */
    const broken = [];
    for (const [file, imports] of graph) {
      for (const target of imports) {
        if (ORDER.indexOf(layerOf(target)) > ORDER.indexOf(layerOf(file))) {
          broken.push(`${file} -> ${target}`);
        }
      }
    }
    broken.push(...cycleImports(graph));
    const known = new Set(KNOWN);
    assert.deepEqual(
      broken.filter((line) => !known.has(line)),
      [],
      "imports that run upward or close a cycle",
    );
    assert.deepEqual(
      KNOWN.filter((line) => !broken.includes(line)),
      [],
      "KNOWN lines that no longer match an import; take them out",
    );
  });
});
