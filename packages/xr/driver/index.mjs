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
import { dirname, resolve } from "node:path";
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
 * Press and release one of the right controller's buttons, four frames
 * each way.
 *
 * @param {import("playwright-core").Page} page
 * @param {"trigger" | "squeeze"} button
 */
export async function press(page, button) {
  for (const value of [1, 0]) {
    await page.evaluate(
      ([b, v]) => /** @type {any} */ (window).xrDevice.controllers.right.updateButtonValue(b, v),
      /** @type {const} */ ([button, value]),
    );
    await frames(page, 4);
  }
}
