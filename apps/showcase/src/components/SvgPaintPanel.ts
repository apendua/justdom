import { stylesheet, text, $, set, children, CLASS_NAME } from "justdom-core";
import { component } from "justdom-signal";
import { cardStyle, captionStyle, classes, headingStyle } from "./panels.js";
import { svg, svgText } from "./svgTree.js";

/**
 * SVG paint servers: fills and strokes that are gradients and patterns
 * rather than colours. A landscape in which every surface is one of them,
 * and under it a gradient stroke on a gauge, the three spread methods side
 * by side, and a pattern whose tiles are sized to the box it fills.
 *
 * Between them they cover both gradient units, a radial gradient with its
 * focus off centre, `gradientTransform`, a gradient that takes its stops or
 * its geometry from another through `href`, `spreadMethod`, a pattern turned
 * by `patternTransform`, one in user space and one in the box's own units,
 * and a gradient inside a `<symbol>` drawn by `<use>`.
 */

/** Ids in the document, prefixed so no other panel's can clash with them. */
const ID = {
  sky: "paint-sky",
  sun: "paint-sun",
  glow: "paint-glow",
  hills: "paint-hills",
  hillsFar: "paint-hills-far",
  river: "paint-river",
  rows: "paint-rows",
  bricks: "paint-bricks",
  tree: "paint-tree",
  canopy: "paint-canopy",
  gauge: "paint-gauge",
  spread: "paint-spread",
  reflect: "paint-spread-reflect",
  repeat: "paint-spread-repeat",
  checks: "paint-checks",
};

const ref = (id: string) => `url(#${id})`;

const stop = (offset: number, color: string, opacity?: number) =>
  svg(
    "stop",
    opacity === undefined
      ? { offset, "stop-color": color }
      : { offset, "stop-color": color, "stop-opacity": opacity },
  );

const panelStyle = stylesheet`
  .${CLASS_NAME} .scene {
    display: block;
    border-radius: 12px;
  }

  .${CLASS_NAME} .label {
    font-size: 10px;
    letter-spacing: 0.06em;
    fill: rgb(110, 116, 136);
  }

  .${CLASS_NAME} .value {
    font-size: 18px;
    font-weight: 700;
    fill: rgb(40, 44, 58);
  }
`;

/** Hills under a sunset, a striped field, a brick barn, trees and a river. */
const landscape = () =>
  svg(
    "svg",
    {
      class: "scene",
      width: 544,
      height: 208,
      viewBox: "0 0 548 210",
      role: "img",
      "aria-label": "Hills under a sunset, a striped field, a brick barn and a river",
    },
    svg(
      "defs",
      {},
      // In the box's own units, the default, from top to bottom.
      svg(
        "linearGradient",
        { id: ID.sky, x2: 0, y2: 1 },
        stop(0, "rgb(40, 60, 140)"),
        stop(0.55, "rgb(240, 120, 110)"),
        stop(1, "rgb(255, 206, 140)"),
      ),
      // A radial whose focus is up and to the left of its centre.
      svg(
        "radialGradient",
        { id: ID.sun, cx: 0.5, cy: 0.5, r: 0.5, fx: 0.38, fy: 0.36 },
        stop(0, "rgb(255, 250, 220)"),
        stop(0.6, "rgb(255, 206, 90)"),
        stop(1, "rgb(255, 150, 60)"),
      ),
      svg(
        "radialGradient",
        { id: ID.glow },
        stop(0, "rgb(255, 220, 140)", 0.7),
        stop(1, "rgb(255, 220, 140)", 0),
      ),
      // In user space: one gradient across both hills, wherever they sit.
      svg(
        "linearGradient",
        { id: ID.hills, gradientUnits: "userSpaceOnUse", x1: 0, y1: 90, x2: 0, y2: 200 },
        stop(0, "rgb(96, 150, 110)"),
        stop(1, "rgb(30, 80, 60)"),
      ),
      // The near hills' geometry through `href`, moved up by a transform,
      // with stops of its own.
      svg(
        "linearGradient",
        { id: ID.hillsFar, href: `#${ID.hills}`, gradientTransform: "translate(0 -20)" },
        stop(0, "rgb(120, 130, 170)"),
        stop(1, "rgb(80, 90, 130)"),
      ),
      svg(
        "linearGradient",
        { id: ID.river, x1: 0, x2: 1 },
        stop(0, "rgb(120, 200, 255)"),
        stop(1, "rgb(40, 110, 220)"),
      ),
      // Rows of a field, turned by the pattern's own transform.
      svg(
        "pattern",
        {
          id: ID.rows,
          width: 10,
          height: 10,
          patternUnits: "userSpaceOnUse",
          patternTransform: "rotate(-20)",
        },
        svg("rect", { width: 10, height: 10, fill: "rgb(214, 170, 60)" }),
        svg("rect", { width: 10, height: 4, fill: "rgb(176, 128, 40)" }),
      ),
      svg(
        "pattern",
        { id: ID.bricks, width: 16, height: 10, patternUnits: "userSpaceOnUse" },
        svg("rect", { width: 16, height: 10, fill: "rgb(150, 50, 40)" }),
        svg("path", {
          d: "M0 0.5H16M0 5.5H16M4 0.5V5.5M12 5.5V10",
          stroke: "rgb(230, 200, 180)",
          "stroke-width": 1,
          fill: "none",
        }),
      ),
      // A tree whose canopy is a gradient, drawn three times by <use>.
      svg(
        "radialGradient",
        { id: ID.canopy, fx: 0.35, fy: 0.3 },
        stop(0, "rgb(140, 200, 120)"),
        stop(1, "rgb(40, 110, 60)"),
      ),
      svg(
        "symbol",
        { id: ID.tree, viewBox: "0 0 20 40" },
        svg("rect", { x: 8.5, y: 24, width: 3, height: 16, fill: "rgb(90, 60, 40)" }),
        svg("circle", { cx: 10, cy: 15, r: 10, fill: ref(ID.canopy) }),
      ),
    ),
    svg("rect", { width: 548, height: 210, fill: ref(ID.sky) }),
    svg("circle", { cx: 380, cy: 92, r: 60, fill: ref(ID.glow) }),
    svg("circle", { cx: 380, cy: 92, r: 30, fill: ref(ID.sun) }),
    svg("path", {
      d: "M0 132C80 92 170 100 250 120S420 96 548 112V210H0z",
      fill: ref(ID.hillsFar),
    }),
    svg("path", { d: "M0 160C90 126 200 132 290 150S460 132 548 146V210H0z", fill: ref(ID.hills) }),
    svg("path", { d: "M300 210C320 182 380 170 548 166V210z", fill: ref(ID.rows) }),
    svg(
      "g",
      { transform: "translate(96 132)" },
      svg("rect", { y: 12, width: 54, height: 34, fill: ref(ID.bricks) }),
      svg("path", { d: "M-4 14L27 -6L58 14z", fill: "rgb(70, 40, 40)" }),
      svg("rect", { x: 20, y: 26, width: 14, height: 20, fill: "rgb(60, 40, 30)" }),
    ),
    svg("use", { href: `#${ID.tree}`, x: 20, y: 132, width: 20, height: 40 }),
    svg("use", { href: `#${ID.tree}`, x: 44, y: 140, width: 16, height: 32 }),
    svg("use", { href: `#${ID.tree}`, x: 186, y: 138, width: 22, height: 44 }),
    svg("path", {
      d: "M150 210C190 186 230 196 270 182S330 170 360 178",
      fill: "none",
      stroke: ref(ID.river),
      "stroke-width": 9,
      "stroke-linecap": "round",
    }),
  );

/**
 * A 72% gauge stroked with a gradient, one gradient three ways, and a flag
 * of checks. The spread gradient runs over the middle fifth of each box
 * only, so what each method does with the rest is most of what is seen:
 * `pad` holds the end colours, `reflect` mirrors the run back and forth and
 * `repeat` starts it over.
 */
const samples = () =>
  svg(
    "svg",
    {
      width: 544,
      height: 95,
      viewBox: "0 0 548 96",
      role: "img",
      "aria-label": "A 72% gauge and three spread methods",
    },
    svg(
      "defs",
      {},
      svg(
        "linearGradient",
        { id: ID.gauge, x1: 0, x2: 1 },
        stop(0, "rgb(0, 168, 150)"),
        stop(1, "rgb(0, 123, 255)"),
      ),
      svg(
        "linearGradient",
        { id: ID.spread, x1: 0.4, x2: 0.6 },
        stop(0, "rgb(148, 96, 220)"),
        stop(1, "rgb(240, 230, 255)"),
      ),
      svg("linearGradient", { id: ID.reflect, href: `#${ID.spread}`, spreadMethod: "reflect" }),
      svg("linearGradient", { id: ID.repeat, href: `#${ID.spread}`, spreadMethod: "repeat" }),
      // Tiles an eighth of the box wide and a quarter tall, in its own units.
      svg(
        "pattern",
        {
          id: ID.checks,
          width: 0.125,
          height: 0.25,
          patternContentUnits: "objectBoundingBox",
        },
        svg("rect", { width: 0.0625, height: 0.125, fill: "rgb(40, 44, 58)" }),
        svg("rect", {
          x: 0.0625,
          y: 0.125,
          width: 0.0625,
          height: 0.125,
          fill: "rgb(40, 44, 58)",
        }),
      ),
    ),
    svg("circle", {
      cx: 44,
      cy: 48,
      r: 36,
      fill: "none",
      stroke: "rgb(228, 231, 240)",
      "stroke-width": 10,
    }),
    svg("circle", {
      cx: 44,
      cy: 48,
      r: 36,
      fill: "none",
      stroke: ref(ID.gauge),
      "stroke-width": 10,
      "stroke-linecap": "round",
      "stroke-dasharray": "163 300",
      transform: "rotate(-90 44 48)",
    }),
    svgText({ class: "value", x: 44, y: 54, "text-anchor": "middle" }, "72%"),
    ...[ID.spread, ID.reflect, ID.repeat].map((id, index) =>
      svg("rect", {
        "data-spread": index,
        x: 104 + index * 108,
        y: 14,
        width: 96,
        height: 56,
        rx: 8,
        fill: ref(id),
      }),
    ),
    ...["PAD", "REFLECT", "REPEAT", "FLAG"].map((label, index) =>
      svgText({ class: "label", x: 152 + index * 108, y: 88, "text-anchor": "middle" }, label),
    ),
    svg("path", { d: "M432 14H540V70H432z", fill: ref(ID.checks), stroke: "rgb(40, 44, 58)" }),
  );

const SvgPaintPanel = component((_ctx: WeakKey) => {
  return $("div", [
    set("className", classes(cardStyle, panelStyle)),
    children(
      $("h1", [set("className", headingStyle), children(text`SVG paint`)]),
      $("p", [
        set("className", captionStyle),
        children(text`a landscape: every surface a gradient or a pattern`),
      ]),
      landscape(),
      $("p", [
        set("className", captionStyle),
        children(text`a gradient stroke, pad, reflect, repeat, a box pattern`),
      ]),
      samples(),
    ),
  ]);
});

export default SvgPaintPanel;
