import { className, text, style, $, children } from "justdom-core";
import { set, on } from "justdom-core";
import { Signal, component } from "justdom-signal";
import {
  cardStyle,
  captionStyle,
  classes,
  headingStyle,
  rowStyle,
  softButtonStyle,
} from "./panels.js";

/**
 * The box path itself: one quad and a distance field per element, so radii,
 * borders, sizes and opacity are all uniform or scale writes. The meter
 * animates `width` — the layout tier, re-measured every frame while it
 * moves — and the badge is a static CSS transform, drawn rotated, not as its
 * bounds.
 */

const swatchBase = `
  width: 44px;
  height: 44px;
  background-color: rgb(0, 123, 255);
`;

const swatchSquare = className`${swatchBase}`;

const swatchRounded = className`
  ${swatchBase}
  border-radius: 8px;
`;

const swatchOutlined = className`
  ${swatchBase}
  background-color: rgb(250, 250, 253);
  border: 3px solid rgb(221, 64, 104);
  border-radius: 12px;
`;

const swatchPill = className`
  width: 66px;
  height: 44px;
  background-color: rgb(64, 148, 88);
  border-radius: 999px;
`;

const swatchCircle = className`
  ${swatchBase}
  background-color: rgb(148, 96, 220);
  border: 4px solid rgb(84, 44, 140);
  border-radius: 50%;
`;

/**
 * Outlines are rings outside the border box, with no room in the layout: the
 * offset one stands clear of its box, the negative one cuts into it, and the
 * round one follows its radius out.
 */
const ringed = className`
  outline: 3px solid rgb(240, 170, 60);
`;

const ringedOffset = className`
  outline: 2px solid rgb(221, 64, 104);
  outline-offset: 4px;
`;

const ringedInside = className`
  outline: 3px solid rgb(255, 255, 255);
  outline-offset: -8px;
`;

/**
 * Shadows under each box, drawn under everything else in the panel: a soft
 * card, a spread ring as sharp as a border, an inset well and two layers
 * stacked.
 */
const shadowCard = className`
  ${swatchBase}
  background-color: rgb(250, 250, 253);
  border-radius: 10px;
  box-shadow: 0 6px 12px -2px rgba(20, 30, 60, 0.35);
`;

const shadowRing = className`
  ${swatchBase}
  border-radius: 10px;
  box-shadow: 0 0 0 3px rgb(240, 170, 60);
`;

const shadowInset = className`
  ${swatchBase}
  background-color: rgb(228, 231, 240);
  border-radius: 10px;
  box-shadow: inset 0 3px 6px rgba(20, 30, 60, 0.45);
`;

const shadowStacked = className`
  ${swatchBase}
  background-color: rgb(148, 96, 220);
  border-radius: 50%;
  box-shadow:
    0 0 0 2px rgb(255, 255, 255),
    0 0 0 4px rgb(148, 96, 220),
    4px 6px 10px rgba(20, 30, 60, 0.4);
`;

const fadedStyle = className`
  opacity: 0.6;
`;

const ghostStyle = className`
  opacity: 0.25;
`;

/**
 * Takes up its room and draws nothing. The slot around it keeps the room
 * visible, so a hidden box drawn by mistake is a blue square where an empty
 * frame should be.
 */
const hiddenStyle = className`
  visibility: hidden;
`;

const slotStyle = className`
  border: 2px solid rgb(228, 231, 240);
  border-radius: 10px;
`;

/**
 * Three square-cornered stripes in a window with round corners: the window's
 * `overflow: hidden` is what rounds the outer two, through the clip chain
 * every element in a portal is already subject to.
 */
const cornerWindowStyle = className`
  display: flex;
  width: 220px;
  height: 48px;
  border-radius: 16px;
  overflow: hidden;
`;

const stripeStyle = className`
  flex: 1;
`;

const STRIPES = ["rgb(240, 170, 60)", "rgb(0, 168, 150)", "rgb(221, 64, 104)"];

const meterTrackStyle = className`
  height: 16px;
  background-color: rgb(228, 231, 240);
  border-radius: 999px;
`;

const meterFillStyle = className`
  height: 16px;
  background-color: rgb(221, 64, 104);
  border-radius: 999px;
  transition: width 0.6s ease;
`;

const badgeStyle = className`
  position: absolute;
  top: -10px;
  right: -14px;
  padding: 5px 12px;
  font-size: 12px;
  color: rgb(255, 255, 255);
  background-color: rgb(221, 64, 104);
  border-radius: 6px;
  transform: rotate(12deg) translateZ(30px);
`;

const BoxesPanel = component((_ctx: WeakKey) => {
  const level = Signal.of(60);

  return $("div", [
    set("className", cardStyle),
    children(
      $("div", [set("className", badgeStyle), children(text`rotated`)]),
      $("h1", [set("className", headingStyle), children(text`Boxes`)]),
      $("p", [set("className", captionStyle), children(text`radii & borders, one quad each`)]),
      $("div", [
        set("className", rowStyle),
        children(
          $("div", [set("className", swatchSquare)]),
          $("div", [set("className", swatchRounded)]),
          $("div", [set("className", swatchOutlined)]),
          $("div", [set("className", swatchPill)]),
          $("div", [set("className", swatchCircle)]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`outline and outline-offset`)]),
      $("div", [
        set("className", rowStyle),
        children(
          $("div", [set("className", classes(swatchSquare, ringed))]),
          $("div", [set("className", classes(swatchRounded, ringedOffset))]),
          $("div", [set("className", classes(swatchRounded, ringedInside))]),
          $("div", [set("className", classes(swatchCircle, ringedOffset))]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`box-shadow, outer and inset`)]),
      $("div", [
        set("className", rowStyle),
        children(
          $("div", [set("className", shadowCard)]),
          $("div", [set("className", shadowRing)]),
          $("div", [set("className", shadowInset)]),
          $("div", [set("className", shadowStacked)]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`opacity & visibility`)]),
      $("div", [
        set("className", rowStyle),
        children(
          $("div", [set("className", swatchRounded)]),
          $("div", [set("className", classes(swatchRounded, fadedStyle))]),
          $("div", [set("className", classes(swatchRounded, ghostStyle))]),
          $("div", [
            set("className", slotStyle),
            children($("div", [set("className", classes(swatchRounded, hiddenStyle))])),
          ]),
        ),
      ]),
      $("p", [
        set("className", captionStyle),
        children(text`overflow: hidden clips a rounded corner`),
      ]),
      $("div", [
        set("className", cornerWindowStyle),
        children(
          ...STRIPES.map((color) =>
            $("div", [set("className", stripeStyle), style({ backgroundColor: color })]),
          ),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`width transition, the layout tier`)]),
      $("div", [
        set("className", meterTrackStyle),
        children(
          $("div", [set("className", meterFillStyle), style("width", () => `${level.get()}%`)]),
        ),
      ]),
      $("div", [
        set("className", rowStyle),
        style({ marginTop: "10px" }),
        children(
          ...[30, 60, 90].map((value) =>
            $("button", [
              set("className", softButtonStyle),
              children(text`${value}%`),
              on("click", () => level.set(value)),
            ]),
          ),
        ),
      ]),
    ),
  ]);
});

export default BoxesPanel;
