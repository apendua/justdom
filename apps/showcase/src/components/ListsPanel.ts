import {
  className,
  stylesheet,
  text,
  $,
  children,
  attr,
  list,
  style,
  CLASS_NAME,
} from "justdom-core";
import { set, on } from "justdom-core";
import { Signal, component, observable } from "justdom-signal";
import { cardStyle, captionStyle, classes, headingStyle, softButtonStyle } from "./panels.js";

/**
 * Lists with their markers. The browser lays an item out with room for its
 * bullet or number, but the marker is not in the DOM, so the portal draws it
 * from the item's computed style: the `list-style-type`, where `start`,
 * `reversed` and the item's place in the list put its number, and the
 * colour and font a `::marker` rule gives it. The steps at the bottom grow
 * at the press of a button, and each one arrives numbered.
 */

/** What the steps list starts with, and goes back to. */
const FIRST_STEPS = ["Point the ray", "Press the trigger"];

/** What each press adds, in order, until there is nothing left to add. */
const MORE_STEPS = ["See it numbered", "Press once more"];

const listStyle = className`
  margin: 0;
  padding-left: 29px;
  font-size: 15px;
  line-height: 1.5;
`;

const columnsStyle = className`
  display: flex;
  gap: 28px;
`;

const circleStyle = className`
  list-style-type: circle;
`;

const squareStyle = className`
  list-style-type: square;
`;

const romanStyle = className`
  list-style-type: upper-roman;
`;

const stepsStyle = stylesheet`
  .${CLASS_NAME} li::marker {
    color: rgb(0, 123, 255);
    font-weight: 700;
  }
`;

const insideStyle = className`
  margin: 6px 0 0;
  padding-left: 0;
  list-style-position: inside;
  font-size: 15px;
  line-height: 1.5;
  color: rgb(110, 116, 136);
`;

/** Items with nothing on them but their labels. */
const items = (labels: readonly string[]) =>
  labels.map((label) => $("li", [children(text`${label}`)]));

const ListsPanel = component((_ctx: WeakKey) => {
  const steps = Signal.of<readonly string[]>(FIRST_STEPS);
  const full = () => steps.get().length === FIRST_STEPS.length + MORE_STEPS.length;

  const press = () => {
    const current = steps.get();
    steps.set(full() ? FIRST_STEPS : [...current, MORE_STEPS[current.length - FIRST_STEPS.length]]);
  };

  return $("div", [
    set("className", cardStyle),
    children(
      $("h1", [set("className", headingStyle), children(text`Lists`)]),
      $("p", [set("className", captionStyle), children(text`bullets, from start, reversed`)]),
      $("div", [
        set("className", columnsStyle),
        children(
          $("ul", [
            set("className", listStyle),
            children(
              $("li", [children(text`Disc`)]),
              $("li", [set("className", circleStyle), children(text`Circle`)]),
              $("li", [set("className", squareStyle), children(text`Square`)]),
            ),
          ]),
          $("ol", [
            set("className", listStyle),
            attr({ start: "9" }),
            children(...items(["Nine", "Ten", "Eleven"])),
          ]),
          $("ol", [
            set("className", classes(listStyle, romanStyle)),
            attr({ reversed: "" }),
            children(...items(["Three", "Two", "One"])),
          ]),
        ),
      ]),
      $("p", [set("className", captionStyle), children(text`::marker colour, live numbers`)]),
      $("ol", [
        set("className", classes(listStyle, stepsStyle)),
        children(
          list(
            () => steps.get(),
            (label) => $("li", [children(text`${label}`)]),
          ),
        ),
      ]),
      $("ul", [
        set("className", insideStyle),
        children($("li", [children(text`An inside marker starts the line`)])),
      ]),
      $("button", [
        set("className", softButtonStyle),
        style({ marginTop: "12px" }),
        children(text`${observable(() => (full() ? "Start over" : "Add a step"))}`),
        on("click", press),
      ]),
    ),
  ]);
});

export default ListsPanel;
