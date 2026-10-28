/**
 * Puts the desk up in a session on the emulated headset (IWER standing in
 * for a Quest 3), with the real browser stack: vite-served desk in headless
 * Chromium.
 *
 *   node tests/xr-check.mjs
 *   SHOTS=out node tests/xr-check.mjs   # and photograph each look's session
 *   STACKS=1 node tests/xr-check.mjs    # with a stack for anything the page throws
 *   PAINT_ORDER=0 node tests/xr-check.mjs  # on panels drawn by the lift
 *   CHROMIUM=<path> node tests/xr-check.mjs  # with a Chromium found elsewhere
 *
 * For each look in turn, it enters a session and checks that:
 *
 * - every zone the look places (`src/looks.ts`) becomes a panel, and every
 *   panel leaves its loading frame;
 * - the right controller's ray, aimed at the power control from the figures
 *   the scene poses the monitor by, is on that control;
 * - the trigger there ends the session and takes the panels down;
 * - for the first look, a second session leaves no more geometries on the
 *   GPU when it ends than the first did, so the room built for each session
 *   is freed with it;
 * - the page throws nothing along the way.
 *
 * It is kept out of `npm test` because it needs a browser and takes a few
 * minutes under SwiftShader, most of it the panels mounting;
 * `.github/workflows/driven.yml` runs it on pull requests. The browser and
 * the controller are driven through `@apendua.dev/headset/driver`.
 */
import { join, resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  aimAt,
  check,
  closeAll,
  finish,
  frames,
  headPosition,
  launch,
  observeThree,
  PAINT_ORDER_QUERY,
  press,
} from "@apendua.dev/headset/driver";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SHOTS = process.env.SHOTS;
if (SHOTS) {
  mkdirSync(SHOTS, { recursive: true });
}

/**
 * How long a look's panels may take to load. Under SwiftShader they take
 * under a minute; the margin is for a slow runner.
 */
const LOAD_TIMEOUT = 240_000;

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

  const browser = await launch();
  try {
    for (const look of looks.LOOKS) {
      const { id } = look;
      console.log(`\n== ${look.name}`);
      const zones = look.placements.map((placement) => placement.id);

      const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
      // The renderer, for the GPU memory three keeps count of.
      await observeThree(page);
      /** @type {string[]} */
      const errors = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.log("[pageerror]", process.env.STACKS ? error.stack : error.message);
      });
      await page.goto(`${url}?look=${id}&emulator=bare${PAINT_ORDER_QUERY}`, { waitUntil: "load" });
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
      const head = await headPosition(page);

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
      /** @type {[number, number, number]} */
      const target = [
        monitor.x + offset.x * metres,
        looks.DESK_TOP + monitor.y - offset.y * metres,
        monitor.z,
      ];
      await aimAt(page, head, target);
      check(
        await page.evaluate(
          () => document.querySelector("[data-power]")?.hasAttribute("data-xr-hover") ?? false,
        ),
        "the ray is on the power control",
      );

      await press(page, "trigger");
      const ended = await page
        .waitForFunction(() => !document.querySelector("[data-xr-portal]"), undefined, {
          timeout: 10_000,
        })
        .then(
          () => true,
          () => false,
        );
      check(ended, "the power control ended the session and took the panels down");

      if (ended && look === looks.LOOKS[0]) {
        const geometries = () =>
          page.evaluate(
            () => /** @type {any} */ (window).threeRenderers.at(-1).info.memory.geometries,
          );
        // The panels go a frame or two after the session does, so the count
        // is read once it holds still across ten frames.
        const settledGeometries = async () => {
          let count = await geometries();
          for (let tries = 0; tries < 20; tries++) {
            await frames(page, 10);
            const next = await geometries();
            if (next === count) break;
            count = next;
          }
          return count;
        };
        const first = await settledGeometries();
        await page.click("#ARButton, #VRButton");
        const reloaded = await page
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
        check(reloaded, "a second session put every panel up again");
        if (reloaded) {
          await frames(page, 10);
          await page.evaluate(() =>
            /** @type {any} */ (window).threeRenderers.at(-1).xr.getSession().end(),
          );
          const left = await page
            .waitForFunction(() => !document.querySelector("[data-xr-portal]"), undefined, {
              timeout: 10_000,
            })
            .then(
              () => true,
              () => false,
            );
          check(left, "ending the second session took the panels down");
          const second = await settledGeometries();
          check(
            second <= first,
            `a second session freed what it built (${first} geometries after the first, ${second} after the second)`,
          );
        }
      }
      check(errors.length === 0, `the page threw nothing (${errors.length} errors)`);
      await page.close();
    }
  } finally {
    await closeAll(browser, server);
  }
  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
