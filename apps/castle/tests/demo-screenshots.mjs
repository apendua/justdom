/**
 * Regenerates the website's demo screenshots for castle, with the real
 * emulator stack: vite-served castle, headless Chromium, IWER standing in
 * for a Quest 3.
 *
 *   node tests/demo-screenshots.mjs build    # castle-01.png (1280x960)
 *   node tests/demo-screenshots.mjs siege    # castle-02.png (780x585)
 *   SHOT=/tmp/out.png node tests/demo-screenshots.mjs build   # elsewhere
 *
 * The build shot is a finished castle — seeded straight into localStorage, so
 * the same one comes back every run — with the panel to its left and the tray
 * to the right. The siege shot is that castle after a few slingshot stones,
 * with the pouch drawn back for one more; the stones are really fired, via
 * gaze aim and the held space bar, so the rubble is honestly Rapier's and lies
 * a little differently every time.
 *
 * The captions in pages/apendua/src/content/demos.ts quote the numbers on the
 * panel — bricks built, shots taken, bricks still standing — so after
 * re-running the siege shot, check they still agree with the picture.
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { clickButton, frames, hideFurniture, pose } from "./emulator.mjs";
import { castle } from "./castle.mjs";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(
  resolve(HERE, "../showcase/node_modules/playwright-core/index.mjs")
);

const MODE = process.argv[2] ?? "build";
if (MODE !== "build" && MODE !== "siege") {
  throw new Error(`unknown mode "${MODE}" — expected build or siege`);
}
const OUT =
  process.env.SHOT ??
  resolve(
    HERE,
    "../../pages/apendua/public/images/demos",
    MODE === "build" ? "castle-01.png" : "castle-02.png",
  );
const SIZE = MODE === "build" ? { width: 1280, height: 960 } : { width: 780, height: 585 };
const CHROMIUM = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

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
    executablePath: CHROMIUM,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: SIZE });
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));

  await page.addInitScript((seed) => {
    localStorage.setItem("castle:castle", seed);
  }, JSON.stringify(castle()));

  await page.goto(`${url}?emulator=bare`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector("#ARButton, #VRButton", { timeout: 30_000 });
  await page.click("#ARButton, #VRButton");
  await page.waitForFunction(() => document.querySelectorAll("canvas").length > 0, undefined, {
    timeout: 30_000,
  });
  await frames(page, 90);

  // The screenshot wants the scene, not the page furniture: the enter/stop
  // button and the stats.js chip are hidden, the in-scene diagnostics panel is
  // switched off through its own button, and the page behind the transparent
  // canvas goes passthrough-dark.
  await hideFurniture(page);
  console.log("[diagnostics]", await clickButton(page, "Hide diagnostics"));

  // Framed a step up and to the left of where the player started, looking
  // back down at the board, so the panel, the castle and the tray share the
  // picture. Tuned by eye against the 4:3 frame.
  const pitch = -0.26;
  const stand = [-0.15, 0.22, 0];
  await pose(page, pitch, -0.28, stand);
  await frames(page, 30);

  if (MODE === "build") {
    await page.screenshot({ path: OUT });
  } else {
    console.log("[ready]", await clickButton(page, "Ready"));
    await frames(page, 40);
    // Aim with the head, which is the one aim a script has.
    console.log("[gaze]", await clickButton(page, "Aim:"));
    await frames(page, 20);

    // A few stones into the castle, swinging the gaze a little between shots
    // so more than one wall comes down. Shots are aimed from the origin,
    // where the pitch that finds the castle is easy to reason about.
    for (const yaw of [0.1, -0.12, 0.02, -0.06, 0.16]) {
      await pose(page, -0.18, yaw);
      await frames(page, 10);
      await page.keyboard.down("Space");
      await frames(page, 100);
      await page.keyboard.up("Space");
      await frames(page, 90);
    }
    // Let the rubble settle, then draw the pouch back for one more.
    await frames(page, 160);
    await pose(page, pitch, -0.28, stand);
    await frames(page, 10);
    await page.keyboard.down("Space");
    await frames(page, 55);
    await page.screenshot({ path: OUT });
    await page.keyboard.up("Space");
  }
  console.log("[written]", OUT);

  await browser.close();
  await server.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
