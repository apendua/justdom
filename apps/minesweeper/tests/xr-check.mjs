/**
 * Plays the mirrored game in a session on the emulated headset (IWER
 * standing in for a Quest 3), with the real browser stack: vite-served
 * minesweeper in headless Chromium.
 *
 *   node tests/xr-check.mjs
 *   SHOTS=out node tests/xr-check.mjs   # and photograph the page and the session
 *   STACKS=1 node tests/xr-check.mjs    # with a stack for anything the page throws
 *   CHROMIUM=<path> node tests/xr-check.mjs  # with a Chromium found elsewhere
 *
 * The right controller is aimed at a point on a panel from the figures the
 * scene places the panels by (`src/placement.ts`), and the script checks
 * that the ray is on the element it was aimed at before it presses
 * anything. First, a production build must not precache the headset's
 * chunks in its service worker, and the page alone, with no emulator, must
 * not fetch the headset scene, and no tile may be under the menu, in a wide
 * window, a tall one or a phone's. Then, in a session, in order:
 *
 * - the grip on a covered tile flags that tile, through the board's own
 *   `contextmenu` handler, at the place the ray met;
 * - the trigger on another covered tile uncovers it, through the board's
 *   `click` handler, and more are uncovered until a count is drawn;
 * - Large, in the menu panel, deals a bigger board with the count's text
 *   taken down, and Restart a new one;
 * - Passthrough takes the backdrop down;
 * - the × ends the session.
 *
 * The script fails if any of them does not happen, or if the page throws
 * along the way. It is kept out of `npm test` because it needs a browser
 * and takes about half a minute under SwiftShader;
 * `.github/workflows/driven.yml` runs it on pull requests. The browser and
 * the controller are driven through `@apendua.dev/headset/driver`.
 */
import { join, resolve, dirname } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  press,
  rotate,
} from "@apendua.dev/headset/driver";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SHOTS = process.env.SHOTS;
if (SHOTS) {
  mkdirSync(SHOTS, { recursive: true });
}

/**
 * Build the app for production into a scratch directory, and say which JS
 * its service worker precaches, and which JS the page loads before it
 * offers anything: the entry chunk and every chunk it imports statically.
 * The worker is installed on every visit, so whatever it lists is
 * downloaded by every visitor.
 *
 * @returns {Promise<{ precached: string[], loaded: string[] }>}
 */
async function precache() {
  const outDir = mkdtempSync(join(tmpdir(), "minesweeper-"));
  try {
    const built = await build({
      root: HERE,
      configFile: join(HERE, "vite.config.mts"),
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

async function main() {
  console.log("\n== the precache");
  {
    const { precached, loaded } = await precache();
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
  /** @type {string} */
  const flagUrl = (await server.ssrLoadModule("/src/components/FieldStatus.ts")).FLAG_URL;

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
      await plain.waitForSelector("#board svg path");
      await plain.waitForLoadState("networkidle");
      check(
        !fetched.some((path) => path.endsWith("/src/xr.ts")),
        "a browser that cannot present does not load the headset scene",
      );
      check(!(await plain.$("#ARButton, #VRButton")), "and shows no Enter button");

      // The menu is laid out beside the board, or above it in a window
      // taller than it is wide, and the board is fitted to what is left:
      // a press anywhere on the covered tiles reaches the board, never the
      // card. The first two are windows where a card floating over the
      // board's corner, as it once did, hid some of its tiles; the third is
      // a phone's, where the card is a bar.
      for (const [width, height] of [
        [1024, 640],
        [768, 1024],
        [390, 844],
      ]) {
        await plain.setViewportSize({ width, height });
        await plain.waitForFunction(() => {
          const board = /** @type {HTMLElement} */ (document.querySelector("#board"));
          const svg = board.querySelector("svg");
          return (
            svg?.getAttribute("width") === String(board.clientWidth) &&
            svg.getAttribute("height") === String(board.clientHeight)
          );
        });
        const hidden = await plain.evaluate(() => {
          const board = /** @type {HTMLElement} */ (document.querySelector("#board"));
          const svg = /** @type {SVGSVGElement} */ (board.querySelector("svg"));
          const path = /** @type {SVGPathElement} */ (svg.querySelector("path"));
          const rect = svg.getBoundingClientRect();
          let covered = 0;
          let missed = 0;
          for (let y = 0; y < rect.height; y += 6) {
            for (let x = 0; x < rect.width; x += 6) {
              if (path.isPointInFill(new DOMPoint(x, y))) {
                covered += 1;
                if (!board.contains(document.elementFromPoint(rect.left + x, rect.top + y))) {
                  missed += 1;
                }
              }
            }
          }
          return { covered, missed };
        });
        check(
          hidden.covered > 0 && hidden.missed === 0,
          `at ${width}x${height} every covered tile can be pressed ` +
            `(${hidden.missed} of ${hidden.covered} points are under something else)`,
        );
        // And the other way round: the board is not laid over the card.
        const menuMissed = await plain.evaluate(() => {
          const menu = /** @type {HTMLElement} */ (document.querySelector("#menu"));
          const rect = menu.getBoundingClientRect();
          let missed = 0;
          for (let y = rect.top + 2; y < rect.bottom - 2; y += 6) {
            for (let x = rect.left + 2; x < rect.right - 2; x += 6) {
              if (!menu.contains(document.elementFromPoint(x, y))) {
                missed += 1;
              }
            }
          }
          return missed;
        });
        check(
          menuMissed === 0,
          `and all of the card can be pressed (${menuMissed} points are not)`,
        );
      }
      await plain.close();
    }

    const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.log("[pageerror]", process.env.STACKS ? error.stack : error.message);
    });
    await page.goto(`${url}?emulator=bare`, { waitUntil: "load" });
    await page.waitForSelector("#board svg path");
    await page.waitForSelector("#ARButton, #VRButton");
    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, "page.png") });
    }
    await page.click("#ARButton, #VRButton");
    await page
      .waitForFunction(
        () =>
          document.querySelector("#board[data-xr-portal]") &&
          document.querySelector("#menu[data-xr-portal]") &&
          !document.querySelector("[data-xr-loading]"),
      )
      .catch(async (error) => {
        console.log(
          "panels:",
          await page.evaluate(() =>
            [...document.querySelectorAll("[data-xr-portal]")].map(
              (e) => `${e.id} loading=${e.hasAttribute("data-xr-loading")}`,
            ),
          ),
        );
        if (SHOTS) await page.screenshot({ path: join(SHOTS, "stuck.png") });
        throw error;
      });
    await frames(page, 30);

    // Where the head was as the session started, which is the origin of the
    // `local` space the scene is laid out in.
    const head = await headPosition(page);

    /**
     * Where a point of the board element, in its own px, is in the scene.
     *
     * @param {number} x
     * @param {number} y
     */
    const onBoard = async (x, y) => {
      const { width, height } = await page.evaluate(() =>
        /** @type {Element} */ (document.querySelector("#board")).getBoundingClientRect().toJSON(),
      );
      const metres = 0.01 * placement.boardScale(width, height);
      const [bx, by, bz] = placement.BOARD_AT;
      return /** @type {[number, number, number]} */ ([
        bx + (x - width / 2) * metres,
        by - (y - height / 2) * metres,
        bz,
      ]);
    };

    /**
     * Where the middle of the menu's button with this text is in the scene.
     *
     * @param {string} label
     */
    const onMenu = async (label) => {
      const { menu, element } = await page.evaluate((text) => {
        const menu = /** @type {Element} */ (document.querySelector("#menu"));
        const button = [...menu.querySelectorAll("button")].find((b) => b.textContent === text);
        if (!button) throw new Error(`no ${text} in the menu`);
        return {
          menu: menu.getBoundingClientRect().toJSON(),
          element: button.getBoundingClientRect().toJSON(),
        };
      }, label);
      const metres = 0.01 * placement.MENU_SCALE;
      const local = /** @type {[number, number, number]} */ ([
        (element.left + element.width / 2 - menu.left - menu.width / 2) * metres,
        -(element.top + element.height / 2 - menu.top - menu.height / 2) * metres,
        0,
      ]);
      const [x, y, z] = rotate(local, placement.MENU_PITCH, placement.MENU_YAW);
      const [mx, my, mz] = placement.MENU_AT;
      return /** @type {[number, number, number]} */ ([mx + x, my + y, mz + z]);
    };

    /**
     * Whether the menu's button with this text carries a flag.
     *
     * @param {string} label
     * @param {string} flag
     */
    const flagged = (label, flag) =>
      page.evaluate(
        ([text, name]) =>
          [...document.querySelectorAll("#menu button")]
            .find((b) => b.textContent === text)
            ?.hasAttribute(name) ?? false,
        [label, flag],
      );

    /** @param {string} selector */
    const hovered = (selector) =>
      page.evaluate(
        (q) => document.querySelector(q)?.hasAttribute("data-xr-hover") ?? false,
        selector,
      );

    /** Press the menu's button with this text, by the ray. */
    const pressInMenu = async (/** @type {string} */ label) => {
      await aimAt(page, head, await onMenu(label));
      check(await flagged(label, "data-xr-hover"), `the ray is on ${label}`);
      await press(page, "trigger");
      await frames(page, 10);
    };

    // The page reports what its handlers heard, and where.
    await page.evaluate(() => {
      /** @type {any} */ const w = window;
      w.__heard = [];
      for (const type of ["click", "contextmenu"]) {
        document.querySelector("#board")?.addEventListener(type, (event) => {
          const { clientX, clientY } = /** @type {MouseEvent} */ (event);
          w.__heard.push({ type, clientX, clientY });
        });
      }
    });

    /**
     * The middles of covered tiles, in the board's px, found from the page:
     * points in the covered set with covered ground on either side, so that
     * a ray a little off still lands on the same set.
     */
    const coveredPoints = () =>
      page.evaluate(() => {
        const svg = /** @type {SVGSVGElement} */ (document.querySelector("#board svg"));
        const path = /** @type {SVGPathElement} */ (svg.querySelector("path"));
        const rect = svg.getBoundingClientRect();
        /** @type {{ x: number, y: number }[]} */
        const points = [];
        for (let y = rect.height * 0.3; y < rect.height * 0.7; y += 9) {
          for (let x = rect.width * 0.35; x < rect.width * 0.65; x += 9) {
            if ([-8, 0, 8].every((d) => path.isPointInFill(new DOMPoint(x + d, y)))) {
              points.push({ x, y });
            }
          }
        }
        return points;
      });

    const flags = () =>
      page.$$eval(
        "#board svg image",
        (images, url) => images.filter((image) => image.getAttribute("href") === url).length,
        flagUrl,
      );
    const coveredPath = () => page.$eval("#board svg path", (path) => path.getAttribute("d") ?? "");

    console.log("\n== the board");
    const covered = await coveredPoints();
    if (covered.length < 2) throw new Error("no covered tiles to aim at");
    const flagAt = covered[0];
    await aimAt(page, head, await onBoard(flagAt.x, flagAt.y));
    check(await hovered("#board svg path"), "the ray is on the covered tiles");
    const flagsBefore = await flags();
    await press(page, "squeeze");
    await frames(page, 10);
    const heard = await page.evaluate(() => /** @type {any} */ (window).__heard);
    console.log("  heard:", JSON.stringify(heard));
    const menuEvent = heard.find((/** @type {any} */ e) => e.type === "contextmenu");
    check(!!menuEvent, "the grip was heard as a contextmenu");
    // The board is laid out beside the menu, so a point of it is that far
    // across the page.
    const boardAt = await page.evaluate(() =>
      /** @type {Element} */ (document.querySelector("#board")).getBoundingClientRect().toJSON(),
    );
    check(
      !!menuEvent &&
        Math.hypot(
          menuEvent.clientX - (boardAt.left + flagAt.x),
          menuEvent.clientY - (boardAt.top + flagAt.y),
        ) < 12,
      "at the place on the page the ray was aimed at",
    );
    check((await flags()) === flagsBefore + 1, "and it planted a flag");

    const uncoverAt = covered[covered.length - 1];
    await aimAt(page, head, await onBoard(uncoverAt.x, uncoverAt.y));
    const before = await coveredPath();
    await press(page, "trigger");
    await frames(page, 20);
    check((await coveredPath()) !== before, "the trigger uncovered a tile");
    // A count on the board when it is dealt again is what once broke the
    // scene: the counts' text nodes left the page before the portal heard.
    const counts = () => page.$$eval("#board svg text", (texts) => texts.length);
    // A press can find a mine, which ends the game with no count drawn, so
    // a lost board is dealt again from the page; a few tries are plenty.
    const lost = () =>
      page.evaluate(() => document.querySelector("#menu")?.textContent?.includes("Game over"));
    for (let tries = 0; tries < 8 && (await counts()) === 0; tries += 1) {
      if (await lost()) {
        await page.evaluate(() =>
          [...document.querySelectorAll("#menu button")]
            .find((button) => button.textContent === "Restart")
            ?.click(),
        );
        await frames(page, 30);
      }
      const points = await coveredPoints();
      const point = points[Math.floor(points.length / 2)];
      if (!point) {
        break;
      }
      await aimAt(page, head, await onBoard(point.x, point.y));
      await press(page, "trigger");
      await frames(page, 10);
    }
    check((await counts()) > 0, "a count is drawn on the board");
    if (SHOTS) {
      // A big update reaches a panel whole, a few frames after the page.
      await frames(page, 30);
      await page.screenshot({ path: join(SHOTS, "session.png") });
    }

    console.log("\n== the menu");
    const boardBefore = await page.$("#board svg");
    await pressInMenu("Large");
    check(await flagged("Large", "data-on"), "Large is chosen");
    const boardAfter = await page.$("#board svg");
    check(
      !(await page.evaluate(([a, b]) => a === b, [boardBefore, boardAfter])),
      "and a new board was dealt",
    );
    await frames(page, 30);
    await pressInMenu("Restart");
    check((await flags()) === 0, "a restarted board has no flags on it");

    await pressInMenu("Passthrough");
    check(await flagged("Passthrough", "data-on"), "Passthrough is on");
    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, "passthrough.png") });
    }

    await pressInMenu("\u00d7");
    const ended = await page.evaluate(
      () => !document.querySelector("#board[data-xr-portal], #menu[data-xr-portal]"),
    );
    check(ended, "the × ended the session and took the panels down");
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
