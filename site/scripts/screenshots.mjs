// Records the site's clips and takes its screenshots from its last build: a
// looping clip of each demo in use for the demos page, with its last frame
// kept as a still for readers who ask for reduced motion, and the todo app on
// a page and in a headset for the guide. They are committed under
// public/screenshots/, so a build only copies them, and this is run by hand
// when a demo changes the way it looks or behaves:
//
//   node common/scripts/install-run-rush.js build --to justdom-site
//   cd site && npm run screenshots [-- <app> ...]
//
// With app folder names after `--` it records only those demos; with `guide`
// among them, it takes the guide's pictures too. The clips are encoded by
// ffmpeg, which has to be on the PATH, built with libwebp.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { serve } from "vitepress";
import { castle } from "../../apps/castle/tests/castle.mjs";
import { clickButton, frames, hideFurniture, pose } from "../../apps/castle/tests/emulator.mjs";
import { demos, demoViewport as viewport, screenshots, site } from "./projects.mjs";

/** How long a clip rests on where its demo ends up, in ms. */
const HOLD = 1500;
/** How long a demo with nothing to do is recorded doing it, in ms. */
const IDLE = 6000;
/** A clip's frame rate. */
const FPS = 15;
/**
 * How far the emulated head looks down at the castle, in radians. The head
 * aims the slingshot, and much lower than this the stones fall short of the
 * walls.
 */
const AIM_PITCH = -0.08;
/** libwebp's quality for a clip's frames, from 0 to 100. */
const QUALITY = 60;

/**
 * Hides what is page furniture rather than the demo: the button that starts a
 * headset session, and the frame rate readout the headset apps wear, which
 * says how fast SwiftShader drew the scene rather than anything about the app.
 * The showcase hands its readout out on `window.__diagnostics`, and the others
 * hide it with the button on their own panel.
 *
 * @param {import("playwright-core").Page} page
 */
async function tidy(page) {
  await page.addStyleTag({ content: "#ARButton, #VRButton { display: none !important; }" });
  await page.evaluate(() => {
    /** @type {any} */ (window).__diagnostics?.visible.set(false);
    for (const element of document.querySelectorAll("div, button")) {
      if (element.childElementCount === 0 && element.textContent === "Hide diagnostics") {
        /** @type {HTMLElement} */ (element).click();
      }
    }
  });
}

/**
 * Waits until the panels have stopped loading and the scene has had time to
 * settle: a panel shows a loading frame until its DOM is measured, and fonts
 * and textures arrive after the page's load event.
 *
 * @param {import("playwright-core").Page} page
 */
async function settle(page) {
  await page.waitForFunction(() => !document.querySelector("[data-xr-loading]"), undefined, {
    timeout: 30_000,
  });
  await page.waitForTimeout(3000);
}

/**
 * Swaps Math.random for a seeded generator, mulberry32, so that a demo that
 * deals its board at random deals the same one every run.
 *
 * @param {import("playwright-core").Page} page
 * @param {number} seed
 */
function seedRandom(page, seed) {
  return page.addInitScript((state) => {
    Math.random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }, seed);
}

/**
 * Draws an arrow where the mouse is, since a headless browser draws none and a
 * clip should show where each click lands. It starts off the page.
 *
 * @param {import("playwright-core").Page} page
 */
async function pointer(page) {
  await page.evaluate(() => {
    const arrow = document.createElement("div");
    arrow.id = "clip-pointer";
    arrow.innerHTML =
      '<svg width="22" height="30" viewBox="-1 -1 15 21"><path d="M0 0V16L4.5 12L7.5 19L10 18L7 11H13Z" ' +
      'fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    Object.assign(arrow.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      transform: "translate(-100px, -100px)",
    });
    document.body.append(arrow);
    addEventListener(
      "pointermove",
      (event) => {
        arrow.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
      },
      true,
    );
  });
}

/**
 * Glides the mouse to a point and clicks there, so the clip shows the arrow
 * travel rather than jump.
 *
 * @param {import("playwright-core").Page} page
 * @param {{ x: number, y: number } | import("playwright-core").Locator} target
 */
async function glideAndClick(page, target) {
  let point = target;
  if ("boundingBox" in target) {
    const box = await target.boundingBox();
    if (!box) throw new Error(`nothing to click: ${target}`);
    point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  const { x, y } = /** @type {{ x: number, y: number }} */ (point);
  await page.mouse.move(x, y, { steps: 15 });
  await page.waitForTimeout(200);
  await page.mouse.click(x, y);
}

/**
 * Encodes a PNG as WebP in the page itself, since Chromium can and Playwright
 * cannot, and writes it out.
 *
 * @param {import("playwright-core").Page} page
 * @param {Buffer} png
 * @param {string} file under public/screenshots/
 */
async function save(page, png, file) {
  const webp = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    return canvas.toDataURL("image/webp", 0.85).split(",")[1];
  }, png.toString("base64"));
  const path = join(screenshots, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.from(webp, "base64"));
  console.log(`Wrote public/screenshots/${file}`);
}

/**
 * Records the page while `act` runs, and for `HOLD` ms after it, so that the
 * clip rests on where the demo ends up before it loops. Chromium sends a frame
 * only when the page has changed, each stamped with when it was drawn, so a
 * frame is shown until the next one's stamp, and the last until the end.
 *
 * @param {import("playwright-core").Page} page
 * @param {() => Promise<void>} act
 * @returns {Promise<{ data: Buffer, time: number }[]>} JPEG frames, times in seconds
 */
async function record(page, act) {
  const cdp = await page.context().newCDPSession(page);
  /** @type {{ data: Buffer, time: number }[]} */
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({
      data: Buffer.from(data, "base64"),
      time: metadata.timestamp ?? Date.now() / 1000,
    });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 95,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
  });
  await act();
  await page.waitForTimeout(HOLD);
  await cdp.send("Page.stopScreencast");
  const end = Date.now() / 1000;
  await cdp.detach();
  if (frames.length === 0) throw new Error("the page drew nothing while it was recorded");
  frames.push({ data: frames[frames.length - 1].data, time: end });
  return frames;
}

/**
 * Encodes recorded frames as a looping animated WebP with ffmpeg, at `FPS`
 * frames a second and the page's own size.
 *
 * @param {{ data: Buffer, time: number }[]} frames the last one only marks the end
 * @param {string} file under public/screenshots/
 */
function encode(frames, file) {
  const scratch = mkdtempSync(join(tmpdir(), "justdom-clip-"));
  try {
    const list = frames.slice(0, -1).flatMap((frame, i) => {
      const name = `${String(i).padStart(5, "0")}.jpg`;
      writeFileSync(join(scratch, name), frame.data);
      return [`file '${name}'`, `duration ${(frames[i + 1].time - frame.time).toFixed(4)}`];
    });
    // The concat demuxer drops the last entry's duration unless the entry is
    // given again after it.
    const last = list[list.length - 2];
    writeFileSync(
      join(scratch, "frames.txt"),
      ["ffconcat version 1.0", ...list, last, ""].join("\n"),
    );
    const path = join(screenshots, file);
    mkdirSync(join(path, ".."), { recursive: true });
    execFileSync(
      "ffmpeg",
      [
        ...["-loglevel", "error", "-y", "-f", "concat", "-i", join(scratch, "frames.txt")],
        ...["-vf", `fps=${FPS}`, "-c:v", "libwebp_anim"],
        ...["-quality", String(QUALITY), "-compression_level", "6", "-loop", "0", path],
      ],
      { stdio: "inherit" },
    );
    console.log(`Wrote public/screenshots/${file}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * What a demo's clip shows it doing. `before` runs before the page is opened,
 * `start` once it has loaded and before the recording starts, and `act` is
 * what is recorded. A demo with no `act` is recorded doing what it does on
 * its own for `IDLE` ms.
 *
 * @type {Record<string, {
 *   query?: string,
 *   before?: (page: import("playwright-core").Page) => Promise<void>,
 *   start?: (page: import("playwright-core").Page) => Promise<void>,
 *   act?: (page: import("playwright-core").Page) => Promise<void>,
 * }>}
 */
const setups = {
  // A castle already built, put where the game keeps the castle between
  // visits, and then knocked about with the slingshot in an emulated headset.
  // The stones are really fired, so the rubble lies differently every run.
  castle: {
    query: "?emulator=bare",
    before: (page) =>
      page.addInitScript((seed) => {
        localStorage.setItem("castle:castle", seed);
      }, JSON.stringify(castle())),
    start: async (page) => {
      await page.click("#ARButton, #VRButton");
      await page.waitForFunction(() => document.querySelector("canvas"));
      await frames(page, 90);
      await hideFurniture(page);
      await pose(page, AIM_PITCH);
      // A narrower view than the headset's own, so the castle fills the clip.
      await page.evaluate(() => {
        const device = /** @type {any} */ (window).xrDevice;
        device.fovy *= 0.6;
      });
      await frames(page, 30);
    },
    act: async (page) => {
      await page.waitForTimeout(1000);
      await clickButton(page, "Ready");
      await page.waitForTimeout(600);
      // Aim with the head, which is the one aim a script has.
      await clickButton(page, "Aim:");
      let yaw = 0;
      for (const target of [0.1, -0.04]) {
        // Turned to over a few frames, since a cut from one aim to the next
        // jolts the whole picture.
        for (let step = 1; step <= 10; step++) {
          await pose(page, AIM_PITCH, yaw + ((target - yaw) * step) / 10);
          await frames(page, 1);
        }
        yaw = target;
        // The space bar draws the pouch all the way back in 1.2 s.
        await page.keyboard.down("Space");
        await page.waitForTimeout(1300);
        await page.keyboard.up("Space");
        await page.waitForTimeout(2500);
      }
    },
  },
  // Richmond's exact pentagon, one of the app's examples, written out a line
  // at a time, with the drawing following the code.
  euclid: {
    start: async (page) => {
      await page.getByText("Equilateral triangle (Elements I.1)").first().click();
      await page.getByText("Pentagon (Richmond, exact)").first().click();
      await page.getByText("Fit view").click();
    },
    act: async (page) => {
      const editor = page.locator("textarea").first();
      const program = await editor.inputValue();
      await editor.fill("");
      await editor.focus();
      await page.waitForTimeout(500);
      for (const line of program.split("\n")) {
        await page.keyboard.insertText(`${line}\n`);
        // Comments are shown whole; the code a line at a time.
        if (!line.startsWith("//")) await page.waitForTimeout(350);
      }
    },
  },
  // The board is laid with Math.random, so a seeded one lays the same board
  // every run, and these five clicks open part of it without hitting a mine
  // on that board.
  minesweeper: {
    before: (page) => seedRandom(page, 4),
    act: async (page) => {
      for (const [x, y] of [
        [640, 400],
        [900, 250],
        [450, 650],
        [1100, 600],
        [700, 150],
      ]) {
        await glideAndClick(page, { x, y });
        await page.waitForTimeout(500);
      }
      if (!(await page.getByText("Good luck!").isVisible())) {
        throw new Error(
          "minesweeper: a click hit a mine; the board is not the one these clicks were picked for",
        );
      }
    },
  },
  knights: {
    before: (page) => seedRandom(page, 7),
    act: async (page) => {
      await page.waitForTimeout(500);
      await glideAndClick(page, { x: 586, y: 270 });
      await page.waitForTimeout(7000);
    },
  },
  // A todo added and ticked off.
  todo: {
    act: async (page) => {
      await page.waitForTimeout(500);
      await glideAndClick(page, page.getByPlaceholder("Add a new todo"));
      await page.keyboard.type("Record the demos", { delay: 70 });
      await page.waitForTimeout(300);
      await glideAndClick(page, page.getByText("Add", { exact: true }));
      await page.waitForTimeout(600);
      // The list's own scroll-down arrow, right of the list, which brings the
      // new todo, the last, into its window.
      for (let i = 0; i < 2; i++) {
        await glideAndClick(page, { x: 820, y: 437 });
        await page.waitForTimeout(400);
      }
      await glideAndClick(page, page.locator("input[type=checkbox]").last());
    },
  },
};

/**
 * Records a demo's clip and keeps its last frame as the still, which shows
 * where there is no motion wanted.
 *
 * @param {import("playwright-core").Browser} browser
 * @param {string} origin
 * @param {string} slug
 */
async function demo(browser, origin, slug) {
  const page = await browser.newPage({ viewport });
  try {
    const setup = setups[slug];
    await setup?.before?.(page);
    await page.goto(`${origin}/demos/${slug}/${setup?.query ?? ""}`, { waitUntil: "networkidle" });
    await setup?.start?.(page);
    await settle(page);
    await tidy(page);
    await pointer(page);
    await page.waitForTimeout(500);
    const act = setup?.act;
    const clip = await record(page, act ? () => act(page) : () => page.waitForTimeout(IDLE));
    await page.evaluate(() => document.getElementById("clip-pointer")?.remove());
    await save(page, await page.screenshot(), `demos/${slug}.webp`);
    encode(clip, `demos/${slug}.anim.webp`);
  } finally {
    await page.close();
  }
}

/**
 * The todo app as a page, and the same element mirrored into a headset, which
 * is what the guide's two pictures set side by side.
 *
 * @param {import("playwright-core").Browser} browser
 * @param {string} origin
 */
async function guide(browser, origin) {
  const page = await browser.newPage({ viewport });
  try {
    // `bare` asks for the emulated headset without its controls on the page.
    await page.goto(`${origin}/demos/todo/?emulator=bare`, { waitUntil: "networkidle" });
    const card = await page.locator("#root > *").first().boundingBox();
    if (!card) throw new Error("the todo app drew nothing");
    const margin = 32;
    const clip = {
      x: card.x - margin,
      y: card.y - margin,
      width: card.width + 2 * margin,
      height: card.height + 2 * margin,
    };
    // Both pictures are cropped to the app, so the button that starts the
    // session, at the bottom of the window, is in neither.
    await save(page, await page.screenshot({ clip }), "guide/todo-page.webp");

    await page.click("#ARButton, #VRButton");
    await page.waitForFunction(() => document.querySelector("canvas"));
    await settle(page);
    // The readout hangs off the camera, left of the middle of the view, and
    // the todo app has no button to hide it. Turning the head a little to the
    // left and stepping closer moves the panel clear of it, to the right.
    await page.evaluate(
      (turn) => {
        const device = /** @type {any} */ (window).xrDevice;
        device.quaternion.set(0, Math.sin(turn / 2), 0, Math.cos(turn / 2));
        device.position.z -= 0.25;
      },
      (20 * Math.PI) / 180,
    );
    await page.waitForTimeout(1500);
    // Where the panel lands in the view after that turn.
    const headset = { x: 600, y: 70, width: 480, height: 480 };
    await save(page, await page.screenshot({ clip: headset }), "guide/todo-headset.webp");
  } finally {
    await page.close();
  }
}

async function main() {
  const only = process.argv.slice(2);
  const all = demos().map((d) => d.slug);
  const unknown = only.filter((name) => name !== "guide" && !all.includes(name));
  if (unknown.length) {
    throw new Error(
      `not a demo or "guide": ${unknown.join(", ")}; the demos are ${all.join(", ")}`,
    );
  }
  const slugs = all.filter((slug) => only.length === 0 || only.includes(slug));

  const server = await serve({ root: site, port: 0 });
  // Closed whatever fails below, Chromium's launch included: a server left
  // listening keeps the process from ever exiting.
  try {
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("the preview has no port");
    const origin = `http://localhost:${address.port}`;

    const browser = await chromium.launch({
      // Playwright looks for the build of Chromium it was released with. Name
      // another one here where that one is not installed.
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      // The headset demos draw with WebGL, and SwiftShader is what draws it
      // wherever there is no GPU.
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    try {
      for (const slug of slugs) await demo(browser, origin, slug);
      if (only.length === 0 || only.includes("guide")) await guide(browser, origin);
    } finally {
      await browser.close();
    }
  } finally {
    server.server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
