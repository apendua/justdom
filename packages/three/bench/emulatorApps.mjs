/**
 * The apps the paint-order benches open under the emulator: the desk's
 * three looks, the showcase, Knights and Euclid, each in a session on the
 * emulated headset with every panel loaded, handed to a visitor that
 * measures the page.
 *
 * Each app is served from source by its own Vite config, as its driven check
 * serves it, so a module the visitor imports through the same server reads
 * the very modules the app's panels were built by. Chromium is launched
 * through `packages/xr/driver`, as `bench/lineBoxCopy.browser.mjs`
 * explains, and the showcase's session is entered by its own harness, as its
 * photographs are.
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeAll, frames, launch } from "../../xr/driver/index.mjs";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** How long an app's panels may take to load under SwiftShader. */
const LOAD_TIMEOUT = 240_000;

/**
 * @typedef {import("playwright-core").Page} Page
 * @typedef {(page: Page, base: string, label: string) => Promise<void>} Visit
 *   Measure a page in a session, every panel loaded. `base` is the app's
 *   served URL, its Vite `base` included, and `label` names the look or
 *   app.
 */

/**
 * An app's Vite server, from the app's own copy of Vite.
 *
 * @param {string} app The directory under `apps/`.
 * @returns {Promise<{ url: string, server: import("vite").ViteDevServer }>}
 */
async function serve(app) {
  const root = join(REPO, "apps", app);
  const vite = /** @type {typeof import("vite")} */ (
    await import(pathToFileURL(createRequire(join(root, "package.json")).resolve("vite")).href)
  );
  const server = await vite.createServer({
    root,
    configFile: join(root, "vite.config.mts"),
    logLevel: "warn",
    server: { port: 0, strictPort: false, fs: { allow: [REPO] } },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error(`no vite url for ${app}`);
  return { url, server };
}

/**
 * Enter a session with the emulator's Enter button and wait for `ready`.
 *
 * @param {Page} page
 * @param {string} url
 * @param {string} shown A selector the page shows before it can be entered.
 * @param {(ids: string[]) => boolean} ready Run in the page.
 * @param {string[]} [ids]
 */
async function enter(page, url, shown, ready, ids = []) {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector(shown);
  await page.waitForSelector("#ARButton, #VRButton");
  await page.click("#ARButton, #VRButton");
  await page.waitForFunction(ready, ids, { timeout: LOAD_TIMEOUT, polling: 1000 });
  await frames(page, 30);
}

/**
 * Each app, each page of it handed to `visit`: one server and one browser
 * an app, and a page a look.
 *
 * @type {Record<string, (visit: Visit) => Promise<void>>}
 */
export const APPS = {
  async desk(visit) {
    const { url, server } = await serve("desk");
    /** @type {typeof import("../../../apps/desk/src/looks.ts")} */
    const looks = /** @type {any} */ (await server.ssrLoadModule("/src/looks.ts"));
    const browser = await launch();
    try {
      for (const look of looks.LOOKS) {
        const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
        await enter(
          page,
          `${url}?look=${look.id}&emulator=bare`,
          "body",
          (zones) =>
            zones.every((zone) => document.getElementById(zone)?.hasAttribute("data-xr-portal")) &&
            !document.querySelector("[data-xr-loading]"),
          look.placements.map((placement) => placement.id),
        );
        await visit(page, url, `desk, ${look.name}`);
        await page.close();
      }
    } finally {
      await closeAll(browser, server);
    }
  },

  async showcase(visit) {
    /** @type {typeof import("../../../apps/showcase-xr/tests/harness.js")} */
    const harness = await import(join(REPO, "apps/showcase-xr/tests/harness.js"));
    const { url, server } = await serve("showcase-xr");
    const browser = await launch();
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: harness.VIEWPORT });
      await page.goto(`${url}?emulator=bare`, { waitUntil: "load" });
      await page.waitForSelector("#ARButton");
      await harness.enterSession(page, { freeze: false });
      await visit(page, url, "showcase");
      await page.close();
    } finally {
      await closeAll(browser, server);
    }
  },

  async knights(visit) {
    const { url, server } = await serve("knights");
    const browser = await launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
      await enter(
        page,
        `${url}?emulator=bare`,
        "#root svg polygon",
        () =>
          !!document.querySelector("#root[data-xr-portal]") &&
          !document.querySelector("[data-xr-loading]"),
      );
      await visit(page, url, "knights");
      await page.close();
    } finally {
      await closeAll(browser, server);
    }
  },

  async euclid(visit) {
    const { url, server } = await serve("euclid");
    const browser = await launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
      await enter(
        page,
        `${url}?emulator=bare`,
        "#canvas svg circle",
        (ids) =>
          ids.every((id) => document.querySelector(`#${id}[data-xr-portal]`)) &&
          !document.querySelector("[data-xr-loading]"),
        ["toolbar", "editor", "canvas"],
      );
      await visit(page, url, "euclid");
      await page.close();
    } finally {
      await closeAll(browser, server);
    }
  },
};

/**
 * The apps `APPS=` names, comma-separated, or `fallback`.
 *
 * @param {string[]} fallback
 * @returns {string[]}
 */
export function chosenApps(fallback) {
  const chosen = process.env.APPS ? process.env.APPS.split(",") : fallback;
  for (const app of chosen) {
    if (!APPS[app]) throw new Error(`no app called ${app}`);
  }
  return chosen;
}
