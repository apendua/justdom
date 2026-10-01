import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { apply } from "./geometry.js";
import {
  bisect,
  findMarker,
  markerMatrix,
  markerVertices,
  parseMarkerReference,
  parseOrient,
  readMarkerSpec,
} from "./marker.js";

// jsdom-env installs the common DOM globals, but not DOMParser, which three's
// SVGLoader parses its document with.
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = window.DOMParser;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @param {string} markup
 */
function parse(markup) {
  return new SVGLoader().parse(`<svg xmlns="${SVG_NS}">${markup}</svg>`).paths[0];
}

/**
 * @param {number} value
 */
function round(value) {
  return Math.round(value * 1e4) / 1e4 + 0;
}

/**
 * @param {ReturnType<typeof markerVertices>} vertices
 */
function summary(vertices) {
  return vertices.map(({ x, y, angle, position }) => [
    round(x),
    round(y),
    round((angle * 180) / Math.PI),
    position,
  ]);
}

/**
 * @param {Record<string, string>} attributes
 */
function marker(attributes) {
  const element = document.createElementNS(SVG_NS, "marker");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

describe("markerVertices", () => {
  test("an open path starts along its first segment, ends along its last, and turns halfway", () => {
    assert.deepEqual(summary(markerVertices(parse(`<polyline points="0,0 10,0 10,10"/>`))), [
      [0, 0, 0, "start"],
      [10, 0, 45, "mid"],
      [10, 10, 90, "end"],
    ]);
  });

  test("a closed path has a vertex at each end of its closing segment", () => {
    // The closing segment runs from (10, 10) back to (0, 0), at -135°, and
    // the first leaves at 0°: halfway between is -67.5°, at both ends.
    assert.deepEqual(summary(markerVertices(parse(`<polygon points="0,0 10,0 10,10"/>`))), [
      [0, 0, -67.5, "start"],
      [10, 0, 45, "mid"],
      [10, 10, 157.5, "mid"],
      [0, 0, -67.5, "end"],
    ]);
  });

  test("a curve's ends point along its tangents", () => {
    // Three finds a curve's tangent by a finite difference, which is a few
    // thousandths of a degree off: compared to a tenth.
    const vertices = markerVertices(parse(`<path d="M0 0 C 0 10, 10 10, 10 0"/>`));
    assert.deepEqual(
      summary(vertices).map(([x, y, angle, position]) => [
        x,
        y,
        Math.round(Number(angle) * 10) / 10,
        position,
      ]),
      [
        [0, 0, 90, "start"],
        [10, 0, -90, "end"],
      ],
    );
  });

  test("an arc after a segment starts where the segment ends, with one vertex there", () => {
    // Three puts a line of rounding error before an arc that does not
    // start exactly at the current point. It is not a segment.
    const vertices = markerVertices(parse(`<path d="M0 0 L10 0 A5 5 0 0 1 20 0 L30 0"/>`));
    const corners = vertices.filter((vertex) => round(vertex.x) === 10 && round(vertex.y) === 0);
    assert.equal(vertices.length, 4);
    assert.equal(corners.length, 1);
    // Arriving along +x, leaving up the arc at -90°: halfway is -45°.
    assert.equal(Math.round((corners[0].angle * 180) / Math.PI), -45);
  });

  test("two arcs in a row meet at one vertex", () => {
    const vertices = markerVertices(parse(`<path d="M0 0 A5 5 0 0 1 10 0 A5 5 0 0 1 20 0"/>`));
    assert.equal(vertices.length, 3);
  });

  test("a second subpath's vertices are all mid but the last", () => {
    const vertices = markerVertices(parse(`<path d="M0 0 L10 0 M20 0 L30 0"/>`));
    assert.deepEqual(
      vertices.map((vertex) => vertex.position),
      ["start", "mid", "mid", "end"],
    );
  });
});

describe("bisect", () => {
  test("a path that doubles back keeps the direction it arrived in", () => {
    assert.equal(bisect(0, Math.PI), 0);
  });
});

describe("parseOrient", () => {
  test("auto, auto-start-reverse, and an angle in any unit", () => {
    assert.equal(parseOrient("auto").kind, "auto");
    assert.equal(parseOrient("auto-start-reverse").kind, "auto-start-reverse");
    assert.equal(round(parseOrient("90").angle), round(Math.PI / 2));
    assert.equal(round(parseOrient("0.25turn").angle), round(Math.PI / 2));
    assert.equal(parseOrient("1rad").angle, 1);
    assert.deepEqual(parseOrient(null), { kind: "angle", angle: 0 });
    assert.deepEqual(parseOrient("sideways"), { kind: "angle", angle: 0 });
  });
});

describe("readMarkerSpec", () => {
  test("a bare marker is three by three stroke widths, not turned", () => {
    assert.deepEqual(readMarkerSpec(marker({})), {
      viewBox: null,
      aspect: { align: "xMidYMid", meet: true },
      width: 3,
      height: 3,
      refX: 0,
      refY: 0,
      strokeUnits: true,
      orient: { kind: "angle", angle: 0 },
    });
  });

  test("refX and refY take the keywords, against the viewBox", () => {
    const spec = readMarkerSpec(
      marker({ viewBox: "0 0 10 8", refX: "right", refY: "center", markerUnits: "userSpaceOnUse" }),
    );
    assert.equal(spec.refX, 10);
    assert.equal(spec.refY, 4);
    assert.equal(spec.strokeUnits, false);
  });
});

describe("markerMatrix", () => {
  // An arrowhead the way a diagram tool writes one: drawn in a 10×10 box,
  // tip at (10, 5), shown 6×6 stroke widths large.
  const arrow = readMarkerSpec(
    marker({
      viewBox: "0 0 10 10",
      markerWidth: "6",
      markerHeight: "6",
      refX: "10",
      refY: "5",
      orient: "auto",
    }),
  );

  test("the reference point lands on the vertex", () => {
    const m = markerMatrix(arrow, { x: 100, y: 50, angle: Math.PI / 2, position: "end" }, 2);
    assert.deepEqual(apply(m, 10, 5).map(round), [100, 50]);
  });

  test("the marker turns with the path and scales with its stroke", () => {
    // Ten units behind the tip is 10 × 0.6 × 2 = 12 px back along the
    // path, which runs down the screen here.
    const m = markerMatrix(arrow, { x: 100, y: 50, angle: Math.PI / 2, position: "end" }, 2);
    assert.deepEqual(apply(m, 0, 5).map(round), [100, 38]);
  });

  test("userSpaceOnUse ignores the stroke width", () => {
    const spec = { ...arrow, strokeUnits: false };
    const m = markerMatrix(spec, { x: 0, y: 0, angle: 0, position: "end" }, 5);
    assert.deepEqual(apply(m, 0, 5).map(round), [-6, 0]);
  });

  test("auto-start-reverse turns the start marker around and no other", () => {
    const spec = { ...arrow, orient: parseOrient("auto-start-reverse") };
    const start = markerMatrix(spec, { x: 0, y: 0, angle: 0, position: "start" }, 1);
    const end = markerMatrix(spec, { x: 0, y: 0, angle: 0, position: "end" }, 1);
    assert.deepEqual(apply(start, 0, 5).map(round), [6, 0]);
    assert.deepEqual(apply(end, 0, 5).map(round), [-6, 0]);
  });

  test("a fixed orient ignores the path's direction", () => {
    const spec = { ...arrow, orient: parseOrient("0") };
    const m = markerMatrix(spec, { x: 0, y: 0, angle: Math.PI / 2, position: "mid" }, 1);
    assert.deepEqual(apply(m, 0, 5).map(round), [-6, 0]);
  });
});

describe("marker references", () => {
  test("a computed url, an attribute's, a full URL and none", () => {
    assert.equal(parseMarkerReference(`url("#arrow")`), "arrow");
    assert.equal(parseMarkerReference("url(#arrow)"), "arrow");
    assert.equal(parseMarkerReference(`url("https://example.com/page#arrow")`), "arrow");
    assert.equal(parseMarkerReference("none"), null);
    assert.equal(parseMarkerReference(""), null);
  });

  test("only a marker is found by its id", () => {
    const root = document.createElementNS(SVG_NS, "svg");
    const found = marker({ id: "found-marker" });
    const other = document.createElementNS(SVG_NS, "g");
    other.setAttribute("id", "not-a-marker");
    root.append(found, other);
    document.body.appendChild(root);
    assert.equal(findMarker(root, "found-marker"), found);
    assert.equal(findMarker(root, "not-a-marker"), null);
    assert.equal(findMarker(root, "missing"), null);
    root.remove();
  });
});
