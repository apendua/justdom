import {
  className,
  stylesheet,
  text,
  $,
  type $$,
  attr,
  children,
  set,
  CLASS_NAME,
} from "justdom-core";
import { component } from "justdom-signal";
import { cardStyle, captionStyle, classes, headingStyle, rowStyle } from "./panels.js";
import { svg, svgText } from "./svgTree.js";

/**
 * Inline SVG, drawn through `justdom-three/svg`, the way a page draws it:
 * an icon sprite of `<symbol>`s drawn by `<use>` everywhere below, a pipeline
 * diagram of nodes, arrows with marker heads, dashed and dotted edges and
 * labels, a chart whose line overshoots its plot and is cut back by a
 * `clip-path`, and a row of icons that a hover recolours, at three sizes, as
 * a rating and in motion, with two pictures drawn through `<image>`.
 *
 * Everything is styled through classes and a stylesheet rather than
 * presentation attributes, because computed style is what the plugin reads.
 * The teal is the pipeline's, on its nodes, the cache's outline and icon,
 * its port and its pulse, and the orange is the chart line's; nothing else
 * on the panel wears either, so the visual suite can count them.
 */

/** The nodes' fill: the colour the visual suite looks for. */
const NODE_COLOR = "rgb(0, 168, 150)";

/** The chart's line: the colour the clip-path check counts. */
const LINE_COLOR = "rgb(255, 110, 0)";

/**
 * Two pictures for `<image>` elements, as data URLs so no asset travels with
 * the app. One is a bitmap, a 16px PNG of four squares, and one is an SVG
 * file, which is drawn as a bitmap of itself as it would be in an `<img>`.
 */
const RASTER_PICTURE =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAIUlEQVR42mP4sMoGKwrR6cGKGEY10EQDLglcBo1qoIkGAGorcRAqZXGIAAAAAElFTkSuQmCC";

const VECTOR_PICTURE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24">` +
    `<circle cx="12" cy="12" r="11" fill="rgb(0,123,255)"/>` +
    `<path d="M7 12.5l3.5 3.5 6.5-7.5" fill="none" stroke="white" stroke-width="2.5"` +
    ` stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`,
)}`;

/** Ids in the document, prefixed so no other panel's can clash with them. */
const ID = {
  source: "vec-source",
  parse: "vec-parse",
  render: "vec-render",
  cache: "vec-cache",
  play: "vec-play",
  pause: "vec-pause",
  search: "vec-search",
  gear: "vec-gear",
  star: "vec-star",
  head: "vec-head",
  pinkHead: "vec-pink-head",
  dot: "vec-dot",
  plot: "vec-plot",
};

const ref = (id: string) => `url(#${id})`;

const panelStyle = stylesheet`
  @keyframes ${CLASS_NAME}-march {
    to { stroke-dashoffset: -9px; }
  }

  @keyframes ${CLASS_NAME}-pulse {
    from { transform: scale(1); opacity: 0.9; }
    to { transform: scale(1.6); opacity: 0; }
  }

  @keyframes ${CLASS_NAME}-spin {
    to { transform: rotate(360deg); }
  }

  @keyframes ${CLASS_NAME}-beat {
    0%, 100% { fill: rgb(221, 64, 104); }
    50% { fill: rgb(148, 96, 220); }
  }

  .${CLASS_NAME} .sprite {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
  }

  .${CLASS_NAME} .board {
    display: block;
    border-radius: 12px;
    background-color: rgb(238, 241, 247);
  }

  .${CLASS_NAME} .node rect {
    fill: ${NODE_COLOR};
    cursor: pointer;
    transition: fill 0.15s ease;
  }

  .${CLASS_NAME} .node rect:hover {
    fill: rgb(0, 128, 114);
  }

  .${CLASS_NAME} .node use {
    color: rgb(255, 255, 255);
  }

  .${CLASS_NAME} .node text {
    fill: rgb(255, 255, 255);
    font-size: 13px;
    font-weight: 600;
    pointer-events: none;
  }

  .${CLASS_NAME} .node.cold rect {
    fill: rgb(250, 250, 253);
    stroke: ${NODE_COLOR};
    stroke-width: 2;
  }

  .${CLASS_NAME} .node.cold use {
    color: ${NODE_COLOR};
  }

  .${CLASS_NAME} .node.cold text {
    fill: rgb(0, 128, 114);
  }

  .${CLASS_NAME} .edge {
    fill: none;
    stroke: rgb(40, 44, 58);
    stroke-width: 2;
  }

  .${CLASS_NAME} .edge.dashed {
    stroke-dasharray: 7 5;
  }

  .${CLASS_NAME} .edge.dotted {
    stroke: rgb(221, 64, 104);
    stroke-dasharray: 0 6;
    stroke-linecap: round;
    stroke-width: 3;
  }

  .${CLASS_NAME} .edge-label {
    fill: rgb(110, 116, 136);
    font-size: 10px;
    letter-spacing: 0.04em;
  }

  .${CLASS_NAME} .edge-label.hit {
    fill: rgb(221, 64, 104);
  }

  /* A selection round the node on show, marching. */
  .${CLASS_NAME} .ants {
    fill: none;
    stroke: rgb(0, 123, 255);
    stroke-width: 2;
    stroke-dasharray: 5 4;
    animation: ${CLASS_NAME}-march 0.8s linear infinite;
  }

  /* A ring that grows out of the cache's port and fades. The origin is the
     port's centre in the board's own units. */
  .${CLASS_NAME} .pulse {
    fill: none;
    stroke: ${NODE_COLOR};
    stroke-width: 2;
    transform-origin: 334px 114px;
    animation: ${CLASS_NAME}-pulse 1.8s ease-out infinite;
  }

  .${CLASS_NAME} .grid {
    stroke: rgb(214, 218, 230);
    stroke-width: 1;
    stroke-dasharray: 3 4;
  }

  .${CLASS_NAME} .axis {
    fill: none;
    stroke: rgb(160, 166, 184);
    stroke-width: 1.5;
  }

  .${CLASS_NAME} .tick {
    fill: rgb(110, 116, 136);
    font-size: 10px;
  }

  .${CLASS_NAME} .line {
    fill: none;
    stroke: ${LINE_COLOR};
    stroke-width: 3;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .${CLASS_NAME} .area {
    fill: ${LINE_COLOR};
    fill-opacity: 0.12;
  }

  .${CLASS_NAME} .point {
    fill: rgb(255, 255, 255);
    stroke: ${LINE_COLOR};
    stroke-width: 2.5;
  }

  .${CLASS_NAME} .limit {
    stroke: rgb(221, 64, 104);
    stroke-width: 1.5;
    stroke-dasharray: 6 4;
  }

  .${CLASS_NAME} .limit-label {
    fill: rgb(221, 64, 104);
    font-size: 10px;
    font-weight: 700;
  }

  .${CLASS_NAME} .tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: none;
    border-radius: 10px;
    background-color: rgb(228, 231, 240);
    color: rgb(40, 44, 58);
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
  }

  .${CLASS_NAME} .tool:hover {
    background-color: rgb(0, 123, 255);
    color: rgb(255, 255, 255);
  }

  .${CLASS_NAME} .tool svg {
    width: 22px;
    height: 22px;
  }

  .${CLASS_NAME} .star-on {
    color: rgb(240, 170, 60);
  }

  .${CLASS_NAME} .star-off {
    color: rgb(200, 206, 222);
  }

  .${CLASS_NAME} .spinner {
    transform-origin: 17px 17px;
    animation: ${CLASS_NAME}-spin 1.2s linear infinite;
  }

  .${CLASS_NAME} .spinner circle {
    fill: none;
    stroke: rgb(0, 123, 255);
    stroke-width: 4;
    stroke-linecap: round;
    stroke-dasharray: 60 200;
  }

  .${CLASS_NAME} .heart {
    animation: ${CLASS_NAME}-beat 2.4s ease-in-out infinite;
  }
`;

const toolRowStyle = className`
  gap: 8px;
`;

/** A `<symbol>` in the sprite, drawn in whatever colour its `<use>` has. */
const symbol = (id: string, ...kids: ReturnType<typeof $$>[]) =>
  svg("symbol", { id, viewBox: "0 0 24 24" }, ...kids);

const outline = (extra: Record<string, string | number> = {}) => ({
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 2,
  ...extra,
});

/** The icons, one `<symbol>` each, in an `<svg>` that takes up no room. */
const sprite = () =>
  svg(
    "svg",
    { class: "sprite", "aria-hidden": "true" },
    symbol(
      ID.source,
      svg(
        "g",
        outline(),
        svg("ellipse", { cx: 12, cy: 5, rx: 8, ry: 3 }),
        svg("path", { d: "M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" }),
        svg("path", { d: "M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" }),
      ),
    ),
    symbol(
      ID.parse,
      svg(
        "g",
        outline({ "stroke-linecap": "round", "stroke-linejoin": "round" }),
        svg("path", { d: "M8 6l-6 6 6 6" }),
        svg("path", { d: "M16 6l6 6-6 6" }),
        svg("path", { d: "M14 4l-4 16" }),
      ),
    ),
    symbol(
      ID.render,
      svg(
        "g",
        outline({ "stroke-linejoin": "round" }),
        svg("path", { d: "M12 2l9 5v10l-9 5-9-5V7z" }),
        svg("path", { d: "M3 7l9 5 9-5M12 12v10" }),
      ),
    ),
    symbol(
      ID.cache,
      svg("path", { ...outline({ "stroke-linejoin": "round" }), d: "M13 2L4 14h7l-1 8 9-12h-7z" }),
    ),
    symbol(ID.play, svg("path", { d: "M7 4l13 8-13 8z", fill: "currentColor" })),
    symbol(
      ID.pause,
      svg(
        "g",
        { fill: "currentColor" },
        svg("rect", { x: 5, y: 4, width: 5, height: 16, rx: 1.5 }),
        svg("rect", { x: 14, y: 4, width: 5, height: 16, rx: 1.5 }),
      ),
    ),
    symbol(
      ID.search,
      svg(
        "g",
        outline({ "stroke-width": 2.5, "stroke-linecap": "round" }),
        svg("circle", { cx: 10.5, cy: 10.5, r: 6.5 }),
        svg("path", { d: "M15.5 15.5L21 21" }),
      ),
    ),
    symbol(
      ID.gear,
      svg(
        "g",
        outline({ "stroke-linejoin": "round" }),
        svg("circle", { cx: 12, cy: 12, r: 3.5 }),
        svg("path", {
          d: "M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1",
        }),
      ),
    ),
    symbol(
      ID.star,
      svg("path", {
        d: "M12 2.5l2.9 6.2 6.8.8-5 4.6 1.4 6.7L12 17.4l-6.1 3.4 1.4-6.7-5-4.6 6.8-.8z",
        fill: "currentColor",
      }),
    ),
  );

/** A node of the pipeline: a rounded box, its icon and its name. */
const node = (x: number, y: number, icon: string, name: string, cold = false) =>
  svg(
    "g",
    { class: cold ? "node cold" : "node", transform: `translate(${x} ${y})` },
    svg("rect", { width: 120, height: 48, rx: 10 }),
    svg("use", { href: `#${icon}`, x: 12, y: 12, width: 24, height: 24 }),
    svgText({ x: 44, y: 29 }, name),
  );

const arrowHead = (id: string, fill: string, size: number) =>
  svg(
    "marker",
    {
      id,
      viewBox: "0 0 10 10",
      refX: 9,
      refY: 5,
      markerWidth: size,
      markerHeight: size,
      orient: "auto-start-reverse",
    },
    svg("path", { d: "M0 0L10 5L0 10z", fill }),
  );

/**
 * Source feeds Parse, which feeds Render and Cache, and Cache feeds Render
 * on a hit. The edges come first, so the nodes sit over their ends.
 */
const pipeline = () =>
  svg(
    "svg",
    {
      class: "board",
      width: 544,
      height: 175,
      viewBox: "0 0 548 176",
      role: "img",
      "aria-label": "Source feeds Parse, which feeds Render and Cache; Cache feeds Render on a hit",
    },
    svg(
      "defs",
      {},
      arrowHead(ID.head, "rgb(40, 44, 58)", 7),
      arrowHead(ID.pinkHead, "rgb(221, 64, 104)", 6),
      svg(
        "marker",
        { id: ID.dot, viewBox: "0 0 10 10", refX: 5, refY: 5, markerWidth: 5, markerHeight: 5 },
        svg("circle", { cx: 5, cy: 5, r: 4, fill: "rgb(40, 44, 58)" }),
      ),
    ),
    svg("path", {
      class: "edge",
      d: "M130 44H204",
      "marker-start": ref(ID.dot),
      "marker-end": ref(ID.head),
    }),
    svgText({ class: "edge-label", x: 167, y: 36, "text-anchor": "middle" }, "bytes"),
    svg("path", { class: "edge dashed", d: "M334 44H408", "marker-end": ref(ID.head) }),
    svgText({ class: "edge-label", x: 371, y: 36, "text-anchor": "middle" }, "tree"),
    svg("path", { class: "edge dashed", d: "M274 70V112", "marker-end": ref(ID.head) }),
    svgText({ class: "edge-label", x: 282, y: 96 }, "store"),
    svg("path", {
      class: "edge dotted",
      d: "M336 138C400 138 468 120 474 76",
      "marker-end": ref(ID.pinkHead),
    }),
    svgText({ class: "edge-label hit", x: 420, y: 150 }, "hit"),
    node(10, 20, ID.source, "Source"),
    node(214, 20, ID.parse, "Parse"),
    node(418, 20, ID.render, "Render"),
    svg("rect", { class: "ants", x: 412, y: 14, width: 132, height: 60, rx: 14 }),
    node(214, 114, ID.cache, "Cache", true),
    svg("circle", { class: "pulse", cx: 334, cy: 114, r: 6 }),
    svg("circle", { cx: 334, cy: 114, r: 5, fill: NODE_COLOR }),
  );

/** Frame time by week, as a line and the area under it. */
const WEEKS = "M40 92L89 80L139 86L188 -10L238 66L287 74L336 58L386 -24L435 70L485 62L534 54";

/**
 * A chart whose line spikes past the top of its plot twice. The plot's
 * `clip-path` cuts the spikes off where the plot ends, so taking it away
 * adds orange above the plot.
 */
const chart = () =>
  svg(
    "svg",
    {
      class: "board",
      width: 544,
      height: 149,
      viewBox: "0 0 548 150",
      role: "img",
      "aria-label": "Frame time by week, with two spikes past the 16 ms budget",
    },
    svg(
      "defs",
      {},
      svg("clipPath", { id: ID.plot }, svg("rect", { x: 40, y: 14, width: 494, height: 106 })),
    ),
    svg(
      "g",
      { class: "grid" },
      svg("line", { x1: 40, y1: 14, x2: 534, y2: 14 }),
      svg("line", { x1: 40, y1: 49, x2: 534, y2: 49 }),
      svg("line", { x1: 40, y1: 84, x2: 534, y2: 84 }),
    ),
    svg("path", { class: "axis", d: "M40 10V120H534" }),
    svgText({ class: "tick", x: 32, y: 18, "text-anchor": "end" }, "24"),
    svgText({ class: "tick", x: 32, y: 53, "text-anchor": "end" }, "16"),
    svgText({ class: "tick", x: 32, y: 88, "text-anchor": "end" }, "8"),
    svgText({ class: "tick", x: 32, y: 124, "text-anchor": "end" }, "0"),
    svgText({ class: "tick", x: 40, y: 138 }, "W1"),
    svgText({ class: "tick", x: 287, y: 138, "text-anchor": "middle" }, "W6"),
    svgText({ class: "tick", x: 534, y: 138, "text-anchor": "end" }, "W11"),
    svg("line", { class: "limit", x1: 40, y1: 49, x2: 534, y2: 49 }),
    svgText({ class: "limit-label", x: 530, y: 44, "text-anchor": "end" }, "16 ms budget"),
    svg(
      "g",
      { "clip-path": ref(ID.plot) },
      svg("path", { class: "area", d: `${WEEKS}V120H40z` }),
      svg("path", { class: "line", d: WEEKS }),
      ...[
        [89, 80],
        [238, 66],
        [336, 58],
        [485, 62],
      ].map(([cx, cy]) => svg("circle", { class: "point", cx, cy, r: 4 })),
    ),
  );

/** A button whose icon is drawn in the button's own colour. */
const tool = (label: string, icon: string) =>
  $("button", [
    attr({ class: "tool", "aria-label": label }),
    children(
      svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, svg("use", { href: `#${icon}` })),
    ),
  ]);

/** The star at one size, in the colour of its `<svg>`. */
const star = (size: number) =>
  svg(
    "svg",
    { width: size, height: size, viewBox: "0 0 24 24", class: "star-on", "aria-hidden": "true" },
    svg("use", { href: `#${ID.star}` }),
  );

/** Three stars of five, one `<symbol>` drawn five times in two colours. */
const rating = () =>
  svg(
    "svg",
    { width: 100, height: 20, viewBox: "0 0 100 20", role: "img", "aria-label": "Rated 3 of 5" },
    ...[0, 1, 2, 3, 4].map((index) =>
      svg("use", {
        href: `#${ID.star}`,
        x: index * 20,
        width: 20,
        height: 20,
        class: index < 3 ? "star-on" : "star-off",
      }),
    ),
  );

const SvgPanel = component((_ctx: WeakKey) => {
  return $("div", [
    set("className", classes(cardStyle, panelStyle)),
    children(
      sprite(),
      $("h1", [set("className", headingStyle), children(text`Vectors`)]),
      $("p", [
        set("className", captionStyle),
        children(text`a pipeline: nodes from <use>, markers, dashes, labels, a live selection`),
      ]),
      pipeline(),
      $("p", [
        set("className", captionStyle),
        children(text`a chart: a line that overshoots, clipped to its plot by a clip-path`),
      ]),
      chart(),
      $("p", [
        set("className", captionStyle),
        children(text`one sprite: hover recolours, sizes, a rating, motion, images`),
      ]),
      $("div", [
        set("className", classes(rowStyle, toolRowStyle)),
        children(
          tool("Play", ID.play),
          tool("Pause", ID.pause),
          tool("Search", ID.search),
          tool("Settings", ID.gear),
          star(24),
          star(36),
          rating(),
          svg(
            "svg",
            { width: 34, height: 34, viewBox: "0 0 34 34", "aria-hidden": "true" },
            svg("g", { class: "spinner" }, svg("circle", { cx: 17, cy: 17, r: 12 })),
          ),
          // Two pictures through `<image>`: the SVG file upright, and the
          // bitmap turned by its group, which an <img> in a box cannot be.
          svg(
            "svg",
            { width: 60, height: 28, viewBox: "0 0 60 28", "aria-hidden": "true" },
            svg("image", { href: VECTOR_PICTURE, x: 0, y: 1, width: 26, height: 26 }),
            svg(
              "g",
              { transform: "rotate(-20 46 14)" },
              svg("image", { href: RASTER_PICTURE, x: 33, y: 1, width: 26, height: 26 }),
            ),
          ),
          svg(
            "svg",
            { width: 30, height: 30, viewBox: "0 0 24 24", "aria-hidden": "true" },
            svg("path", {
              class: "heart",
              d: "M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z",
            }),
          ),
        ),
      ]),
    ),
  ]);
});

export default SvgPanel;
