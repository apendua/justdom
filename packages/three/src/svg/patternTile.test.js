import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Derived } from "justdom-signal";
import { releaseIdleImages } from "../elements/controls/image.js";
import { deferredLoader } from "../test/deferredLoader.js";
import { apply } from "./geometry.js";
import { patternLayout, serializePatternContent, TileHold } from "./patternTile.js";

/**
 * @import {PatternServer} from './paintServer.js';
 * @import {Matrix2D} from './geometry.js';
 */

const SVG_NS = "http://www.w3.org/2000/svg";

afterEach(() => releaseIdleImages());

/**
 * An `<svg>` on the page holding `markup`.
 *
 * @param {string} markup
 */
function page(markup) {
  const root = document.createElementNS(SVG_NS, "svg");
  root.innerHTML = markup;
  document.body.appendChild(root);
  return {
    /** @param {string} id */
    get: (id) => /** @type {Element} */ (document.getElementById(id)),
    teardown: () => root.remove(),
  };
}

/**
 * @param {Partial<PatternServer>} [overrides]
 * @returns {PatternServer}
 */
function pattern(overrides = {}) {
  return {
    kind: "pattern",
    objectBox: false,
    contentObjectBox: false,
    viewBox: null,
    preserveAspectRatio: null,
    transform: null,
    tile: [2, 4, 10, 20],
    content: `<rect width="5" height="5"/>`,
    fallback: null,
    ...overrides,
  };
}

/**
 * @param {readonly number[]} actual
 * @param {readonly number[]} expected
 */
function assertClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => {
    assert.ok(Math.abs(value - expected[i]) < 1e-9, `[${actual}] is not [${expected}]`);
  });
}

/**
 * The tile's markup, out of its URL.
 *
 * @param {string} url
 */
function markupOf(url) {
  return decodeURIComponent(url.slice("data:image/svg+xml,".length));
}

describe("a pattern's content", () => {
  test("is written with its presentation properties inline", () => {
    const p = page(
      `<pattern id="p"><rect width="4" height="2" fill="red" style="stroke: blue"/></pattern>`,
    );
    const markup = serializePatternContent(p.get("p"));
    assert.match(markup, /^<rect width="4" height="2" fill="red" style="[^"]*fill: red/);
    assert.doesNotMatch(markup, /style="stroke: blue"/, "the original style is not copied over");
    p.teardown();
  });

  test("carries what it refers to outside itself, and that thing's references", () => {
    const p = page(
      `<defs><linearGradient id="g" href="#base"/>` +
        `<linearGradient id="base"><stop offset="0" stop-color="red"/></linearGradient></defs>` +
        `<pattern id="p"><rect width="4" height="2" fill="url(#g)"/></pattern>`,
    );
    const markup = serializePatternContent(p.get("p"));
    assert.match(markup, /<defs><linearGradient id="g" href="#base"[^>]*><\/linearGradient>/);
    assert.match(markup, /<linearGradient id="base"[^>]*><stop /);
    p.teardown();
  });

  test("writes an element once, however it is referred to", () => {
    const p = page(
      `<defs><linearGradient id="g"><stop id="s" offset="0" stop-color="red"/></linearGradient></defs>` +
        `<pattern id="p"><use href="#later"/><circle id="later" r="1"/>` +
        `<rect width="1" height="1" fill="url(#g)" stroke="url(#s)"/></pattern>`,
    );
    const markup = serializePatternContent(p.get("p"));
    assert.equal(markup.match(/id="later"/g)?.length, 1);
    assert.equal(markup.match(/id="s"/g)?.length, 1);
    p.teardown();
  });

  test("is nothing when nothing in it draws", () => {
    const p = page(`<pattern id="p"> <title>dots</title> </pattern>`);
    assert.equal(serializePatternContent(p.get("p")), "");
    p.teardown();
  });

  test("escapes what it copies", () => {
    const p = page(`<pattern id="p"><text data-x="a&quot;b">1 &lt; 2</text></pattern>`);
    const markup = serializePatternContent(p.get("p"));
    assert.match(markup, /data-x="a&quot;b"/);
    assert.match(markup, />1 &lt; 2</);
    p.teardown();
  });
});

describe("a pattern laid over a shape", () => {
  test("in user space, the matrix takes the tile to the unit square", () => {
    const layout = patternLayout(pattern(), () => null, 1);
    assert.ok(layout);
    assertClose(apply(layout.matrix, 2, 4), [0, 0]);
    assertClose(apply(layout.matrix, 12, 24), [1, 1]);
    assert.match(markupOf(layout.url), /width="20" height="40" viewBox="0 0 10 20"/);
  });

  test("objectBoundingBox places the tile in the box, and content units scale the content", () => {
    const box = { x: 10, y: 10, width: 100, height: 50 };
    const layout = patternLayout(
      pattern({ objectBox: true, contentObjectBox: true, tile: [0, 0, 0.5, 0.5] }),
      () => box,
      1,
    );
    assert.ok(layout);
    assertClose(apply(layout.matrix, 10, 10), [0, 0]);
    assertClose(apply(layout.matrix, 60, 35), [1, 1]);
    assert.match(markupOf(layout.url), /<g transform="scale\(100 50\)"><rect/);
  });

  test("a viewBox wins over the content units", () => {
    const layout = patternLayout(
      pattern({ contentObjectBox: true, viewBox: "0 0 1 1", preserveAspectRatio: "none" }),
      () => {
        throw new Error("the box is not read");
      },
      1,
    );
    assert.ok(layout);
    const markup = markupOf(layout.url);
    assert.match(markup, /viewBox="0 0 1 1" preserveAspectRatio="none"/);
    assert.doesNotMatch(markup, /scale\(/);
  });

  test("patternTransform turns the tile and draws it as large as it is drawn", () => {
    const layout = patternLayout(pattern({ transform: [2, 0, 0, 2, 0, 0] }), () => null, 1);
    assert.ok(layout);
    assertClose(apply(layout.matrix, 4, 8), [0, 0]);
    assert.match(markupOf(layout.url), /width="40" height="80"/);
  });

  test("the tile is drawn finer as the shape is, up to a cap", () => {
    const coarse = patternLayout(pattern(), () => null, 1);
    const fine = patternLayout(pattern(), () => null, 4);
    const huge = patternLayout(pattern(), () => null, 1000);
    assert.match(markupOf(/** @type {{ url: string }} */ (fine).url), /width="80" height="160"/);
    assert.notEqual(coarse?.url, fine?.url);
    assert.match(markupOf(/** @type {{ url: string }} */ (huge).url), /width="512" height="1024"/);
  });

  test("nothing is drawn over a box with no area or through a flat transform", () => {
    const empty = { x: 0, y: 0, width: 0, height: 10 };
    assert.equal(
      patternLayout(pattern({ objectBox: true }), () => empty, 1),
      null,
    );
    /** @type {Matrix2D} */
    const flat = [1, 0, 0, 0, 0, 0];
    assert.equal(
      patternLayout(pattern({ transform: flat }), () => null, 1),
      null,
    );
  });
});

// The hold cares for URLs alone, so these are pictures the stub need not
// draw on a canvas, as it would an SVG's, one URL apart per test.
describe("a shape's hold on its tiles", () => {
  test("draws nothing while the first tile loads, and the tile once it lands", () => {
    const loader = deferredLoader();
    try {
      const hold = new TileHold();
      const url = "data:image/png;case=1,a";
      assert.equal(hold.texture(url), null);
      assert.equal(loader.loads.length, 1);
      const { texture } = loader.loads[0].land(4, 4);
      assert.equal(hold.texture(url), texture);
      hold.release();
    } finally {
      loader.restore();
    }
  });

  test("keeps drawing the old tile until the new one lands, then lets it go", () => {
    const loader = deferredLoader();
    try {
      const hold = new TileHold();
      hold.texture("data:image/png;case=2,a");
      const old = loader.loads[0].land(4, 4);
      assert.equal(hold.texture("data:image/png;case=2,b"), old.texture, "pending: the old tile");
      const next = loader.loads[1].land(4, 4);
      assert.equal(hold.texture("data:image/png;case=2,b"), next.texture);
      // Let go of, it idles in the cache; the cache forgetting it disposes
      // it, which it could not while it was held.
      releaseIdleImages();
      assert.equal(old.disposed(), 1);
      assert.equal(next.disposed(), 0);
      hold.release();
    } finally {
      loader.restore();
    }
  });

  test("going back to the tile it draws takes no second share", () => {
    const loader = deferredLoader();
    try {
      const hold = new TileHold();
      hold.texture("data:image/png;case=3,a");
      const a = loader.loads[0].land(4, 4);
      hold.texture("data:image/png;case=3,b");
      assert.equal(hold.texture("data:image/png;case=3,a"), a.texture);
      hold.release();
      releaseIdleImages();
      assert.equal(a.disposed(), 1, "every share given back");
    } finally {
      loader.restore();
    }
  });

  test("a tile that fails draws nothing, and lets go of the one before", () => {
    const loader = deferredLoader();
    try {
      const hold = new TileHold();
      hold.texture("data:image/png;case=4,a");
      const a = loader.loads[0].land(4, 4);
      hold.texture("data:image/png;case=4,b");
      loader.loads[1].fail();
      assert.equal(hold.texture("data:image/png;case=4,b"), null);
      releaseIdleImages();
      assert.equal(a.disposed(), 1);
      hold.release();
    } finally {
      loader.restore();
    }
  });

  test("a computation that asks for a tile runs again when it lands", () => {
    const loader = deferredLoader();
    try {
      const hold = new TileHold();
      const drawn = new Derived(() => hold.texture("data:image/png;case=5,a"));
      assert.equal(drawn.get(), null);
      const { texture } = loader.loads[0].land(4, 4);
      assert.equal(drawn.get(), texture);
      hold.release();
    } finally {
      loader.restore();
    }
  });

  test("released while pending, the tile is the cache's to drop when it lands", () => {
    const loader = deferredLoader();
    try {
      const hold = new TileHold();
      hold.texture("data:image/png;case=6,a");
      hold.release();
      const { disposed } = loader.loads[0].land(4, 4);
      releaseIdleImages();
      assert.equal(disposed(), 1);
    } finally {
      loader.restore();
    }
  });
});
