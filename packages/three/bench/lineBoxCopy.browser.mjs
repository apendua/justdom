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
 * `REPEATS` runs, each on a fresh card and a fresh mirror, including what the
 * measurement leaves for the end of the task.
 *
 * Chromium is launched through `packages/headset/driver`, which borrows
 * Playwright from `apps/showcase-xr` and finds the browser at
 * `/opt/pw-browsers/chromium-1194`, or at the path `CHROMIUM` names. Both
 * projects have to have been installed.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { closeAll, launch } from "../../headset/driver/index.mjs";

const SIZES = [10, 50, 100, 200, 400];
const REPEATS = 7;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const PAGE = `<!doctype html>
<meta charset="utf-8">
<script type="importmap">
  {
    "imports": {
      "@apendua/signal": "/packages/signal/src/index.js",
      "three": "/packages/freedom/node_modules/three/build/three.module.js"
    }
  }
</script>
<style>
  body { margin: 0; font: 16px/1.25 monospace; }
  .card { width: 300px; padding: 12px; transform: rotate(-4deg); }
</style>
<script type="module">
  import { createMirror, getTextLayout } from "/packages/freedom/src/elements/mirror.js";

  function makeCard(sentences) {
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

  window.runBench = async (sentences, which) => {
    const { card, texts } = makeCard(sentences);
    // Lay the live card out first: that is the page's cost, not the mirror's.
    card.getBoundingClientRect();
    const started = performance.now();
    let lines = 0;
    for (const text of which === "all" ? texts : texts.slice(0, 1)) {
      lines += getTextLayout(text).lines.length;
    }
    await new Promise((done) => setTimeout(done, 0));
    const ms = performance.now() - started;
    card.remove();
    return { ms, lines };
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

  for (const which of /** @type {const} */ (["all", "one"])) {
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
} finally {
  await closeAll(browser);
  server.close();
}
