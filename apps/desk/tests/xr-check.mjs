/**
 * Puts the desk up in a session on the emulated headset (IWER standing in
 * for a Quest 3), with the real browser stack: vite-served desk in headless
 * Chromium.
 *
 *   node tests/xr-check.mjs
 *   SHOTS=out node tests/xr-check.mjs   # and photograph each look's session
 *   STACKS=1 node tests/xr-check.mjs    # with a stack for anything the page throws
 *   CHROMIUM=<path> node tests/xr-check.mjs  # with a Chromium found elsewhere
 *
 * For each look in turn, it enters a session and checks that:
 *
 * - every zone the look places (`src/looks.ts`) becomes a panel, and every
 *   panel leaves its loading frame;
 * - the right controller's ray, aimed at the power control from the figures
 *   the scene poses the monitor by, is on that control;
 * - the trigger there ends the session and takes the panels down;
 * - the page throws nothing along the way.
 *
 * A manual check rather than part of `npm test`: it needs a browser, and
 * takes a few minutes under SwiftShader, most of it the panels mounting.
 */
import { join, resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(
  resolve(HERE, "../showcase-xr/node_modules/playwright-core/index.mjs")
);

const CHROMIUM = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const SHOTS = process.env.SHOTS;
if (SHOTS) {
  mkdirSync(SHOTS, { recursive: true });
}

/**
 * How long a look's panels may take to load. Under SwiftShader they take
 * under a minute; the margin is for a slow runner.
 */
const LOAD_TIMEOUT = 240_000;

/**
 * @param {import("playwright-core").Page} page
 * @param {number} count
 */
async function frames(page, count) {
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
 * @param {boolean} ok
 * @param {string} what
 */
function check(ok, what) {
  console.log(`  ${ok ? "OK" : "FAIL"}: ${what}`);
  if (!ok) {
    failures.push(what);
  }
}

async function main() {
  const server = await createServer({
    root: HERE,
    configFile: join(HERE, "vite.config.mts"),
    logLevel: "warn",
    server: { port: 0, strictPort: false },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error("no vite url");
  /** @type {typeof import("../src/looks.ts")} */
  const looks = /** @type {any} */ (await server.ssrLoadModule("/src/looks.ts"));

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    for (const look of looks.LOOKS) {
      const { id } = look;
      console.log(`\n== ${look.name}`);
      const zones = look.placements.map((placement) => placement.id);

      const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
      /** @type {string[]} */
      const errors = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.log("[pageerror]", process.env.STACKS ? error.stack : error.message);
      });
      await page.goto(`${url}?look=${id}&emulator=bare`, { waitUntil: "load" });
      await page.waitForSelector("#ARButton, #VRButton");
      await page.click("#ARButton, #VRButton");

      const started = Date.now();
      const loaded = await page
        .waitForFunction(
          (ids) =>
            ids.every((zone) => document.getElementById(zone)?.hasAttribute("data-xr-portal")) &&
            !document.querySelector("[data-xr-loading]"),
          zones,
          { timeout: LOAD_TIMEOUT, polling: 1000 },
        )
        .then(
          () => true,
          () => false,
        );
      const panels = await page.evaluate(
        (ids) =>
          ids.map((zone) => {
            const element = document.getElementById(zone);
            const state = !element?.hasAttribute("data-xr-portal")
              ? "not mirrored"
              : element.hasAttribute("data-xr-loading")
                ? "loading"
                : "loaded";
            return `${zone} ${state}`;
          }),
        zones,
      );
      console.log(`  after ${Math.round((Date.now() - started) / 1000)} s: ${panels.join(", ")}`);
      check(loaded, `every zone of ${look.name} is a panel, and every panel has loaded`);
      if (!loaded) {
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${id}-stuck.png`) });
        await page.close();
        continue;
      }
      await frames(page, 30);
      if (SHOTS) {
        await page.screenshot({ path: join(SHOTS, `${id}.png`) });
      }

      // Where the head was as the session started, which is the origin of
      // the `local` space the room is laid out in.
      const head = await page.evaluate(() => {
        const { x, y, z } = /** @type {any} */ (window).xrDevice.position;
        return [x, y, z];
      });

      // The power control is on the monitor in every look, and the monitor
      // stands upright, square to the viewer, at its placement. A session
      // takes the page's scale off, so a px of the page is a px of the
      // panel, and the panel's middle is the monitor's.
      const monitor = look.placements.find((placement) => placement.id === "monitor");
      if (!monitor || monitor.facing || monitor.lying) {
        throw new Error("the check expects an upright, unturned monitor");
      }
      const offset = await page.evaluate(() => {
        const zone = /** @type {Element} */ (document.getElementById("monitor"));
        const power = zone.querySelector("[data-power]");
        if (!power) throw new Error("no [data-power] on the monitor");
        const z = zone.getBoundingClientRect();
        const p = power.getBoundingClientRect();
        return {
          x: p.left + p.width / 2 - (z.left + z.width / 2),
          y: p.top + p.height / 2 - (z.top + z.height / 2),
        };
      });
      const metres = monitor.px ?? looks.PX;
      const target = [
        monitor.x + offset.x * metres,
        looks.DESK_TOP + monitor.y - offset.y * metres,
        monitor.z,
      ];

      // The right controller below the head, its ray through the target.
      const from = [head[0] + 0.05, head[1] - 0.2, head[2] - 0.05];
      const d = target.map((v, i) => v + head[i] - from[i]);
      const yaw = Math.atan2(-d[0], -d[2]);
      const pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
      await page.evaluate(
        ([p, y, f]) => {
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
        },
        [pitch, yaw, from],
      );
      await frames(page, 5);
      check(
        await page.evaluate(
          () => document.querySelector("[data-power]")?.hasAttribute("data-xr-hover") ?? false,
        ),
        "the ray is on the power control",
      );

      for (const value of [1, 0]) {
        await page.evaluate(
          (v) =>
            /** @type {any} */ (window).xrDevice.controllers.right.updateButtonValue("trigger", v),
          value,
        );
        await frames(page, 4);
      }
      const ended = await page
        .waitForFunction(() => !document.querySelector("[data-xr-portal]"), undefined, {
          timeout: 10_000,
        })
        .then(
          () => true,
          () => false,
        );
      check(ended, "the power control ended the session and took the panels down");
      check(errors.length === 0, `the page threw nothing (${errors.length} errors)`);
      await page.close();
    }
  } finally {
    // Chromium under SwiftShader now and then never answers a close. Every
    // check has been made by then, so it is given a few seconds and left.
    const giveUp = new Promise((done) => setTimeout(done, 10_000));
    await Promise.race([browser.close(), giveUp]);
    await Promise.race([server.close(), giveUp]);
  }
  if (failures.length) {
    console.log(`\n${failures.length} failed`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
