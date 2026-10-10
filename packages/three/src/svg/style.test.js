import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isPainted,
  parseDashArray,
  parseFillRule,
  parseLength,
  parseLineCap,
  parseLineJoin,
  parsePaint,
  parsePointerEvents,
  readProperty,
  parsePoints,
  readShapeGeometry,
  shapeGeometryEqual,
} from "./style.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A shape element with the given attributes, as the DOM builds it, and its
 * computed style as jsdom computes it — which knows none of SVG's
 * properties, so every read here goes through the attribute fallback. That
 * is one of the two paths the reader has, and the one a test runner can
 * exercise; the computed-style path is what the showcase's visual suite
 * looks at in a browser.
 *
 * @param {string} tag
 * @param {Record<string, string>} attributes
 */
function element(tag, attributes) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    el.setAttribute(name, value);
  }
  document.body.appendChild(el);
  return { el, style: window.getComputedStyle(el) };
}

/** For a shape with no percentage to resolve: no viewport. */
const noViewport = () => null;

describe("svg style reading", () => {
  test("readProperty falls back to the presentation attribute", () => {
    const { el, style } = element("rect", { fill: "red" });
    assert.equal(readProperty(style, el, "fill"), "red");
    assert.equal(readProperty(style, el, "stroke"), "");
  });

  test("parseLength reads px and unitless, and refuses percentages", () => {
    assert.equal(parseLength("3px"), 3);
    assert.equal(parseLength(" 2.5 "), 2.5);
    assert.equal(parseLength("50%", 7), 7);
    assert.equal(parseLength("auto", 7), 7);
    assert.equal(parseLength("", 7), 7);
  });

  test("parsePaint reads computed colours as sRGB, and none as nothing", () => {
    const paint = parsePaint("rgba(255, 0, 0, 0.5)");
    assert.ok(paint);
    assert.equal(paint.alpha, 0.5);
    assert.equal(paint.color.getHexString(), "ff0000");
    assert.equal(parsePaint("none"), null);
    assert.equal(parsePaint(""), null);
    assert.equal(parsePaint("url(#gradient)"), null);
    const keyword = parsePaint("blue");
    assert.ok(keyword);
    assert.equal(keyword.color.getHexString(), "0000ff");
    assert.equal(keyword.alpha, 1);
    const transparent = parsePaint("transparent");
    assert.ok(transparent);
    assert.equal(transparent.alpha, 0);
  });

  test("parseDashArray reads the computed and the attribute spellings", () => {
    assert.deepEqual(parseDashArray("4px, 2px"), [4, 2]);
    assert.deepEqual(parseDashArray("4 2"), [4, 2]);
    assert.deepEqual(parseDashArray("4,2,1"), [4, 2, 1, 4, 2, 1]);
    assert.equal(parseDashArray("none"), null);
    assert.equal(parseDashArray(""), null);
    assert.equal(parseDashArray("0 0"), null);
  });

  test("the enumerations default to what SVG defaults to", () => {
    assert.equal(parseFillRule("evenodd"), "evenodd");
    assert.equal(parseFillRule(""), "nonzero");
    assert.equal(parseLineCap("round"), "round");
    assert.equal(parseLineCap("anything"), "butt");
    assert.equal(parseLineJoin("bevel"), "bevel");
    assert.equal(parseLineJoin("miter-clip"), "miter");
  });

  test("isPainted counts every paint but none, drawn or not", () => {
    assert.equal(isPainted("rgb(255, 0, 0)"), true);
    assert.equal(isPainted("transparent"), true);
    assert.equal(isPainted("url(#gradient)"), true);
    assert.equal(isPainted("none"), false);
    assert.equal(isPainted(""), false);
  });

  test("parsePointerEvents gives each region its rule, as SVG does", () => {
    const always = { painted: false, visible: false };
    const initial = parsePointerEvents("visiblePainted");
    assert.deepEqual(initial.fill, { painted: true, visible: true });
    assert.equal(parsePointerEvents("auto"), initial);
    assert.equal(parsePointerEvents("bounding-box"), initial);
    assert.equal(parsePointerEvents("toString"), initial, "not read off the prototype");
    assert.deepEqual(parsePointerEvents("none"), { fill: null, stroke: null });
    assert.deepEqual(parsePointerEvents("stroke"), { fill: null, stroke: always });
    assert.deepEqual(parsePointerEvents(" all "), { fill: always, stroke: always });
    assert.deepEqual(parsePointerEvents("visibleFill"), {
      fill: { painted: false, visible: true },
      stroke: null,
    });
    assert.deepEqual(parsePointerEvents("painted").stroke, { painted: true, visible: false });
  });

  describe("readShapeGeometry", () => {
    test("a rect, with auto radii resolved", () => {
      const { el, style } = element("rect", { x: "1", y: "2", width: "10", height: "5" });
      assert.deepEqual(readShapeGeometry(style, el, noViewport), {
        kind: "rect",
        x: 1,
        y: 2,
        width: 10,
        height: 5,
        rx: 0,
        ry: 0,
      });
      el.setAttribute("rx", "3");
      assert.deepEqual(readShapeGeometry(style, el, noViewport), {
        kind: "rect",
        x: 1,
        y: 2,
        width: 10,
        height: 5,
        rx: 3,
        ry: 3,
      });
    });

    test("a rect with no area is nothing", () => {
      const { el, style } = element("rect", { width: "0", height: "5" });
      assert.equal(readShapeGeometry(style, el, noViewport), null);
    });

    test("a circle and an ellipse", () => {
      const circle = element("circle", { cx: "5", cy: "5", r: "4" });
      assert.deepEqual(readShapeGeometry(circle.style, circle.el, noViewport), {
        kind: "circle",
        cx: 5,
        cy: 5,
        r: 4,
      });
      const ellipse = element("ellipse", { rx: "4" });
      assert.deepEqual(readShapeGeometry(ellipse.style, ellipse.el, noViewport), {
        kind: "ellipse",
        cx: 0,
        cy: 0,
        rx: 4,
        ry: 4,
      });
      const flat = element("circle", { r: "0" });
      assert.equal(readShapeGeometry(flat.style, flat.el, noViewport), null);
    });

    test("a line, a polyline and a polygon", () => {
      const line = element("line", { x1: "1", y1: "2", x2: "3", y2: "4" });
      assert.deepEqual(readShapeGeometry(line.style, line.el, noViewport), {
        kind: "line",
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
      });
      const polygon = element("polygon", { points: "0,0 10,0 5,5" });
      assert.deepEqual(readShapeGeometry(polygon.style, polygon.el, noViewport), {
        kind: "polygon",
        points: [0, 0, 10, 0, 5, 5],
      });
      const unreadable = element("polyline", { points: "5" });
      assert.equal(
        readShapeGeometry(unreadable.style, unreadable.el, noViewport),
        null,
        "a list with no whole pair draws nothing",
      );
      const empty = element("polyline", {});
      assert.equal(readShapeGeometry(empty.style, empty.el, noViewport), null);
    });

    test("a path, its d as it is", () => {
      const { el, style } = element("path", { d: " M0 0 L10 10 " });
      assert.deepEqual(readShapeGeometry(style, el, noViewport), {
        kind: "path",
        d: "M0 0 L10 10",
      });
      el.removeAttribute("d");
      assert.equal(readShapeGeometry(style, el, noViewport), null);
    });

    test("a percentage is a share of the viewport, read only for a percentage", () => {
      let reads = 0;
      const viewport = () => {
        reads += 1;
        return { width: 30, height: 40 };
      };
      const plain = element("rect", { width: "10", height: "5" });
      readShapeGeometry(plain.style, plain.el, viewport);
      assert.equal(reads, 0, "a shape with no percentage does not read the viewport");

      const rect = element("rect", { x: "10%", width: "50%", height: "25%", ry: "5%" });
      assert.deepEqual(readShapeGeometry(rect.style, rect.el, viewport), {
        kind: "rect",
        x: 3,
        y: 0,
        width: 15,
        height: 10,
        rx: 2,
        ry: 2,
      });
      assert.equal(reads, 1, "four percentages read the viewport once");
      // A radius is of the diagonal over root two, 50 for 10 by 70.
      const circle = element("circle", { cx: "50%", cy: "50%", r: "10%" });
      assert.deepEqual(
        readShapeGeometry(circle.style, circle.el, () => ({ width: 10, height: 70 })),
        { kind: "circle", cx: 5, cy: 35, r: 5 },
      );
      // With no viewport to measure against, a percentage is the fallback.
      assert.equal(readShapeGeometry(rect.style, rect.el, noViewport), null);
    });

    test("a points list is read as SVG's grammar writes one", () => {
      assert.deepEqual(parsePoints("0, 0 10 ,0\n5,5"), [0, 0, 10, 0, 5, 5], "comma and spaces");
      assert.deepEqual(parsePoints("10-5 .5.5 1e1,2E-1"), [10, -5, 0.5, 0.5, 10, 0.2], "no gaps");
      assert.deepEqual(parsePoints("0,0 10,0 5"), [0, 0, 10, 0], "an odd last number is dropped");
      assert.equal(parsePoints("5"), null);
      assert.equal(parsePoints("a b"), null);
    });

    test("a points list stops at the first thing that is not a number, as a browser's does", () => {
      assert.deepEqual(parsePoints("0,0 x 10,10"), [0, 0], "a word ends the list");
      assert.deepEqual(parsePoints("0,0 --5,5"), [0, 0], "so does a doubled sign");
      assert.deepEqual(parsePoints("0,0 1e999,5 10,10"), [0, 0], "and a number past finite");
      assert.equal(parsePoints("1e,2 3,4"), null, "an exponent with no digits ends it at once");
      assert.deepEqual(
        parsePoints("0,0 10,10,"),
        [0, 0, 10, 10],
        "a trailing comma keeps the pairs",
      );
    });

    test("two readings are equal when every number is", () => {
      /** @type {import("./style.js").ShapeGeometry} */
      const polygon = { kind: "polygon", points: [0, 0, 10, 0] };
      assert.ok(shapeGeometryEqual(polygon, { kind: "polygon", points: [0, 0, 10, 0] }));
      assert.ok(!shapeGeometryEqual(polygon, { kind: "polygon", points: [0, 0, 10, 1] }));
      assert.ok(!shapeGeometryEqual(polygon, { kind: "polyline", points: [0, 0, 10, 0] }));
      assert.ok(!shapeGeometryEqual(polygon, { kind: "polygon", points: [0, 0, 10, 0, 1, 1] }));
      assert.ok(
        shapeGeometryEqual(
          { kind: "circle", cx: 1, cy: 2, r: 3 },
          { kind: "circle", cx: 1, cy: 2, r: 3 },
        ),
      );
      assert.ok(
        !shapeGeometryEqual(
          { kind: "circle", cx: 1, cy: 2, r: 3 },
          { kind: "circle", cx: 1, cy: 2, r: 4 },
        ),
      );
      assert.ok(!shapeGeometryEqual({ kind: "path", d: "M0 0" }, null));
    });

    test("an element that is not a shape is nothing", () => {
      const { el, style } = element("g", {});
      assert.equal(readShapeGeometry(style, el, noViewport), null);
    });
  });
});
