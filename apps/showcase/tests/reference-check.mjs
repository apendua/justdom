/**
 * Photographs every panel of the deck twice in a session on the emulated
 * headset, once mirrored by justdom-three and once drawn by the browser with
 * HTML-in-Canvas (`?panels=texture`), and puts the two side by side, so that
 * what the mirror draws differently from the page shows up panel by panel.
 *
 *   node tests/reference-check.mjs                 # every panel
 *   node tests/reference-check.mjs svg-paint text  # these panels
 *   OUT=<dir> node tests/reference-check.mjs       # somewhere else
 *
 * For each panel it writes `<id>.png` into `OUT` (by default
 * `tests/output/reference`): the mirror on the left, the browser's drawing
 * in the middle, and on the right where the two disagree, in magenta over a
 * dim copy of the browser's. Then it prints a table of the panels, the most
 * different first.
 *
 * Text never matches to the pixel: the mirror rasterizes glyphs for the
 * size they cover on the screen, and the texture is the page's px scaled
 * down. So the photographs are compared in blocks of `BLOCK` by `BLOCK`
 * pixels, each averaged, and a block counts as different when a channel of
 * its average is more than `TOLERANCE` apart. A misplaced shape or a wrong
 * colour moves whole blocks; antialiasing moves few.
 *
 * It is a tool for finding regressions, not a test: nothing here passes or
 * fails, and it is not run on pull requests, since the browser it needs has
 * HTML-in-Canvas behind a flag (`--enable-blink-features=CanvasDrawElement`)
 * that a later Chromium may rename. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` names
 * the Chromium, as for the visual suite.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  enterSession,
  nextFrames,
  openShowcase,
  panelIds,
  photographScene,
  showPanel,
} from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? join(HERE, "output", "reference");
/** The side of a block the photographs are averaged over, in px. */
const BLOCK = 4;
/** How far apart a channel of two blocks' averages may be, 0–255. */
const TOLERANCE = 40;
/**
 * Device px per CSS px. At 2 the card covers about 900 by 840 px of the
 * photograph, which is enough to see a shape that is a few px out.
 */
const SCALE = 2;
/** The room's colour, which the sheets are cropped to the panels inside. */
const ROOM = [20, 22, 29];

/**
 * Photograph the panels `ids` (every panel when it is empty) as one way of
 * drawing them draws them.
 *
 * @param {"mirror" | "texture"} panels
 * @param {string[]} ids
 * @returns {Promise<Map<string, Buffer>>}
 */
async function photograph(panels, ids) {
  const showcase = await openShowcase({
    freeze: true,
    query: panels === "texture" ? "panels=texture" : undefined,
    args: ["--enable-blink-features=CanvasDrawElement"],
    deviceScaleFactor: SCALE,
  });
  try {
    await enterSession(showcase.page, { freeze: true });
    if (panels === "texture") {
      const reference = await showcase.page.evaluate(
        () => !!document.querySelector("canvas [data-reference]"),
      );
      if (!reference) {
        throw new Error(
          "the page fell back to the mirror: this Chromium cannot draw HTML in a canvas",
        );
      }
    }
    const all = await panelIds(showcase.page);
    /** @type {Map<string, Buffer>} */
    const shots = new Map();
    for (const id of ids.length ? ids : all) {
      await showPanel(showcase.page, id);
      await nextFrames(showcase.page, 10);
      shots.set(id, await photographScene(showcase.page, { freeze: true }));
    }
    return shots;
  } finally {
    await showcase.close();
  }
}

/**
 * The two photographs side by side with where they disagree, cropped to
 * the panels, and how much of the crop disagrees.
 *
 * @param {Buffer} mirrorBytes
 * @param {Buffer} textureBytes
 * @returns {{ sheet: Buffer, share: number }}
 */
function compare(mirrorBytes, textureBytes) {
  const mirror = PNG.sync.read(mirrorBytes);
  const texture = PNG.sync.read(textureBytes);
  /** @param {PNG} png @param {number} x @param {number} y @param {number} c */
  const at = (png, x, y, c) => png.data[(y * png.width + x) * 4 + c];
  // The box round everything that is not the room, in either photograph.
  let [left, top, right, bottom] = [mirror.width, mirror.height, 0, 0];
  for (const png of [mirror, texture]) {
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        if ([0, 1, 2].some((c) => Math.abs(at(png, x, y, c) - ROOM[c]) > 12)) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x + 1);
          bottom = Math.max(bottom, y + 1);
        }
      }
    }
  }
  const width = right - left;
  const height = bottom - top;
  const sheet = new PNG({ width: width * 3, height });
  /** @param {PNG} png @param {number} x @param {number} y @param {number} c */
  const crop = (png, x, y, c) => at(png, left + x, top + y, c);
  /** @param {number} x @param {number} y @param {number[]} rgb */
  const put = (x, y, rgb) => {
    const index = (y * sheet.width + x) * 4;
    sheet.data[index] = rgb[0];
    sheet.data[index + 1] = rgb[1];
    sheet.data[index + 2] = rgb[2];
    sheet.data[index + 3] = 255;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      put(
        x,
        y,
        [0, 1, 2].map((c) => crop(mirror, x, y, c)),
      );
      put(
        width + x,
        y,
        [0, 1, 2].map((c) => crop(texture, x, y, c)),
      );
      put(
        2 * width + x,
        y,
        [0, 1, 2].map((c) => crop(texture, x, y, c) >> 2),
      );
    }
  }
  let blocks = 0;
  let different = 0;
  for (let by = 0; by + BLOCK <= height; by += BLOCK) {
    for (let bx = 0; bx + BLOCK <= width; bx += BLOCK) {
      blocks++;
      /** @param {PNG} png */
      const mean = (png) =>
        [0, 1, 2].map((c) => {
          let sum = 0;
          for (let y = by; y < by + BLOCK; y++) {
            for (let x = bx; x < bx + BLOCK; x++) {
              sum += crop(png, x, y, c);
            }
          }
          return sum / (BLOCK * BLOCK);
        });
      const a = mean(mirror);
      const b = mean(texture);
      if (a.some((value, c) => Math.abs(value - b[c]) > TOLERANCE)) {
        different++;
        for (let y = by; y < by + BLOCK; y++) {
          for (let x = bx; x < bx + BLOCK; x++) {
            put(2 * width + x, y, [255, 0, 255]);
          }
        }
      }
    }
  }
  return { sheet: PNG.sync.write(sheet), share: different / blocks };
}

const ids = process.argv.slice(2);
const mirror = await photograph("mirror", ids);
const texture = await photograph("texture", ids);
mkdirSync(OUT, { recursive: true });
/** @type {[string, number][]} */
const rows = [];
for (const [id, mirrorBytes] of mirror) {
  const textureBytes = texture.get(id);
  if (!textureBytes) {
    continue;
  }
  const { sheet, share } = compare(mirrorBytes, textureBytes);
  writeFileSync(join(OUT, `${id}.png`), sheet);
  rows.push([id, share]);
}
rows.sort((a, b) => b[1] - a[1]);
console.log("| Panel | Blocks that differ |");
console.log("| ----- | ------------------ |");
for (const [id, share] of rows) {
  console.log(`| ${id} | ${(share * 100).toFixed(2)}% |`);
}
console.log(`\nSheets in ${OUT}: the mirror, the browser's drawing, and where they differ.`);
