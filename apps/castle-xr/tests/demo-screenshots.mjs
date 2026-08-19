/**
 * Regenerates the website's demo screenshots for castle-xr, with the real
 * emulator stack: vite-served castle-xr, headless Chromium, IWER standing in
 * for a Quest 3.
 *
 *   node tests/demo-screenshots.mjs build    # castle-xr-01.png (1280x960)
 *   node tests/demo-screenshots.mjs siege    # castle-xr-02.png (780x585)
 *   SHOT=/tmp/out.png node tests/demo-screenshots.mjs build   # elsewhere
 *
 * The build shot is a finished castle — seeded straight into localStorage, so
 * the same one comes back every run — with the panel to its left and the tray
 * to the right. The siege shot is that castle after a few slingshot stones,
 * with the pouch drawn back for one more; the stones are really fired, via
 * gaze aim and the held space bar, so the rubble is honestly Rapier's and lies
 * a little differently every time.
 *
 * The captions in apps/website/src/content/demos.ts quote the numbers on the
 * panel — bricks built, shots taken, bricks still standing — so after
 * re-running the siege shot, check they still agree with the picture.
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(
  resolve(HERE, "../showcase-xr/node_modules/playwright-core/index.mjs")
);

const MODE = process.argv[2] ?? "build";
if (MODE !== "build" && MODE !== "siege") {
  throw new Error(`unknown mode "${MODE}" — expected build or siege`);
}
const OUT =
  process.env.SHOT ??
  resolve(
    HERE,
    "../website/public/images/demos",
    MODE === "build" ? "castle-xr-01.png" : "castle-xr-02.png",
  );
const SIZE = MODE === "build" ? { width: 1280, height: 960 } : { width: 780, height: 585 };
const CHROMIUM = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/** A castle: four roofed towers, walls, a gate, and a keep in the middle. */
function castle() {
  const bricks = [];
  const cube = (x, y, z) => bricks.push({ type: "cube", position: [x, y, z], rotation: [0, 0, 0] });
  const wedge = (x, y, z) =>
    bricks.push({ type: "wedge", position: [x, y, z], rotation: [0, 0, 0] });
  const block = (x, y, z, turn = 0) =>
    bricks.push({ type: "block", position: [x, y, z], rotation: [0, turn, 0] });
  const pillar = (x, y, z) =>
    bricks.push({ type: "pillar", position: [x, y, z], rotation: [0, 0, 0] });

  const QUARTER_TURN = Math.PI / 2;
  // Corner towers, two cubes and a roof each.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      cube(sx * 1.5, 0.5, sz * 1.5);
      cube(sx * 1.5, 1.5, sz * 1.5);
      wedge(sx * 1.5, 2.5, sz * 1.5);
    }
  }
  // Side walls run along z, so the blocks are turned a quarter.
  for (const sx of [-1, 1]) {
    block(sx * 1.5, 0.5, 0, QUARTER_TURN);
    block(sx * 1.5, 1.5, 0, QUARTER_TURN);
  }
  // The back wall runs along x.
  block(0, 0.5, -1.5);
  block(0, 1.5, -1.5);
  // The gate: two pillars and a lintel.
  pillar(-0.75, 1, 1.5);
  pillar(0.75, 1, 1.5);
  block(0, 2.5, 1.5);
  // The keep: a three-storey 2x2 of cubes under a double roof, so it stands
  // proud of the towers.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      cube(sx * 0.5, 0.5, sz * 0.5);
      cube(sx * 0.5, 1.5, sz * 0.5);
      cube(sx * 0.5, 2.5, sz * 0.5);
      wedge(sx * 0.5, 3.5, sz * 0.5);
    }
  }
  return bricks;
}

const frames = async (page, count) => {
  await page.evaluate(
    (n) =>
      new Promise((done) => {
        let left = n;
        const tick = () => (left-- > 0 ? requestAnimationFrame(tick) : done());
        tick();
      }),
    count,
  );
};

/**
 * Pose the emulated head, and keep the hands out of the picture. The offset is
 * from wherever the head started, which under a `local` reference space is
 * also the scene's origin — so these numbers read as scene coordinates.
 */
const pose = (page, pitch, yaw = 0, offset = [0, 0, 0]) =>
  page.evaluate(
    ([p, y, dx, dy, dz]) => {
      const device = window.xrDevice;
      if (window.__home === undefined) {
        window.__home = {
          x: device.position.x,
          y: device.position.y,
          z: device.position.z,
        };
      }
      device.position.x = window.__home.x + dx;
      device.position.y = window.__home.y + dy;
      device.position.z = window.__home.z + dz;
      const cp = Math.cos(p / 2);
      const sp = Math.sin(p / 2);
      const cy = Math.cos(y / 2);
      const sy = Math.sin(y / 2);
      // q = qyaw * qpitch
      device.quaternion.x = cy * sp;
      device.quaternion.y = sy * cp;
      device.quaternion.z = -sy * sp;
      device.quaternion.w = cy * cp;
      for (const side of ["left", "right"]) {
        const controller = device.controllers[side];
        if (!controller) continue;
        controller.position.x = side === "left" ? -0.3 : 0.3;
        controller.position.y = 0.9;
        controller.position.z = 0.25;
        // Straight down, so no ray crosses the frame.
        controller.quaternion.x = Math.sin(-Math.PI / 4);
        controller.quaternion.y = 0;
        controller.quaternion.z = 0;
        controller.quaternion.w = Math.cos(-Math.PI / 4);
      }
    },
    [pitch, yaw, ...offset],
  );

/** Presses a panel button by the text it starts with, through the DOM. */
const clickButton = (page, label) =>
  page.evaluate((wanted) => {
    const portals = Array.from(document.querySelectorAll("[data-xr-portal]"));
    const panel = portals.find((portal) => (portal.textContent || "").includes("Music"));
    if (!panel) return "no panel";
    const candidates = Array.from(panel.querySelectorAll("div")).filter((el) =>
      (el.textContent || "").trim().startsWith(wanted),
    );
    const leaves = candidates.filter(
      (el) => !candidates.some((other) => other !== el && el.contains(other)),
    );
    const target = leaves[leaves.length - 1];
    if (!target) return `no button ${wanted}`;
    target.click();
    return "clicked";
  }, label);

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
    localStorage.setItem("castle-xr:castle", seed);
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
  await page.evaluate(() => {
    const isScene = (el) => {
      if (el.tagName === "CANVAS") {
        return el.clientWidth > 400;
      }
      // stats.js is a div of small canvases; the scene is one big one.
      return Array.from(el.querySelectorAll("canvas")).some((c) => c.clientWidth > 400);
    };
    for (const el of document.body.children) {
      if (!isScene(el)) {
        el.style.visibility = "hidden";
      }
    }
    document.body.style.background = "#0c0d10";
  });
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
