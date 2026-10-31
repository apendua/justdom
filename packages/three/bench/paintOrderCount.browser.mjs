/**
 * Phase 1's count under the emulator: the desk's three looks, the showcase,
 * Knights and Euclid, each in a session on the emulated headset, every
 * panel counted once it has loaded.
 *
 *   node bench/paintOrderCount.browser.mjs
 *   APPS=desk node bench/paintOrderCount.browser.mjs   # one app
 *
 * The apps are opened by `emulatorApps.mjs`, and `paintOrderCount.js` is
 * imported into each page through the app's own server, so it reads the
 * very modules the app's panels were built by.
 *
 * Prints one Markdown table, a row a panel, in `paintOrderCount.js`'s
 * columns, and a second with a row for each look or app, its panels added
 * up.
 */
import { join } from "node:path";
import { APPS, REPO, chosenApps } from "./emulatorApps.mjs";
import { formatCounts, sumCounts } from "../src/test/paintOrderCount.js";

const COUNTER = join(REPO, "packages/freedom/src/test/paintOrderCount.js");

/**
 * @typedef {import("../src/test/paintOrderCount.js").PanelCount} PanelCount
 * @typedef {import("playwright-core").Page} Page
 */

/**
 * Count every panel on a page, in the page.
 *
 * @param {Page} page
 * @param {string} base The app's served URL, its Vite `base` included.
 * @returns {Promise<[string, PanelCount][]>}
 */
function countPage(page, base) {
  return page.evaluate(async (url) => {
    const { countPanel, panelName } = await import(url);
    return [...document.querySelectorAll("[data-xr-portal]")].map((root, index) => [
      panelName(root, index),
      countPanel(root),
    ]);
  }, `${base}@fs${COUNTER}`);
}

/** @type {[string, PanelCount][]} */
const rows = [];
for (const app of chosenApps(Object.keys(APPS))) {
  await APPS[app](async (page, base, label) => {
    for (const [name, count] of await countPage(page, base)) {
      rows.push([`${label}: ${name}`, count]);
    }
  });
}
console.log(formatCounts(rows));

// A row's name is its look or app, a colon, then its panel.
/** @type {Map<string, PanelCount[]>} */
const groups = new Map();
for (const [name, count] of rows) {
  const group = name.slice(0, name.lastIndexOf(":"));
  groups.set(group, [...(groups.get(group) ?? []), count]);
}
console.log("");
console.log(formatCounts([...groups].map(([group, counts]) => [group, sumCounts(counts)])));
