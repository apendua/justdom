/**
 * Puts the desk's HTML-in-Canvas variant (`?panels=texture`) up in a
 * session on the emulated headset, in headless Chromium with the feature
 * that variant needs turned on (`--enable-blink-features=CanvasDrawElement`).
 *
 *   node tests/texture-check.mjs
 *   SHOTS=out node tests/texture-check.mjs   # and photograph each session
 *   CHROMIUM=<path> node tests/texture-check.mjs
 *
 * For each look in turn, it enters a session and checks that:
 *
 * - the desk's element is moved into the renderer's canvas, and the
 *   browser paints it there;
 * - the right controller's ray, aimed at the power control from the
 *   figures the scene poses the monitor by, puts `data-xr-hover` on it;
 * - for the first look, a key of the keyboard, aimed at and pressed, types
 *   on the monitor, and a floppy dragged onto the drive loads its program;
 * - the trigger on the power control ends the session, and the desk goes
 *   back to the page;
 * - the page throws nothing along the way.
 *
 * Unlike `tests/xr-check.mjs` it is not run on pull requests: the feature
 * is behind a flag, and a Chromium that drops or renames it would fail the
 * check for a reason no change here made.
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
  hold,
  launch,
  press,
  rotate,
} from "justdom-xr/driver";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SHOTS = process.env.SHOTS;
if (SHOTS) {
  mkdirSync(SHOTS, { recursive: true });
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

  const browser = await launch({ args: ["--enable-blink-features=CanvasDrawElement"] });
  try {
    for (const look of looks.LOOKS) {
      const { id } = look;
      console.log(`\n== ${look.name}`);
      const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
      /** @type {string[]} */
      const errors = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.log("[pageerror]", process.env.STACKS ? error.stack : error.message);
      });
      page.on("console", (message) => {
        if (message.type() === "error") console.log("[console]", message.text());
      });
      await page.goto(`${url}?look=${id}&emulator=bare&panels=texture`, { waitUntil: "load" });
      await page.waitForSelector("#ARButton, #VRButton");
      // Paints of the canvas, counted from before the session.
      await page.evaluate(() => {
        /** @type {any} */ (window).paints = 0;
        for (const canvas of document.querySelectorAll("canvas")) {
          canvas.addEventListener("paint", () => {
            /** @type {any} */ (window).paints += 1;
          });
        }
      });
      await page.click("#ARButton, #VRButton");

      const inCanvas = await page
        .waitForFunction(() => document.querySelector("canvas > [data-desk]") !== null, undefined, {
          timeout: 30_000,
        })
        .then(
          () => true,
          () => false,
        );
      check(inCanvas, "the desk is drawn from inside the renderer's canvas");
      if (!inCanvas) {
        await page.close();
        continue;
      }
      await frames(page, 30);
      const paints = await page.evaluate(() => /** @type {any} */ (window).paints);
      check(paints > 0, `the canvas painted the desk (${paints} paints)`);
      if (SHOTS) {
        await page.screenshot({ path: join(SHOTS, `texture-${id}.png`) });
      }

      const head = await headPosition(page);
      const monitor = look.placements.find((placement) => placement.id === "monitor");
      const keyboard = look.placements.find((placement) => placement.id === "keyboard");
      if (!monitor || !keyboard) throw new Error("the check expects a monitor and a keyboard");

      /**
       * Where in the scene the middle of `selector` is, on the zone a
       * placement poses: its offset from the zone's middle, in the desk's
       * px, turned and scaled as the scene poses the zone.
       */
      const pointOf = async (placement, selector) => {
        const offset = await page.evaluate(
          ([zoneId, sel]) => {
            const zone = /** @type {Element} */ (document.getElementById(zoneId));
            const element = zone.querySelector(sel);
            if (!element) throw new Error(`no ${sel} in #${zoneId}`);
            const z = zone.getBoundingClientRect();
            const e = element.getBoundingClientRect();
            return {
              x: e.left + e.width / 2 - (z.left + z.width / 2),
              y: e.top + e.height / 2 - (z.top + z.height / 2),
            };
          },
          [placement.id, selector],
        );
        const metres = placement.px ?? looks.PX;
        const pitch = placement.lying ? -Math.PI / 2 + (placement.tilt ?? 0) : 0;
        if (placement.facing || placement.roll) {
          throw new Error(`the check cannot aim at #${placement.id}, which is turned`);
        }
        const [dx, dy, dz] = rotate([offset.x * metres, -offset.y * metres, 0], pitch, 0);
        return /** @type {[number, number, number]} */ ([
          placement.x + dx,
          looks.DESK_TOP + placement.y + dy,
          placement.z + dz,
        ]);
      };

      if (look === looks.LOOKS[0]) {
        const before = await page.evaluate(
          () => document.querySelector("[data-prompt]")?.textContent ?? "",
        );
        await aimAt(page, head, await pointOf(keyboard, '.key[data-key="q"]'));
        check(
          await page.evaluate(() =>
            document.querySelector('.key[data-key="q"]')?.hasAttribute("data-xr-hover"),
          ),
          "the ray is on the Q key",
        );
        await press(page, "trigger");
        await frames(page, 10);
        const after = await page.evaluate(
          () => document.querySelector("[data-prompt]")?.textContent ?? "",
        );
        check(after !== before, `the Q key typed on the monitor (${JSON.stringify(after)})`);

        const media = look.placements.find((placement) => placement.id === "floppies");
        if (media) {
          await aimAt(page, head, await pointOf(media, "[data-floppy]"));
          await hold(page, "trigger", 1);
          // Across the desk to the drive, in a few steps, so that the drag
          // starts on the floppy and crosses on to the monitor.
          const from = await pointOf(media, "[data-floppy]");
          const to = await pointOf(monitor, "[data-drive]");
          for (let step = 1; step <= 6; step++) {
            const t = step / 6;
            await aimAt(
              page,
              head,
              /** @type {[number, number, number]} */ (from.map((v, i) => v + (to[i] - v) * t)),
            );
          }
          const dragging = await page.evaluate(
            () => document.querySelector("[data-dragging]") !== null,
          );
          check(dragging, "pressing on a floppy and moving lifted it");
          await hold(page, "trigger", 0);
          await frames(page, 10);
          const loaded = await page.evaluate(() => {
            const name = document.querySelector("[data-floppy]")?.getAttribute("data-floppy");
            const listing = document.querySelector("[data-program]")?.textContent ?? "";
            return listing.startsWith(`LOAD "${name}"`);
          });
          check(loaded, "the floppy let go over the drive loaded its program");
        }
      }

      await aimAt(page, head, await pointOf(monitor, "[data-power]"));
      check(
        await page.evaluate(
          () => document.querySelector("[data-power]")?.hasAttribute("data-xr-hover") ?? false,
        ),
        "the ray is on the power control",
      );
      if (SHOTS) {
        await page.screenshot({ path: join(SHOTS, `texture-${id}-power.png`) });
      }
      await press(page, "trigger");
      const ended = await page
        .waitForFunction(
          () =>
            !document.documentElement.hasAttribute("data-presenting") &&
            document.querySelector(".stage > [data-desk]") !== null,
          undefined,
          { timeout: 10_000 },
        )
        .then(
          () => true,
          () => false,
        );
      check(ended, "the power control ended the session and put the desk back on the page");
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
