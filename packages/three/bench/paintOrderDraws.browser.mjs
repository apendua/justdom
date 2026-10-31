/**
 * Phase 4's draw calls a frame under the emulator: the desk's three looks
 * and the showcase, each in a session, every panel loaded.
 *
 *   node bench/paintOrderDraws.browser.mjs
 *   APPS=desk node bench/paintOrderDraws.browser.mjs   # one app
 *
 * The apps are opened by `emulatorApps.mjs`. In each page
 * `paintOrderDraws.js` counts the WebGL draw calls of `FRAMES` frames by
 * the panel that made them, and `paintOrderCount.js` counts each panel's
 * draws under one batch by node, the scheme phase 2 decided, one eye.
 *
 * Prints a table a row a panel: its content's draws from one eye beside
 * the count, its draws that write no colour, and the instances it re-packs
 * a frame. Then a table a row a look or app: its frame's draws, both eyes
 * and everything in the scene, and its panels' draws from one eye.
 */
import { join } from "node:path";
import { APPS, REPO, chosenApps } from "./emulatorApps.mjs";

const DRAWS = join(REPO, "packages/freedom/src/test/paintOrderDraws.js");
const COUNTER = join(REPO, "packages/freedom/src/test/paintOrderCount.js");

/** How many frames each page's draws are averaged over. */
const FRAMES = 60;

/**
 * @typedef {import("../src/test/paintOrderDraws.js").DrawCount} DrawCount
 * @typedef {{ draws: DrawCount, counted: Map<string, number> }} Measured
 */

/**
 * Measure a page in the page: its draws, and each panel's count.
 *
 * @param {import("playwright-core").Page} page
 * @param {string} base
 * @returns {Promise<Measured>}
 */
async function measurePage(page, base) {
  const [draws, counted] = await page.evaluate(
    async ([drawsUrl, counterUrl, frames]) => {
      const { measureDraws } = await import(drawsUrl);
      const { countPanel, panelName } = await import(counterUrl);
      const roots = [...document.querySelectorAll("[data-xr-portal]")];
      return [
        await measureDraws(frames),
        roots.map((root, index) => [panelName(root, index), countPanel(root).oneBatchByNode]),
      ];
    },
    /** @type {const} */ ([`${base}@fs${DRAWS}`, `${base}@fs${COUNTER}`, FRAMES]),
  );
  return { draws, counted: new Map(counted) };
}

/** @type {Map<string, Measured>} */
const pages = new Map();
for (const app of chosenApps(["desk", "showcase"])) {
  await APPS[app](async (page, base, label) => {
    pages.set(label, await measurePage(page, base));
  });
}

/** @param {number} n */
const fixed = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

console.log("| Panel | Draws | Counted, one batch by node | Blank | Re-packed |");
console.log("| ----- | ----- | -------------------------- | ----- | --------- |");
for (const [label, { draws, counted }] of pages) {
  const blank = new Map(draws.blank);
  const repacked = new Map(draws.repacked);
  for (const [name, panel] of draws.panels) {
    console.log(
      `| ${label}: ${name} | ${fixed(panel)} | ${counted.get(name) ?? ""} | ` +
        `${fixed(blank.get(name) ?? 0)} | ${fixed(repacked.get(name) ?? 0)} |`,
    );
  }
}

console.log("");
console.log("| Look or app | A frame | Panels, one eye |");
console.log("| ----------- | ------- | --------------- |");
for (const [label, { draws }] of pages) {
  const panels = [...draws.panels, ...draws.blank].reduce((sum, [, n]) => sum + n, 0);
  console.log(`| ${label} | ${fixed(draws.total)} | ${fixed(panels)} |`);
}
