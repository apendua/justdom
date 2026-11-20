/**
 * What a panel's text steps cost while the head moves: the desk in a session
 * on the emulated headset, its own timers stopped, and the head moved along
 * two paths.
 *
 *   node bench/textSteps.browser.mjs
 *   LOOK=ops node bench/textSteps.browser.mjs   # another of the desk's looks
 *
 * - **Still**: the head at rest, for what the page costs on its own.
 * - **Sway**: the head goes round a circle of 15 cm every six seconds,
 *   forwards and sideways, as it does when somebody leans from panel to
 *   panel, six times.
 * - **Walk**: 75 cm towards the monitor in three seconds, and back in three.
 *
 * The head is moved by the clock, since the rules that decide when a panel
 * changes step count time (`RELEASE_MS`, `SHARPEN_WAIT_MS`).
 *
 * For each it prints how many runs were rasterized (2D canvases made), how
 * many array textures were allocated (`texStorage3D`) and how many bytes
 * went into them (`texSubImage3D`), and how long the session's frame
 * callback took: the median, the 95th percentile, the worst, and how many
 * frames took more than half again the median.
 *
 * The field of view is narrowed until the canvas has the pixels per unit of
 * a Quest 3 eye buffer, so the steps change where they would on a headset
 * (`docs/freedom-text-step-cache.md`, section 3.1).
 * WebGL is SwiftShader here, so the uploads are CPU time in another process
 * and show up only as bytes.
 */
import { observeThree } from "../../xr/driver/index.mjs";
import { APPS } from "./emulatorApps.mjs";

/**
 * The page's viewport. Small, so that SwiftShader draws enough frames a
 * second for a head moved by the clock to move smoothly.
 */
const VIEWPORT = { width: 320, height: 200 };

/**
 * The vertical field of view at which a canvas as tall as the viewport has
 * the pixels per unit of a Quest 3 eye buffer, 1760 px tall at 90 degrees.
 */
const FOVY = 2 * Math.atan(VIEWPORT.height / 1760);

const LOOK = process.env.LOOK ?? "beige";

/**
 * Wrap the natives the measurement counts, before the page loads, and stop
 * the desk's own timers once `window.textSteps.frozen` is set.
 */
function instrument() {
  const stats = { rasters: 0, arrays: 0, bytes: 0, frozen: false };
  /** @type {any} */ (window).textSteps = stats;

  const getContext = HTMLCanvasElement.prototype.getContext;
  /** @type {WeakSet<HTMLCanvasElement>} */
  const seen = new WeakSet();
  HTMLCanvasElement.prototype.getContext = /** @type {any} */ (
    /** @this {HTMLCanvasElement} */
    function (/** @type {any[]} */ ...args) {
      if (args[0] === "2d" && !seen.has(this)) {
        seen.add(this);
        stats.rasters += 1;
      }
      return getContext.apply(this, /** @type {any} */ (args));
    }
  );

  const gl = WebGL2RenderingContext.prototype;
  const texStorage3D = gl.texStorage3D;
  gl.texStorage3D = function (...args) {
    stats.arrays += 1;
    return texStorage3D.apply(this, args);
  };
  const texSubImage3D = gl.texSubImage3D;
  gl.texSubImage3D = /** @type {any} */ (
    /** @this {WebGL2RenderingContext} */
    function (/** @type {any[]} */ ...args) {
      stats.bytes += args[5] * args[6] * args[7] * 4;
      return texSubImage3D.apply(this, /** @type {any} */ (args));
    }
  );

  // The desk's clock, charts and terminal invalidate their panels on timers
  // of their own, which would hide what the head's movement costs.
  const setInterval = window.setInterval;
  window.setInterval = /** @type {any} */ (
    (/** @type {Function} */ callback, /** @type {any[]} */ ...rest) =>
      setInterval(
        (/** @type {any[]} */ ...args) => {
          if (!stats.frozen) {
            callback(...args);
          }
        },
        ...rest,
      )
  );
}

/**
 * Move the head along a path for `duration` milliseconds, by the clock and
 * not by the frame, and time each frame.
 *
 * @param {import("playwright-core").Page} page
 * @param {"still" | "sway" | "walk"} path
 * @param {number} duration
 * @param {[number, number, number]} head Where the head rests.
 */
function run(page, path, duration, head) {
  return page.evaluate(
    ([name, length, [x, y, z]]) =>
      new Promise((done) => {
        const w = /** @type {any} */ (window);
        /** @type {Record<string, (t: number) => [number, number, number]>} */
        const paths = {
          still: () => [x, y, z],
          // A circle of 15 cm every six seconds, about a point 15 cm nearer
          // the monitor, so that it starts and ends where the head rests.
          sway(t) {
            const angle = (t / 6000) * 2 * Math.PI;
            return [x + 0.15 * Math.sin(angle), y, z - 0.15 + 0.15 * Math.cos(angle)];
          },
          // 75 cm in over the first half and back out over the second.
          walk(t) {
            const there = 1 - Math.abs((2 * t) / length - 1);
            return [x, y, z - 0.75 * there];
          },
        };
        const stats = w.textSteps;
        const before = { ...stats };
        const session = w.threeRenderers[0].xr.getSession();
        const request = session.requestAnimationFrame.bind(session);
        /** @type {number[]} */
        const times = [];
        const began = performance.now();
        let finished = false;
        session.requestAnimationFrame = (/** @type {XRFrameRequestCallback} */ callback) =>
          request((/** @type {number} */ time, /** @type {XRFrame} */ frame) => {
            if (finished) {
              callback(time, frame);
              return;
            }
            const elapsed = performance.now() - began;
            w.xrDevice.position.set(...paths[name](Math.min(elapsed, length)));
            const start = performance.now();
            callback(time, frame);
            times.push(performance.now() - start);
            // Half a second more at the path's end, for what it left queued.
            // The frame asked for before the wrapper comes off still comes
            // through it, and by then the next path's may be on.
            if (elapsed >= length + 500) {
              finished = true;
              session.requestAnimationFrame = request;
              done({
                times,
                rasters: stats.rasters - before.rasters,
                arrays: stats.arrays - before.arrays,
                bytes: stats.bytes - before.bytes,
              });
            }
          });
      }),
    /** @type {const} */ ([path, duration, head]),
  );
}

/**
 * @param {number[]} values
 * @param {number} share
 */
function percentile(values, share) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
}

/** @type {string[]} */
const rows = [];

await APPS.desk(
  async (page) => {
    const head = await page.evaluate((fovy) => {
      const w = /** @type {any} */ (window);
      w.xrDevice.fovy = fovy;
      w.textSteps.frozen = true;
      const { x, y, z } = w.xrDevice.position;
      return /** @type {[number, number, number]} */ ([x, y, z]);
    }, FOVY);
    // Let the narrowed view's first steps land before anything is counted,
    // and what each path left held go before the next.
    await run(page, "still", 8000, head);

    for (const [name, path, duration] of /** @type {const} */ ([
      ["Still", "still", 10_000],
      ["Sway", "sway", 36_000],
      ["Walk", "walk", 6000],
    ])) {
      const result = /** @type {any} */ (await run(page, path, duration, head));
      const median = percentile(result.times, 0.5);
      const slow = result.times.filter((/** @type {number} */ time) => time > 1.5 * median).length;
      rows.push(
        `| ${name} | ${duration / 1000} s | ${result.times.length} | ${result.rasters} | ` +
          `${result.arrays} | ${(result.bytes / 1e6).toFixed(1)} MB | ${median.toFixed(1)} ms | ` +
          `${percentile(result.times, 0.95).toFixed(1)} ms | ` +
          `${Math.max(...result.times).toFixed(1)} ms | ${slow} |`,
      );
      await run(page, "still", 8000, head);
    }
  },
  {
    look: LOOK,
    setUp: async (page) => {
      await page.setViewportSize(VIEWPORT);
      await observeThree(page);
      await page.addInitScript(instrument);
    },
  },
);

console.log(`Desk, ${LOOK}`);
console.log("");
console.log(
  "| Path | Time | Frames | Runs rasterized | Arrays | Uploaded | Median | 95th | Worst | Slow |",
);
console.log(
  "| ---- | ---- | ------ | --------------- | ------ | -------- | ------ | ---- | ----- | ---- |",
);
for (const row of rows) {
  console.log(row);
}
