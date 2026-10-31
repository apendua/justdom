// Takes the site's screenshots from its last build: one of each demo for the
// demos page, and the todo app on a page and in a headset for the guide. They
// are committed under public/screenshots/, so a build only copies them, and
// this is run by hand when a demo changes the way it looks:
//
//   node common/scripts/install-run-rush.js build --to justdom-site
//   cd site && npm run screenshots [-- <app> ...]
//
// With app folder names after `--` it retakes only those demos' screenshots;
// with `guide` among them, the guide's too.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { serve } from "vitepress";
import { castle } from "../../apps/castle/tests/castle.mjs";
import { demos, demoViewport as viewport, screenshots, site } from "./projects.mjs";

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
 * What a demo needs set up first, so that its picture shows it doing what it
 * is for rather than its empty first screen. `before` runs before the page is
 * opened, `after` once it has loaded.
 *
 * @type {Record<string, {
 *   before?: (page: import("playwright-core").Page) => Promise<void>,
 *   after?: (page: import("playwright-core").Page) => Promise<void>,
 * }>}
 */
const setups = {
  // A castle already built on the board, put where the game keeps the castle
  // between visits. It is the one the app's own screenshots show.
  castle: {
    before: (page) =>
      page.addInitScript((seed) => {
        localStorage.setItem("castle:castle", seed);
      }, JSON.stringify(castle())),
  },
  // Richmond's exact pentagon, one of the app's examples.
  euclid: {
    after: async (page) => {
      await page.getByText("Equilateral triangle (Elements I.1)").first().click();
      await page.getByText("Pentagon (Richmond, exact)").first().click();
      await page.getByText("Fit view").click();
    },
  },
  // A game under way. The mines are laid with Math.random, so a seeded one
  // lays the same board every run, and these five clicks open part of it
  // without hitting a mine on that board.
  minesweeper: {
    before: (page) =>
      page.addInitScript(() => {
        // mulberry32
        let state = 4;
        Math.random = () => {
          state = (state + 0x6d2b79f5) >>> 0;
          let t = state;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }),
    after: async (page) => {
      for (const [x, y] of [
        [640, 400],
        [900, 250],
        [450, 650],
        [1100, 600],
        [700, 150],
      ]) {
        await page.mouse.click(x, y);
      }
      if (!(await page.getByText("Good luck!").isVisible())) {
        throw new Error(
          "minesweeper: a click hit a mine; the board is not the one these clicks were picked for",
        );
      }
    },
  },
};

/**
 * @param {import("playwright-core").Browser} browser
 * @param {string} origin
 * @param {string} slug
 */
async function demo(browser, origin, slug) {
  const page = await browser.newPage({ viewport });
  try {
    const setup = setups[slug];
    await setup?.before?.(page);
    await page.goto(`${origin}/demos/${slug}/`, { waitUntil: "networkidle" });
    await setup?.after?.(page);
    await settle(page);
    await tidy(page);
    await page.waitForTimeout(500);
    await save(page, await page.screenshot(), `demos/${slug}.webp`);
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
