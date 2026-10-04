/**
 * Draws a construction in a session on the emulated headset (IWER standing
 * in for a Quest 3), with the real browser stack: vite-served euclid in
 * headless Chromium.
 *
 *   node tests/xr-check.mjs
 *   SHOTS=out node tests/xr-check.mjs   # and photograph the page and the session
 *   STACKS=1 node tests/xr-check.mjs    # with a stack for anything the page throws
 *   CHROMIUM=<path> node tests/xr-check.mjs  # with a Chromium found elsewhere
 *
 * The right controller is aimed at a point on a panel from the figures the
 * scene places the panels by (`src/placement.ts`), and the script checks
 * that the ray is on the element it was aimed at before it presses
 * anything. First, the page's own entry chunk, built for production, must
 * not carry three.js, and the page alone, with no emulator, must not fetch
 * the headset scene. Then, in a session, in order:
 *
 * - Point, in the toolbar panel, picks the point tool, and the trigger on
 *   empty paper writes a `point(…)` statement through the drawing's own
 *   pointer handlers, at the place the ray met;
 * - Line, then the trigger on `A` and on `B`, writes a `line(A, B)`;
 * - Select, then the trigger held on `B` while the ray moves, drags `B`
 *   and rewrites its coordinates; held on empty paper, it pans the view;
 * - the construction picker opens and loads another construction;
 * - the × ends the session.
 *
 * The script fails if any of them does not happen, or if the page throws
 * along the way. A manual check rather than part of `npm test`: it needs
 * a browser, and takes about a minute under SwiftShader.
 */
import { join, resolve, dirname } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(
  resolve(HERE, "../showcase-xr/node_modules/playwright-core/index.mjs")
);

const CHROMIUM = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const SHOTS = process.env.SHOTS;
if (SHOTS) {
  mkdirSync(SHOTS, { recursive: true });
}

/**
 * @param {import("playwright-core").Page} page
 * @param {number} count
 */
async function frames(page, count) {
  await page.evaluate(
    (n) =>
      new Promise((done) => {
        let left = n;
        const step = () => (--left <= 0 ? done(undefined) : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    count,
  );
}

/** @type {string[]} */
const failures = [];

/**
 * @param {boolean} ok
 * @param {string} what
 */
function check(ok, what) {
  console.log(`  ${ok ? "OK" : "FAIL"}: ${what}`);
  if (!ok) {
    failures.push(what);
  }
}

/**
 * Rotate a vector by a panel's Euler angles in the order `YXZ`: the pitch
 * about x first, then the yaw about y.
 *
 * @param {[number, number, number]} v
 * @param {number} pitch
 * @param {number} yaw
 * @returns {[number, number, number]}
 */
function rotate([x, y, z], pitch, yaw) {
  const y1 = y * Math.cos(pitch) - z * Math.sin(pitch);
  const z1 = y * Math.sin(pitch) + z * Math.cos(pitch);
  return [x * Math.cos(yaw) + z1 * Math.sin(yaw), y1, -x * Math.sin(yaw) + z1 * Math.cos(yaw)];
}

/**
 * Build the app for production into a scratch directory, and say which JS
 * the page loads before it offers anything: the entry chunk and every
 * chunk it imports statically, with whether any of them carries three.js.
 *
 * @returns {Promise<{ loaded: string[], three: string[] }>}
 */
async function entryChunks() {
  const outDir = mkdtempSync(join(tmpdir(), "euclid-"));
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
    /** @type {Map<string, import("rollup").OutputChunk>} */
    const chunks = new Map();
    for (const item of outputs) {
      if (item.type === "chunk") {
        chunks.set(item.fileName, item);
      }
    }
    const loaded = new Set();
    const visit = (/** @type {string} */ name) => {
      if (!loaded.has(name)) {
        loaded.add(name);
        (chunks.get(name)?.imports ?? []).forEach(visit);
      }
    };
    [...chunks.values()].filter((chunk) => chunk.isEntry).forEach((c) => visit(c.fileName));
    const three = [...loaded].filter((name) =>
      Object.keys(chunks.get(name)?.modules ?? {}).some((id) => id.includes("/three/build/")),
    );
    return { loaded: [...loaded], three };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log("\n== the page's chunks");
  {
    const { loaded, three } = await entryChunks();
    console.log(`  loaded: ${loaded.join(", ")}`);
    check(three.length === 0, "the page loads no chunk carrying three.js");
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

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    console.log("\n== the page alone");
    {
      // Headless Chromium has a `navigator.xr` that supports no session,
      // which is a laptop's browser: the page is all there is, and the
      // headset scene, with three.js under it, is never fetched.
      const plain = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      /** @type {string[]} */
      const fetched = [];
      plain.on("request", (request) => fetched.push(new URL(request.url()).pathname));
      await plain.goto(url, { waitUntil: "load" });
      await plain.waitForSelector("#canvas svg circle");
      await plain.waitForLoadState("networkidle");
      check(
        !fetched.some((path) => path.endsWith("/src/xr.ts")),
        "a browser that cannot present does not load the headset scene",
      );
      check(!(await plain.$("#ARButton, #VRButton")), "and shows no Enter button");
      await plain.close();
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.log("[pageerror]", process.env.STACKS ? error.stack : error.message);
    });
    await page.goto(`${url}?emulator=bare`, { waitUntil: "load" });
    await page.waitForSelector("#canvas svg circle");
    await page.waitForSelector("#ARButton, #VRButton");
    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, "page.png") });
    }
    await page.click("#ARButton, #VRButton");
    await page.waitForFunction(
      () =>
        ["toolbar", "editor", "canvas"].every((id) =>
          document.querySelector(`#${id}[data-xr-portal]`),
        ) && !document.querySelector("[data-xr-loading]"),
    );
    await frames(page, 30);

    // Where the head was as the session started, which is the origin of the
    // `local` space the scene is laid out in.
    const head = await page.evaluate(() => {
      const { x, y, z } = /** @type {any} */ (window).xrDevice.position;
      return [x, y, z];
    });

    /**
     * The right controller below the head, its ray through a point in the
     * scene.
     *
     * @param {[number, number, number]} target
     */
    const aimAt = async (target) => {
      const from = [head[0] + 0.05, head[1] - 0.2, head[2] - 0.05];
      const d = target.map((v, i) => v + head[i] - from[i]);
      const yaw = Math.atan2(-d[0], -d[2]);
      const pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
      await page.evaluate(
        ([p, y, f]) => {
          const c = /** @type {any} */ (window).xrDevice.controllers.right;
          c.position.x = f[0];
          c.position.y = f[1];
          c.position.z = f[2];
          const cy = Math.cos(y / 2);
          const sy = Math.sin(y / 2);
          const cx = Math.cos(p / 2);
          const sx = Math.sin(p / 2);
          c.quaternion.x = cy * sx;
          c.quaternion.y = sy * cx;
          c.quaternion.z = -sy * sx;
          c.quaternion.w = cy * cx;
        },
        [pitch, yaw, from],
      );
      await frames(page, 3);
    };

    /**
     * Where a point of the page, in client px, is in the scene, on the
     * panel mirroring the mount point with this id.
     *
     * @param {"toolbar" | "editor" | "canvas"} id
     * @param {number} clientX
     * @param {number} clientY
     * @returns {Promise<[number, number, number]>}
     */
    const onPanel = async (id, clientX, clientY) => {
      const rect = await page.evaluate(
        (q) => /** @type {Element} */ (document.querySelector(q)).getBoundingClientRect().toJSON(),
        `#${id}`,
      );
      const [at, scale] =
        id === "toolbar"
          ? [placement.TOOLBAR_AT, placement.toolbarScale(rect.width)]
          : id === "editor"
            ? [placement.EDITOR_AT, placement.EDITOR_SCALE]
            : [placement.BOARD_AT, placement.boardScale(rect.width, rect.height)];
      const metres = 0.01 * scale;
      const local = /** @type {[number, number, number]} */ ([
        (clientX - rect.left - rect.width / 2) * metres,
        -(clientY - rect.top - rect.height / 2) * metres,
        0,
      ]);
      const { pitch, yaw } = placement.facing(at);
      const [x, y, z] = rotate(local, pitch, yaw);
      return [at[0] + x, at[1] + y, at[2] + z];
    };

    /** @param {"trigger" | "squeeze"} button @param {number} value */
    const hold = async (button, value) => {
      await page.evaluate(
        ([b, v]) => /** @type {any} */ (window).xrDevice.controllers.right.updateButtonValue(b, v),
        /** @type {const} */ ([button, value]),
      );
      await frames(page, 4);
    };

    const press = async () => {
      await hold("trigger", 1);
      await hold("trigger", 0);
      await frames(page, 6);
    };

    /**
     * Press, by the ray, the toolbar's control whose text starts with this:
     * a button, the construction picker or one of its options.
     *
     * @param {string} label
     */
    const pressInToolbar = async (label) => {
      const handle = await page.evaluateHandle((text) => {
        const found = [
          ...document.querySelectorAll(
            "#toolbar button, #toolbar [role=combobox], #toolbar [role=option]",
          ),
        ].find((e) => e.textContent?.trim().startsWith(text));
        if (!found) throw new Error(`no ${text} in the toolbar`);
        return found;
      }, label);
      const box = await handle.evaluate((e) => e.getBoundingClientRect().toJSON());
      await aimAt(await onPanel("toolbar", box.left + box.width / 2, box.top + box.height / 2));
      check(
        await handle.evaluate((e) => e.hasAttribute("data-xr-hover")),
        `the ray is on ${label}`,
      );
      await press();
    };

    const code = () =>
      page.$eval("#editor textarea", (t) => /** @type {HTMLTextAreaElement} */ (t).value);

    /**
     * Where the point with this label is drawn on the page, in client px.
     *
     * @param {string} name
     */
    const pointOnPage = (name) =>
      page.evaluate((n) => {
        const label = [...document.querySelectorAll("#canvas svg text")].find(
          (t) => t.textContent === n,
        );
        const dot = label?.previousElementSibling;
        if (!dot) throw new Error(`no point ${n}`);
        const r = dot.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, name);

    const canvasRect = await page.evaluate(() =>
      /** @type {Element} */ (document.querySelector("#canvas")).getBoundingClientRect().toJSON(),
    );

    console.log("\n== a point");
    await pressInToolbar("Point");
    check(
      await page.$eval("#toolbar", (t) =>
        [...t.querySelectorAll("button")].some(
          (b) => b.textContent === "Point" && b.getAttribute("data-active") === "true",
        ),
      ),
      "the point tool is picked",
    );
    {
      // Empty paper: a quarter of the way in from the drawing's lower left.
      const x = canvasRect.left + canvasRect.width * 0.2;
      const y = canvasRect.top + canvasRect.height * 0.85;
      await aimAt(await onPanel("canvas", x, y));
      check(
        await page.$eval("#canvas svg", (svg) => svg.hasAttribute("data-xr-hover")),
        "the ray is on the drawing",
      );
      const before = await code();
      await press();
      const after = await code();
      const added = after.slice(before.length);
      console.log(`  wrote: ${JSON.stringify(added.trim())}`);
      check(/^D=point\(/.test(added.trim()), "the trigger wrote a point statement");
      if (/^D=point\(/.test(added.trim())) {
        const drawn = await pointOnPage("D");
        check(
          Math.hypot(drawn.x - x, drawn.y - y) < 12,
          "at the place on the page the ray was aimed at",
        );
      }
    }

    console.log("\n== a line");
    await pressInToolbar("Line");
    {
      const before = await code();
      for (const name of ["A", "B"]) {
        const at = await pointOnPage(name);
        await aimAt(await onPanel("canvas", at.x, at.y));
        await press();
      }
      const added = (await code()).slice(before.length).trim();
      console.log(`  wrote: ${JSON.stringify(added)}`);
      check(/=line\(A, B\);$/.test(added), "two presses on A and B wrote a line through them");
    }

    console.log("\n== dragging");
    await pressInToolbar("Select");
    {
      const from = await pointOnPage("B");
      await aimAt(await onPanel("canvas", from.x, from.y));
      await hold("trigger", 1);
      for (let step = 1; step <= 6; step += 1) {
        await aimAt(await onPanel("canvas", from.x + step * 6, from.y - step * 6));
      }
      await hold("trigger", 0);
      await frames(page, 6);
      const moved = /B=point\(([^)]*)\)/.exec(await code())?.[1];
      console.log(`  B is now at (${moved})`);
      check(moved !== undefined && moved !== "4, 0", "holding the trigger on B dragged it");
    }
    {
      const before = await pointOnPage("A");
      const x = canvasRect.left + canvasRect.width * 0.15;
      const y = canvasRect.top + canvasRect.height * 0.15;
      await aimAt(await onPanel("canvas", x, y));
      await hold("trigger", 1);
      for (let step = 1; step <= 6; step += 1) {
        await aimAt(await onPanel("canvas", x + step * 8, y));
      }
      await hold("trigger", 0);
      await frames(page, 6);
      const after = await pointOnPage("A");
      console.log(`  A moved by ${Math.round(after.x - before.x)} px across the page`);
      check(after.x - before.x > 20, "holding it on empty paper panned the view");
    }

    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, "drawn.png") });
    }

    console.log("\n== the constructions");
    await pressInToolbar("Equilateral");
    await frames(page, 10);
    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, "picker.png") });
    }
    await pressInToolbar("Regular hexagon");
    await frames(page, 10);
    check(
      (await code()).includes("IV.15") || (await code()).includes("hexagon"),
      "the picker loaded the hexagon",
    );

    console.log("\n== leaving");
    await pressInToolbar("×");
    await frames(page, 20);
    check(
      !(await page.evaluate(() => document.querySelector("[data-xr-portal]"))),
      "the × ended the session and took the panels down",
    );
    check(errors.length === 0, `the page threw nothing (${errors.length} errors)`);
  } finally {
    await browser.close();
    await server.close();
  }
  if (failures.length > 0) {
    console.log(`\n${failures.length} failed`);
    process.exit(1);
  }
  console.log("\nall passed");
}

await main();
