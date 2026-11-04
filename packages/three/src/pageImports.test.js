import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Bundle `contents` as a page would, from this package's directory, and
 * answer the bundle's text.
 *
 * @param {string} contents
 * @returns {Promise<string>}
 */
async function bundle(contents) {
  const result = await build({
    stdin: { contents, resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

/**
 * The modules a bundle is made of, each with its code, in a fixed order.
 * esbuild puts them in the order the entry reaches them, which differs
 * between two entries that reach the same modules.
 *
 * @param {string} text A bundle, as `bundle` answers it.
 * @returns {string[]}
 */
function modules(text) {
  return text.split(/^(?=\/\/ )/m).sort();
}

test("a page that imports the page's side from the main entry bundles no three.js", async () => {
  // `page.js` is the entry for a page with no scene, and imports nothing of
  // three.js. A widget that imports the same names from the main entry
  // instead gets the same bundle only because the package says its modules
  // have no side effects: the renderer is then left out as unused.
  const names = "FOCUS_ATTRIBUTE, getPortalRoot, scrollElementBy";
  const use = `console.log(${names});`;
  const main = await bundle(`import { ${names} } from "./src/index.js"; ${use}`);
  const page = await bundle(`import { ${names} } from "./src/page.js"; ${use}`);
  assert.deepEqual(modules(main), modules(page));
});

test("a scene that imports render keeps what it draws with", async () => {
  // The other half of the promise: a module left out must be one nothing
  // used, so an app that renders still bundles the renderer.
  const text = await bundle(`import { render } from "./src/index.js"; console.log(render);`);
  assert.ok(text.includes("WebGLRenderer"));
});
