import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

/**
 * Driving the showcase the way a headset would, from a script.
 *
 * The scene only exists inside an immersive session — outside one there is no
 * frame loop, no views and nothing on the canvas — so a test that wants to
 * look at it has to enter one. IWER is what makes that possible without a
 * headset: it installs a `navigator.xr` that answers like a Quest 3 and draws
 * the session's views into the ordinary page canvas, which is a thing a
 * browser can be asked to photograph.
 *
 * @import {Browser, Page} from 'playwright-core';
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");

/** The size every baseline was taken at. Changing it invalidates all of them. */
export const VIEWPORT = { width: 1024, height: 640 };

/**
 * The timestamp every animation frame reports in frozen mode. Chosen off a
 * round number so that none of the specimens in the motion panel — 1.6s,
 * 2s, 2.5s, 3s and 4s loops — is caught at the top or the bottom of its
 * travel, where a slip either way would look like no change at all.
 */
export const FROZEN_TIME = 1234;

/**
 * Chromium, from wherever this machine keeps it. Playwright normally resolves
 * its own download by revision, which is the one thing a pre-provisioned
 * container does not have; naming the executable explicitly works in both
 * places, and is also what pins the renderer a baseline was drawn with.
 *
 * @returns {string | undefined} undefined lets playwright resolve its own.
 */
function findChromium() {
  const named = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (named) {
    return named;
  }
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsers || !existsSync(browsers)) {
    return undefined;
  }
  const candidates = readdirSync(browsers)
    .filter((entry) => entry.startsWith("chromium-"))
    .sort()
    .reverse()
    .map((entry) => join(browsers, entry, "chrome-linux", "chrome"));
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Serve the app from source, on a port of the operating system's choosing so
 * that two runs never collide.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function serve() {
  const server = await createServer({
    root: APP_ROOT,
    configFile: join(APP_ROOT, "vite.config.mts"),
    logLevel: "warn",
    server: { port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.resolvedUrls?.local?.[0];
  if (!address) {
    await server.close();
    throw new Error("Vite did not report a local address");
  }
  return {
    url: address,
    close: () => server.close(),
  };
}

/**
 * A browser looking at the showcase, in an immersive session, holding still.
 *
 * @param {object} [options]
 * @param {boolean} [options.freeze] Whether to hold every animation at
 *   `FROZEN_TIME`. On for anything compared against a baseline; off for a test
 *   that is watching something move.
 * @returns {Promise<{ page: Page, browser: Browser, close: () => Promise<void> }>}
 */
export async function openShowcase({ freeze = true } = {}) {
  const server = await serve();
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: [
      // SwiftShader is the renderer wherever there is no GPU, which is
      // everywhere this runs; asking for it explicitly keeps a machine that
      // *does* have one from drawing the baselines differently.
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--force-color-profile=srgb",
      "--disable-lcd-text",
      "--font-render-hinting=none",
    ],
  });
  const page = await browser.newPage({
    // The dev server signs its own certificate.
    ignoreHTTPSErrors: true,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });
  if (process.env.DEBUG_PAGE === "1") {
    page.on("console", (message) => console.log("[page]", message.text().slice(0, 160)));
  }

  if (freeze) {
    await page.addInitScript((time) => {
      // Frames keep coming — the scene has to be drawn — but they all claim
      // to have arrived at the same moment, so anything driven by the clock
      // draws the same thing every time.
      const request = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => request(() => callback(time));

      // An animation started through the API is pinned as it is created,
      // because sweeping the ones that exist only pins the ones that exist:
      // the panel's slider is started by an effect, and an effect can run
      // again later, leaving a second animation running free behind the
      // frozen one. That is exactly what it looks like when a baseline
      // becomes flaky in one small rectangle.
      const animate = Element.prototype.animate;
      Element.prototype.animate = function frozenAnimate(...args) {
        const animation = animate.apply(this, args);
        animation.pause();
        animation.currentTime = time;
        return animation;
      };
    }, FROZEN_TIME);
  }

  await page.goto(`${server.url}?emulator=bare`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector("#ARButton", { timeout: 30_000 });

  return {
    page,
    browser,
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}

/**
 * Enter the emulated session, and wait until there is something in it.
 *
 * The button three provides is the only supported way in: it is what asks for
 * the session, and what hands the session to the renderer.
 *
 * @param {Page} page
 * @param {object} [options]
 * @param {boolean} [options.freeze]
 * @returns {Promise<void>}
 */
export async function enterSession(page, { freeze = true } = {}) {
  if (freeze) {
    // The session's frames need pinning as well as the page's. Anything
    // driven by `useFrame(ctx, …)` — which is the frame loop that survives a
    // headset taking the display — is timed by the session rather than by
    // the page, so the freeze above never reached it. Frames keep coming,
    // because the scene still has to be drawn; only the clock they report
    // stands still, exactly as it does for the page's own.
    await page.evaluate((time) => {
      const xr = navigator.xr;
      if (!xr) {
        return;
      }
      const request = xr.requestSession.bind(xr);
      // @ts-expect-error -- narrowing the overloads is not worth it here.
      xr.requestSession = async (...args) => {
        const session = await request(...args);
        const frames = session.requestAnimationFrame.bind(session);
        session.requestAnimationFrame = (callback) => frames((_, frame) => callback(time, frame));
        return session;
      };
    }, FROZEN_TIME);
  }

  await page.click("#ARButton");
  await page.waitForFunction(() => document.querySelectorAll("canvas").length > 0, undefined, {
    timeout: 30_000,
  });

  // The frame rate readout is an instrument, not scene: it hangs off the
  // camera in every headset app here, and what it says is a live number over
  // a minute of live numbers. Photographed, it is a rectangle that never
  // matches the one before — and the freeze does not stop it, because the
  // timestamps it counts come from the emulated session rather than from the
  // page's own animation frames. Put it down before anything is measured or
  // photographed; what these baselines are for is the four panels.
  await page.waitForFunction(() => !!window.__diagnostics, undefined, { timeout: 30_000 });
  await page.evaluate(() => {
    window.__diagnostics?.visible.set(false);
  });
  // The panels are built from measured DOM, and the measuring waits on fonts;
  // a few frames of settling is the difference between photographing the
  // scene and photographing it being built.
  await nextFrames(page, 30);

  if (freeze) {
    await freezeAnimations(page);
    await nextFrames(page, 5);
  }

  // Page furniture, not scene: the button that started the session sits over
  // the canvas while it runs.
  //
  // The emulator's own exit control cannot be dealt with the same way — it is
  // drawn into the session canvas rather than laid over it, so it is in every
  // photograph, in the top right. It is also drawn identically in every one
  // of them, which is what matters here: a mark that never changes can
  // neither raise a difference nor hide one.
  await page.addStyleTag({
    content: "#ARButton, #VRButton { display: none !important; }",
  });
}

/**
 * Wait for the page to actually paint, `count` times over.
 *
 * @param {Page} page
 * @param {number} count
 * @returns {Promise<void>}
 */
export async function nextFrames(page, count) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index++) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
  }, count);
}

/**
 * Stop every animation that exists, where it would have been at
 * `FROZEN_TIME`. Idempotent, and worth repeating: a CSS animation can begin
 * whenever a class does.
 *
 * @param {Page} page
 * @returns {Promise<void>}
 */
export async function freezeAnimations(page) {
  await page.evaluate((time) => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = time;
    }
  }, FROZEN_TIME);
}

/**
 * A photograph of the scene: the renderer's canvas and nothing else.
 *
 * @param {Page} page
 * @param {object} [options]
 * @param {boolean} [options.freeze] Pin the animations again before shooting.
 *   On for anything a baseline will be held against.
 * @returns {Promise<Buffer>} PNG bytes.
 */
export async function photographScene(page, { freeze = false } = {}) {
  if (freeze) {
    await freezeAnimations(page);
    await nextFrames(page, 2);
  }
  const canvas = page.locator("canvas[data-engine]").first();
  // `animations: "disabled"` deliberately not used. It rewinds infinite
  // animations to their first frame for the capture and plays them again
  // afterwards — sound for photographing a page, and a race here, because
  // what is being photographed is not the page but a mirror of it that
  // samples on its own frames. Whether the rewind reached the scene before
  // the shutter decided which of two positions the slider was drawn at.
  return canvas.screenshot({ animations: "allow" });
}

/**
 * What this machine draws with. Baselines are only comparable against the
 * same answer: a different Chromium rasterizes differently, and a machine
 * with different fonts installed lays the panels' text out differently — both
 * of which are real differences in what was drawn, and neither of which is a
 * regression in the code under test.
 *
 * The font is fingerprinted by measuring the app's own stack rather than by
 * asking what is installed, which is not a thing a page can ask.
 *
 * @param {Page} page
 * @param {Browser} browser
 * @returns {Promise<{ chromium: string, font: string, viewport: string }>}
 */
export async function fingerprint(page, browser) {
  const font = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      return "no-2d-context";
    }
    const stack =
      getComputedStyle(document.body).fontFamily || "-apple-system, BlinkMacSystemFont, sans-serif";
    context.font = `16px ${stack}`;
    const specimen = "Interactions — hover and press transitions 0123456789";
    return `${Math.round(context.measureText(specimen).width * 100)}`;
  });
  return {
    chromium: browser.version(),
    font,
    viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
  };
}
