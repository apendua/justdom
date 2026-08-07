import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enterSession, fingerprint, nextFrames, openShowcase, photographScene } from "./harness.js";
import { BASELINE, MOVEMENT, comparePng, countNear, inkRatio } from "./pixels.js";

/**
 * What the showcase looks like once it is a scene, checked by photographing
 * it inside an emulated headset.
 *
 * These are the checks jsdom structurally cannot make. It computes styles but
 * lays nothing out and draws nothing, so the unit suites can assert that an
 * element registered the right uniforms and never that anything appeared. The
 * two rendering bugs this project has actually shipped — text masks that lost
 * their tint, and a hairline border drawn around boxes that had none — both
 * passed every unit test and were caught by a person looking at the scene.
 *
 * Two kinds of check live here, and they fail for different reasons:
 *
 *  - The baseline comparison is exact, and is only meaningful against the
 *    machine that drew the baseline. It carries a fingerprint of the renderer
 *    and the fonts, and *skips itself* rather than lying when it is somewhere
 *    else. Regenerate with `npm run test:visual:update`.
 *  - Everything else asks a question about the frame that has one answer
 *    anywhere: that the panels are there, that they are wearing the colours
 *    their stylesheets asked for, that animation moves and that a style
 *    written into the mirrored DOM reaches the scene. These are the ones that
 *    can go in front of a pull request on any machine.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, "baselines");
const OUTPUT = join(HERE, "output");
const UPDATE = process.argv.includes("--update") || process.env.UPDATE_BASELINES === "1";

/** The stylesheet's own accent, which several labels and borders are drawn in. */
const ACCENT = /** @type {[number, number, number]} */ ([0, 123, 255]);

/**
 * @param {string} name
 * @param {Buffer} png
 * @param {Record<string, string>} stamp
 */
function compareToBaseline(name, png, stamp) {
  mkdirSync(OUTPUT, { recursive: true });
  writeFileSync(join(OUTPUT, `${name}.png`), png);

  const baseline = join(BASELINES, `${name}.png`);
  const recorded = join(BASELINES, "fingerprint.json");
  if (UPDATE || !existsSync(baseline)) {
    mkdirSync(BASELINES, { recursive: true });
    writeFileSync(baseline, png);
    writeFileSync(recorded, `${JSON.stringify(stamp, null, 2)}\n`);
    return { skipped: `baseline written: ${baseline}` };
  }

  const expected = JSON.parse(readFileSync(recorded, "utf8"));
  for (const key of Object.keys(stamp)) {
    if (expected[key] !== stamp[key]) {
      return {
        skipped:
          `this machine draws differently from the one the baselines came from ` +
          `(${key}: ${stamp[key]}, recorded: ${expected[key]}). ` +
          `Run with --update to redraw them here.`,
      };
    }
  }

  const result = comparePng(png, readFileSync(baseline), BASELINE);
  if (!result.same && result.diff) {
    writeFileSync(join(OUTPUT, `${name}.diff.png`), result.diff);
  }
  return { result };
}

describe("the showcase in an emulated headset", { timeout: 180_000 }, () => {
  /** @type {Awaited<ReturnType<typeof openShowcase>>} */
  let showcase;
  /** @type {Buffer} */
  let scene;
  /** @type {Record<string, string>} */
  let stamp;

  before(async () => {
    showcase = await openShowcase({ freeze: true });
    await enterSession(showcase.page, { freeze: true });
    stamp = await fingerprint(showcase.page, showcase.browser);
    scene = await photographScene(showcase.page);
  });

  after(async () => {
    await showcase?.close();
  });

  test("the panels are drawn", () => {
    // Three panels of white cards against a dark room: if the session came up
    // empty, or the portal drew nothing, this is what notices.
    const ink = inkRatio(scene);
    assert.ok(ink > 0.15, `expected the scene to be covered in panels, got ${ink.toFixed(3)}`);
    assert.ok(ink < 0.95, `expected a room around the panels, got ${ink.toFixed(3)}`);
  });

  test("text and borders wear the colour their stylesheet asked for", () => {
    // The regression this stands guard over: text is drawn as a white mask and
    // tinted by its material, so a break in the tint path leaves every label
    // white — the panels stay exactly as full of pixels as before, and only
    // the colour tells you.
    const accented = countNear(scene, ACCENT);
    assert.ok(accented > 500, `expected the accent colour in the frame, found ${accented} pixels`);
  });

  test("the scene matches its baseline", (t) => {
    const { skipped, result } = compareToBaseline("scene", scene, stamp);
    if (skipped) {
      t.skip(skipped);
      return;
    }
    assert.ok(
      result?.same,
      `the scene differs from its baseline: ${result?.changed} pixels ` +
        `(${((result?.ratio ?? 0) * 100).toFixed(3)}%)${result?.reason ? `, ${result.reason}` : ""}. ` +
        `Look at tests/output/scene.diff.png; if the change is meant, ` +
        `re-record with npm run test:visual:update.`,
    );
  });

  test("a style written into the mirrored DOM reaches the scene", async () => {
    // The mirror's whole claim: the DOM is the source, and what is written
    // there shows up in the headset. A transform is the sharpest way to ask,
    // because it moves a whole panel's worth of pixels and touches the
    // transform path the CSS mapping added.
    const before = await photographScene(showcase.page);
    await showcase.page.evaluate(() => {
      const portal = document.querySelector("[data-xr-portal]");
      const card = portal?.querySelector("div");
      if (!(card instanceof HTMLElement)) {
        throw new Error("no card to rotate");
      }
      card.dataset.testRotated = "";
      card.style.transform = "rotate(12deg) scale(0.8)";
    });
    await nextFrames(showcase.page, 10);
    const after = await photographScene(showcase.page);

    const moved = comparePng(after, before, MOVEMENT);
    assert.ok(
      !moved.same,
      "rotating a mirrored element changed nothing in the scene: the transform never arrived",
    );

    await showcase.page.evaluate(() => {
      const card = document.querySelector("[data-test-rotated]");
      if (card instanceof HTMLElement) {
        card.style.transform = "";
        delete card.dataset.testRotated;
      }
    });
    await nextFrames(showcase.page, 10);
    const restored = await photographScene(showcase.page);
    assert.ok(
      comparePng(restored, before, BASELINE).same,
      "taking the transform away did not put the scene back",
    );
  });
});

describe("the showcase while it is animating", { timeout: 180_000 }, () => {
  /** @type {Awaited<ReturnType<typeof openShowcase>>} */
  let showcase;

  before(async () => {
    showcase = await openShowcase({ freeze: false });
    await enterSession(showcase.page, { freeze: false });
  });

  after(async () => {
    await showcase?.close();
  });

  test("animation plays: two frames apart, the scene has moved", async () => {
    // Keyframes, a WAAPI animation and a rAF loop all run in the motion panel;
    // the clock samples them and the scene follows. Nothing in jsdom advances
    // a timeline, so this is the only place that can tell whether any of it
    // actually plays.
    const first = await photographScene(showcase.page);
    await nextFrames(showcase.page, 24);
    const second = await photographScene(showcase.page);

    const moved = comparePng(first, second, MOVEMENT);
    assert.ok(!moved.same, "the scene held perfectly still while three animations were running");
  });
});
