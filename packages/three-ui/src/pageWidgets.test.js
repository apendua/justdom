import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every module `entry` loads, followed through relative imports and through
 * the packages it names, as specifiers: the relative ones resolved against
 * the importing file, the bare ones by Node, as a bundler resolves them.
 * Read from source rather than imported, so that what is checked is what
 * a bundler would put in the page's chunk, not what happens to be loaded.
 *
 * @param {string} entry A file URL.
 * @returns {Set<string>} The file URLs of the modules, and each bare
 *   specifier that resolved to none.
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
      /^(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"/gms,
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
  // A dropdown or a scrolling list on a page that may never open a session
  // asks freedom only which panel it is in and how to scroll, which is the
  // page's side of freedom, not the renderer's.
  for (const widget of ["./dropdown.js", "./scrollable.js"]) {
    const graph = [...importGraph(new URL(widget, import.meta.url).href)];
    const three = graph.filter((url) => /\/three\/(src|build)\//.test(url));
    assert.deepEqual(three, [], `${widget} reaches three.js`);
    const scene = graph.filter((url) => url.endsWith("/freedom/src/index.js"));
    assert.deepEqual(scene, [], `${widget} reaches freedom's scene`);
  }
});
