/**
 * What taking a panel down costs in Chromium, against what building it
 * cost, as a function of how many rows the panel holds.
 *
 *   node bench/dispose.browser.mjs
 *
 * A panel is mounted the way an app mounts one, a frame budget at a time
 * under `requestAnimationFrame`, and left to load. Then `disconnect` is
 * called, as `dom()` calls it when a panel goes. The table reports the
 * longest frame the mount took, how long `disconnect` itself took, the
 * longest frame after it until the panel had nothing left to take down, how
 * many frames passed before its objects left the scene, and how many until
 * that was over. Milliseconds on whatever machine runs it, the
 * median of `REPEATS` runs. The portals share one scheduler, as they do
 * under `render()`, which is what spreads the teardown over frames.
 *
 * The second table empties the panel's list instead and leaves the panel
 * open: the same columns, with "sync ms" the removal itself, "leave frames"
 * the frames the rows were still drawn for, until the panel's commit, and
 * the rest counted until the rows that left are taken down.
 *
 * Chromium is launched through `packages/headset/driver`, as
 * `bench/lineBoxCopy.browser.mjs` explains.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { closeAll, launch } from "../../headset/driver/index.mjs";

const SIZES = (process.env.SIZES ?? "25,50,100,200,400").split(",").map(Number);
const REPEATS = 5;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const PAGE = `<!doctype html>
<meta charset="utf-8">
<script type="importmap">
  {
    "imports": {
      "@apendua/signal": "/packages/signal/src/index.js",
      "three": "/packages/freedom/node_modules/three/build/three.module.js",
      "three/addons/": "/packages/freedom/node_modules/three/examples/jsm/"
    }
  }
</script>
<style>
  body { margin: 0; font: 16px/1.25 sans-serif; }
  .row { display: flex; gap: 8px; padding: 4px 8px; border-bottom: 1px solid #ccc; }
  .row button { border-radius: 4px; background: #eef; cursor: pointer; }
</style>
<script type="module">
  import * as THREE from "three";
  import { createPortal } from "/packages/freedom/src/elements/portal.js";
  import { InteractionContext, InteractionManager } from "/packages/freedom/src/interactions.js";
  import {
    createPortalScheduler,
    PortalSchedulerContext,
  } from "/packages/freedom/src/elements/portalScheduler.js";
  import { createFrameRequester } from "/packages/freedom/src/elements/frameRequester.js";

  // One scheduler for every portal on the page, as \`render()\` installs one
  // for every portal in a scene: what paces the mounts, and what takes a
  // closed panel's objects down.
  // Counting the ray targets every panel registers tells when a closed
  // panel's teardown is over: the last thing each control's teardown does
  // is leave the raycast set.
  const manager = new InteractionManager();
  let targets = 0;
  const add = manager.add.bind(manager);
  const remove = manager.remove.bind(manager);
  manager.add = (object) => {
    targets += 1;
    add(object);
  };
  manager.remove = (object) => {
    targets -= 1;
    remove(object);
  };
  const sceneCtx = InteractionContext.set({}, manager);
  const scene = PortalSchedulerContext.set(
    sceneCtx,
    createPortalScheduler({ requestFrames: createFrameRequester(sceneCtx) }),
  );

  function buildList(rows) {
    const list = document.createElement("div");
    list.style.width = "400px";
    for (let i = 0; i < rows; i++) {
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("span");
      label.textContent = "row " + i;
      const button = document.createElement("button");
      button.textContent = "remove";
      row.append(label, button);
      list.appendChild(row);
    }
    return list;
  }

  const nextFrame = () => new Promise((done) => requestAnimationFrame(done));

  window.runBench = async (rows, mode) => {
    const ctx = scene;
    let resolveLoaded;
    const loaded = new Promise((done) => (resolveLoaded = done));
    const portal = createPortal(ctx, {
      loadingFrame: false,
      onLoadingChanged: (loading) => {
        if (!loading) {
          resolveLoaded();
        }
      },
    });
    const sceneRoot = new THREE.Group();
    portal.addTo(sceneRoot);
    const objectCount = () => {
      let count = 0;
      sceneRoot.traverse(() => {
        count += 1;
      });
      return count;
    };
    const containers = document.querySelectorAll("[data-xr-portal]");
    const container = containers[containers.length - 1];
    // Every frame's length, from one animation frame to the next.
    const frames = [];
    let counting = true;
    let last = performance.now();
    const count = (time) => {
      frames.push(time - last);
      last = time;
      if (counting) {
        requestAnimationFrame(count);
      }
    };
    requestAnimationFrame((time) => {
      last = time;
      requestAnimationFrame(count);
    });
    await nextFrame();
    const mountStarted = performance.now();
    const list = buildList(rows);
    container.appendChild(list);
    await loaded;
    const mountMs = performance.now() - mountStarted;
    const mountWorst = Math.max(...frames);
    // Let the panel settle before taking it down.
    for (let i = 0; i < 5; i++) {
      await nextFrame();
    }
    const drawn = objectCount();
    frames.length = 0;
    const started = performance.now();
    // Either the panel closes, or every row leaves a panel that stays open,
    // whose blocker is then the one ray target left.
    const left = mode === "close" ? 0 : 1;
    if (mode === "close") {
      portal.disconnect();
    } else {
      list.replaceChildren();
    }
    const syncMs = performance.now() - started;
    // Until the teardown spread across frames is over, and a few more.
    // The frame the objects left the scene in, which for a panel that stays
    // open is its commit: until then the rows are still drawn. Null while
    // they are, and a run that ends with them drawn is refused, as one that
    // leaves ray targets behind is.
    let leaveFrames = objectCount() < drawn ? 0 : null;
    let teardownFrames = 0;
    while (targets > left && teardownFrames < 600) {
      await nextFrame();
      teardownFrames += 1;
      if (leaveFrames === null && objectCount() < drawn) {
        leaveFrames = teardownFrames;
      }
    }
    for (let i = 0; i < 5; i++) {
      await nextFrame();
    }
    counting = false;
    const disposeWorst = Math.max(...frames);
    // What the teardown left behind, counted before an emptied panel is
    // closed in turn, which takes its own frames and is not measured.
    let stuck = targets - left;
    if (mode === "empty") {
      portal.disconnect();
      for (let frame = 0; targets > 0 && frame < 600; frame++) {
        await nextFrame();
      }
      stuck += targets;
    }
    return { mountMs, mountWorst, syncMs, disposeWorst, leaveFrames, teardownFrames, left: stuck };
  };
  window.benchReady = true;
</script>`;

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript" };

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE);
    return;
  }
  const file = resolve(REPO, `.${path}`);
  if (!file.startsWith(REPO + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": TYPES[/** @type {keyof TYPES} */ (extname(file))] ?? "text/plain",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;

/**
 * @param {number[]} values
 * @returns {number}
 */
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const browser = await launch();
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => /** @type {any} */ (window).benchReady === true);
  for (const mode of /** @type {const} */ (["close", "empty"])) {
    console.log(
      mode === "close"
        ? "\n=== the panel closes ==="
        : "\n=== every row leaves a panel that stays open ===",
    );
    console.log(
      "rows\tmount ms\tworst mount frame\tsync ms\tworst frame after\tleave frames\tteardown frames",
    );
    for (const rows of SIZES) {
      /** @type {{ mountMs: number, mountWorst: number, syncMs: number, disposeWorst: number, leaveFrames: number, teardownFrames: number, left: number }[]} */
      const results = [];
      // The first run warms the JIT and is dropped.
      for (let repeat = 0; repeat <= REPEATS; repeat++) {
        const result = await page.evaluate(
          ([n, m]) => /** @type {any} */ (window).runBench(n, m),
          /** @type {const} */ ([rows, mode]),
        );
        if (result.left !== 0) {
          throw new Error(`${result.left} ray targets were never taken down`);
        }
        if (result.leaveFrames === null) {
          throw new Error("the objects were never taken out of the scene");
        }
        if (repeat > 0) {
          results.push(result);
        }
      }
      console.log(
        [
          rows,
          median(results.map((r) => r.mountMs)).toFixed(0),
          median(results.map((r) => r.mountWorst)).toFixed(1),
          median(results.map((r) => r.syncMs)).toFixed(1),
          median(results.map((r) => r.disposeWorst)).toFixed(1),
          median(results.map((r) => r.leaveFrames)),
          median(results.map((r) => r.teardownFrames)),
        ].join("\t\t"),
      );
    }
  }
} finally {
  await closeAll(browser);
  server.close();
}
