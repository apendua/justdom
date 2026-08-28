/**
 * Exercises the game end to end through the bare IWER emulator in headless
 * Chromium: a seeded castle loads, a brick is really dragged off the tray
 * with the emulated trigger and lands snapped on the board, Undo takes it
 * back, Ready starts the siege, space-bar shots knock bricks down, and Back
 * To Building puts the castle back up.
 *
 *   node tests/emulator-check.mjs             # run the checks
 *   SHOT=/some/dir node tests/emulator-check.mjs   # also write screenshots
 *
 * `demo-screenshots.mjs` covers looking at the game; this covers touching
 * it. The drag is the part nothing else tests — the ray, the grab, the grid
 * preview, the drop — and the panels being real DOM is what makes the
 * assertions cheap: the bricks-built and still-standing counts are read
 * straight out of the panel's text, and the buttons are pressed by DOM
 * click, no scripting hooks in the app at all.
 *
 * This file was brought back from the castle-r3f experiment, whose harness
 * had to invent the controller-driven drag; see apps/castle-r3f/tests.
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(
  resolve(HERE, "../showcase-xr/node_modules/playwright-core/index.mjs")
);

const SHOT = process.env.SHOT ?? "";
const CHROMIUM = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/**
 * Where things stand in the scene, in the `local` reference space the game
 * runs in — the origin is wherever the head was when the session started.
 * These follow from `App.ts` (the board's home and scale), `Game.ts` (the
 * tray's pose) and `utils/paletteLayout.ts` (the cube's slot on the tray);
 * a change to that layout moves these targets, and the drag check will say
 * so by failing to pick anything up.
 */
const BOARD_HOME = [0, -0.4, -1.1];
const SCALE = 0.1;
/** The tray's cube slot, the layout chain above worked through by hand. */
const CUBE_SLOT = [0.444, -0.3, -1.01];
/** An empty cell to drop the copy on: board (2.5, 0.5, 2), clear of the seed. */
const DROP_CELL = [
  BOARD_HOME[0] + SCALE * 2.5,
  BOARD_HOME[1] + SCALE * 0.5,
  BOARD_HOME[2] + SCALE * 2,
];

/** The same castle the screenshot script seeds: 37 bricks, 24 off the ground. */
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
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      cube(sx * 1.5, 0.5, sz * 1.5);
      cube(sx * 1.5, 1.5, sz * 1.5);
      wedge(sx * 1.5, 2.5, sz * 1.5);
    }
  }
  for (const sx of [-1, 1]) {
    block(sx * 1.5, 0.5, 0, QUARTER_TURN);
    block(sx * 1.5, 1.5, 0, QUARTER_TURN);
  }
  block(0, 0.5, -1.5);
  block(0, 1.5, -1.5);
  pillar(-0.75, 1, 1.5);
  pillar(0.75, 1, 1.5);
  block(0, 2.5, 1.5);
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

const frames = (page, count) =>
  page.evaluate(
    (n) =>
      new Promise((done) => {
        let left = n;
        const tick = () => (left-- > 0 ? requestAnimationFrame(tick) : done());
        tick();
      }),
    count,
  );

/** Pose the emulated head, and park the hands out of the picture. */
const pose = (page, pitch, yaw = 0, offset = [0, 0, 0]) =>
  page.evaluate(
    ([p, y, dx, dy, dz]) => {
      const device = window.xrDevice;
      if (window.__home === undefined) {
        window.__home = { x: device.position.x, y: device.position.y, z: device.position.z };
      }
      device.position.x = window.__home.x + dx;
      device.position.y = window.__home.y + dy;
      device.position.z = window.__home.z + dz;
      const cp = Math.cos(p / 2);
      const sp = Math.sin(p / 2);
      const cy = Math.cos(y / 2);
      const sy = Math.sin(y / 2);
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
        controller.quaternion.x = Math.sin(-Math.PI / 4);
        controller.quaternion.y = 0;
        controller.quaternion.z = 0;
        controller.quaternion.w = Math.cos(-Math.PI / 4);
      }
    },
    [pitch, yaw, ...offset],
  );

/**
 * Point the right controller so its ray runs from `from` through `at`, both
 * given in scene coordinates. IWER drives the target-ray space straight from
 * the pose set here, so the ray is exactly the pose's own -z; the rotation
 * taking -z onto the wanted direction has axis (-z) x d = (d.y, -d.x, 0).
 * Device coordinates are the scene's shifted by the head's starting pose,
 * which `pose()` remembered as `__home`.
 */
const aimRayFrom = (page, from, at) =>
  page.evaluate(
    ([fx, fy, fz, ax, ay, az]) => {
      const home = window.__home;
      const controller = window.xrDevice.controllers.right;
      controller.position.x = home.x + fx;
      controller.position.y = home.y + fy;
      controller.position.z = home.z + fz;
      const length = Math.hypot(ax - fx, ay - fy, az - fz);
      const dx = (ax - fx) / length;
      const dy = (ay - fy) / length;
      const dz = (az - fz) / length;
      const axisX = dy;
      const axisY = -dx;
      const axisLength = Math.hypot(axisX, axisY) || 1;
      const angle = Math.acos(Math.max(-1, Math.min(1, -dz)));
      const s = Math.sin(angle / 2);
      controller.quaternion.x = (axisX / axisLength) * s;
      controller.quaternion.y = (axisY / axisLength) * s;
      controller.quaternion.z = 0;
      controller.quaternion.w = Math.cos(angle / 2);
    },
    [...from, ...at],
  );

const trigger = (page, value) =>
  page.evaluate((v) => {
    window.xrDevice.controllers.right.updateButtonValue("trigger", v);
  }, value);

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

/** Reads a `Label: value` line off the panel, e.g. "Bricks" or "Standing". */
const readValue = (page, label) =>
  page.evaluate((wanted) => {
    const portals = Array.from(document.querySelectorAll("[data-xr-portal]"));
    const panel = portals.find((portal) => (portal.textContent || "").includes("Music"));
    if (!panel) return null;
    const lines = Array.from(panel.querySelectorAll("div"))
      .map((el) => (el.textContent || "").trim())
      .filter((line) => line.startsWith(`${wanted}:`));
    if (lines.length === 0) return null;
    // The innermost match comes last, and carries no other rows' text.
    return lines[lines.length - 1].slice(wanted.length + 1).trim();
  }, label);

const readCount = async (page, label) => {
  const value = await readValue(page, label);
  const parsed = value === null ? NaN : parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const shot = async (page, name) => {
  if (SHOT) {
    await page.screenshot({ path: join(SHOT, name) });
    console.log("[shot]", join(SHOT, name));
  }
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

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
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 960 },
  });
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));

  await page.addInitScript((seed) => {
    localStorage.setItem("castle-xr:castle", seed);
  }, JSON.stringify(castle()));

  await page.goto(`${url}?emulator=bare`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector("#ARButton, #VRButton", { timeout: 30_000 });
  await page.click("#ARButton, #VRButton");
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("[data-xr-portal]")).some((portal) =>
        (portal.textContent || "").includes("Music"),
      ),
    undefined,
    { timeout: 30_000 },
  );
  await pose(page, -0.3);
  await frames(page, 60);

  check("castle seeded from localStorage", (await readCount(page, "Bricks")) === 37);
  await shot(page, "build.png");

  // Pull a brick off the tray with the emulated trigger: aim at the cube
  // slot, squeeze, sweep over an empty cell, release.
  await aimRayFrom(page, [CUBE_SLOT[0] - 0.1, CUBE_SLOT[1] + 0.25, CUBE_SLOT[2] + 0.45], CUBE_SLOT);
  await frames(page, 15);
  await trigger(page, 1);
  await frames(page, 15);
  await aimRayFrom(page, [CUBE_SLOT[0] - 0.1, CUBE_SLOT[1] + 0.25, CUBE_SLOT[2] + 0.45], DROP_CELL);
  await frames(page, 30);
  await shot(page, "drag.png");
  await trigger(page, 0);
  await frames(page, 30);
  check("tray drag placed a brick", (await readCount(page, "Bricks")) === 38);

  console.log("[undo]", await clickButton(page, "Undo"));
  await frames(page, 15);
  check("undo removes it again", (await readCount(page, "Bricks")) === 37);

  // Ready: the bricks become bodies and the slingshot appears. The seed's
  // bottom layer touches the ground, which is already "down" by the game's
  // own rule; 24 of the 37 start off it.
  console.log("[ready]", await clickButton(page, "Ready"));
  await frames(page, 40);
  check("siege starts with 24 standing", (await readValue(page, "Standing")) === "24 / 37");

  // Aim with the head, which is the one aim a script has, and let the held
  // space bar draw the pouch.
  console.log("[gaze]", await clickButton(page, "Aim:"));
  await frames(page, 15);
  for (const yaw of [0.1, -0.12, 0.02]) {
    await pose(page, -0.18, yaw);
    await frames(page, 10);
    await page.keyboard.down("Space");
    await frames(page, 100);
    await page.keyboard.up("Space");
    await frames(page, 120);
  }
  await frames(page, 120);
  await shot(page, "siege.png");
  check("three shots were fired", (await readCount(page, "Shots")) === 3);
  const standing = await readValue(page, "Standing");
  check(
    "the slingshot knocked bricks down",
    /^\d+ \/ 37$/.test(standing ?? "") && parseInt(standing, 10) < 24,
    `standing=${standing}`,
  );

  console.log("[rebuild]", await clickButton(page, "Back To Building"));
  await frames(page, 30);
  check("back to building restores the castle", (await readCount(page, "Bricks")) === 37);
  await shot(page, "rebuilt.png");

  await browser.close();
  await server.close();

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
