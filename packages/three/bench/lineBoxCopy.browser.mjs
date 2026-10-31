/**
 * What measuring the text in a transformed paragraph costs in Chromium, with
 * real layout, as a function of how many pieces of text the paragraph holds.
 *
 *   node bench/lineBoxCopy.browser.mjs
 *
 * The paragraphs are those of `bench/lineBoxCopy.bench.mjs`, which counts the
 * copying work exactly under jsdom. jsdom lays nothing out, though, and in a
 * browser each copy put in the document is laid out before it can be
 * measured. This loads `src/elements/mirror.js` as it is, unbundled, into a
 * page served from the repository, and times the measurement there. The
 * numbers are milliseconds on whatever machine runs it: the median of
 * `REPEATS` runs, each on a fresh card and a fresh mirror, including letting
 * go of the layouts, which removes the copy they were measured in.
 *
 * The last table mounts the paragraph in a portal instead, as an app
 * mounts a panel, and times it until the portal stops loading. With
 * `requestAnimationFrame` there, the portal builds and measures a frame
 * budget's worth at a time, so the texts of one paragraph are measured
 * across frames: it counts the copies made and the frames taken.
 * `PORTAL_SIZES=10,50` picks its sizes, and `PORTAL_ONLY=1` runs it alone.
 *
 * Chromium is launched through `packages/xr/driver`, which borrows
 * Playwright from `apps/showcase-xr` and finds the browser at
 * `/opt/pw-browsers/chromium-1194`, or at the path `CHROMIUM` names. Both
 * projects have to have been installed.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { closeAll, launch } from "../../xr/driver/index.mjs";

const SIZES = [10, 50, 100, 200, 400];
const REPEATS = 7;
// A mount spread across frames takes seconds rather than milliseconds, so
// the portal table runs fewer sizes, fewer times.
const PORTAL_SIZES = (process.env.PORTAL_SIZES ?? "10,50,100,200").split(",").map(Number);
const PORTAL_REPEATS = 3;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const PAGE = `<!doctype html>
<meta charset="utf-8">
<script type="importmap">
  {
    "imports": {
      "justdom-signal": "/packages/signal/src/index.js",
      "three": "/packages/three/node_modules/three/build/three.module.js",
      "three/addons/": "/packages/three/node_modules/three/examples/jsm/"
    }
  }
</script>
<style>
  body { margin: 0; font: 16px/1.25 monospace; }
  .card { width: 300px; padding: 12px; transform: rotate(-4deg); }
</style>
<script type="module">
  import { Effect } from "justdom-signal";
  import { createMirror, getTextLayout } from "/packages/three/src/elements/mirror.js";

  function buildCard(sentences) {
    const card = document.createElement("div");
    card.className = "card";
    const paragraph = document.createElement("p");
    const texts = [];
    for (let i = 0; i < sentences; i++) {
      const bold = document.createElement("b");
      const word = document.createTextNode("word" + i);
      bold.appendChild(word);
      const rest = document.createTextNode(" and the rest of sentence " + i + ". ");
      paragraph.append(bold, rest);
      texts.push(word, rest);
    }
    card.appendChild(paragraph);
    return { card, paragraph, texts };
  }

  function makeCard(sentences) {
    const { card, paragraph, texts } = buildCard(sentences);
    document.body.appendChild(card);
    const mirror = createMirror();
    for (const node of [card, paragraph, ...paragraph.querySelectorAll("b")]) {
      mirror.adopt(node);
    }
    for (const text of texts) {
      mirror.adopt(text);
    }
    return { card, texts };
  }

  window.runBench = (sentences, which) => {
    const { card, texts } = makeCard(sentences);
    // Lay the live card out first: that is the page's cost, not the mirror's.
    card.getBoundingClientRect();
    const started = performance.now();
    let lines = 0;
    // Held by effects, as the mirror holds a layout, and let go of at the
    // end, which is what removes the copy they shared.
    const readers = (which === "all" ? texts : texts.slice(0, 1)).map(
      (text) => new Effect(() => (lines += getTextLayout(text).lines.length)),
    );
    readers.forEach((reader) => reader.dispose());
    const ms = performance.now() - started;
    card.remove();
    return { ms, lines };
  };
  // The same paragraph mounted in a portal, as an app mounts a panel. With
  // \`requestAnimationFrame\` there, the portal builds the panel a node at a
  // time and measures it a frame budget at a time, so the texts of one
  // paragraph are measured across frames, a pass or more each.
  window.runPortalBench = async (sentences) => {
    const { createPortal } = await import("/packages/three/src/elements/portal.js");
    const { InteractionContext, InteractionManager } = await import(
      "/packages/three/src/interactions.js"
    );
    const THREE = await import("three");
    let copies = 0;
    const appendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function (child) {
      if (this === document.body && child.style?.left === "-99999px") {
        copies += 1;
      }
      return appendChild.call(this, child);
    };
    let frames = 0;
    let counting = true;
    const countFrames = () => {
      frames += 1;
      if (counting) {
        requestAnimationFrame(countFrames);
      }
    };
    const ctx = InteractionContext.set({}, new InteractionManager());
    let resolveLoaded;
    const loaded = new Promise((resolve) => (resolveLoaded = resolve));
    const portal = createPortal(ctx, {
      onLoadingChanged: (loading) => {
        if (!loading) {
          resolveLoaded();
        }
      },
    });
    portal.addTo(new THREE.Group());
    const containers = document.querySelectorAll("[data-xr-portal]");
    const container = containers[containers.length - 1];
    container.appendChild(buildCard(sentences).card);
    requestAnimationFrame(countFrames);
    const started = performance.now();
    await loaded;
    const ms = performance.now() - started;
    counting = false;
    Node.prototype.appendChild = appendChild;
    portal.disconnect();
    container.remove();
    return { ms, copies, frames };
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

const browser = await launch();
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => /** @type {any} */ (window).benchReady === true);

  for (const which of process.env.PORTAL_ONLY ? [] : /** @type {const} */ (["all", "one"])) {
    console.log(
      `\n=== ${which === "all" ? "every text in the paragraph" : "the first text alone"} ===`,
    );
    console.log("sentences\ttexts\tlines\tms (median)\tms per text");
    for (const sentences of SIZES) {
      /** @type {number[]} */
      const times = [];
      let lines = 0;
      // The first run warms the JIT and is dropped.
      for (let repeat = 0; repeat <= REPEATS; repeat++) {
        const result = await page.evaluate(
          ([n, w]) => /** @type {any} */ (window).runBench(n, w),
          /** @type {const} */ ([sentences, which]),
        );
        if (repeat > 0) {
          times.push(result.ms);
        }
        lines = result.lines;
      }
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)];
      const texts = which === "all" ? 2 * sentences : 1;
      console.log(
        [sentences, texts, lines, median.toFixed(2), (median / texts).toFixed(3)].join("\t"),
      );
    }
  }

  console.log("\n=== the paragraph mounted in a portal, measured across frames ===");
  console.log("sentences\ttexts\tcopies\tframes\tms (median)");
  for (const sentences of PORTAL_SIZES) {
    /** @type {number[]} */
    const times = [];
    let last = { copies: 0, frames: 0 };
    for (let repeat = 0; repeat <= PORTAL_REPEATS; repeat++) {
      const result = await page.evaluate(
        (n) => /** @type {any} */ (window).runPortalBench(n),
        sentences,
      );
      if (repeat > 0) {
        times.push(result.ms);
      }
      last = result;
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log([sentences, 2 * sentences, last.copies, last.frames, median.toFixed(1)].join("\t"));
  }
} finally {
  await closeAll(browser);
  server.close();
}
