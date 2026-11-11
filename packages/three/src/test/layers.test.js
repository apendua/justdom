/**
 * The package's layers, and a check that every import runs down them.
 *
 * Each module under `src/` belongs to one layer, by the table below. A
 * module may import from its own layer and the ones under it. An import
 * from a layer above is a failure, and so is a cycle of imports, whatever
 * the layers. Both are read from the source: every `import … from`,
 * `export … from` and `import(…)` outside a comment. A type named in a
 * JSDoc comment is not an import at run time and is not read.
 *
 * The layers, from the bottom:
 *
 * - `base`: what knows nothing of a scene, such as the operators, the
 *   draw order constants and the XR button.
 * - `scene`: the renderer, its loop, the interaction manager and what
 *   points and grabs.
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
  "operators.js": "base",
  "viewport.js": "base",
  "xr.js": "base",
  "carry.js": "scene",
  "drag.js": "scene",
  "hold.js": "scene",
  "interactions.js": "scene",
  "mouse.js": "scene",
  "pointers.js": "scene",
  "render.js": "scene",
  "bakery.js": "panel",
  "dom.js": "panel",
  "page.js": "panel",
  "elements/": "panel",
  "svg/": "plugin",
  "index.js": "entry",
};

/**
 * The imports that break the rule today, as `from -> to`, and the cycles,
 * as `cycle: a -> b -> … -> a` starting from the first module of the cycle
 * by name.
 *
 * @type {readonly string[]}
 */
const KNOWN = [
  "render.js -> elements/image.js",
  "render.js -> elements/keyboardSlot.js",
  "render.js -> elements/panelOptions.js",
  "render.js -> elements/plugins.js",
  "render.js -> elements/portalScheduler.js",
  "cycle: elements/VisualProperties.js -> elements/elevation.js -> elements/pseudoElements.js -> elements/VisualProperties.js",
  "cycle: mouse.js -> render.js -> mouse.js",
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
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
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
 * Every cycle in the graph, each once, from its first module by name.
 *
 * @param {Map<string, string[]>} graph
 * @returns {string[]}
 */
function cycles(graph) {
  /** @type {Set<string>} */
  const found = new Set();
  /** @type {string[]} */
  const path = [];
  /** @type {Set<string>} */
  const onPath = new Set();
  /** @type {Set<string>} */
  const done = new Set();
  /** @param {string} node */
  const visit = (node) => {
    path.push(node);
    onPath.add(node);
    for (const next of graph.get(node) ?? []) {
      if (onPath.has(next)) {
        const loop = path.slice(path.indexOf(next));
        const first = loop.indexOf([...loop].sort()[0]);
        const turned = [...loop.slice(first), ...loop.slice(0, first)];
        found.add(`cycle: ${[...turned, turned[0]].join(" -> ")}`);
      } else if (!done.has(next)) {
        visit(next);
      }
    }
    path.pop();
    onPath.delete(node);
    done.add(node);
  };
  for (const node of [...graph.keys()].sort()) {
    if (!done.has(node)) {
      visit(node);
    }
  }
  return [...found].sort();
}

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
    broken.push(...cycles(graph));
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
