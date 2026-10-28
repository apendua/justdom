/**
 * Plays the mirrored game in a session on the emulated headset (IWER
 * standing in for a Quest 3), with the real browser stack: vite-served
 * Knights in headless Chromium.
 *
 *   node tests/xr-check.mjs
 *   SHOTS=out node tests/xr-check.mjs   # and photograph the page and the session
 *   STACKS=1 node tests/xr-check.mjs    # with a stack for anything the page throws
 *   PAINT_ORDER=0 node tests/xr-check.mjs  # on panels drawn by the lift
 *   CHROMIUM=<path> node tests/xr-check.mjs  # with a Chromium found elsewhere
 *
 * The right controller is aimed at a point on the panel from the figures
 * the scene places it by (`src/placement.ts`). First, the page alone, with
 * no emulator, must not fetch the headset scene, and a click on a field
 * the stack can reach, with no move before it, must send the stack there.
 * Then, in a session, in order:
 *
 * - the ray over a field the white stack can reach previews the route
 *   there, through the board's own `mousemove` handler;
 * - the trigger sends the stack along it, through the board's `click`
 *   handler, at the place on the page the ray met, and the turn passes on;
 * - Passthrough, in the toolbar, takes the backdrop down;
 * - the × ends the session.
 *
 * The script fails if any of them does not happen, or if the page throws
 * along the way. It is kept out of `npm test` because it needs a browser
 * and takes about a minute under SwiftShader;
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
  PAINT_ORDER_QUERY,
  press,
} from "@apendua.dev/headset/driver";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SHOTS = process.env.SHOTS;
if (SHOTS) {
  mkdirSync(SHOTS, { recursive: true });
}

/**
 * A point well inside the area the stack whose turn it is can reach, three
 * fields or more from it, on the page: found in the board's own user space
 * and taken through its transform, so it is where the page draws it.
 *
 * @param {import("playwright-core").Page} page
 * @returns {Promise<{ x: number, y: number } | null>}
 */
function reachablePoint(page) {
  return page.evaluate(() => {
    const svg = /** @type {SVGSVGElement} */ (document.querySelector("#root svg"));
    const [reach] = /** @type {SVGPathElement[]} */ ([
      ...svg.querySelectorAll(":scope > g > path"),
    ]);
    const here = /** @type {SVGPolygonElement} */ (svg.querySelector(":scope > g > polygon"));
    const box = here.getBBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const ctm = /** @type {DOMMatrix} */ (svg.getScreenCTM());
    let best = null;
    for (let y = 0; y < 640; y += 4) {
      for (let x = 0; x < 1024; x += 4) {
        const inside = [
          [0, 0],
          [-6, 0],
          [6, 0],
          [0, -4],
          [0, 4],
        ].every(([dx, dy]) => reach.isPointInFill(new DOMPoint(x + dx, y + dy)));
        const distance = Math.hypot(x - cx, y - cy);
        if (inside && distance > 3 * box.width && (!best || distance < best.distance)) {
          best = { x, y, distance };
        }
      }
    }
    if (!best) return null;
    const point = new DOMPoint(best.x, best.y).matrixTransform(ctm);
    return { x: point.x, y: point.y };
  });
}

/**
 * Whether the toolbar comes to show an item with this text within half a
 * minute. It shows Continue on the white stack's turn while nothing moves,
 * and Skip while a move plays out.
 *
 * @param {import("playwright-core").Page} page
 * @param {string} label
 * @returns {Promise<boolean>}
 */
function toolbarSays(page, label) {
  return page
    .waitForFunction(
      (text) =>
        [...document.querySelectorAll("#root li")].some(
          // The menu behind ☰ has a Continue of its own, hidden while it is
          // closed.
          (li) => li.textContent === text && !li.closest("[hidden]"),
        ),
      label,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false);
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
  /** @type {typeof import("../src/placement.ts")} */
  const placement = /** @type {any} */ (await server.ssrLoadModule("/src/placement.ts"));

  const browser = await launch();
  try {
    console.log("\n== the page alone");
    {
      // Headless Chromium has a `navigator.xr` that supports no session,
      // which is a laptop's browser: the page is all there is, and the
      // headset scene, with three.js under it, is never fetched.
      const plain = await browser.newPage({ viewport: { width: 1024, height: 640 } });
      /** @type {string[]} */
      const fetched = [];
      plain.on("request", (request) => fetched.push(new URL(request.url()).pathname));
      await plain.goto(url, { waitUntil: "load" });
      await plain.waitForSelector("#root svg polygon");
      await plain.waitForLoadState("networkidle");
      check(
        !fetched.some((path) => path.endsWith("/src/xr.ts")),
        "a browser that cannot present does not load the headset scene",
      );
      check(!(await plain.$("#ARButton, #VRButton")), "and shows no Enter button");
      if (SHOTS) {
        await plain.screenshot({ path: join(SHOTS, "page.png") });
      }

      // The menu behind ☰ stacks its items one under another, each as wide
      // as the list.
      await plain.evaluate(() =>
        /** @type {HTMLElement} */ (
          [...document.querySelectorAll("#root li")].find((li) => li.textContent === "\u2630")
        ).click(),
      );
      const items = await plain.evaluate(() =>
        [...document.querySelectorAll("#root li")]
          .filter((li) => li.textContent?.startsWith("New Game"))
          .map((li) => li.getBoundingClientRect().toJSON()),
      );
      check(
        items.length === 2 &&
          items[0].left === items[1].left &&
          items[0].width === items[1].width &&
          items[0].bottom <= items[1].top,
        "the menu stacks its items one under another",
      );
      // The menu's own Continue closes it. The menu comes after the toolbar,
      // so it is the last Continue on the page.
      await plain.evaluate(() =>
        /** @type {HTMLElement | undefined} */ (
          [...document.querySelectorAll("#root li")]
            .filter((li) => li.textContent === "Continue")
            .at(-1)
        )?.click(),
      );

      // A click with no move before it, as a tap on a touchscreen is, and as
      // a headset's trigger is when the other hand moves the mouse: the stack
      // goes where it was clicked.
      if (!(await toolbarSays(plain, "Continue"))) {
        throw new Error("the white stack never got its turn");
      }
      const tap = await reachablePoint(plain);
      if (!tap) throw new Error("no reachable field to tap");
      await plain.evaluate(({ x, y }) => {
        document
          .elementFromPoint(x, y)
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
      }, tap);
      const moved = await toolbarSays(plain, "Skip");
      check(moved, "a click with no move before it sends the stack");
      await plain.close();
    }

    const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.log("[pageerror]", process.env.STACKS ? error.stack : error.message);
    });
    await page.goto(`${url}?emulator=bare${PAINT_ORDER_QUERY}`, { waitUntil: "load" });
    // The battle is dealt half a second after the page loads, and the board
    // is drawn once it is.
    await page.waitForSelector("#root svg polygon");
    await page.waitForSelector("#ARButton, #VRButton");
    // The Enter button stands clear of the toolbar along the bottom.
    const clear = await page.evaluate(() => {
      const button = /** @type {Element} */ (document.querySelector("#ARButton, #VRButton"));
      const bar = /** @type {Element} */ (document.querySelector("#root ul"));
      const a = button.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right;
    });
    check(clear, "the Enter button does not cover the toolbar");
    await page.click("#ARButton, #VRButton");
    await page
      .waitForFunction(
        () =>
          document.querySelector("#root[data-xr-portal]") &&
          !document.querySelector("[data-xr-loading]"),
        undefined,
        { timeout: 120_000 },
      )
      .catch(async (error) => {
        if (SHOTS) await page.screenshot({ path: join(SHOTS, "stuck.png") });
        throw error;
      });
    await frames(page, 30);
    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, "session.png") });
    }

    // Where the head was as the session started, which is the origin of the
    // `local` space the scene is laid out in.
    const head = await headPosition(page);

    /**
     * Where a point on the page, in its px, is in the scene: the panel is
     * the whole of `#root`, which is the whole window.
     *
     * @param {number} x
     * @param {number} y
     */
    const onGame = async (x, y) => {
      const { left, top, width, height } = await page.evaluate(() =>
        /** @type {Element} */ (document.querySelector("#root")).getBoundingClientRect().toJSON(),
      );
      const metres = 0.01 * placement.gameScale(width);
      const [gx, gy, gz] = placement.GAME_AT;
      return /** @type {[number, number, number]} */ ([
        gx + (x - left - width / 2) * metres,
        gy - (y - top - height / 2) * metres,
        gz,
      ]);
    };

    /**
     * Where the middle of the toolbar's item with this text is on the page.
     *
     * @param {string} label
     */
    const toolbarItem = (label) =>
      page.evaluate((text) => {
        const item = [...document.querySelectorAll("#root li")].find(
          (li) => li.textContent === text,
        );
        if (!item) throw new Error(`no ${text} in the toolbar`);
        const rect = item.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, label);

    /**
     * Whether the toolbar's item with this text carries a flag.
     *
     * @param {string} label
     * @param {string} flag
     */
    const flagged = (label, flag) =>
      page.evaluate(
        ([text, name]) =>
          [...document.querySelectorAll("#root li")]
            .find((li) => li.textContent === text)
            ?.hasAttribute(name) ?? false,
        [label, flag],
      );

    /** Press the toolbar's item with this text, by the ray. */
    const pressInToolbar = async (/** @type {string} */ label) => {
      const { x, y } = await toolbarItem(label);
      await aimAt(page, head, await onGame(x, y));
      check(await flagged(label, "data-xr-hover"), `the ray is on ${label}`);
      await press(page, "trigger");
      await frames(page, 10);
    };

    // The board's paths, in the order the board draws them: what the stack
    // can reach, the walls and the route to the cursor. The polygon is the
    // field the stack stands on.
    const route = () =>
      page.$eval("#root svg > g > path:nth-of-type(3)", (p) => p.getAttribute("d"));
    const standing = () =>
      page.$eval("#root svg > g > polygon", (p) => p.getAttribute("points") ?? "");

    // The page reports what its handler heard, and where.
    await page.evaluate(() => {
      /** @type {any} */ const w = window;
      w.__heard = [];
      document.querySelector("#root svg")?.addEventListener("click", (event) => {
        const { clientX, clientY } = /** @type {MouseEvent} */ (event);
        w.__heard.push({ clientX, clientY });
      });
    });

    console.log("\n== the board");
    // The computer's stack moves first when it stands highest on the board,
    // and the board takes no orders until it is the white stack's turn.
    if (!(await toolbarSays(page, "Continue"))) {
      throw new Error("the white stack never got its turn");
    }
    const target = await reachablePoint(page);
    if (!target) throw new Error("no reachable field to aim at");
    const routeBefore = await route();
    await aimAt(page, head, await onGame(target.x, target.y));
    await frames(page, 10);
    const routeAfter = await route();
    check(
      !!routeAfter && routeAfter !== routeBefore,
      "the ray over a reachable field shows the route",
    );
    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, "route.png") });
    }

    const from = await standing();
    await press(page, "trigger");
    const heard = await page.evaluate(() => /** @type {any} */ (window).__heard);
    console.log("  heard:", JSON.stringify(heard));
    check(
      heard.length === 1 &&
        Math.hypot(heard[0].clientX - target.x, heard[0].clientY - target.y) < 12,
      "the trigger was heard as a click at the place on the page it was aimed at",
    );
    await page
      .waitForFunction(
        (before) => {
          const polygon = document.querySelector("#root svg > g > polygon");
          return polygon && polygon.getAttribute("points") !== before;
        },
        from,
        { timeout: 60_000 },
      )
      .catch(() => {});
    check((await standing()) !== from, "the stack went and the turn passed on");

    console.log("\n== the toolbar");
    await pressInToolbar("Passthrough");
    check(await flagged("Passthrough", "data-inverted"), "Passthrough is on");
    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, "passthrough.png") });
    }

    await pressInToolbar("×");
    const ended = await page.evaluate(() => !document.querySelector("#root[data-xr-portal]"));
    check(ended, "the × ended the session and took the panel down");
    check(errors.length === 0, `the page threw nothing (${errors.length} errors)`);
  } finally {
    await closeAll(browser, server);
  }
  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
