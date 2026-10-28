/**
 * What a check script needs to drive an app's session on the emulated
 * headset in headless Chromium: the browser, the frame clock, the right
 * controller's aim and buttons, and the tally of what passed. The apps'
 * `tests/xr-check.mjs` import it, so that one fix to the aiming or to IWER's
 * controller calls reaches every check at once.
 *
 * It runs in Node, not in the page, and drives the device `install` leaves
 * on `window.xrDevice` (`src/emulator.js`), so the page has to be loaded
 * with `?emulator`, or `?emulator=bare` for nothing over the scene.
 *
 * Playwright is borrowed from `apps/showcase-xr`, so that project has to
 * have been installed. The browser is the Chromium a development container
 * keeps at `/opt/pw-browsers/chromium-1194`, or the one `CHROMIUM` names.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** @type {typeof import("playwright-core")} */
const { chromium } = await import(
  resolve(REPO, "apps/showcase-xr/node_modules/playwright-core/index.mjs")
);

/**
 * Chromium on SwiftShader, which is what draws a session with no GPU.
 *
 * @returns {Promise<import("playwright-core").Browser>}
 */
export function launch() {
  return chromium.launch({
    executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
}

/**
 * Close what a check opened. Chromium under SwiftShader now and then never
 * answers a close, and every check has been made by then, so each is given
 * a few seconds and left.
 *
 * @param {...{ close(): Promise<unknown> }} closables
 */
export async function closeAll(...closables) {
  for (const closable of closables) {
    const giveUp = new Promise((done) => setTimeout(done, 10_000));
    await Promise.race([closable.close(), giveUp]);
  }
}

/**
 * Wait for the page to draw `count` frames.
 *
 * @param {import("playwright-core").Page} page
 * @param {number} count
 */
export async function frames(page, count) {
  await page.evaluate(
    (n) =>
      new Promise((done) => {
        let left = n;
        const step = () => (--left <= 0 ? done(undefined) : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    count,
  );
}

/**
 * Keep what three makes in the page, for a check of what is drawn: three
 * tells a devtools hook of every scene and every renderer it makes, if one
 * is there. This puts one there before the page loads, which keeps them in
 * `window.threeScenes` and `window.threeRenderers`.
 *
 * @param {import("playwright-core").Page} page
 */
export async function observeThree(page) {
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    w.threeScenes = [];
    w.threeRenderers = [];
    const hook = new EventTarget();
    hook.addEventListener("observe", (/** @type {any} */ event) => {
      if (event.detail?.isScene) w.threeScenes.push(event.detail);
      if (event.detail?.isWebGLRenderer) w.threeRenderers.push(event.detail);
    });
    w.__THREE_DEVTOOLS__ = hook;
  });
}

/** @type {string[]} */
const failures = [];

/**
 * Print one check, and remember it if it failed.
 *
 * @param {boolean} ok
 * @param {string} what
 */
export function check(ok, what) {
  console.log(`  ${ok ? "OK" : "FAIL"}: ${what}`);
  if (!ok) {
    failures.push(what);
  }
}

/** Say how many checks failed, and exit 1 if any did and 0 if none did. */
export function finish() {
  if (failures.length) {
    console.log(`\n${failures.length} failed`);
  }
  process.exit(failures.length ? 1 : 0);
}

/**
 * Where the head was as the session started, which is the origin of the
 * `local` space a scene is laid out in.
 *
 * @param {import("playwright-core").Page} page
 * @returns {Promise<[number, number, number]>}
 */
export function headPosition(page) {
  return page.evaluate(() => {
    const { x, y, z } = /** @type {any} */ (window).xrDevice.position;
    return /** @type {[number, number, number]} */ ([x, y, z]);
  });
}

/**
 * Hold the right controller below the head, its ray through `target`, a
 * point in the `local` space whose origin is `head`, and let three frames
 * pass so that the ray is cast.
 *
 * @param {import("playwright-core").Page} page
 * @param {[number, number, number]} head
 * @param {[number, number, number]} target
 */
export async function aimAt(page, head, target) {
  const from = [head[0] + 0.05, head[1] - 0.2, head[2] - 0.05];
  const d = target.map((v, i) => v + head[i] - from[i]);
  const yaw = Math.atan2(-d[0], -d[2]);
  const pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
  await page.evaluate(([p, y, f]) => {
    const c = /** @type {any} */ (window).xrDevice.controllers.right;
    c.position.x = f[0];
    c.position.y = f[1];
    c.position.z = f[2];
    const cy = Math.cos(y / 2);
    const sy = Math.sin(y / 2);
    const cx = Math.cos(p / 2);
    const sx = Math.sin(p / 2);
    c.quaternion.x = cy * sx;
    c.quaternion.y = sy * cx;
    c.quaternion.z = -sy * sx;
    c.quaternion.w = cy * cx;
  }, /** @type {const} */ ([pitch, yaw, from]));
  await frames(page, 3);
}

/**
 * Rotate a vector by a panel's Euler angles in the order `YXZ`, the pitch
 * about x first and then the yaw about y, which is how a check turns a
 * point on a panel into the scene from the figures the app places the
 * panel by.
 *
 * @param {[number, number, number]} v
 * @param {number} pitch
 * @param {number} yaw
 * @returns {[number, number, number]}
 */
export function rotate([x, y, z], pitch, yaw) {
  const y1 = y * Math.cos(pitch) - z * Math.sin(pitch);
  const z1 = y * Math.sin(pitch) + z * Math.cos(pitch);
  return [x * Math.cos(yaw) + z1 * Math.sin(yaw), y1, -x * Math.sin(yaw) + z1 * Math.cos(yaw)];
}

/**
 * Close (1) or open (0) one of the right controller's buttons, and let four
 * frames pass. A drag is a close, some aims and an open.
 *
 * @param {import("playwright-core").Page} page
 * @param {"trigger" | "squeeze"} button
 * @param {0 | 1} value
 */
export async function hold(page, button, value) {
  await page.evaluate(
    ([b, v]) => /** @type {any} */ (window).xrDevice.controllers.right.updateButtonValue(b, v),
    /** @type {const} */ ([button, value]),
  );
  await frames(page, 4);
}

/**
 * Press and release one of the right controller's buttons, four frames
 * each way.
 *
 * @param {import("playwright-core").Page} page
 * @param {"trigger" | "squeeze"} button
 */
export async function press(page, button) {
  await hold(page, button, 1);
  await hold(page, button, 0);
}

/**
 * Build the app at `root` for production into a scratch directory, and say
 * which JS its service worker precaches, and which JS the page loads before
 * it offers anything: the entry chunk and every chunk it imports
 * statically. The worker is installed on every visit, so whatever it lists
 * is downloaded by every visitor. A check holds the two lists equal, which
 * is how a `globIgnores` that stops matching a renamed chunk shows up.
 *
 * `build` is Vite's, from the app's own `vite`, which this package does not
 * depend on.
 *
 * @param {typeof import("vite").build} build
 * @param {string} root
 * @returns {Promise<{ precached: string[], loaded: string[] }>}
 */
export async function precache(build, root) {
  const outDir = mkdtempSync(join(tmpdir(), "precache-"));
  try {
    const built = await build({
      root,
      configFile: join(root, "vite.config.mts"),
      logLevel: "warn",
      build: { outDir, emptyOutDir: true, sourcemap: false },
    });
    const outputs = (Array.isArray(built) ? built : [built]).flatMap((result) =>
      "output" in result ? result.output : [],
    );
    /** @type {Map<string, string[]>} */
    const imports = new Map();
    /** @type {string[]} */
    const entries = [];
    for (const item of outputs) {
      if (item.type === "chunk") {
        imports.set(item.fileName, item.imports);
        if (item.isEntry) {
          entries.push(item.fileName);
        }
      }
    }
    const loaded = new Set();
    const visit = (/** @type {string} */ name) => {
      if (!loaded.has(name)) {
        loaded.add(name);
        (imports.get(name) ?? []).forEach(visit);
      }
    };
    entries.forEach(visit);
    const worker = readFileSync(join(outDir, "sw.js"), "utf8");
    const precached = [...worker.matchAll(/url:"([^"]+)"/g)]
      .map((match) => match[1])
      .filter((url) => url.startsWith("assets/") && url.endsWith(".js"));
    return { precached: precached.sort(), loaded: [...loaded].sort() };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
