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
 * joined by arrows, the arrows dashed and dotted, the heads polygons — and
 * it is styled the way a diagram on a page is styled, through classes and
 * a stylesheet rather than presentation attributes, because computed style
 * is what the plugin reads. Below it: the same icon through the same
 * `viewBox` at three sizes, a star spun by a CSS animation on its `<g>`, a
 * rotated group, the three line joins and caps, a `stroke-dashoffset`
 * animation (the marching ants every selection rectangle wears) and a stroke
 * colour animated by CSS keyframes. The three animations cost a matrix
 * write, a geometry rebuild and a uniform write respectively, which is worth
 * being able to see side by side.
 *
 * The teal of the diagram's nodes is used nowhere else in the showcase, so
 * the visual suite can count it and know the shapes were drawn.
 */

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
          // A faint dotted grid behind everything, the kind a canvas draws.
          $$("g", [
            attr({ class: "grid" }),
            children(
              $$("line", [attr({ x1: 0, y1: 40, x2: 272, y2: 40 })]),
              $$("line", [attr({ x1: 0, y1: 80, x2: 272, y2: 80 })]),
            ),
          ]),
          // Two nodes and a small third one.
          $$("rect", [attr({ class: "node", x: 16, y: 34, width: 72, height: 44, rx: 8 })]),
          $$("rect", [attr({ class: "node", x: 184, y: 34, width: 72, height: 44, rx: 8 })]),
          $$("circle", [attr({ class: "node", cx: 136, cy: 100, r: 12 })]),
          // Ports on the nodes' edges.
          $$("circle", [attr({ class: "port", cx: 88, cy: 56, r: 4 })]),
          $$("circle", [attr({ class: "port", cx: 184, cy: 56, r: 4 })]),
          // A dashed arrow straight across, head and all.
          $$("line", [attr({ class: "dashed", x1: 94, y1: 56, x2: 168, y2: 56 })]),
          $$("polygon", [attr({ class: "head", points: "168,50 180,56 168,62" })]),
          // A dotted arrow curving down to the small node and back up. Each
          // head is aimed along the last nine units of its curve, which is
          // the direction the dots are read as travelling, with its tip one
          // unit short of the node — and is twelve long by seven wide, since
          // a head near equilateral reads as pointing whichever way its
          // flattest edge faces away from.
          $$("path", [attr({ class: "dotted", d: "M52 80 C 52 112, 110 112, 122 104" })]),
          $$("polygon", [
            attr({ class: "head pink", points: "113.4,110.8 123.5,103.5 111,104.2" }),
          ]),
          $$("path", [attr({ class: "dotted", d: "M150 96 C 170 84, 190 92, 220 80" })]),
          $$("polygon", [attr({ class: "head pink", points: "212.7,86.3 222.9,79 210.4,79.7" })]),
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
