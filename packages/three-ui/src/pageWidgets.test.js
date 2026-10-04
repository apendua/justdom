import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** The widgets a page may show with no scene anywhere near it. */
const WIDGETS = ["dropdown", "scrollable", "keyboard"];

/**
 * Every module `entry` loads, followed through relative imports and through
 * the packages it names, as specifiers: the relative ones resolved against
 * the importing file, the bare ones by Node, as a bundler resolves them. A
 * side-effect import, with no `from`, is followed too, since a bundler
 * keeps it. Read from source rather than imported, so that what is checked
 * is what a bundler would put in the page's chunk, not what happens to be
 * loaded.
 *
 * @param {string} entry A file URL.
 * @returns {Set<string>} The URLs of the modules: the `.js` files the walk
 *   read, and the ones it does not read, `node:` builtins and files that
 *   are not `.js`. A bare specifier Node cannot resolve throws.
 */
function importGraph(entry) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} url */
  const visit = (url) => {
    if (seen.has(url)) {
      return;
    }
    seen.add(url);
    if (!url.startsWith("file:") || !url.endsWith(".js")) {
      return;
    }
    const source = readFileSync(fileURLToPath(url), "utf8");
    for (const [, specifier] of source.matchAll(
      /^(?:import|export)\s(?:[^;"']*?\sfrom\s*)?["']([^"']+)["']/gm,
    )) {
      visit(
        specifier.startsWith(".") ? new URL(specifier, url).href : import.meta.resolve(specifier),
      );
    }
  };
  visit(entry);
  return seen;
}

test("the widgets a page shows load no three.js and no scene", () => {
  // A dropdown, a scrolling list or a keyboard on a page that may never
  // open a session asks freedom at most which panel it is in and how to
  // scroll, which is the page's side of freedom, not the renderer's.
  for (const widget of WIDGETS) {
    const graph = [...importGraph(new URL(`./${widget}.js`, import.meta.url).href)];
    const three = graph.filter((url) => /\/three\/(src|build)\//.test(url));
    assert.deepEqual(three, [], `${widget}.js reaches three.js`);
    const scene = graph.filter((url) => url.endsWith("/freedom/src/index.js"));
    assert.deepEqual(scene, [], `${widget}.js reaches freedom's scene`);
  }
});

test("a page that imports them from the package bundles no three.js", async () => {
  // The package's entry also exports the diagnostics, which do import
  // three.js and freedom's scene. A bundler leaves them out of a page that
  // does not use them only because the package says it has no side effects.
  const result = await build({
    stdin: {
      contents: `import { ${WIDGETS.join(", ")} } from "./src/index.js";
        console.log(${WIDGETS.join(", ")});`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const bundle = result.outputFiles[0].text;
  assert.ok(bundle.includes("aria-expanded"), "the bundle is the widgets'");
  assert.ok(!bundle.includes("WebGLRenderer"), "the bundle carries three.js's renderer");
});
