import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDashArray,
  parseFillRule,
  parseLength,
  parseLineCap,
  parseLineJoin,
  parsePaint,
  readProperty,
  readShapeMarkup,
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

  describe("readShapeMarkup", () => {
    test("a rect, with auto radii resolved", () => {
      const { el, style } = element("rect", { x: "1", y: "2", width: "10", height: "5" });
      assert.equal(
        readShapeMarkup(style, el),
        '<rect x="1" y="2" width="10" height="5" rx="0" ry="0"/>',
      );
      el.setAttribute("rx", "3");
      assert.equal(
        readShapeMarkup(style, el),
        '<rect x="1" y="2" width="10" height="5" rx="3" ry="3"/>',
      );
    });

    test("a rect with no area is nothing", () => {
      const { el, style } = element("rect", { width: "0", height: "5" });
      assert.equal(readShapeMarkup(style, el), null);
    });

    test("a circle and an ellipse", () => {
      const circle = element("circle", { cx: "5", cy: "5", r: "4" });
      assert.equal(readShapeMarkup(circle.style, circle.el), '<circle cx="5" cy="5" r="4"/>');
      const ellipse = element("ellipse", { rx: "4" });
      assert.equal(
        readShapeMarkup(ellipse.style, ellipse.el),
        '<ellipse cx="0" cy="0" rx="4" ry="4"/>',
      );
      const flat = element("circle", { r: "0" });
      assert.equal(readShapeMarkup(flat.style, flat.el), null);
    });

    test("a line, a polyline and a polygon", () => {
      const line = element("line", { x1: "1", y1: "2", x2: "3", y2: "4" });
      assert.equal(readShapeMarkup(line.style, line.el), '<line x1="1" y1="2" x2="3" y2="4"/>');
      const polygon = element("polygon", { points: "0,0 10,0 5,5" });
      assert.equal(readShapeMarkup(polygon.style, polygon.el), '<polygon points="0,0 10,0 5,5"/>');
      const empty = element("polyline", {});
      assert.equal(readShapeMarkup(empty.style, empty.el), null);
    });

    test("a path, escaped for the document it goes into", () => {
      const { el, style } = element("path", { d: 'M0 0 L10 10 "quoted" & <odd>' });
      assert.equal(
        readShapeMarkup(style, el),
        '<path d="M0 0 L10 10 &quot;quoted&quot; &amp; &lt;odd&gt;"/>',
      );
      el.removeAttribute("d");
      assert.equal(readShapeMarkup(style, el), null);
    });

    test("an element that is not a shape is nothing", () => {
      const { el, style } = element("g", {});
      assert.equal(readShapeMarkup(style, el), null);
    });
  });
});
