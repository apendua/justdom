/**
 * Reorders the todo list by dragging a row's handle twice, with the real
 * browser stack: vite-served todo-vanilla in headless Chromium.
 *
 *   node tests/drag-check.mjs
 *   SHOT=drag.png node tests/drag-check.mjs   # and photograph it mid-drag
 *
 * First on the page with the mouse, which is the browser's own drag and
 * drop. Then in a session on the emulated headset (IWER standing in for a
 * Quest 3), with the right controller's ray: the ray finds the first row's
 * handle, the trigger closes on it, the ray moves down the list, and the
 * trigger opens. Both runs print the drag events the list heard and the
 * order the todos ended up in, and the script fails unless each run moved
 * the first todo further down. The same handlers ran both times; freedom
 * is what turned the second one into drag events.
 *
 * A manual check rather than part of `npm test`: it needs a browser, and
 * takes about a minute under SwiftShader.
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(
  resolve(HERE, "../showcase-xr/node_modules/playwright-core/index.mjs")
);

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

/**
 * Record every drag event the list hears, as `type: text of the row`.
 *
 * @param {import("playwright-core").Page} page
 */
async function recordDrags(page) {
  await page.evaluate(() => {
    /** @type {any} */ const w = window;
    w.__drags = [];
    for (const type of ["dragstart", "dragenter", "dragleave", "drop", "dragend"]) {
      document.addEventListener(type, (event) => {
        const row = /** @type {Element} */ (event.target).closest?.("li");
        const label = row?.querySelector("span:not([draggable])")?.textContent ?? "list";
        w.__drags.push(`${type}: ${label}`);
      });
    }
  });
}

/** @param {import("playwright-core").Page} page */
const order = (page) =>
  page.$$eval("li span:not([draggable])", (spans) =>
    spans.map((span) => (span.textContent ?? "").replace(/^\d+\. /, "")),
  );

/**
 * @param {string} label
 * @param {string[]} before
 * @param {string[]} after
 * @param {string[]} drags
 */
function report(label, before, after, drags) {
  console.log(`\n== ${label}`);
  console.log("  events:", drags.length ? drags.join(", ") : "none");
  console.log("  before:", before.join(" | "));
  console.log("  after: ", after.join(" | "));
  const moved = after.indexOf(before[0]) > 0;
  console.log(moved ? "  OK: the first todo moved down" : "  FAIL: nothing moved");
  return moved;
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

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  let ok = true;
  try {
    // On the page, with the mouse.
    {
      const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
      page.on("pageerror", (error) => console.log("[pageerror]", error.message));
      await page.goto(url, { waitUntil: "load" });
      await page.waitForSelector("li span[draggable]");
      await recordDrags(page);
      const before = await order(page);
      await page.dragAndDrop("li:nth-child(1) span[draggable]", "li:nth-child(4)", {
        targetPosition: { x: 20, y: 30 },
      });
      const after = await order(page);
      ok = report("page, mouse", before, after, await page.evaluate(() => window.__drags)) && ok;
      await page.close();
    }

    // In the emulated headset, with the controller ray.
    {
      const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
      page.on("pageerror", (error) => console.log("[pageerror]", error.message));
      await page.goto(`${url}?emulator=bare`, { waitUntil: "load" });
      await page.waitForSelector("li span[draggable]");
      await page.waitForSelector("#ARButton, #VRButton");
      await page.click("#ARButton, #VRButton");
      await page.waitForFunction(
        () =>
          !document.querySelector("[data-xr-loading]") &&
          document.querySelector("[data-xr-portal]"),
      );
      await frames(page, 30);
      await recordDrags(page);
      const before = await order(page);
      /**
       * The right controller at chest height, aimed by yaw and pitch in
       * degrees.
       *
       * @param {number} yaw
       * @param {number} pitch
       */
      const aim = async (yaw, pitch) => {
        await page.evaluate(
          ([y, p]) => {
            const c = /** @type {any} */ (window).xrDevice.controllers.right;
            c.position.x = 0.05;
            c.position.y = 1.4;
            c.position.z = -0.05;
            const cy = Math.cos(y / 2);
            const sy = Math.sin(y / 2);
            const cx = Math.cos(p / 2);
            const sx = Math.sin(p / 2);
            c.quaternion.x = cy * sx;
            c.quaternion.y = sy * cx;
            c.quaternion.z = -sy * sx;
            c.quaternion.w = cy * cx;
          },
          [(yaw * Math.PI) / 180, (pitch * Math.PI) / 180],
        );
        await frames(page, 2);
      };
      /** Which row's handle the ray is on, by its index, or -1. */
      const handleUnderRay = () =>
        page.evaluate(() =>
          [...document.querySelectorAll("li span[draggable]")].findIndex((handle) =>
            handle.hasAttribute("data-xr-hover"),
          ),
        );

      // Find the first row's handle, then where the fourth row's is.
      /** @type {Map<number, [number, number]>} */
      const found = new Map();
      // The panel hangs above the hand, and the handles are at its left
      // edge, which is to the left of straight ahead: positive yaw.
      for (let pitch = 40; pitch >= 0 && !(found.has(0) && found.has(3)); pitch -= 0.5) {
        for (let yaw = 5; yaw <= 40; yaw += 1) {
          await aim(yaw, pitch);
          const index = await handleUnderRay();
          if (index >= 0 && !found.has(index)) {
            found.set(index, [yaw, pitch]);
            break;
          }
        }
      }
      const first = found.get(0);
      const fourth = found.get(3);
      if (!first || !fourth) {
        throw new Error(`could not find the handles with the ray: ${[...found.keys()]}`);
      }
      console.log("\n  first handle at yaw/pitch", first, "fourth at", fourth);

      const trigger = (value) =>
        page.evaluate(
          (v) =>
            /** @type {any} */ (window).xrDevice.controllers.right.updateButtonValue("trigger", v),
          value,
        );
      await aim(...first);
      await trigger(1);
      await frames(page, 3);
      // Down the list a little at a time, as a hand would carry it.
      const steps = 8;
      for (let step = 1; step <= steps; step += 1) {
        await aim(
          first[0] + ((fourth[0] - first[0]) * step) / steps,
          first[1] + ((fourth[1] - first[1] - 0.5) * step) / steps,
        );
      }
      const dragging = await page.evaluate(() => document.querySelectorAll("li.dragging").length);
      console.log("  rows marked as being dragged mid-drag:", dragging);
      if (process.env.SHOT) {
        // Long enough for the panel to have drawn the marks the drag made.
        await frames(page, 20);
        await page.screenshot({ path: process.env.SHOT });
        console.log("  mid-drag screenshot:", process.env.SHOT);
      }
      await trigger(0);
      await frames(page, 10);
      const after = await order(page);
      ok =
        report(
          "headset, controller ray",
          before,
          after,
          await page.evaluate(() => window.__drags),
        ) && ok;
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
