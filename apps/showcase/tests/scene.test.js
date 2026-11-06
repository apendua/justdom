import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aimAt,
  enterSession,
  fingerprint,
  holdTrigger,
  nextFrames,
  openShowcase,
  panelIds,
  photographScene,
  showPanel,
} from "./harness.js";
import { BASELINE, MOVEMENT, comparePng, countNear, countWhere, inkRatio } from "./pixels.js";

/**
 * What the showcase looks like once it is a scene, checked by photographing
 * it inside an emulated headset: every panel of the deck, one photograph
 * each, in one session that switches from panel to panel.
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
 *    its own, it records one and says so; under `VISUAL_STRICT=1`, which is
 *    how CI runs it, it fails instead — a check that quietly declines to
 *    check is worse than none.
 *  - Everything else asks a question about the frame that has one answer
 *    anywhere: that the panels are there, that they are wearing the colours
 *    their stylesheets asked for, that animation moves and that a style or
 *    an SVG attribute written into the mirrored DOM reaches the scene. These
 *    are the ones that can go in front of a pull request on any machine.
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

/** The pointer panel's buttons are filled with it, and several labels are drawn in it. */
const ACCENT = /** @type {[number, number, number]} */ ([0, 123, 255]);

/**
 * The teal the SVG panel's diagram nodes are filled with, and nothing on that
 * panel's photograph besides: SVG shapes are drawn through a plugin with a path
 * of its own — parsed geometry, triangulated fills, stroked outlines — and
 * none of the unit suite can see whether any of it appears.
 */
const NODE_COLOR = /** @type {[number, number, number]} */ ([0, 168, 150]);

/**
 * The orange of the SVG panel's clipped bar, used nowhere else on that
 * panel. A `clip-path` shows the left half of the bar, so the scene holds
 * half as much of it as the bar with no clip would.
 */
const CLIPPED_COLOR = /** @type {[number, number, number]} */ ([255, 110, 0]);

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

/**
 * Holds a photograph against its baseline, or records one and says so.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} name
 * @param {Buffer} png
 * @param {Record<string, string>} stamp
 */
function assertMatchesBaseline(t, name, png, stamp) {
  const { recorded, missing, result } = compareToBaseline(name, png, stamp);
  assert.ok(!missing, missing);
  if (recorded) {
    t.diagnostic(recorded);
    return;
  }
  assert.ok(
    result?.same,
    `the ${name} photograph differs from its baseline: ${result?.changed} pixels ` +
      `(${((result?.ratio ?? 0) * 100).toFixed(3)}%)${result?.reason ? `, ${result.reason}` : ""}. ` +
      `Look at tests/output/${name}.diff.png; if the change is meant, ` +
      `re-record with npm run test:visual:update.`,
  );
}

describe("the deck in an emulated headset", { timeout: 300_000 }, () => {
  /** @type {Awaited<ReturnType<typeof openShowcase>>} */
  let showcase;
  /** @type {Record<string, string>} */
  let stamp;
  /**
   * Each panel's photograph, taken as the panel is first shown. The checks
   * below ask the panel they are about, and each puts it on show first, so
   * none of them depends on the order they run in.
   *
   * @type {Map<string, Buffer>}
   */
  const photographs = new Map();

  /**
   * Put a panel on show and photograph it, held still.
   *
   * @param {string} id
   * @returns {Promise<Buffer>}
   */
  const photograph = async (id) => {
    await showPanel(showcase.page, id);
    return photographScene(showcase.page, { freeze: true });
  };

  /**
   * A panel's photograph as it was first shown.
   *
   * @param {string} id
   * @returns {Promise<Buffer>}
   */
  const first = async (id) => {
    const taken = photographs.get(id) ?? (await photograph(id));
    photographs.set(id, taken);
    return taken;
  };

  before(async () => {
    showcase = await openShowcase({ freeze: true });
    await enterSession(showcase.page, { freeze: true });
    stamp = await fingerprint(showcase.page, showcase.browser);
  });

  after(async () => {
    await showcase?.close();
  });

  test("every panel is drawn, and matches its baseline", async (t) => {
    // One photograph per panel, named by its id. A panel that came up empty,
    // or a session with nothing in it, fails the ink check before the
    // comparison has anything to say.
    for (const id of await panelIds(showcase.page)) {
      await t.test(id, async (t) => {
        const scene = await first(id);
        const ink = inkRatio(scene);
        assert.ok(ink > 0.15, `expected the ${id} panel in the frame, got ${ink.toFixed(3)}`);
        assert.ok(ink < 0.95, `expected a room around the ${id} panel, got ${ink.toFixed(3)}`);
        assertMatchesBaseline(t, id, scene, stamp);
      });
    }
  });

  test("text and borders wear the colour their stylesheet asked for", async () => {
    // The regression this stands guard over: text is drawn as a white mask and
    // tinted by its material, so a break in the tint path leaves every label
    // white — the panels stay exactly as full of pixels as before, and only
    // the colour tells you. The pointer panel's buttons and its counter's
    // label are the accent.
    const accented = countNear(await first("pointer"), ACCENT);
    assert.ok(accented > 500, `expected the accent colour in the frame, found ${accented} pixels`);
  });

  test("the SVG panel's shapes are drawn", async () => {
    // The two node rectangles and the small node between them are filled
    // with a colour the rest of the panel never uses, so finding it means the
    // SVG plugin parsed, triangulated and painted at least those; a diagram
    // that came out as the empty box the portal drew before the plugin
    // finds none of it.
    const filled = countNear(await first("svg"), NODE_COLOR);
    assert.ok(
      filled > 400,
      `expected the diagram's teal nodes in the frame, found ${filled} pixels`,
    );
  });

  test("a style written into the mirrored DOM reaches the scene", async () => {
    // The mirror's whole claim: the DOM is the source, and what is written
    // there shows up in the headset. A transform is the sharpest way to ask,
    // because it moves a whole panel's worth of pixels and touches the
    // transform path the CSS mapping added.
    const before = await photograph("boxes");
    await showcase.page.evaluate(() => {
      const card = document.querySelector('[data-panel="boxes"] > div');
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

  test("an SVG attribute written into the mirrored DOM reaches the scene", async () => {
    // The same claim for an attribute rather than a style: the diamond on the
    // SVG panel is a square turned by a `transform` attribute on its `<g>`.
    // Unturning it by attribute has to show up in the headset, which it did
    // not while the portal observed a fixed list of attribute names.
    const before = await photograph("svg");
    // Writes the group's transform and hands back the one it replaced, so
    // the panel stays the only place the diamond's angle is written down.
    const rewrite = (/** @type {string} */ transform) =>
      showcase.page.evaluate((transform) => {
        const group = document.querySelector('[data-panel="svg"] svg g[transform]');
        if (!group) {
          throw new Error("no group to turn");
        }
        const previous = group.getAttribute("transform") ?? "";
        group.setAttribute("transform", transform);
        return previous;
      }, transform);

    const original = await rewrite("");
    await nextFrames(showcase.page, 10);
    const after = await photographScene(showcase.page, { freeze: true });
    assert.ok(
      !comparePng(after, before, MOVEMENT).same,
      "turning a group by its transform attribute changed nothing in the scene",
    );

    await rewrite(original);
    await nextFrames(showcase.page, 10);
    const restored = await photographScene(showcase.page, { freeze: true });
    assert.ok(
      comparePng(restored, before, BASELINE).same,
      "turning it back did not put the scene back",
    );
  });

  test("a clip-path shows half of the bar, and all of it once it is taken off", async () => {
    // The bar is 56 by 18 and its clip the left 28 by 18. Taking the
    // clip-path off has to double the orange in the headset, and putting it
    // back has to put the scene back. Counts rather than a baseline, so this
    // means the same on any machine.
    const before = await photograph("svg");
    const clipped = countNear(before, CLIPPED_COLOR);
    assert.ok(clipped > 100, `expected the clipped bar in the frame, found ${clipped} pixels`);

    // Sets the bar's clip-path and hands back the one it replaced.
    const reclip = (/** @type {string | null} */ value) =>
      showcase.page.evaluate((value) => {
        const bar = document.querySelector('[data-panel="svg"] svg rect.clipped');
        if (!bar) {
          throw new Error("no clipped bar");
        }
        const previous = bar.getAttribute("clip-path");
        if (value === null) {
          bar.removeAttribute("clip-path");
        } else {
          bar.setAttribute("clip-path", value);
        }
        return previous;
      }, value);

    const original = await reclip(null);
    await nextFrames(showcase.page, 10);
    const bare = await photographScene(showcase.page, { freeze: true });
    const whole = countNear(bare, CLIPPED_COLOR);
    // Twice as much, give or take the antialiased edges.
    assert.ok(
      whole > clipped * 1.7 && whole < clipped * 2.3,
      `expected about twice ${clipped} orange pixels with the clip taken off, found ${whole}`,
    );

    await reclip(original);
    await nextFrames(showcase.page, 10);
    const restored = await photographScene(showcase.page, { freeze: true });
    // A frozen scene photographed twice matches to the pixel, so the scene
    // with the clip back must too.
    const back = countNear(restored, CLIPPED_COLOR);
    assert.equal(back, clipped, "putting the clip-path back did not hide the bar's right half");
    assert.ok(
      comparePng(restored, before, MOVEMENT).same,
      "putting the clip-path back did not put the scene back",
    );
  });

  test("list markers are drawn", async () => {
    // A marker is not in the DOM, so the portal draws it from the item's
    // computed style. Turning the outside markers off with
    // `list-style-type: none` moves no box and no text, since an outside
    // marker takes no room, so the only pixels that can change are the
    // markers' own: a scene that stays the same never drew them. An inside
    // marker is left alone, because taking it away moves its line's text.
    const before = await photograph("lists");
    const toggle = (/** @type {boolean} */ off) =>
      showcase.page.evaluate((off) => {
        const items = [...document.querySelectorAll('[data-panel="lists"] li')].filter(
          (item) =>
            item instanceof HTMLElement && getComputedStyle(item).listStylePosition === "outside",
        );
        if (items.length === 0) {
          throw new Error("no list items to take the markers off");
        }
        for (const item of items) {
          /** @type {HTMLElement} */ (item).style.listStyleType = off ? "none" : "";
        }
      }, off);

    await toggle(true);
    await nextFrames(showcase.page, 10);
    const bare = await photographScene(showcase.page, { freeze: true });
    assert.ok(
      !comparePng(bare, before, MOVEMENT).same,
      "taking the lists' markers off changed nothing in the scene: none were drawn",
    );

    await toggle(false);
    await nextFrames(showcase.page, 10);
    const restored = await photographScene(showcase.page, { freeze: true });
    assert.ok(
      comparePng(restored, before, BASELINE).same,
      "putting the markers back did not put the scene back",
    );
  });

  test("a label under a translucent card is tinted, not hidden", async () => {
    // Two positioned cards on the boxes panel: a white one with a blue label,
    // and a half-transparent white one over the whole label. A page shows the
    // label pale blue through the second card. The second card is stepped in
    // front of the first in depth, and drawn before the label it would keep
    // out of the depth test, so nothing blue showed at all.
    const pale = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) =>
      b - r > 40 && b - g > 40 && Math.abs(r - g) < 30;
    const before = await photograph("boxes");
    const toggle = (/** @type {boolean} */ on) =>
      showcase.page.evaluate((on) => {
        if (!on) {
          document.querySelector("[data-test-translucent]")?.remove();
          return;
        }
        const card = document.querySelector('[data-panel="boxes"] > div');
        if (!card) {
          throw new Error("no boxes card to lay the cards on");
        }
        const board = document.createElement("div");
        board.dataset.testTranslucent = "";
        // Over the empty room at the bottom of the card, clear of the
        // swatches, whose blue would count as pale blue too.
        board.style.cssText =
          "position: absolute; left: 16px; bottom: 16px; width: 160px; height: 90px";
        board.innerHTML =
          '<div style="position: absolute; left: 0; top: 0; width: 120px; height: 80px; ' +
          'background: white"><div style="margin: 20px; height: 40px; ' +
          'background: rgb(0, 0, 255)"></div></div>' +
          '<div style="position: absolute; left: 10px; top: 10px; width: 140px; ' +
          'height: 80px; background: rgba(255, 255, 255, 0.5)"></div>';
        card.appendChild(board);
      }, on);

    await toggle(true);
    await nextFrames(showcase.page, 10);
    const covered = await photographScene(showcase.page, { freeze: true });
    const tinted = countWhere(covered, pale) - countWhere(before, pale);
    assert.ok(
      tinted > 200,
      `expected the label pale blue through the card, found ${tinted} more pale blue pixels`,
    );

    await toggle(false);
    await nextFrames(showcase.page, 10);
    const restored = await photographScene(showcase.page, { freeze: true });
    assert.ok(
      comparePng(restored, before, BASELINE).same,
      "taking the cards away did not put the scene back",
    );
  });
});

describe("the pointer panel under a hand", { timeout: 180_000 }, () => {
  // A browser of its own, so that the hand is in none of the photographs above.
  // What these two are for is what a panel draws for a ray resting on a control
  // and for a trigger held on it: the hover and press styles a stylesheet hangs
  // on `:hover` and `:active`, which the portal answers with `data-xr-hover`
  // and `data-xr-active`. The event goldens in justdom-three can say the flags
  // were set; only a photograph can say the styles were drawn.

  /** @type {Awaited<ReturnType<typeof openShowcase>>} */
  let showcase;
  /** @type {Record<string, string>} */
  let stamp;

  before(async () => {
    showcase = await openShowcase({ freeze: true });
    await enterSession(showcase.page, { freeze: true });
    stamp = await fingerprint(showcase.page, showcase.browser);
    await showPanel(showcase.page, "pointer");
  });

  after(async () => {
    await showcase?.close();
  });

  /**
   * Which of the panel's buttons carry a flag, by their text.
   *
   * @param {string} flag
   * @returns {Promise<string[]>}
   */
  const flagged = (flag) =>
    showcase.page.evaluate(
      (flag) =>
        [...document.querySelectorAll(`[data-panel="pointer"] button[${flag}]`)].map(
          (button) => button.textContent ?? "",
        ),
      flag,
    );

  test("a ray resting on a button, and the trigger held on it, match their baselines", async (t) => {
    await aimAt(showcase.page, "button");
    assert.deepEqual(await flagged("data-xr-hover"), ["One"], "the ray is on the first button");
    const resting = await photographScene(showcase.page, { freeze: true });

    await holdTrigger(showcase.page, true);
    assert.deepEqual(await flagged("data-xr-active"), ["One"], "the trigger holds it");
    const held = await photographScene(showcase.page, { freeze: true });
    await holdTrigger(showcase.page, false);

    // The press shrinks the button where the hover grew it, so the two
    // photographs differ on any machine. A press that reached the DOM and
    // not the scene leaves them the same.
    assert.ok(
      !comparePng(held, resting, MOVEMENT).same,
      "holding the trigger changed nothing in the scene: the press style was not drawn",
    );

    assertMatchesBaseline(t, "pointer-hover", resting, stamp);
    assertMatchesBaseline(t, "pointer-press", held, stamp);
  });
});

describe("the motion panel while it is animating", { timeout: 180_000 }, () => {
  /** @type {Awaited<ReturnType<typeof openShowcase>>} */
  let showcase;

  before(async () => {
    showcase = await openShowcase({ freeze: false });
    await enterSession(showcase.page, { freeze: false });
    await showPanel(showcase.page, "motion");
  });

  after(async () => {
    await showcase?.close();
  });

  test("animation plays: two frames apart, the scene has moved", async () => {
    // Keyframes, a WAAPI animation and a frame loop all run in the motion
    // panel; the clock samples them and the scene follows. Nothing in jsdom
    // advances a timeline, so this is the only place that can tell whether
    // any of it actually plays.
    const first = await photographScene(showcase.page);
    await nextFrames(showcase.page, 24);
    const second = await photographScene(showcase.page);

    const moved = comparePng(first, second, MOVEMENT);
    assert.ok(!moved.same, "the scene held perfectly still while three animations were running");
  });
});
