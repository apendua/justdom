/**
 * What the page's focus does in a session, with and without the
 * `?realfocus` experiment (`@apendua.dev/headset/focus`): vite-served
 * todo-vanilla in headless Chromium, on the emulated headset, driven
 * through `@apendua.dev/headset/driver`.
 *
 *   node tests/focus-check.mjs
 *
 * Each run enters a session and presses the field with the right
 * controller's ray, which opens freedom's keyboard. It prints what has the
 * page's focus, then types `milk` and Enter on the laptop's keyboard, the
 * way a keyboard paired with a headset would, then a key on freedom's board
 * with the ray, and then presses the Add button, which puts the board away.
 * It fails unless, without the experiment, the field is marked but
 * `<body>` keeps the focus and the laptop's keys are lost, and unless, with
 * it, the field has focus while the board is up, the laptop's keys type
 * into it and add a todo, the board's key still types, and the field loses
 * focus with the board.
 *
 * A manual check rather than part of `npm test`: it needs a browser, and
 * takes about a minute under SwiftShader.
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { aim, closeAll, frames, launch, press } from "@apendua.dev/headset/driver";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the right controller is held while the ray sweeps: chest height. */
const HAND = /** @type {[number, number, number]} */ ([0.05, 1.4, -0.05]);

/**
 * The page's state as the check reads it.
 *
 * @param {import("playwright-core").Page} page
 */
const state = (page) =>
  page.evaluate(() => {
    const field = /** @type {HTMLInputElement} */ (document.querySelector("#root input"));
    const active = document.activeElement;
    return {
      focused: active === field ? "field" : (active?.tagName.toLowerCase() ?? "none"),
      marked: field.hasAttribute("data-xr-focus"),
      value: field.value,
      todos: document.querySelectorAll("li").length,
    };
  });

/**
 * @param {import("playwright-core").Browser} browser
 * @param {string} url
 * @param {boolean} realFocus
 */
async function run(browser, url, realFocus) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));
  await page.goto(`${url}?emulator=bare${realFocus ? "&realfocus" : ""}`, { waitUntil: "load" });
  await page.waitForSelector("#root input");
  await page.waitForSelector("#ARButton, #VRButton");
  await page.click("#ARButton, #VRButton");
  await page.waitForFunction(
    () =>
      !document.querySelector("[data-xr-loading]") && document.querySelector("[data-xr-portal]"),
  );
  await frames(page, 30);

  /** The right controller held at `HAND`, aimed by yaw and pitch in degrees. */
  const at = (/** @type {number} */ yaw, /** @type {number} */ pitch) =>
    aim(page, HAND, (yaw * Math.PI) / 180, (pitch * Math.PI) / 180);
  /**
   * Sweep the ray until `found` says it is on what it looks for.
   *
   * @param {() => Promise<boolean>} found
   * @param {number} from highest pitch
   * @param {number} to lowest pitch
   */
  const find = async (found, from, to) => {
    for (let pitch = from; pitch >= to; pitch -= 1) {
      for (let yaw = -20; yaw <= 20; yaw += 2) {
        await at(yaw, pitch);
        if (await found()) {
          return [yaw, pitch];
        }
      }
    }
    return null;
  };
  const click = () => press(page, "trigger");

  const label = realFocus ? "with ?realfocus" : "without ?realfocus";
  console.log(`\n== ${label}`);
  const field = await find(
    () => page.evaluate(() => document.querySelector("#root input[data-xr-hover]") !== null),
    40,
    -10,
  );
  if (!field) {
    throw new Error("could not find the field with the ray");
  }
  await click();
  const pressed = await state(page);
  console.log("  field pressed:       ", pressed);

  await page.keyboard.type("milk");
  await frames(page, 3);
  const typed = await state(page);
  console.log("  laptop typed 'milk': ", typed);
  await page.keyboard.press("Enter");
  await frames(page, 3);
  const entered = await state(page);
  console.log("  laptop pressed Enter:", entered);

  // A letter on freedom's board, which opens below the eyes.
  const key = await find(
    () =>
      page.evaluate(() =>
        [...document.querySelectorAll("[data-xr-hover]")].some((element) =>
          /^[a-z]$/.test(element.textContent ?? ""),
        ),
      ),
    -5,
    -60,
  );
  let board = null;
  if (key) {
    const letter = await page.evaluate(
      () =>
        [...document.querySelectorAll("[data-xr-hover]")].find((element) =>
          /^[a-z]$/.test(element.textContent ?? ""),
        )?.textContent,
    );
    await click();
    board = { letter, ...(await state(page)) };
    console.log("  board key pressed:   ", board);
  } else {
    console.log("  board key pressed:    could not find a key with the ray");
  }

  await at(...field);
  const add = await find(
    () =>
      page.evaluate(
        () => document.querySelector("#root button[data-xr-hover]")?.textContent === "Add",
      ),
    40,
    -10,
  );
  if (!add) {
    throw new Error("could not find the Add button with the ray");
  }
  await click();
  const dismissed = await state(page);
  console.log("  Add pressed:         ", dismissed);
  await page.close();

  const checks = realFocus
    ? [
        [
          "the field has focus while the board is up",
          pressed.focused === "field" && pressed.marked,
        ],
        ["the laptop's keys type into the field", typed.value === "milk"],
        [
          "Enter adds a todo and clears the field",
          entered.todos === pressed.todos + 1 && !entered.value,
        ],
        ["a key on the board still types", board !== null && board.value === board.letter],
        [
          "the field loses focus with the board",
          dismissed.focused !== "field" && !dismissed.marked,
        ],
      ]
    : [
        ["the field is marked but has no focus", pressed.focused !== "field" && pressed.marked],
        ["the laptop's keys are lost", typed.value === ""],
        ["Enter adds nothing", entered.todos === pressed.todos],
      ];
  let ok = true;
  for (const [what, held] of checks) {
    console.log(`  ${held ? "OK" : "FAIL"}: ${what}`);
    ok = ok && Boolean(held);
  }
  return ok;
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

  const browser = await launch();
  let ok = true;
  try {
    ok = (await run(browser, url, false)) && ok;
    ok = (await run(browser, url, true)) && ok;
  } finally {
    await closeAll(browser, server);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
