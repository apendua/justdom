/**
 * Phase 4's draw calls a frame under the emulator: the desk's three looks
 * and the showcase, each in a session drawn by the lift and again in
 * paint order (`?paintOrder`), every panel loaded.
 *
 *   node bench/paintOrderDraws.browser.mjs
 *   APPS=desk node bench/paintOrderDraws.browser.mjs   # one app
 *
 * The apps are opened by `emulatorApps.mjs`. In each page
 * `paintOrderDraws.js` counts the WebGL draw calls of `FRAMES` frames by
 * the panel that made them, and `paintOrderCount.js` counts each panel's
 * draws under one batch by node, the scheme phase 2 decided, one eye.
 *
 * Prints a table a row a panel: its content's draws from one eye in both
 * builds beside the count, its draws that write no colour in each, and the
 * instances it re-packs a frame in each. Then a table a row a look or app:
 * its frame's draws, both eyes and everything in the scene, in each build,
 * their ratio, which is what the plan's threshold reads, and its panels'
 * draws from one eye.
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

/** @type {Map<string, { lift?: Measured, paint?: Measured }>} */
const pages = new Map();
/** The query the paint-order build is opened with; the lift build takes none. */
const PAINT_ORDER = "&paintOrder";
for (const app of chosenApps(["desk", "showcase"])) {
  await APPS[app](
    async (page, base, label, query) => {
      const entry = pages.get(label) ?? {};
      entry[query === PAINT_ORDER ? "paint" : "lift"] = await measurePage(page, base);
      pages.set(label, entry);
    },
    ["", PAINT_ORDER],
  );
}

/** @param {number} n */
const fixed = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

console.log(
  "| Panel | Lift | Paint order | Counted, one batch by node | Blank, lift | Blank, paint order | Re-packed, lift | Re-packed, paint order |",
);
console.log(
  "| ----- | ---- | ----------- | -------------------------- | ----------- | ------------------ | --------------- | ---------------------- |",
);
for (const [label, { lift, paint }] of pages) {
  if (!lift || !paint) continue;
  const liftPanels = new Map(lift.draws.panels);
  const liftBlank = new Map(lift.draws.blank);
  const paintBlank = new Map(paint.draws.blank);
  const liftRepacked = new Map(lift.draws.repacked);
  const paintRepacked = new Map(paint.draws.repacked);
  for (const [name, draws] of paint.draws.panels) {
    console.log(
      `| ${label}: ${name} | ${fixed(liftPanels.get(name) ?? 0)} | ${fixed(draws)} | ` +
        `${paint.counted.get(name) ?? ""} | ${fixed(liftBlank.get(name) ?? 0)} | ` +
        `${fixed(paintBlank.get(name) ?? 0)} | ${fixed(liftRepacked.get(name) ?? 0)} | ` +
        `${fixed(paintRepacked.get(name) ?? 0)} |`,
    );
  }
}

console.log("");
console.log(
  "| Look or app | Lift, a frame | Paint order, a frame | Ratio | Panels, one eye, lift | Panels, one eye, paint order |",
);
console.log(
  "| ----------- | ------------- | -------------------- | ----- | --------------------- | ---------------------------- |",
);
for (const [label, { lift, paint }] of pages) {
  if (!lift || !paint) continue;
  /** @param {DrawCount} draws */
  const panels = (draws) => [...draws.panels, ...draws.blank].reduce((sum, [, n]) => sum + n, 0);
  console.log(
    `| ${label} | ${fixed(lift.draws.total)} | ${fixed(paint.draws.total)} | ` +
      `${(paint.draws.total / lift.draws.total).toFixed(2)} | ${fixed(panels(lift.draws))} | ` +
      `${fixed(panels(paint.draws))} |`,
  );
}
