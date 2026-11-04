import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  paintServerEqual,
  readPaintServer,
  SPREAD_PAD,
  SPREAD_REFLECT,
  SPREAD_REPEAT,
} from "./paintServer.js";

/**
 * @import {GradientServer, PaintServer} from './paintServer.js';
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * An `<svg>` on the page holding `markup` in its `<defs>`, and a rect to
 * paint against it. jsdom maps no presentation attribute into computed
 * style, so a stop's colour is read through the attribute fallback, as it is
 * everywhere in these suites.
 *
 * @param {string} markup
 */
function setup(markup) {
  const root = document.createElementNS(SVG_NS, "svg");
  root.innerHTML = `<defs>${markup}</defs><rect id="shape" width="10" height="10"/>`;
  document.body.appendChild(root);
  const shape = /** @type {Element} */ (root.querySelector("#shape"));
  return {
    /**
     * @param {string} value
     * @param {{ width: number, height: number } | null} [viewport]
     * @returns {PaintServer | null}
     */
    read(value, viewport = { width: 200, height: 100 }) {
      return readPaintServer(shape, value, () => viewport);
    },
    teardown() {
      root.remove();
    },
  };
}

/**
 * @param {PaintServer | null} server
 * @returns {GradientServer}
 */
function gradient(server) {
  assert.ok(server && server.kind !== "color", `a gradient, got ${server?.kind}`);
  return server;
}

/**
 * @param {readonly number[]} actual
 * @param {readonly number[]} expected
 */
function assertClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => {
    assert.ok(Math.abs(value - expected[i]) < 1e-6, `[${actual}] is not [${expected}]`);
  });
}

describe("paint servers", () => {
  test("a colour is a flat paint, none is nothing", () => {
    const s = setup("");
    const red = s.read("rgb(255, 0, 0)");
    assert.ok(red && red.kind === "color");
    assert.equal(red.paint.color.getHexString(), "ff0000");
    assert.equal(s.read("none"), null);
    s.teardown();
  });

  test("a linear gradient takes SVG's defaults: left to right over the box", () => {
    const s = setup(
      `<linearGradient id="g"><stop offset="0" stop-color="red"/>` +
        `<stop offset="1" stop-color="blue"/></linearGradient>`,
    );
    const g = gradient(s.read("url(#g)"));
    assert.equal(g.kind, "linear");
    assert.equal(g.objectBox, true);
    assert.equal(g.transform, null);
    assert.equal(g.spread, SPREAD_PAD);
    assert.deepEqual(g.coords, [0, 0, 1, 0]);
    assert.equal(g.ramp.straight, true);
    assert.deepEqual(
      g.ramp.stops.map((stop) => stop.position),
      [0, 1],
    );
    assertClose(g.ramp.stops[0].color, [1, 0, 0, 1]);
    assertClose(g.ramp.stops[1].color, [0, 0, 1, 1]);
    s.teardown();
  });

  test("the computed spelling of the reference is followed too", () => {
    const s = setup(`<linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient>`);
    assert.equal(gradient(s.read('url("#g")')).kind, "linear");
    s.teardown();
  });

  test("a radial gradient centres its focus on its centre unless told", () => {
    const s = setup(
      `<radialGradient id="a"><stop offset="0" stop-color="red"/></radialGradient>` +
        `<radialGradient id="b" cx="0.2" fx="40%" fr="0.1"><stop offset="0" stop-color="red"/></radialGradient>`,
    );
    const a = gradient(s.read("url(#a)"));
    assert.equal(a.kind, "radial");
    assertClose(a.coords, [0.5, 0.5, 0.5, 0.5, 0.5, 0]);
    const b = gradient(s.read("url(#b)"));
    assertClose(b.coords, [0.2, 0.5, 0.5, 0.4, 0.5, 0.1]);
    s.teardown();
  });

  test("userSpaceOnUse takes a percentage of the viewport, by axis", () => {
    const s = setup(
      `<linearGradient id="l" gradientUnits="userSpaceOnUse" x1="10" x2="50%" y2="25%">` +
        `<stop offset="0" stop-color="red"/></linearGradient>` +
        `<radialGradient id="r" gradientUnits="userSpaceOnUse" r="10%">` +
        `<stop offset="0" stop-color="red"/></radialGradient>`,
    );
    const l = gradient(s.read("url(#l)"));
    assert.equal(l.objectBox, false);
    assertClose(l.coords, [10, 0, 100, 25]);
    const r = gradient(s.read("url(#r)"));
    // The diagonal over root two: sqrt(200² + 100²) / sqrt(2).
    const diagonal = Math.hypot(200, 100) / Math.SQRT2;
    assertClose(r.coords, [100, 50, diagonal / 10, 100, 50, 0]);
    s.teardown();
  });

  test("a userSpaceOnUse gradient given in numbers reads no viewport", () => {
    const s = setup(
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="1" y1="2" x2="3" y2="4">` +
        `<stop offset="0" stop-color="red"/></linearGradient>`,
    );
    let reads = 0;
    const g = gradient(
      readPaintServer(/** @type {Element} */ (document.getElementById("shape")), "url(#g)", () => {
        reads += 1;
        return { width: 200, height: 100 };
      }),
    );
    assertClose(g.coords, [1, 2, 3, 4]);
    assert.equal(reads, 0);
    s.teardown();
  });

  test("a focus that does not parse is unspecified, so on the centre", () => {
    const s = setup(
      `<radialGradient id="g" cx="0.2" cy="0.3" fx="abc" fy=""><stop offset="0" stop-color="red"/></radialGradient>`,
    );
    assertClose(gradient(s.read("url(#g)")).coords, [0.2, 0.3, 0.5, 0.2, 0.3, 0]);
    s.teardown();
  });

  test("spreadMethod and gradientTransform are read", () => {
    const s = setup(
      `<linearGradient id="a" spreadMethod="reflect" gradientTransform="translate(2 3) scale(2)">` +
        `<stop offset="0" stop-color="red"/></linearGradient>` +
        `<linearGradient id="b" spreadMethod="repeat"><stop offset="0" stop-color="red"/></linearGradient>`,
    );
    const a = gradient(s.read("url(#a)"));
    assert.equal(a.spread, SPREAD_REFLECT);
    assert.deepEqual(a.transform, [2, 0, 0, 2, 2, 3]);
    assert.equal(gradient(s.read("url(#b)")).spread, SPREAD_REPEAT);
    s.teardown();
  });

  test("href lends what a gradient leaves unset, coordinates only between kinds alike", () => {
    const s = setup(
      `<radialGradient id="base" cx="0.1" spreadMethod="repeat" gradientUnits="userSpaceOnUse">` +
        `<stop offset="0" stop-color="red"/><stop offset="1" stop-color="lime"/></radialGradient>` +
        `<linearGradient id="mid" href="#base" x1="0.3"/>` +
        `<linearGradient id="top" xlink:href="#mid" x2="0.9"/>` +
        `<radialGradient id="round" href="#mid" r="0.2"/>`,
    );
    const top = gradient(s.read("url(#top)"));
    assert.equal(top.kind, "linear");
    assert.equal(top.spread, SPREAD_REPEAT, "from the radial one: not a coordinate");
    assert.equal(top.objectBox, false);
    assertClose(top.coords, [0.3, 0, 0.9, 0]);
    assert.equal(top.ramp.stops.length, 2, "the stops come from the end of the chain");
    const round = gradient(s.read("url(#round)"));
    // cx from `base` across the linear `mid`; nothing from `mid` itself.
    // cx and the units from `base`, across the linear `mid`; cy a share of
    // the viewport's height, since the units are user space.
    assertClose(round.coords, [0.1, 50, 0.2, 0.1, 50, 0]);
    s.teardown();
  });

  test("a chain that comes back on itself ends where it would repeat", () => {
    const s = setup(
      `<linearGradient id="a" href="#b" x1="0.5"/>` +
        `<linearGradient id="b" href="#a"><stop offset="0" stop-color="red"/></linearGradient>`,
    );
    const a = gradient(s.read("url(#a)"));
    assertClose(a.coords, [0.5, 0, 1, 0]);
    s.teardown();
  });

  test("stop offsets are clamped, never go back, and take percentages", () => {
    const s = setup(
      `<linearGradient id="g">` +
        `<stop offset="-1" stop-color="red"/>` +
        `<stop offset="60%" stop-color="red"/>` +
        `<stop offset="0.3" stop-color="red"/>` +
        `<stop offset="7" stop-color="red"/>` +
        `<stop stop-color="red"/>` +
        `</linearGradient>`,
    );
    assert.deepEqual(
      gradient(s.read("url(#g)")).ramp.stops.map((stop) => stop.position),
      [0, 0.6, 0.6, 1, 1],
    );
    s.teardown();
  });

  test("stop-opacity is folded into the stop's alpha, and a stop with no colour is black", () => {
    const s = setup(
      `<linearGradient id="g">` +
        `<stop offset="0" stop-color="rgba(255, 0, 0, 0.5)" stop-opacity="0.5"/>` +
        `<stop offset="1"/>` +
        `</linearGradient>`,
    );
    const { stops } = gradient(s.read("url(#g)")).ramp;
    assertClose(stops[0].color, [1, 0, 0, 0.25]);
    assertClose(stops[1].color, [0, 0, 0, 1]);
    s.teardown();
  });

  test("a gradient with no extent paints its last stop's colour", () => {
    const s = setup(
      `<linearGradient id="l" x2="0"><stop offset="0" stop-color="red"/>` +
        `<stop offset="1" stop-color="blue" stop-opacity="0.5"/></linearGradient>` +
        `<radialGradient id="r" r="0"><stop offset="0" stop-color="red"/>` +
        `<stop offset="1" stop-color="lime"/></radialGradient>`,
    );
    const l = s.read("url(#l)");
    assert.ok(l && l.kind === "color");
    assert.equal(l.paint.color.getHexString(), "0000ff");
    assert.equal(l.paint.alpha, 0.5);
    const r = s.read("url(#r)");
    assert.ok(r && r.kind === "color");
    assert.equal(r.paint.color.getHexString(), "00ff00");
    s.teardown();
  });

  test("a gradient with no stops paints nothing, even with a fallback", () => {
    const s = setup(`<linearGradient id="g"/>`);
    assert.equal(s.read("url(#g) red"), null);
    s.teardown();
  });

  test("a reference to nothing a server can be draws the fallback", () => {
    const s = setup(`<rect id="notagradient"/>`);
    const missing = s.read("url(#missing) rgb(0, 128, 0)");
    assert.ok(missing && missing.kind === "color");
    assert.equal(missing.paint.color.getHexString(), "008000");
    assert.equal(s.read("url(#notagradient)"), null);
    s.teardown();
  });

  test("two reads of one gradient are equal; a stop recoloured is not", () => {
    const s = setup(
      `<linearGradient id="g"><stop id="stop" offset="0" stop-color="red"/></linearGradient>`,
    );
    const before = s.read("url(#g)");
    assert.ok(paintServerEqual(before, s.read("url(#g)")));
    document.getElementById("stop")?.setAttribute("stop-color", "blue");
    assert.equal(paintServerEqual(before, s.read("url(#g)")), false);
    s.teardown();
  });
});
