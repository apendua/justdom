/**
 * Audits each look's session for marks a box behind them can paint over.
 * In every panel it pairs each element that holds marks (text, a field's
 * value or caret, a list marker, an <svg>'s shapes) with each box that
 * paints, and reports a pair where the box's quad is behind the marks, the
 * two overlap on the page, and the box draws later. The marks write no
 * depth, so such a box paints over them.
 *
 *   node tests/draw-order-audit.mjs
 *
 * It reads freedom's own `getLift`, `getDrawLevel` and
 * `getContentRenderOrder` from the page's module instance, so it checks the
 * model the scene is built from, not pixels. It counts a box as painting by
 * its computed background and border, and leaves out what an `overflow`
 * clips, so a pair it reports may be hidden in the scene; it has to be
 * looked at. A box is taken to draw half a level after its draw level, as
 * the box batch draws it.
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launch, frames, closeAll } from "@apendua.dev/headset/driver";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const server = await createServer({
  root: HERE,
  configFile: join(HERE, "vite.config.mts"),
  logLevel: "warn",
  server: { port: 0, strictPort: false },
});
await server.listen();
const url = server.resolvedUrls?.local?.[0];
const looks = /** @type {any} */ (await server.ssrLoadModule("/src/looks.ts"));
const browser = await launch();
try {
  for (const look of looks.LOOKS) {
    const zones = look.placements.map((p) => p.id);
    const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
    await page.goto(`${url}?look=${look.id}&emulator=bare`, { waitUntil: "load" });
    await page.waitForSelector("#ARButton, #VRButton");
    await page.click("#ARButton, #VRButton");
    await page.waitForFunction(
      (ids) =>
        ids.every((z) => document.getElementById(z)?.hasAttribute("data-xr-portal")) &&
        !document.querySelector("[data-xr-loading]"),
      zones,
      { timeout: 240_000, polling: 1000 },
    );
    await frames(page, 30);
    const result = await page.evaluate(async () => {
      const entry = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .find((n) => /freedom\/src\/elements\/elevation\.js/.test(n));
      if (!entry) throw new Error("elevation.js not loaded");
      const m = await import(entry);
      const name = (/** @type {Element} */ e) =>
        e.tagName.toLowerCase() +
        (e.id ? `#${e.id}` : "") +
        (e.classList.length ? "." + [...e.classList].join(".") : "");
      const path = (/** @type {Element} */ e, /** @type {Element} */ root) => {
        const parts = [];
        for (let x = e; x && x !== root; x = /** @type {Element} */ (x.parentElement)) {
          parts.unshift(name(x));
        }
        return `${root.id} > ${parts.slice(-3).join(" > ")}`;
      };
      const overlaps = (a, b) =>
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      /** @type {string[]} */
      const found = [];
      let pairs = 0;
      let markHolders = 0;
      let painters = 0;
      for (const root of document.querySelectorAll("[data-xr-portal]")) {
        /** @type {Map<Element, number>} */
        const z = new Map();
        const zOf = (/** @type {Element} */ e) => {
          if (e === root) return 0;
          let v = z.get(e);
          if (v === undefined) {
            v = zOf(/** @type {Element} */ (e.parentElement)) + m.getLift(e);
            z.set(e, v);
          }
          return v;
        };
        /** @type {{ el: Element, rects: DOMRect[], order: number, z: number, kind: string }[]} */
        const marks = [];
        /** @type {{ el: Element, rect: DOMRect, order: number, z: number }[]} */
        const boxes = [];
        const walk = (/** @type {Element} */ e) => {
          if (e instanceof SVGElement && e.tagName.toLowerCase() !== "svg") return;
          const style = getComputedStyle(e);
          if (style.display === "none" || style.visibility === "hidden") return;
          const html = /** @type {HTMLElement} */ (e);
          const band = m.getElevation(html) * m.ELEVATION_BAND;
          const content = m.getContentRenderOrder(html);
          // Marks that belong to this element.
          /** @type {DOMRect[]} */
          const rects = [];
          let kind = "";
          for (const node of e.childNodes) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
              const range = document.createRange();
              range.selectNodeContents(node);
              rects.push(...range.getClientRects());
              kind = "text";
            }
          }
          const tag = e.tagName.toLowerCase();
          if (tag === "input" || tag === "textarea") {
            rects.push(e.getBoundingClientRect());
            kind = "field";
          }
          if (style.display === "list-item" && style.listStyleType !== "none") {
            rects.push(e.getBoundingClientRect());
            kind = "marker";
          }
          if (tag === "svg") {
            rects.push(e.getBoundingClientRect());
            kind = "svg";
          }
          if (rects.length) {
            marks.push({ el: e, rects, order: content, z: zOf(e), kind });
          }
          // The box's own quad, if it paints anything.
          const paints =
            style.backgroundImage !== "none" ||
            !/rgba\(.*, 0\)|transparent/.test(style.backgroundColor) ||
            (parseFloat(style.borderTopWidth) > 0 && !/rgba\(.*, 0\)/.test(style.borderTopColor));
          if (paints && e !== root && tag !== "svg") {
            boxes.push({
              el: e,
              rect: e.getBoundingClientRect(),
              order: band + m.getDrawLevel(html) + 0.5,
              z: zOf(e) - 1,
            });
          }
          if (tag === "svg") return;
          for (const child of e.children) walk(child);
        };
        walk(root);
        markHolders += marks.length;
        painters += boxes.length;
        for (const mark of marks) {
          for (const box of boxes) {
            if (!(box.z < mark.z)) continue;
            if (!mark.rects.some((r) => r.width > 0 && r.height > 0 && overlaps(r, box.rect)))
              continue;
            pairs += 1;
            if (box.order > mark.order) {
              found.push(
                `${mark.kind} ${path(mark.el, root)} (order ${mark.order}, z ${mark.z}) ` +
                  `under box ${path(box.el, root)} (order ${box.order}, z ${box.z})`,
              );
            }
          }
        }
      }
      return { pairs, markHolders, painters, found };
    });
    console.log(
      `== ${look.name}: ${result.markHolders} mark holders, ${result.painters} painting boxes, ` +
        `${result.pairs} overlapping box-behind-mark pairs, ${result.found.length} drawn in the wrong order`,
    );
    for (const line of result.found) console.log("  " + line);
    await page.close();
  }
} finally {
  await closeAll(browser, server);
}
