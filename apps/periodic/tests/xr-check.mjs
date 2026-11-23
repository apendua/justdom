/**
 * Plays the mirrored table in a session on the emulated headset (IWER
 * standing in for a Quest 3), with the real browser stack: vite-served
 * periodic in headless Chromium.
 *
 *   node tests/xr-check.mjs
 *   SHOTS=out node tests/xr-check.mjs   # and photograph the page and the session
 *   STACKS=1 node tests/xr-check.mjs    # with a stack for anything the page throws
 *   CHROMIUM=<path> node tests/xr-check.mjs  # with a Chromium found elsewhere
 *
 * The right controller is aimed at a point on the panel from the figures
 * the scene places it by (`src/placement.ts`), and the script checks that
 * the ray is on the element it was aimed at before it presses anything.
 * First, a production build must not precache the headset's chunks in its
 * service worker, and the page alone, with no emulator, must not fetch the
 * headset scene. Then, in a session, in order:
 *
 * - the ray on iron's tile hovers it: the page's popup comes up over the
 *   tile and the inspector shows iron;
 * - the trigger pins it;
 * - Discovery, then the 1869 chip, turn the table back to Mendeleev's year,
 *   with gallium's tile a gap he foretold;
 * - the × ends the session;
 * - a second session, entered and left, holds no more geometry on the GPU
 *   than the first left behind, so the atom is not built again each time.
 *
 * The script fails if any of them does not happen, or if the page throws
 * along the way. It is kept out of `npm test` because it needs a browser.
 * The browser and the controller are driven through `justdom-xr/driver`.
 */
import { join, resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import {
  aimAt,
  check,
  closeAll,
  finish,
  frames,
  headPosition,
  launch,
  observeThree,
  precache,
  press,
} from "justdom-xr/driver";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SHOTS = process.env.SHOTS;
if (SHOTS) {
  mkdirSync(SHOTS, { recursive: true });
}

async function main() {
  console.log("\n== the precache");
  {
    const { precached, loaded } = await precache(build, HERE);
    console.log(`  precached: ${precached.join(", ")}`);
    check(
      loaded.length > 0 && loaded.every((name) => precached.includes(name)),
      "the service worker precaches every chunk the page loads",
    );
    check(
      precached.every((name) => loaded.includes(name)),
      "and no other: none that only a headset or the emulator imports",
    );
  }

  const server = await createServer({
    root: HERE,
    configFile: join(HERE, "vite.config.mts"),
    logLevel: "warn",
    server: { port: 0, strictPort: false },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error("no vite url");
  /** @type {typeof import("../src/placement.ts")} */
  const placement = /** @type {any} */ (await server.ssrLoadModule("/src/placement.ts"));

  const browser = await launch();
  try {
    console.log("\n== the page alone");
    {
      // Headless Chromium has a `navigator.xr` that supports no session,
      // which is a laptop's browser: the page is all there is, and the
      // headset scene, with three.js under it, is never fetched.
      const plain = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      /** @type {string[]} */
      const fetched = [];
      plain.on("request", (request) => fetched.push(new URL(request.url()).pathname));
      await plain.goto(url, { waitUntil: "load" });
      await plain.waitForSelector("button[aria-label=Oganesson]");
      await plain.waitForLoadState("networkidle");
      check(
        !fetched.some((path) => path.endsWith("/src/xr.ts")),
        "a browser that cannot present does not load the headset scene",
      );
      check(!(await plain.$("#ARButton, #VRButton")), "and shows no Enter button");
      await plain.close();
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.log("[pageerror]", process.env.STACKS ? error.stack : error.message);
    });
    // The renderer, for the GPU memory three keeps count of.
    await observeThree(page);
    await page.goto(`${url}?emulator=bare`, { waitUntil: "load" });
    await page.waitForSelector("button[aria-label=Oganesson]");
    await page.waitForSelector("#ARButton, #VRButton");
    // The tiles' entrance is over before the session starts.
    await page.waitForTimeout(1500);
    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, "page.png") });
    }
    await page.click("#ARButton, #VRButton");
    await page.waitForFunction(
      () =>
        document.querySelector("#table[data-xr-portal]") &&
        !document.querySelector("[data-xr-loading]"),
    );
    await frames(page, 30);

    // Where the head was as the session started, which is the origin of the
    // `local` space the scene is laid out in.
    const head = await headPosition(page);

    /**
     * Where the middle of the element `selector` finds is in the scene.
     *
     * @param {string} selector
     */
    const onTable = async (selector) => {
      const { table, element } = await page.evaluate((q) => {
        const target = document.querySelector(q);
        if (!target) throw new Error(`no ${q} on the table`);
        return {
          table: /** @type {Element} */ (document.querySelector("#table"))
            .getBoundingClientRect()
            .toJSON(),
          element: target.getBoundingClientRect().toJSON(),
        };
      }, selector);
      const metres = 0.01 * placement.tableScale(table.width);
      const [tx, ty, tz] = placement.TABLE_AT;
      return /** @type {[number, number, number]} */ ([
        tx + (element.left + element.width / 2 - table.left - table.width / 2) * metres,
        ty - (element.top + element.height / 2 - table.top - table.height / 2) * metres,
        tz,
      ]);
    };

    /** @param {string} selector @param {string} name */
    const has = (selector, name) =>
      page.evaluate(
        ([q, n]) => document.querySelector(q)?.hasAttribute(n) ?? false,
        [selector, name],
      );

    const tableText = () => page.$eval("#table", (table) => table.textContent ?? "");

    /** Press, by the ray, the button with this text. */
    const pressButton = async (/** @type {string} */ label) => {
      const id = await page.evaluate((text) => {
        const button = [...document.querySelectorAll("#table button")].find(
          (b) => b.textContent === text,
        );
        if (!button) throw new Error(`no ${text} button`);
        button.id ||= `check-${text.replace(/\W+/g, "-")}`;
        return button.id;
      }, label);
      await aimAt(page, head, await onTable(`#${id}`));
      check(await has(`#${id}`, "data-xr-hover"), `the ray is on ${label}`);
      await press(page, "trigger");
      await frames(page, 10);
    };

    console.log("\n== a tile");
    const iron = "button[aria-label=Iron]";
    await aimAt(page, head, await onTable(iron));
    await frames(page, 10);
    check(await has(iron, "data-xr-hover"), "the ray is on iron's tile");
    const text = await tableText();
    check(text.includes("26 · Transition metal"), "the popup comes up over it");
    check(/IronTransition metal/.test(text), "and the inspector shows iron");
    if (SHOTS) {
      await frames(page, 20);
      await page.screenshot({ path: join(SHOTS, "session-iron.png") });
    }
    await press(page, "trigger");
    await frames(page, 10);
    check(await has(iron, "data-pinned"), "the trigger pins it");

    console.log("\n== Mendeleev's year");
    await pressButton("Discovery");
    await pressButton("Mendeleev, 1869");
    check((await tableText()).includes("63 of 118 known in 1869"), "the table is set to 1869");
    check(
      await has("button[aria-label=Gallium]", "data-prophecy"),
      "and gallium's tile is a gap Mendeleev foretold",
    );
    const gallium = "button[aria-label=Gallium]";
    await aimAt(page, head, await onTable(gallium));
    await frames(page, 30);
    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, "session-1869.png") });
    }

    console.log("\n== the ×");
    await pressButton("×");
    await frames(page, 10);
    check(
      !(await page.evaluate(() => document.querySelector("#table[data-xr-portal]"))),
      "the × ends the session",
    );

    console.log("\n== a second session");
    {
      const geometries = () =>
        page.evaluate(
          () => /** @type {any} */ (window).threeRenderers.at(-1).info.memory.geometries,
        );
      // The panel goes a little after the session does, so the count is
      // read once it holds still for a second.
      const settledGeometries = async () => {
        let count = await geometries();
        for (let tries = 0; tries < 20; tries++) {
          await page.waitForTimeout(1000);
          const next = await geometries();
          if (next === count) break;
          count = next;
        }
        return count;
      };
      const first = await settledGeometries();
      await page.click("#ARButton, #VRButton");
      await page.waitForFunction(
        () =>
          document.querySelector("#table[data-xr-portal]") &&
          !document.querySelector("[data-xr-loading]"),
      );
      await frames(page, 30);
      await page.evaluate(() =>
        /** @type {any} */ (window).threeRenderers.at(-1).xr.getSession().end(),
      );
      await page.waitForFunction(() => !document.querySelector("#table[data-xr-portal]"));
      // What the panel built goes a little later still, so the count has
      // ten seconds to come back down before it is read.
      await page
        .waitForFunction(
          (before) =>
            /** @type {any} */ (window).threeRenderers.at(-1).info.memory.geometries <= before,
          first,
          { timeout: 10_000 },
        )
        .catch(() => {});
      const second = await settledGeometries();
      check(
        second <= first,
        `a second session freed what it built (${first} geometries after the first, ${second} after the second)`,
      );
    }

    check(errors.length === 0, `the page threw nothing (${errors.length} errors)`);
    await page.close();
  } finally {
    await closeAll(browser, server);
  }
}

main()
  .then(finish)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
