import { className, stylesheet, text, $, attr, children, on, set, CLASS_NAME } from "justdom-core";
import { component, Signal } from "justdom-signal";
import {
  dropdown,
  scrollable,
  type DropdownClasses,
  type ScrollableClasses,
} from "justdom-three-ui";
import { cardStyle, captionStyle, classes, fontFamily, headingStyle, rowStyle } from "./panels.js";

/**
 * The widgets of `justdom-three-ui` and the gestures a panel adds to a page:
 * a dropdown whose menu is an overlay, a scrolling window with arrows, a
 * track and a thumb, a list that hides its overflow and is scrolled by
 * taking hold of it and pulling, and two lists that cards are dragged
 * between with the browser's own drag and drop. The panel itself is
 * `draggable`, so a ray near its edges finds the strips that carry it.
 */

const gridStyle = className`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 24px;
`;

const pickerRoot = className`
  position: relative;
`;

const pickerTrigger = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    display: flex;
    justify-content: space-between;
    width: 170px;
    padding: 8px 12px;
    font-family: ${fontFamily};
    font-size: 14px;
    background-color: rgb(255, 255, 255);
    color: rgb(40, 44, 58);
    border: 2px solid rgb(214, 218, 230);
    border-radius: 10px;
    cursor: pointer;
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
  width: 170px;
  margin-top: 6px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  background-color: rgb(255, 255, 255);
  border: 2px solid rgb(214, 218, 230);
  border-radius: 10px;
`;

const pickerOption = stylesheet`
  .${CLASS_NAME} {
    padding: 6px 8px;
    font-size: 13px;
    border-radius: 6px;
    cursor: pointer;
  }

  .${CLASS_NAME}:hover {
    background-color: rgb(232, 240, 255);
  }
`;

const pickerSelected = stylesheet`
  .${CLASS_NAME},
  .${CLASS_NAME}:hover {
    background-color: rgb(148, 96, 220);
    color: rgb(255, 255, 255);
  }
`;

const pickerClasses: DropdownClasses = {
  root: pickerRoot,
  trigger: pickerTrigger,
  caret: pickerCaret,
  menu: pickerMenu,
  option: pickerOption,
  optionSelected: pickerSelected,
};

const SIZES = ["Small", "Medium", "Large"].map((label) => ({ value: label, label }));

const listStyle = className`
  box-sizing: border-box;
  height: 112px;
  overflow: hidden;
  border: 2px solid rgb(214, 218, 230);
  border-radius: 10px;
  background-color: rgb(255, 255, 255);
`;

const rowItemStyle = className`
  height: 27px;
  line-height: 27px;
  padding: 0 10px;
  font-size: 13px;
  border-bottom: 1px solid rgb(232, 235, 242);
`;

const scrollRoot = className`
  display: flex;
  gap: 6px;
  height: 112px;
`;

const scrollViewport = className`
  box-sizing: border-box;
  flex: 1;
  overflow: hidden;
  border: 2px solid rgb(214, 218, 230);
  border-radius: 10px;
  background-color: rgb(255, 255, 255);
`;

const scrollBar = className`
  width: 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
`;

const scrollButton = stylesheet`
  .${CLASS_NAME} {
    width: 22px;
    height: 22px;
    padding: 0;
    font-family: ${fontFamily};
    font-size: 10px;
    border: none;
    border-radius: 6px;
    background-color: rgb(228, 231, 240);
    cursor: pointer;
  }

  .${CLASS_NAME}:hover {
    background-color: rgb(200, 206, 222);
  }
`;

const scrollTrack = className`
  position: relative;
  flex: 1;
  width: 8px;
  border-radius: 4px;
  background-color: rgb(228, 231, 240);
`;

const scrollThumb = className`
  position: absolute;
  left: 0;
  width: 8px;
  border-radius: 4px;
  background-color: rgb(0, 123, 255);
`;

const scrollClasses: ScrollableClasses = {
  root: scrollRoot,
  viewport: scrollViewport,
  bar: scrollBar,
  button: scrollButton,
  track: scrollTrack,
  thumb: scrollThumb,
};

const dropRowStyle = className`
  align-items: stretch;
  flex-wrap: nowrap;
`;

const dropStyle = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    flex: 1;
    min-height: 96px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 2px solid rgb(214, 218, 230);
    border-radius: 10px;
  }

  .${CLASS_NAME}.over {
    background-color: rgb(240, 245, 255);
    border-color: rgb(0, 123, 255);
  }
`;

const cardItemStyle = className`
  padding: 6px 10px;
  border-radius: 8px;
  background-color: rgb(232, 240, 255);
  font-size: 13px;
  cursor: grab;
`;

const noteStyle = className`
  font-size: 13px;
  line-height: 1.45;
`;

const caption = (words: string) =>
  $("p", [set("className", captionStyle), children(text`${words}`)]);

const rows = (words: readonly string[]) =>
  words.map((word) => $("div", [set("className", rowItemStyle), children(text`${word}`)]));

const FRUIT = [
  "Apples",
  "Bananas",
  "Cherries",
  "Dates",
  "Elderberries",
  "Figs",
  "Grapes",
  "Honeydew",
];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The card being dragged, between its `dragstart` and its `drop`. */
let dragged: HTMLElement | null = null;

/** A card that can be picked up and dropped in either column. */
const card = (label: string) =>
  $("div", [
    set("className", cardItemStyle),
    attr({ draggable: "true", "data-card": label }),
    on("dragstart", (event) => {
      dragged = event.currentTarget as HTMLElement;
      event.dataTransfer?.setData("text/plain", label);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
      }
    }),
    on("dragend", () => {
      dragged = null;
    }),
    children(text`${label}`),
  ]);

/** A column that takes drops, lit while a card is over it. */
const column = (name: string, ...cards: ReturnType<typeof card>[]) =>
  $("div", [
    set("className", dropStyle),
    attr({ "data-column": name }),
    on("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      (event.currentTarget as HTMLElement).classList.add("over");
    }),
    on("dragleave", (event) => {
      (event.currentTarget as HTMLElement).classList.remove("over");
    }),
    on("drop", (event) => {
      event.preventDefault();
      const target = event.currentTarget as HTMLElement;
      target.classList.remove("over");
      if (dragged) {
        target.append(dragged);
      }
    }),
    children(...cards),
  ]);

const WidgetsPanel = component((_ctx: WeakKey) => {
  const size = Signal.of("Medium");

  return $("div", [
    set("className", cardStyle),
    children(
      $("h1", [set("className", headingStyle), children(text`Widgets`)]),
      $("div", [
        set("className", gridStyle),
        children(
          $("div", [
            children(
              caption("dropdown (justdom-three-ui)"),
              dropdown({
                options: SIZES,
                selected: () => size.get(),
                onSelect: (value) => size.set(value),
                classes: pickerClasses,
              }),
            ),
          ]),
          $("div", [
            children(
              caption("draggable: true handles"),
              $("div", [
                set("className", noteStyle),
                children(
                  text`In the scene this panel has strips along its edges that pick it up and carry it. The portal draws them, not the page.`,
                ),
              ]),
            ),
          ]),
          $("div", [
            children(
              caption("scrollable: arrows, track, thumb"),
              scrollable({ classes: scrollClasses, step: 28, content: rows(FRUIT) }),
            ),
          ]),
          $("div", [
            children(
              caption("an overflowing list, pulled by hand"),
              $("div", [
                set("className", listStyle),
                attr({ "data-pulled": "" }),
                children(...rows(DAYS)),
              ]),
            ),
          ]),
        ),
      ]),
      caption("drag and drop between two lists"),
      $("div", [
        set("className", classes(rowStyle, dropRowStyle)),
        children(column("todo", card("Draft"), card("Review")), column("done", card("Done"))),
      ]),
    ),
  ]);
});

export default WidgetsPanel;
