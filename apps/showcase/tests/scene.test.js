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
import { PNG } from "pngjs";
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

/** The underline under the pseudo panel's link, and nothing else on that panel. */
const UNDERLINE = /** @type {[number, number, number]} */ ([214, 48, 160]);

/**
 * The teal the SVG panel's pipeline nodes are filled with, and the cache's
 * outline, port and pulse, and nothing on that panel's photograph besides:
 * SVG shapes are drawn through a plugin with a path of its own — parsed
 * geometry, triangulated fills, stroked outlines — and none of the unit
 * suite can see whether any of it appears.
 */
const NODE_COLOR = /** @type {[number, number, number]} */ ([0, 168, 150]);

/**
 * The orange of the SVG panel's chart line, used nowhere else on that panel.
 * The line spikes past the top of its plot twice, and the plot's `clip-path`
 * cuts the spikes off, so the scene holds less of it than the line with no
 * clip would.
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
        // Switching takes the panel before down, so a teardown that leaked
        // one into this photograph fails here by name rather than as a
        // difference from the baseline.
        const mounted = await showcase.page.evaluate(
          () => document.querySelectorAll("[data-xr-portal] [data-panel]").length,
        );
        assert.equal(mounted, 1, `expected the ${id} panel alone in the scene`);
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
    // The pipeline's three hot nodes are filled with a colour the rest of
    // the panel never uses, so finding it means the
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
    // The same claim for an attribute rather than a style: each node of the
    // SVG panel's pipeline is placed by a `transform` attribute on its `<g>`.
    // Taking the first one's away has to move it in the headset, which it
    // did not while the portal observed a fixed list of attribute names.
    const before = await photograph("svg");
    // Writes the group's transform and hands back the one it replaced, so
    // the panel stays the only place the node's place is written down.
    const rewrite = (/** @type {string} */ transform) =>
      showcase.page.evaluate((transform) => {
        const group = document.querySelector('[data-panel="svg"] svg g[transform]');
        if (!group) {
          throw new Error("no group to move");
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
      "moving a group by its transform attribute changed nothing in the scene",
    );

    await rewrite(original);
    await nextFrames(showcase.page, 10);
    const restored = await photographScene(showcase.page, { freeze: true });
    assert.ok(
      comparePng(restored, before, BASELINE).same,
      "moving it back did not put the scene back",
    );
  });

  test("a clip-path cuts the chart's spikes off, and they show once it is taken off", async () => {
    // The chart's line runs past the top of its plot twice, and the group
    // holding it is clipped to the plot. Taking the clip-path off has to add
    // orange above the plot in the headset, and putting it back has to put
    // the scene back. Counts rather than a baseline, so this means the same
    // on any machine.
    const before = await photograph("svg");
    const clipped = countNear(before, CLIPPED_COLOR);
    assert.ok(clipped > 100, `expected the chart's line in the frame, found ${clipped} pixels`);

    // Sets the group's clip-path and hands back the one it replaced.
    const reclip = (/** @type {string | null} */ value) =>
      showcase.page.evaluate((value) => {
        const group = document.querySelector('[data-panel="svg"] svg g[clip-path]');
        const plot = group ?? document.querySelector("[data-test-unclipped]");
        if (!plot) {
          throw new Error("no clipped group");
        }
        const previous = plot.getAttribute("clip-path");
        if (value === null) {
          plot.setAttribute("data-test-unclipped", "");
          plot.removeAttribute("clip-path");
        } else {
          plot.removeAttribute("data-test-unclipped");
          plot.setAttribute("clip-path", value);
        }
        return previous;
      }, value);

    const original = await reclip(null);
    await nextFrames(showcase.page, 10);
    const bare = await photographScene(showcase.page, { freeze: true });
    const whole = countNear(bare, CLIPPED_COLOR);
    // The plot's clip cuts about 230 units of line off the two spikes,
    // against some 470 inside it, but the board's own overflow still clips
    // at its top edge whether or not the plot does. Taking the clip-path off
    // brings back only the stretch between the plot's top and the board's,
    // about 65 units, or some 9% more orange: that is the margin here.
    assert.ok(
      whole > clipped * 1.05,
      `expected more than ${clipped} orange pixels with the clip taken off, found ${whole}`,
    );

    await reclip(original);
    await nextFrames(showcase.page, 10);
    const restored = await photographScene(showcase.page, { freeze: true });
    // A frozen scene photographed twice matches to the pixel, so the scene
    // with the clip back must too.
    const back = countNear(restored, CLIPPED_COLOR);
    assert.equal(back, clipped, "putting the clip-path back did not cut the spikes off");
    assert.ok(
      comparePng(restored, before, MOVEMENT).same,
      "putting the clip-path back did not put the scene back",
    );
  });

  test("a gradient's spread method, taken through href, is drawn", async () => {
    // The SVG paint panel's REFLECT box is filled with a gradient that has
    // no stops or geometry of its own: it takes them from the PAD box's
    // through `href` and adds `spreadMethod="reflect"`. Filling it with the
    // PAD gradient instead has to change the scene, which it would not if
    // the spread method were dropped on the way through `href`.
    const before = await photograph("svg-paint");
    const refill = (/** @type {string | null} */ fill) =>
      showcase.page.evaluate((fill) => {
        const [pad, reflect] = [0, 1].map((index) =>
          document.querySelector(`[data-panel="svg-paint"] [data-spread="${index}"]`),
        );
        if (!pad || !reflect) {
          throw new Error("no spread boxes");
        }
        const previous = reflect.getAttribute("fill");
        reflect.setAttribute("fill", fill ?? pad.getAttribute("fill") ?? "");
        return previous;
      }, fill);

    const original = await refill(null);
    await nextFrames(showcase.page, 10);
    const padded = await photographScene(showcase.page, { freeze: true });
    assert.ok(
      !comparePng(padded, before, MOVEMENT).same,
      "filling the reflect box with the pad gradient changed nothing: the spread method was lost",
    );

    await refill(original);
    await nextFrames(showcase.page, 10);
    const restored = await photographScene(showcase.page, { freeze: true });
    assert.ok(
      comparePng(restored, before, BASELINE).same,
      "putting the reflect gradient back did not put the scene back",
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

  test("the scroll arrows sit in the middle of their buttons", async () => {
    // An arrow is a box with a glyph in it, and nothing in the box puts the
    // glyph anywhere but its top left corner unless the stylesheet centres
    // it. The scene draws the glyph where the page laid it out, so the
    // layout is what this measures: the glyph's box against its button's.
    await showPanel(showcase.page, "widgets");
    const offsets = await showcase.page.evaluate(() =>
      [...document.querySelectorAll('[data-panel="widgets"] div')]
        // The dropdown's caret is a ▼ too, but it is not an arrow.
        .filter((element) => !element.closest('[role="combobox"]'))
        .filter((element) => element.childElementCount === 0)
        .filter((element) => ["\u25b2", "\u25bc"].includes(element.textContent ?? ""))
        .map((element) => {
          const box = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          const glyph = range.getBoundingClientRect();
          return {
            mark: element.textContent,
            x: glyph.x + glyph.width / 2 - (box.x + box.width / 2),
            y: glyph.y + glyph.height / 2 - (box.y + box.height / 2),
          };
        }),
    );
    assert.equal(offsets.length, 2, "expected the two arrows of the scrolling window");
    for (const { mark, x, y } of offsets) {
      assert.ok(
        Math.abs(x) <= 1.5 && Math.abs(y) <= 1.5,
        `expected ${mark} centred in its button, found it ${x.toFixed(1)}, ${y.toFixed(1)} px off`,
      );
    }
  });

  test("a label under a translucent card is tinted, not hidden", async () => {
    // The paint order panel has two positioned cards: a white one with a pure
    // blue label, and a half-transparent white veil over the whole label. A
    // page shows the label pale blue through the veil. The veil was stepped in
    // front of the first card in depth, and drawn before the label it would
    // keep out of the depth test, so nothing blue showed there at all. Hiding
    // the veil shows the label pure blue, which is not pale, so the pale blue
    // is the veil's doing and nothing else's.
    const pale = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) =>
      r > 60 && b - r > 40 && b - g > 40 && Math.abs(r - g) < 30;
    const before = await photograph("paint-order");
    const veil = (/** @type {boolean} */ on) =>
      showcase.page.evaluate((on) => {
        const element = document.querySelector('[data-panel="paint-order"] [data-veil]');
        if (!(element instanceof HTMLElement)) {
          throw new Error("no veil on the paint order panel");
        }
        element.style.visibility = on ? "" : "hidden";
      }, on);

    await veil(false);
    await nextFrames(showcase.page, 10);
    const bare = await photographScene(showcase.page, { freeze: true });
    const tinted = countWhere(before, pale) - countWhere(bare, pale);
    assert.ok(
      tinted > 200,
      `expected the label pale blue through the veil, found ${tinted} more pale blue pixels`,
    );

    await veil(true);
    await nextFrames(showcase.page, 10);
    const restored = await photographScene(showcase.page, { freeze: true });
    assert.ok(
      comparePng(restored, before, BASELINE).same,
      "putting the veil back did not put the scene back",
    );
  });
});

describe("panels under a hand", { timeout: 180_000 }, () => {
  // A browser of its own, so that the hand is in none of the photographs above.
  // What these are for is what a panel draws for a ray resting on a control
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
  });

  after(async () => {
    await showcase?.close();
  });

  /**
   * Which elements on show that match `selector` carry a flag, by their text.
   *
   * @param {string} selector
   * @param {string} flag
   * @returns {Promise<string[]>}
   */
  const flagged = (selector, flag) =>
    showcase.page.evaluate(
      ([selector, flag]) =>
        [...document.querySelectorAll(`[data-panel] ${selector}[${flag}]`)].map(
          (element) => element.textContent ?? "",
        ),
      [selector, flag],
    );

  test("a ray resting on a button, and the trigger held on it, match their baselines", async (t) => {
    await showPanel(showcase.page, "pointer");
    await aimAt(showcase.page, "button");
    assert.deepEqual(
      await flagged("button", "data-xr-hover"),
      ["One"],
      "the ray is on the first button",
    );
    const resting = await photographScene(showcase.page, { freeze: true });

    await holdTrigger(showcase.page, true);
    assert.deepEqual(await flagged("button", "data-xr-active"), ["One"], "the trigger holds it");
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

  test("a ray resting on a link restyles its ::after, and matches its baseline", async (t) => {
    // The link's underline is an `::after` a third of its width, which a
    // `:hover::after` rule widens to the whole word. A pseudo-element is not
    // in the DOM, so it is restyled only if the portal reads it again when
    // the flag lands on the element it hangs off.
    await showPanel(showcase.page, "pseudo");
    const away = await photographScene(showcase.page, { freeze: true });
    await aimAt(showcase.page, "[data-link]");
    assert.deepEqual(
      await flagged("[data-link]", "data-xr-hover"),
      ["Hover me"],
      "the ray is on the link",
    );
    const resting = await photographScene(showcase.page, { freeze: true });
    // The underline triples in width, and nothing else on the panel is its
    // colour, so its pixels at least double.
    const idle = countNear(away, UNDERLINE);
    const hovered = countNear(resting, UNDERLINE);
    assert.ok(
      hovered > idle * 2,
      `resting the ray on the link did not widen its underline: ${idle} underline pixels, then ${hovered}`,
    );
    assertMatchesBaseline(t, "pseudo-hover", resting, stamp);
  });
});

describe("controls under a hand", { timeout: 240_000 }, () => {
  // A browser of its own, as for the panels above: what these photograph is
  // the state a ray's presses leave a control in, a box ticked, a field typed
  // into through the keyboard, a menu open and a list pulled. Each asserts
  // the DOM state first, so a photograph is trusted only once the press is
  // known to have arrived.

  /** @type {Awaited<ReturnType<typeof openShowcase>>} */
  let showcase;
  /** @type {Record<string, string>} */
  let stamp;

  before(async () => {
    showcase = await openShowcase({ freeze: true });
    await enterSession(showcase.page, { freeze: true });
    stamp = await fingerprint(showcase.page, showcase.browser);
  });

  after(async () => {
    await showcase?.close();
  });

  /**
   * Put a panel on show from its first state. Showing the panel already on
   * show changes nothing, and switching away unmounts it, so another panel
   * goes up first and each photograph is of its own test alone.
   */
  const showFresh = async (/** @type {string} */ id) => {
    await showPanel(showcase.page, id === "forms" ? "widgets" : "forms");
    await showPanel(showcase.page, id);
  };

  /** Aim at an element and pull the trigger on it once. */
  const press = async (/** @type {string} */ selector) => {
    await aimAt(showcase.page, selector);
    await holdTrigger(showcase.page, true);
    await holdTrigger(showcase.page, false);
  };

  test("a box ticked by the trigger lights its label, and matches its baseline", async (t) => {
    await showFresh("forms");
    const before = await photographScene(showcase.page, { freeze: true });
    await press("#forms-dog");
    const state = await showcase.page.evaluate(() => {
      const box = document.querySelector('[data-panel="forms"] #forms-dog');
      return box instanceof HTMLInputElement
        ? { checked: box.checked, flagged: box.hasAttribute("data-xr-checked") }
        : null;
    });
    assert.deepEqual(state, { checked: true, flagged: true }, "the trigger ticked the box");
    const ticked = await photographScene(showcase.page, { freeze: true });
    // The box and the label after it both turn the accent blue.
    const lit = countNear(ticked, ACCENT) - countNear(before, ACCENT);
    assert.ok(lit > 200, `expected the box and its label lit, found ${lit} more accent pixels`);
    assertMatchesBaseline(t, "forms-ticked", ticked, stamp);
  });

  test("the keyboard opens from a field and types into it, and matches its baseline", async (t) => {
    await showFresh("forms");
    await press('[data-field="email"]');
    await showcase.page.waitForFunction(
      () =>
        !!document.querySelector("[data-keyboard]") && !document.querySelector("[data-xr-loading]"),
      undefined,
      { timeout: 30_000 },
    );
    // The keyboard names each key by its `data-code`, as `KeyboardEvent.code`.
    for (const letter of "ABC") {
      await press(`[data-code="Key${letter}"]`);
    }
    const state = await showcase.page.evaluate(() => {
      const field = document.querySelector('[data-panel="forms"] [data-field="email"]');
      return field instanceof HTMLInputElement
        ? { value: field.value, focused: field.hasAttribute("data-xr-focus") }
        : null;
    });
    assert.deepEqual(state, { value: "abc", focused: true }, "the keys typed into the field");
    // Rest the ray off the keys, so no key is photographed lit.
    await aimAt(showcase.page, "h1");
    const typed = await photographScene(showcase.page, { freeze: true });
    assertMatchesBaseline(t, "forms-keyboard", typed, stamp);
  });

  test("the dropdown opens under the trigger, and matches its baseline", async (t) => {
    await showFresh("widgets");
    await press('[role="combobox"]');
    const open = await showcase.page.evaluate(
      () =>
        document
          .querySelector('[data-panel="widgets"] [role="combobox"]')
          ?.getAttribute("aria-expanded") === "true" &&
        !!document.querySelector('[data-panel="widgets"] [role="listbox"]'),
    );
    assert.ok(open, "the trigger opened the menu");
    await aimAt(showcase.page, "h1");
    const opened = await photographScene(showcase.page, { freeze: true });
    assertMatchesBaseline(t, "widgets-dropdown", opened, stamp);
    // Picking an option shuts the menu and shows the choice on the trigger,
    // which also leaves the list below uncovered for the pull that follows.
    await press('[role="option"]:last-child');
    const picked = await showcase.page.evaluate(() => {
      const trigger = document.querySelector('[data-panel="widgets"] [role="combobox"]');
      return {
        expanded: trigger?.getAttribute("aria-expanded"),
        label: trigger?.textContent?.includes("Large") ?? false,
      };
    });
    assert.deepEqual(picked, { expanded: "false", label: true }, "the option was picked");
  });

  test("a list pulled by the trigger scrolls, and matches its baseline", async (t) => {
    await showFresh("widgets");
    // Take hold of the list low down and pull it up to its top row.
    await aimAt(showcase.page, "[data-pulled] > :nth-child(4)");
    await holdTrigger(showcase.page, true);
    await aimAt(showcase.page, "[data-pulled] > :nth-child(1)");
    await holdTrigger(showcase.page, false);
    await nextFrames(showcase.page, 30);
    const scrolled = await showcase.page.evaluate(
      () => document.querySelector('[data-panel="widgets"] [data-pulled]')?.scrollTop ?? 0,
    );
    assert.ok(scrolled > 20, `expected the list scrolled by the pull, found scrollTop ${scrolled}`);
    await aimAt(showcase.page, "h1");
    const pulled = await photographScene(showcase.page, { freeze: true });
    assertMatchesBaseline(t, "widgets-scrolled", pulled, stamp);
  });
});

describe("the motion panel while it is animating", { timeout: 180_000 }, () => {
  /** @type {Awaited<ReturnType<typeof openShowcase>>} */
  let showcase;

  before(async () => {
    showcase = await openShowcase({ freeze: false });
    await enterSession(showcase.page, { freeze: false });
  });

  after(async () => {
    await showcase?.close();
  });

  test("the last panel asked for is the one on show", async () => {
    // The SVG panel's plugin is fetched the first time it is shown, which
    // nothing in this browser has done yet. Asking for it and then, before
    // the plugin has arrived, for the motion panel has to end on motion,
    // not on the panel whose plugin landed last.
    await showcase.page.evaluate(async () => {
      const deck = window.__showcase;
      if (!deck) {
        throw new Error("the showcase hands no window.__showcase to drive the deck by");
      }
      await Promise.all([deck.show("svg"), deck.show("motion")]);
    });
    await nextFrames(showcase.page, 10);
    const shown = await showcase.page.evaluate(() => ({
      current: window.__showcase?.current(),
      address: new URLSearchParams(location.search).get("panel"),
    }));
    assert.deepEqual(shown, { current: "motion", address: "motion" });
  });

  test("animation plays: two frames apart, the scene has moved", async () => {
    await showPanel(showcase.page, "motion");
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

describe("every panel at once, under ?panel=all", { timeout: 240_000 }, () => {
  // What the paint-order benches in packages/three open: every panel in one
  // scene, so that one frame's count covers all of them. Nothing here is
  // photographed against a baseline; the deck's own photographs cover how
  // each panel is drawn.

  /** @type {Awaited<ReturnType<typeof openShowcase>>} */
  let showcase;

  before(async () => {
    showcase = await openShowcase({ freeze: true, query: "panel=all" });
    await enterSession(showcase.page, { freeze: true });
  });

  after(async () => {
    await showcase?.close();
  });

  test("every panel is mounted, with nothing to step through", async () => {
    const ids = await panelIds(showcase.page);
    await showcase.page.waitForFunction(
      (count) =>
        document.querySelectorAll("[data-xr-portal] [data-panel]").length === count &&
        !document.querySelector("[data-xr-loading]"),
      ids.length,
      { timeout: 30_000 },
    );
    const state = await showcase.page.evaluate(() => ({
      mounted: [...document.querySelectorAll("[data-xr-portal] [data-panel]")].map((panel) =>
        panel.getAttribute("data-panel"),
      ),
      steps: document.querySelectorAll(".deck-step").length,
      panel: new URL(location.href).searchParams.get("panel"),
      // The last panel's heading, which the deck would only find on show.
      located: !!window.__showcase?.locate('[data-panel="widgets"] h1'),
    }));
    assert.deepEqual(state, { mounted: ids, steps: 0, panel: "all", located: true });
  });
});

describe("the frame rate readout in the deck", { timeout: 120_000 }, () => {
  // Head-locked, the readout lands on the card wherever it is comfortable
  // to read, so the deck starts with it hidden and a button on the
  // switcher's bar shows it.

  /** @type {Awaited<ReturnType<typeof openShowcase>>} */
  let showcase;

  before(async () => {
    showcase = await openShowcase({ freeze: true });
  });

  after(async () => {
    await showcase?.close();
  });

  test("starts hidden, and the switcher's button shows and hides it", async () => {
    const { page } = showcase;
    await page.waitForFunction(() => !!window.__diagnostics, undefined, { timeout: 30_000 });
    const state = () =>
      page.evaluate(() => {
        const button = [...document.querySelectorAll("[data-xr-portal] button")].find((b) =>
          /FPS/.test(b.textContent ?? ""),
        );
        return { shown: window.__diagnostics?.visible.get(), label: button?.textContent };
      });
    const press = () =>
      page.evaluate(() => {
        const button = [...document.querySelectorAll("[data-xr-portal] button")].find((b) =>
          /FPS/.test(b.textContent ?? ""),
        );
        /** @type {HTMLElement | undefined} */ (button)?.click();
      });
    assert.deepEqual(await state(), { shown: false, label: "Show FPS" });
    await press();
    assert.deepEqual(await state(), { shown: true, label: "Hide FPS" });
    await press();
    assert.deepEqual(await state(), { shown: false, label: "Show FPS" });
  });
});

describe("the deck on a phone, outside a session", { timeout: 120_000 }, () => {
  // A camera with a fixed vertical field of view sees less across a page
  // held upright, and a page held sideways is short, with the Prev, XR and
  // Next buttons along its bottom. The page view widens the view until the
  // deck fits, the card clear of both sides and the deck clear of the top
  // and of the buttons.

  /** @type {Awaited<ReturnType<typeof openShowcase>>} */
  let showcase;

  before(async () => {
    showcase = await openShowcase({ freeze: true });
  });

  after(async () => {
    await showcase?.close();
  });

  /**
   * The page photographed at a size, and which px of a row or a column of
   * it are near white, as the card and the switcher's bar are and nothing
   * else on the page is.
   *
   * @param {{ width: number, height: number }} size
   */
  async function photographAt(size) {
    await showcase.page.setViewportSize(size);
    await nextFrames(showcase.page, 10);
    const png = PNG.sync.read(await photographScene(showcase.page, { freeze: true }));
    /** @param {number} x @param {number} y */
    const white = (x, y) => [0, 1, 2].every((c) => png.data[(y * png.width + x) * 4 + c] > 200);
    return {
      png,
      /** @param {number} y */
      row: (y) => [...Array(png.width).keys()].filter((x) => white(x, y)),
      /** @param {number} x */
      column: (x) => [...Array(png.height).keys()].filter((y) => white(x, y)),
    };
  }

  test("held upright, the card fits across the page, clear of both sides", async () => {
    const { png, row } = await photographAt({ width: 412, height: 915 });
    const card = row(Math.floor(png.height / 2));
    assert.ok(card.length > 0, "no card in the middle row");
    assert.ok(
      card[0] > 0 && card[card.length - 1] < png.width - 1,
      `the card runs from ${card[0]} to ${card[card.length - 1]} of ${png.width} px, ` +
        "off the side of the page",
    );
  });

  test("held sideways, the deck fits down the page, clear of the buttons", async () => {
    const { png, column } = await photographAt({ width: 844, height: 390 });
    // The column through the middle of the card and of the switcher's bar.
    const deck = column(Math.floor(png.width / 2));
    assert.ok(deck.length > 0, "no deck in the middle column");
    // The buttons stand 20px up and are about 44px tall.
    const buttonsTop = png.height - 64;
    assert.ok(
      deck[0] > 0 && deck[deck.length - 1] < buttonsTop,
      `the deck runs from ${deck[0]} to ${deck[deck.length - 1]} of ${png.height} px, ` +
        `off the top of the page or under the buttons, which start at ${buttonsTop}`,
    );
  });
});
