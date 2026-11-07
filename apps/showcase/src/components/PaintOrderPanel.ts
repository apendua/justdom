import { className, text, set, attr, $, children } from "justdom-core";
import { component } from "justdom-signal";
import { cardStyle, captionStyle, classes, headingStyle, rowStyle } from "./panels.js";

/**
 * What is drawn over what: a positioned box over flow that comes after it, a
 * transformed one over its later siblings, a translucent card over a label,
 * and a menu with a submenu laid over the content under them. A box drawn in
 * the wrong order is hidden behind one it should cover, so each specimen is a
 * colour that is missing from the photograph when the order is wrong.
 */

const gridStyle = className`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 24px;
`;

const blockStyle = className`
  width: 70px;
  height: 44px;
  border-radius: 8px;
  background-color: rgb(228, 231, 240);
`;

const darkBlockStyle = className`
  background-color: rgb(200, 206, 222);
`;

const stageStyle = className`
  position: relative;
  height: 100px;
`;

const secondRowStyle = className`
  margin-top: 8px;
`;

const tightRowStyle = className`
  gap: 8px;
`;

const absoluteStyle = className`
  position: absolute;
  left: 46px;
  top: 24px;
  width: 96px;
  height: 48px;
  border-radius: 10px;
  background-color: rgb(0, 123, 255);
  color: rgb(255, 255, 255);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const movedRowStyle = className`
  height: 100px;
`;

const movedStyle = className`
  background-color: rgb(240, 170, 60);
  transform: translateX(40px) rotate(-8deg);
  color: rgb(255, 255, 255);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const cardsStyle = className`
  position: relative;
  width: 180px;
  height: 96px;
`;

const whiteCardStyle = className`
  position: absolute;
  left: 0;
  top: 0;
  width: 140px;
  height: 84px;
  background-color: rgb(255, 255, 255);
  border: 1px solid rgb(214, 218, 230);
`;

/** Pure blue, so that seen through the veil it is a blue nothing else is. */
const labelStyle = className`
  margin: 20px;
  height: 40px;
  background-color: rgb(0, 0, 255);
`;

const veilStyle = className`
  position: absolute;
  left: 12px;
  top: 12px;
  width: 160px;
  height: 84px;
  background-color: rgba(255, 255, 255, 0.5);
  border: 1px solid rgb(160, 166, 184);
`;

/**
 * The button and the menu hanging under it. The anchor is only as big as the
 * button, so the menu's `top: 100%` is the button's bottom edge.
 */
const menuAnchorStyle = className`
  position: relative;
  display: inline-block;
`;

const menuButtonStyle = className`
  font-family: inherit;
  font-size: 13px;
  padding: 7px 12px;
  border: none;
  border-radius: 8px;
  background-color: rgb(0, 123, 255);
  color: rgb(255, 255, 255);
`;

const menuStyle = className`
  position: absolute;
  z-index: 1;
  top: 100%;
  left: 0;
  margin-top: 6px;
  width: 150px;
  padding: 6px;
  background-color: rgb(255, 255, 255);
  border: 2px solid rgb(214, 218, 230);
  border-radius: 10px;
  font-size: 13px;
`;

const submenuStyle = className`
  top: -8px;
  left: 100%;
  margin: 0 0 0 6px;
  width: 120px;
`;

const menuItemStyle = className`
  position: relative;
  padding: 6px 8px;
  border-radius: 6px;
`;

const openItemStyle = className`
  background-color: rgb(232, 240, 255);
`;

const caption = (words: string) =>
  $("p", [set("className", captionStyle), children(text`${words}`)]);

const block = (...more: ReturnType<typeof className>[]) =>
  $("div", [set("className", more.length ? classes(blockStyle, ...more) : blockStyle)]);

const item = (label: string) =>
  $("div", [set("className", menuItemStyle), children(text`${label}`)]);

const PaintOrderPanel = component((_ctx: WeakKey) => {
  return $("div", [
    set("className", cardStyle),
    children(
      $("h1", [set("className", headingStyle), children(text`Paint order`)]),
      $("div", [
        set("className", gridStyle),
        children(
          $("div", [
            children(
              caption("positioned over later flow"),
              $("div", [
                set("className", stageStyle),
                children(
                  $("div", [
                    set("className", classes(rowStyle, tightRowStyle)),
                    children(block(), block(), block()),
                  ]),
                  $("div", [
                    set("className", classes(rowStyle, tightRowStyle, secondRowStyle)),
                    children(block(darkBlockStyle), block(darkBlockStyle), block(darkBlockStyle)),
                  ]),
                  $("div", [set("className", absoluteStyle), children(text`absolute`)]),
                ),
              ]),
            ),
          ]),
          $("div", [
            children(
              caption("transformed over later siblings"),
              $("div", [
                set("className", classes(rowStyle, tightRowStyle, movedRowStyle)),
                children(
                  $("div", [
                    set("className", classes(blockStyle, movedStyle)),
                    children(text`moved`),
                  ]),
                  block(),
                  block(),
                ),
              ]),
            ),
          ]),
          $("div", [
            children(
              caption("translucent card over a label"),
              $("div", [
                set("className", cardsStyle),
                children(
                  $("div", [
                    set("className", whiteCardStyle),
                    children($("div", [set("className", labelStyle)])),
                  ]),
                  $("div", [set("className", veilStyle), attr({ "data-veil": "" })]),
                ),
              ]),
            ),
          ]),
          $("div", [
            children(
              caption("overlay menu, nested"),
              $("div", [
                set("className", menuAnchorStyle),
                children(
                  $("button", [set("className", menuButtonStyle), children(text`Menu ▾`)]),
                  $("div", [
                    set("className", menuStyle),
                    children(
                      item("Rename"),
                      $("div", [
                        set("className", classes(menuItemStyle, openItemStyle)),
                        children(
                          text`Move to ›`,
                          $("div", [
                            set("className", classes(menuStyle, submenuStyle)),
                            children(item("Inbox"), item("Archive")),
                          ]),
                        ),
                      ]),
                      item("Delete"),
                    ),
                  ]),
                ),
              ]),
            ),
          ]),
        ),
      ]),
    ),
  ]);
});

export default PaintOrderPanel;
