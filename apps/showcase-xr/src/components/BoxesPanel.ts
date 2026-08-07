import { className, stylesheet, text, style, $, children, CLASS_NAME } from "@apendua/justdom";
import { set, on } from "@apendua/justdom";
import { Signal, component } from "@apendua/signal";
import { cardStyle, captionStyle, classes, headingStyle, rowStyle } from "./panels.js";

/**
 * The box path itself: one quad and a distance field per element, so radii,
 * borders and sizes are all uniform or scale writes. The meter animates
 * `width` — the layout tier, re-measured every frame while it moves — and
 * the badge is a static CSS transform, drawn rotated, not as its bounds.
 */

const swatchBase = `
  width: 2.4rem;
  height: 2.4rem;
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
  width: 3.6rem;
  height: 2.4rem;
  background-color: rgb(64, 148, 88);
  border-radius: 999px;
`;

const swatchCircle = className`
  ${swatchBase}
  background-color: rgb(148, 96, 220);
  border: 4px solid rgb(84, 44, 140);
  border-radius: 50%;
`;

const meterTrackStyle = className`
  height: 1rem;
  background-color: rgb(228, 231, 240);
  border-radius: 999px;
`;

const meterFillStyle = className`
  height: 1rem;
  background-color: rgb(221, 64, 104);
  border-radius: 999px;
  transition: width 0.6s ease;
`;

const meterButtonStyle = stylesheet`
  .${CLASS_NAME} {
    padding: 0.35rem 0.8rem;
    font-family: inherit;
    font-size: 0.8rem;
    background-color: rgb(228, 231, 240);
    color: rgb(40, 44, 58);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .${CLASS_NAME}[data-xr-hover] {
    background-color: rgb(200, 206, 222);
  }
`;

const positionedStyle = className`
  position: relative;
`;

const badgeStyle = className`
  position: absolute;
  top: -0.4rem;
  right: -0.6rem;
  padding: 0.3rem 0.7rem;
  font-size: 0.7rem;
  color: rgb(255, 255, 255);
  background-color: rgb(221, 64, 104);
  border-radius: 6px;
  transform: rotate(12deg);
`;

const BoxesPanel = component((_ctx: WeakKey) => {
  const level = Signal.of(60);

  return $("div", [
    set("className", classes(cardStyle, positionedStyle)),
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
      $("p", [set("className", captionStyle), children(text`width transition — the layout tier`)]),
      $("div", [
        set("className", meterTrackStyle),
        children(
          $("div", [set("className", meterFillStyle), style("width", () => `${level.get()}%`)]),
        ),
      ]),
      $("div", [
        set("className", rowStyle),
        style({ marginTop: "0.75rem" }),
        children(
          ...[30, 60, 90].map((value) =>
            $("button", [
              set("className", meterButtonStyle),
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
