import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
 *    machine that drew the baseline, so baselines are filed under a
 *    fingerprint of the renderer and the fonts. Somewhere with no baseline of
 *    its own, it records one and says so; under `--strict`, which is how CI
 *    runs it, it fails instead — a check that quietly declines to check is
 *    worse than none.
 *  - Everything else asks a question about the frame that has one answer
 *    anywhere: that the panels are there, that they are wearing the colours
 *    their stylesheets asked for, that animation moves and that a style
 *    written into the mirrored DOM reaches the scene. These are the ones that
 *    can go in front of a pull request on any machine.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, "baselines");
const OUTPUT = join(HERE, "output");
/**
 * Whether to redraw the baselines instead of comparing against them.
 *
 * From the environment, and only from the environment. Reading it from
 * `process.argv` as well is the trap this used to be in: `node --test` runs
 * every file in a child process of its own whose argv is the file and nothing
 * else, so a flag written after `--` on the command line is swallowed before
 * any test can see it. It appeared to work for exactly as long as the runner
 * had no baseline of its own — recording is also what happens when there is
 * nothing on record to compare against — and stopped the first time there was
 * one, reporting the difference it had been asked to overwrite.
 */
const UPDATE = process.env.UPDATE_BASELINES === "1";
/**
 * Whether having no baseline for this machine is a failure rather than
 * something to get on with. CI sets it, because a check that quietly declines
 * to check is worse than no check: the job stays green and the comparison
 * everyone believes is running is not.
 */
const STRICT = process.env.VISUAL_STRICT === "1";

/** The stylesheet's own accent, which several labels and borders are drawn in. */
const ACCENT = /** @type {[number, number, number]} */ ([0, 123, 255]);

/**
 * The teal the vector panel's diagram nodes are filled with, and nothing
 * else in the showcase is: SVG shapes are drawn through a plugin with a path
 * of its own — parsed geometry, triangulated fills, stroked outlines — and
 * none of the unit suite can see whether any of it appears.
 */
const NODE_COLOR = /** @type {[number, number, number]} */ ([0, 168, 150]);

/**
 * Baselines are filed under the environment that drew them, so more than one
 * can be committed at a time and none of them clobbers another: CI keeps its
 * own, and anyone who records locally keeps theirs beside it. The name is a
 * digest because the fingerprint itself — a browser build, a font measurement
 * — makes a poor directory.
 *
 * @param {Record<string, string>} stamp
 * @returns {string}
 */
function baselineDirectory(stamp) {
  const digest = createHash("sha256").update(JSON.stringify(stamp)).digest("hex").slice(0, 8);
  return join(BASELINES, digest);
}

/**
 * @param {string} name
 * @param {Buffer} png
 * @param {Record<string, string>} stamp
 * @returns {{ skipped?: string, recorded?: string, missing?: string, result?: ReturnType<typeof comparePng> }}
 */
function compareToBaseline(name, png, stamp) {
  mkdirSync(OUTPUT, { recursive: true });
  writeFileSync(join(OUTPUT, `${name}.png`), png);

  const directory = baselineDirectory(stamp);
  const baseline = join(directory, `${name}.png`);
  if (UPDATE || !existsSync(baseline)) {
    if (!UPDATE && STRICT) {
      return {
        missing:
          `no baseline recorded for this machine, and none may be written here.\n` +
          `  fingerprint: ${JSON.stringify(stamp)}\n` +
          `  expected at: ${baseline}\n` +
          `Record one by dispatching the "Visual regression" workflow with ` +
          `record=true, which redraws the baselines on a runner and commits them.`,
      };
    }
    mkdirSync(directory, { recursive: true });
    writeFileSync(baseline, png);
    writeFileSync(join(directory, "fingerprint.json"), `${JSON.stringify(stamp, null, 2)}\n`);
    return { recorded: `baseline written: ${baseline}` };
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
    scene = await photographScene(showcase.page, { freeze: true });
  });

  after(async () => {
    await showcase?.close();
  });

  test("the panels are drawn", () => {
    // Five panels of white cards against a dark room: if the session came up
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

  test("the vector panel's shapes are drawn", () => {
    // The two node rectangles and the small node between them are filled
    // with a colour the rest of the scene never uses, so finding it means the
    // SVG plugin parsed, triangulated and painted at least those; a diagram
    // that came out as the empty box the portal drew before the plugin
    // finds none of it.
    const filled = countNear(scene, NODE_COLOR);
    assert.ok(
      filled > 400,
      `expected the diagram's teal nodes in the frame, found ${filled} pixels`,
    );
  });

  test("the scene matches its baseline", (t) => {
    const { recorded, missing, result } = compareToBaseline("scene", scene, stamp);
    assert.ok(!missing, missing);
    if (recorded) {
      t.skip(recorded);
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
    const before = await photographScene(showcase.page, { freeze: true });
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
    const after = await photographScene(showcase.page, { freeze: true });

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
    const restored = await photographScene(showcase.page, { freeze: true });
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
