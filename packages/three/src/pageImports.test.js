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

test("a page that imports the page's side from the main entry bundles no three.js", async () => {
  // `page.js` is the entry for a page with no scene, and imports nothing of
  // three.js. A widget that imports the same names from the main entry
  // instead gets the same bundle only because the package says its modules
  // have no side effects: the renderer is then left out as unused.
  const text =
    await bundle(`import { FOCUS_ATTRIBUTE, getPortalRoot, scrollElementBy } from "./src/index.js";
    console.log(FOCUS_ATTRIBUTE, getPortalRoot, scrollElementBy);`);
  assert.ok(text.includes("data-xr-focus"), "the bundle is the page's side");
  assert.ok(!text.includes("WebGLRenderer"), "the bundle carries three.js's renderer");
  assert.ok(!text.includes("data-xr-hover"), "the bundle carries the pointer forwarding");
});

test("a scene that imports render keeps what it draws with", async () => {
  // The other half of the promise: a module left out must be one nothing
  // used, so an app that renders still bundles the renderer.
  const text = await bundle(`import { render } from "./src/index.js"; console.log(render);`);
  assert.ok(text.includes("WebGLRenderer"));
});
