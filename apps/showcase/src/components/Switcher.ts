import { className, stylesheet, text, $, children, set, on, CLASS_NAME } from "justdom-core";
import { component, observable } from "justdom-signal";
import { dropdown, type DropdownClasses } from "justdom-three-ui";
import { CARD_WIDTH, fontFamily, softButtonStyle } from "./panels.js";
import { PANELS, stepFrom, type PanelId } from "./registry.js";

/** How tall one row of the switcher's menu is, in px. */
const OPTION_HEIGHT = 30;

/** How tall the bar of controls is, in px. */
export const BAR_HEIGHT = 52;

/**
 * How tall the switcher's panel is: the bar, and under it room for the menu
 * with every panel in it. A portal clips what it holds to its own box, so a
 * menu hanging below a panel only as tall as its bar would be cut off at the
 * bar's edge. The room is empty while the menu is shut, and draws nothing.
 */
export const SWITCHER_HEIGHT = BAR_HEIGHT + 8 + PANELS.length * OPTION_HEIGHT + 16;

const rootStyle = className`
  box-sizing: border-box;
  width: ${CARD_WIDTH}px;
  height: ${SWITCHER_HEIGHT}px;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  font-family: ${fontFamily};
`;

const barStyle = className`
  box-sizing: border-box;
  height: ${BAR_HEIGHT}px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background-color: rgb(250, 250, 253);
  border: 2px solid rgb(214, 218, 230);
  border-radius: 14px;
  color: rgb(40, 44, 58);
`;

const countStyle = className`
  min-width: 44px;
  font-size: 12px;
  text-align: center;
  color: rgb(110, 116, 136);
`;

const pickerRoot = className`
  position: relative;
`;

const pickerTrigger = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    min-width: 180px;
    padding: 4px 12px;
    font-size: 13px;
    background-color: rgb(255, 255, 255);
    border: 2px solid rgb(214, 218, 230);
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.15s ease;
  }

  .${CLASS_NAME}:hover {
    border-color: rgb(0, 123, 255);
  }
`;

const pickerCaret = className`
  color: rgb(110, 116, 136);
`;

const pickerMenu = className`
  position: absolute;
  z-index: 1;
  top: 100%;
  left: 0;
  width: 220px;
  margin-top: 8px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  background-color: rgb(255, 255, 255);
  border: 2px solid rgb(214, 218, 230);
  border-radius: 12px;
`;

const pickerOption = stylesheet`
  .${CLASS_NAME} {
    height: ${OPTION_HEIGHT}px;
    line-height: ${OPTION_HEIGHT}px;
    padding: 0 10px;
    font-size: 13px;
    border-radius: 7px;
    cursor: pointer;
  }

  .${CLASS_NAME}:hover {
    background-color: rgb(232, 240, 255);
  }
`;

const pickerOptionSelected = stylesheet`
  .${CLASS_NAME},
  .${CLASS_NAME}:hover {
    background-color: rgb(0, 123, 255);
    color: rgb(255, 255, 255);
  }
`;

const pickerClasses: DropdownClasses = {
  root: pickerRoot,
  trigger: pickerTrigger,
  caret: pickerCaret,
  menu: pickerMenu,
  option: pickerOption,
  optionSelected: pickerOptionSelected,
};

const OPTIONS = PANELS.map(({ id, title }) => ({ value: id, label: title }));

export interface SwitcherProps {
  /** The panel on show, read reactively. */
  current: () => PanelId;
  /** Asked to put another panel on show. */
  show: (id: PanelId) => void;
  /** The frame rate readout, which the last button shows and hides. */
  readout: {
    /** Whether it is shown, read reactively. */
    shown: () => boolean;
    toggle: () => void;
  };
}

/**
 * The deck's controls, on a panel of their own under the one on show: a step
 * back, a menu of every panel by name, where in the deck this one is, a step
 * on, and a switch for the frame rate readout. The steps wrap around at
 * either end.
 */
const Switcher = component(({ current, show, readout }: SwitcherProps) => {
  const index = () => PANELS.findIndex(({ id }) => id === current());
  const step = (by: number) => () => show(stepFrom(current(), by));

  return $("div", [
    set("className", rootStyle),
    children(
      $("div", [
        set("className", barStyle),
        children(
          $("button", [
            set("className", softButtonStyle),
            on("click", step(-1)),
            children(text`‹ Prev`),
          ]),
          dropdown({
            options: OPTIONS,
            selected: current,
            onSelect: show,
            classes: pickerClasses,
          }),
          $("span", [
            set("className", countStyle),
            children(text`${observable(() => `${index() + 1} / ${PANELS.length}`)}`),
          ]),
          $("button", [
            set("className", softButtonStyle),
            on("click", step(1)),
            children(text`Next ›`),
          ]),
          $("button", [
            set("className", softButtonStyle),
            on("click", readout.toggle),
            children(text`${observable(() => (readout.shown() ? "Hide FPS" : "Show FPS"))}`),
          ]),
        ),
      ]),
    ),
  ]);
});

export default Switcher;
