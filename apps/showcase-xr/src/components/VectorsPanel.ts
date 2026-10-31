import {
  className,
  stylesheet,
  text,
  attr,
  $,
  $$,
  children,
  set,
  CLASS_NAME,
} from "@apendua/justdom";
import { component } from "@apendua/signal";
import { cardStyle, captionStyle, classes, headingStyle, rowStyle } from "./panels.js";

/**
 * Inline SVG, drawn through `@apendua/freedom/svg`: every mechanism the
 * plugin supports, on one card, so that a photograph of it is a regression
 * test of all of them.
 *
 * The diagram at the top is the case the whole thing exists for — boxes
 * joined by arrows, the arrows dashed and dotted, their heads markers, the
 * nodes labelled through `<text>`, two pictures above them through
 * `<image>`, one turned by its group, and a bar between them that a
 * `clip-path` cuts in half — and
 * it is styled the way a diagram on a page is styled, through classes and
 * a stylesheet rather than presentation attributes, because computed style
 * is what the plugin reads. Below it: the same icon through the same
 * `viewBox` at three sizes, a star spun by a CSS animation on its `<g>`, one
 * symbol drawn three times by `<use>` in three fills, a rotated group, the
 * three line joins and caps, a `stroke-dashoffset`
 * animation (the marching ants every selection rectangle wears) and a stroke
 * colour animated by CSS keyframes. The three animations cost a matrix
 * write, a geometry rebuild and a uniform write respectively, which is worth
 * being able to see side by side.
 *
 * The teal of the diagram's nodes is used nowhere else in the showcase, so
 * the visual suite can count it and know the shapes were drawn. The orange
 * of the clipped bar is the same kind of marker: half of it is shown, so the
 * suite can count it with the clip and without.
 */

/**
 * Two pictures for the diagram's `<image>` elements, as data URLs so no
 * asset travels with the app. One is a bitmap, a 16px PNG of four squares,
 * and one is an SVG file, which is drawn as a bitmap of itself as it would
 * be in an `<img>`.
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

/** The ids of the diagram's two arrowhead markers. */
const DARK_HEAD = "vectors-dark-head";
const PINK_HEAD = "vectors-pink-head";

/** The id of the symbol the icon row draws three times. */
const DOT = "vectors-dot";

/** The id of the clip that shows the left half of the orange bar. */
const HALF = "vectors-half";

/** The clipped bar's fill: a colour the visual suite looks for. */
export const CLIPPED_COLOR = "rgb(255, 110, 0)";

/** The nodes' fill: the colour the visual suite looks for. */
export const NODE_COLOR = "rgb(0, 168, 150)";

const diagramStyle = stylesheet`
  .${CLASS_NAME} {
    display: block;
    width: 17rem;
    height: 7.5rem;
    background-color: rgb(244, 245, 250);
    border: 1px solid rgb(214, 218, 230);
    border-radius: 10px;
  }

  .${CLASS_NAME} .node {
    fill: ${NODE_COLOR};
    stroke: rgb(0, 118, 105);
    stroke-width: 2;
    cursor: pointer;
  }

  /* The nodes are ray targets of their own and light up under the ray, as
     a button does. A new fill is a colour write, and the node keeps its
     place in the draw order. */
  .${CLASS_NAME} .node[data-xr-hover] {
    fill: rgb(64, 204, 186);
  }

  .${CLASS_NAME} .node[data-xr-active] {
    fill: rgb(0, 118, 105);
  }

  /* The nodes' labels, laid out by the browser and drawn through <text>.
     They let a press through to the node under them, as they would on a
     page. */
  .${CLASS_NAME} .label {
    fill: rgb(255, 255, 255);
    font-family: system-ui, sans-serif;
    font-size: 13px;
    font-weight: 600;
    text-anchor: middle;
    pointer-events: none;
  }

  .${CLASS_NAME} .port {
    fill: rgb(250, 250, 253);
    stroke: rgb(0, 118, 105);
    stroke-width: 1.5;
  }

  .${CLASS_NAME} .dashed {
    fill: none;
    stroke: rgb(40, 44, 58);
    stroke-width: 2;
    stroke-dasharray: 6 4;
    stroke-linecap: round;
  }

  .${CLASS_NAME} .dotted {
    fill: none;
    stroke: rgb(221, 64, 104);
    stroke-width: 2.5;
    stroke-dasharray: 0 6;
    stroke-linecap: round;
  }

  .${CLASS_NAME} .head {
    fill: rgb(40, 44, 58);
  }

  .${CLASS_NAME} .head.pink {
    fill: rgb(221, 64, 104);
  }

  .${CLASS_NAME} .clipped {
    fill: ${CLIPPED_COLOR};
  }

  .${CLASS_NAME} .grid {
    fill: none;
    stroke: rgb(214, 218, 230);
    stroke-width: 1;
    stroke-dasharray: 2 3;
  }
`;

/**
 * One icon, three sizes: the `viewBox` scales it, and `fill: currentColor`
 * takes the colour from the element around it, as an icon on a page does.
 */
const iconStyle = stylesheet`
  @keyframes ${CLASS_NAME}-spin {
    to { transform: rotate(360deg); }
  }

  .${CLASS_NAME} {
    display: block;
    color: rgb(0, 123, 255);
  }

  .${CLASS_NAME} .ring {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }

  .${CLASS_NAME} .tick {
    fill: none;
    stroke: currentColor;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .${CLASS_NAME} .star {
    fill: rgb(240, 180, 40);
    stroke: rgb(178, 122, 24);
    stroke-width: 1;
    stroke-linejoin: round;
  }

  /* About the viewBox's centre: a group's transform moves its shapes
     without touching their geometry, one matrix per frame. */
  .${CLASS_NAME} .spin {
    transform-origin: 12px 12px;
    animation: ${CLASS_NAME}-spin 6s linear infinite;
  }
`;

const iconSmall = className`
  width: 1.5rem;
  height: 1.5rem;
`;

const iconMedium = className`
  width: 2.5rem;
  height: 2.5rem;
`;

const iconLarge = className`
  width: 4rem;
  height: 4rem;
  color: rgb(148, 96, 220);
`;

const strokesStyle = stylesheet`
  @keyframes ${CLASS_NAME}-march {
    to { stroke-dashoffset: -20px; }
  }

  @keyframes ${CLASS_NAME}-hue {
    0%, 100% { stroke: rgb(0, 123, 255); }
    50% { stroke: rgb(221, 64, 104); }
  }

  .${CLASS_NAME} {
    display: block;
    width: 17rem;
    height: 3.5rem;
  }

  .${CLASS_NAME} .zig {
    fill: none;
    stroke: rgb(64, 148, 88);
    stroke-width: 7;
  }

  .${CLASS_NAME} .miter {
    stroke-linejoin: miter;
    stroke-linecap: butt;
  }

  .${CLASS_NAME} .round {
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .${CLASS_NAME} .bevel {
    stroke-linejoin: bevel;
    stroke-linecap: square;
  }

  .${CLASS_NAME} .ants {
    fill: rgba(0, 123, 255, 0.12);
    stroke: rgb(0, 123, 255);
    stroke-width: 2;
    stroke-dasharray: 6 4;
    animation: ${CLASS_NAME}-march 0.8s linear infinite;
  }

  .${CLASS_NAME} .hue {
    fill: none;
    stroke-width: 4;
    stroke-linecap: round;
    animation: ${CLASS_NAME}-hue 3s ease-in-out infinite;
  }

  .${CLASS_NAME} .diamond {
    fill: rgb(148, 96, 220);
    stroke: rgb(84, 44, 140);
    stroke-width: 2;
    stroke-linejoin: round;
  }
`;

/** A ring with a tick in it, drawn in the element's own colour. */
function icon(size: ReturnType<typeof className>) {
  // `class` as an attribute, not `className`: on an SVG element that
  // property is an `SVGAnimatedString`, not a string to assign.
  return $$("svg", [
    attr("class", classes(iconStyle, size)),
    attr({ viewBox: "0 0 24 24" }),
    children(
      $$("circle", [attr({ class: "ring", cx: 12, cy: 12, r: 10 })]),
      $$("polyline", [attr({ class: "tick", points: "7,12.5 10.5,16 17,8.5" })]),
    ),
  ]);
}

const VectorsPanel = component((_ctx: WeakKey) => {
  return $("div", [
    set("className", cardStyle),
    children(
      $("h1", [set("className", headingStyle), children(text`Vectors`)]),
      $("p", [set("className", captionStyle), children(text`a diagram: dashed & dotted arrows`)]),
      $$("svg", [
        attr("class", diagramStyle),
        attr({ viewBox: "0 0 272 120" }),
        children(
          // The arrowheads, drawn wherever a line names them. Sized in the
          // diagram's own units rather than in stroke widths, so the dashed
          // and the dotted arrows' heads keep the sizes they were drawn at.
          // The pink one is twelve long by seven wide, since a head near
          // equilateral reads as pointing whichever way its flattest edge
          // faces away from.
          $$("defs", [
            children(
              $$("marker", [
                attr({
                  id: DARK_HEAD,
                  viewBox: "0 0 12 12",
                  markerWidth: 12,
                  markerHeight: 12,
                  markerUnits: "userSpaceOnUse",
                  refX: 0,
                  refY: 6,
                  orient: "auto",
                }),
                children($$("path", [attr({ class: "head", d: "M0 0 L12 6 L0 12 z" })])),
              ]),
              $$("marker", [
                attr({
                  id: PINK_HEAD,
                  viewBox: "0 0 12 7",
                  markerWidth: 12,
                  markerHeight: 7,
                  markerUnits: "userSpaceOnUse",
                  refX: 12,
                  refY: 3.5,
                  orient: "auto",
                }),
                children($$("path", [attr({ class: "head pink", d: "M0 0 L12 3.5 L0 7 z" })])),
              ]),
              // The left half of the bar below, which is all of it a
              // browser shows.
              $$("clipPath", [
                attr({ id: HALF }),
                children($$("rect", [attr({ x: 108, y: 8, width: 28, height: 18 })])),
              ]),
            ),
          ]),
          // A faint dotted grid behind everything, the kind a canvas draws.
          $$("g", [
            attr({ class: "grid" }),
            children(
              $$("line", [attr({ x1: 0, y1: 40, x2: 272, y2: 40 })]),
              $$("line", [attr({ x1: 0, y1: 80, x2: 272, y2: 80 })]),
            ),
          ]),
          // Two pictures above the nodes, through `<image>`: the SVG file
          // upright, the bitmap turned by its group, which an <img> in a box
          // cannot be.
          $$("image", [attr({ href: VECTOR_PICTURE, x: 40, y: 4, width: 26, height: 26 })]),
          $$("g", [
            attr({ transform: "rotate(-20 220 17)" }),
            children(
              $$("image", [attr({ href: RASTER_PICTURE, x: 207, y: 4, width: 26, height: 26 })]),
            ),
          ]),
          // A bar between the pictures, cut in half by a `clip-path`.
          $$("rect", [
            attr({
              class: "clipped",
              x: 108,
              y: 8,
              width: 56,
              height: 18,
              "clip-path": `url(#${HALF})`,
            }),
          ]),
          // Two nodes and a small third one.
          $$("rect", [attr({ class: "node", x: 16, y: 34, width: 72, height: 44, rx: 8 })]),
          $$("rect", [attr({ class: "node", x: 184, y: 34, width: 72, height: 44, rx: 8 })]),
          $$("circle", [attr({ class: "node", cx: 136, cy: 100, r: 12 })]),
          // Their labels, centred on them by `text-anchor`.
          $$("text", [attr({ class: "label", x: 52, y: 60 }), children(text`input`)]),
          $$("text", [attr({ class: "label", x: 220, y: 60 }), children(text`output`)]),
          // Ports on the nodes' edges.
          $$("circle", [attr({ class: "port", cx: 88, cy: 56, r: 4 })]),
          $$("circle", [attr({ class: "port", cx: 184, cy: 56, r: 4 })]),
          // A dashed arrow straight across, its head a marker set on after
          // the end of the line.
          $$("line", [
            attr({
              class: "dashed",
              x1: 94,
              y1: 56,
              x2: 168,
              y2: 56,
              "marker-end": `url(#${DARK_HEAD})`,
            }),
          ]),
          // A dotted arrow curving down to the small node and back up. The
          // markers point along each curve's end with the tip on it, which
          // is the direction the dots are read as travelling.
          $$("path", [
            attr({
              class: "dotted",
              d: "M52 80 C 52 112, 110 112, 122 104",
              "marker-end": `url(#${PINK_HEAD})`,
            }),
          ]),
          $$("path", [
            attr({
              class: "dotted",
              d: "M150 96 C 170 84, 190 92, 220 80",
              "marker-end": `url(#${PINK_HEAD})`,
            }),
          ]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`one icon, three sizes, currentColor`)]),
      $("div", [
        set("className", rowStyle),
        children(
          icon(iconSmall),
          icon(iconMedium),
          icon(iconLarge),
          $$("svg", [
            attr("class", classes(iconStyle, iconLarge)),
            attr({ viewBox: "0 0 24 24" }),
            children(
              $$("g", [
                attr({ class: "spin" }),
                children(
                  $$("polygon", [
                    attr({
                      class: "star",
                      points:
                        "12,2 14.9,8.6 22,9.3 16.6,14.1 18.2,21 12,17.4 5.8,21 7.4,14.1 2,9.3 9.1,8.6",
                    }),
                  ]),
                ),
              ]),
            ),
          ]),
          // One symbol drawn three times by <use>. The dot sets no fill of
          // its own, so each copy takes the fill of the <use> that draws it.
          $$("svg", [
            attr("class", classes(iconStyle, iconLarge)),
            attr({ viewBox: "0 0 24 24" }),
            children(
              $$("defs", [
                children(
                  $$("symbol", [
                    attr({ id: DOT, viewBox: "0 0 10 10" }),
                    children($$("circle", [attr({ cx: 5, cy: 5, r: 4.5 })])),
                  ]),
                ),
              ]),
              $$("use", [
                attr({
                  href: `#${DOT}`,
                  x: 1,
                  y: 2,
                  width: 11,
                  height: 11,
                  fill: "rgb(221, 64, 104)",
                }),
              ]),
              $$("use", [
                attr({
                  href: `#${DOT}`,
                  x: 12,
                  y: 2,
                  width: 11,
                  height: 11,
                  fill: "rgb(240, 170, 60)",
                }),
              ]),
              $$("use", [
                attr({
                  href: `#${DOT}`,
                  x: 6.5,
                  y: 11.5,
                  width: 11,
                  height: 11,
                  fill: "rgb(0, 123, 255)",
                }),
              ]),
            ),
          ]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`joins & caps, a rotated group, ants`)]),
      $$("svg", [
        attr("class", strokesStyle),
        attr({ viewBox: "0 0 272 56" }),
        children(
          $$("polyline", [attr({ class: "zig miter", points: "8,44 22,12 36,44 50,12" })]),
          $$("polyline", [attr({ class: "zig round", points: "66,44 80,12 94,44 108,12" })]),
          $$("polyline", [attr({ class: "zig bevel", points: "124,44 138,12 152,44 166,12" })]),
          // A square turned into a diamond by a transform on its group.
          $$("g", [
            attr({ transform: "rotate(45 196 28)" }),
            children(
              $$("rect", [attr({ class: "diamond", x: 182, y: 14, width: 28, height: 28 })]),
            ),
          ]),
          $$("rect", [attr({ class: "ants", x: 224, y: 10, width: 40, height: 36, rx: 4 })]),
          $$("path", [attr({ class: "hue", d: "M8 52 Q 136 40, 264 52" })]),
        ),
      ]),
    ),
  ]);
});

export default VectorsPanel;
