import { className, stylesheet, text, $, children, attr, CLASS_NAME } from "justdom-core";
import { set, on } from "justdom-core";
import { Signal, component, observable } from "justdom-signal";
import { cardStyle, captionStyle, classes, headingStyle, rowStyle } from "./panels.js";

/**
 * What a ray does to a panel. Hover and press restyle through the page's own
 * `:hover` and `:active`, which the portal rewrites to answer its
 * `data-xr-hover` and `data-xr-active` flags as well, and every change of
 * transform or colour animates: the transitions play in the scene frame by
 * frame.
 *
 * One button is written against the flag itself, `[data-xr-hover]`, as every
 * panel was before the rewrite. It does nothing on a flat page, and it is
 * here so that the attribute path keeps a photograph of its own.
 *
 * The card with `cursor: pointer` is a target as a button is, the counter
 * follows what every target was pressed, and the tilt runs a transform
 * transition on the whole card. A press on the card itself, between its
 * controls, counts as a click on the panel, which is what a menu's "clicked
 * outside" listens for.
 */

const buttonStyle = stylesheet`
  .${CLASS_NAME} {
    padding: 10px 18px;
    font-family: inherit;
    font-size: 15px;
    background-color: rgb(0, 123, 255);
    color: rgb(255, 255, 255);
    border: none;
    border-radius: 10px;
    cursor: pointer;
    transition:
      transform 0.15s ease,
      background-color 0.15s ease;
  }

  .${CLASS_NAME}:hover {
    background-color: rgb(0, 86, 179);
    transform: scale(1.08);
  }

  .${CLASS_NAME}:active {
    transform: scale(0.92);
  }
`;

/** The button written against the portal's flag rather than `:hover`. */
const flaggedStyle = stylesheet`
  .${CLASS_NAME} {
    background-color: rgb(64, 108, 220);
  }

  .${CLASS_NAME}[data-xr-hover] {
    background-color: rgb(30, 60, 160);
    transform: scale(1.08);
  }
`;

const targetStyle = stylesheet`
  .${CLASS_NAME} {
    width: 170px;
    padding: 12px;
    font-size: 13px;
    background-color: rgb(232, 240, 255);
    border: 2px solid rgb(0, 123, 255);
    border-radius: 12px;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .${CLASS_NAME}:hover {
    background-color: rgb(200, 222, 255);
  }
`;

const countStyle = className`
  display: inline-block;
  padding: 6px 14px;
  font-size: 14px;
  border: 2px solid rgb(214, 218, 230);
  border-radius: 999px;
  color: rgb(0, 123, 255);
`;

const wideRowStyle = className`
  gap: 18px;
`;

const rootCountStyle = className`
  font-size: 13px;
  color: rgb(110, 116, 136);
`;

const tiltableStyle = stylesheet`
  .${CLASS_NAME} {
    transition: transform 0.45s ease;
  }

  .${CLASS_NAME}[data-tilted] {
    transform: rotate(5deg) scale(1.03);
  }
`;

const PointerPanel = component((_ctx: WeakKey) => {
  const clicks = Signal.of(0);
  const panelClicks = Signal.of(0);
  const tilted = Signal.of(false);

  /** Counts a press on a target, and keeps it from counting as one on the panel. */
  const bump = (event: Event) => {
    event.stopPropagation();
    clicks.set(clicks.get() + 1);
  };

  return $("div", [
    set("className", classes(cardStyle, tiltableStyle)),
    attr("data-tilted", () => (tilted.get() ? "true" : undefined)),
    on("click", () => panelClicks.set(panelClicks.get() + 1)),
    children(
      $("h1", [set("className", headingStyle), children(text`Pointer`)]),
      $("p", [
        set("className", captionStyle),
        children(text`plain :hover and :active, and one written against [data-xr-hover]`),
      ]),
      $("div", [
        set("className", rowStyle),
        children(
          $("button", [set("className", buttonStyle), children(text`One`), on("click", bump)]),
          $("button", [set("className", buttonStyle), children(text`Two`), on("click", bump)]),
          $("button", [set("className", buttonStyle), children(text`Three`), on("click", bump)]),
          $("button", [
            set("className", classes(buttonStyle, flaggedStyle)),
            children(text`Attribute`),
            on("click", bump),
          ]),
        ),
      ]),
      $("p", [
        set("className", captionStyle),
        children(text`a cursor: pointer card is a target, a counter, a tilt`),
      ]),
      $("div", [
        set("className", classes(rowStyle, wideRowStyle)),
        children(
          $("div", [
            set("className", targetStyle),
            on("click", bump),
            children(text`A whole card with cursor: pointer takes the ray`),
          ]),
          $("span", [
            set("className", countStyle),
            children(text`Clicks: ${observable(() => clicks.get())}`),
          ]),
          $("button", [
            set("className", buttonStyle),
            children(text`${observable(() => (tilted.get() ? "Straighten" : "Tilt the card"))}`),
            on("click", (event: Event) => {
              event.stopPropagation();
              tilted.set(!tilted.get());
            }),
          ]),
        ),
      ]),
      $("p", [
        set("className", captionStyle),
        children(text`a click on the panel itself, as a menu's "clicked outside"`),
      ]),
      $("div", [
        set("className", rootCountStyle),
        children(text`Clicks on the panel: ${observable(() => panelClicks.get())}`),
      ]),
    ),
  ]);
});

export default PointerPanel;
