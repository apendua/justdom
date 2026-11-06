import { className, stylesheet, $, attr, children, set, CLASS_NAME } from "justdom-core";
import { component } from "justdom-signal";
import { keyboard } from "justdom-three-ui";
import type { KeyboardTarget } from "justdom-three";
import { fontFamily } from "./panels.js";

/**
 * The board the forms panel's fields are typed with: justdom-three-ui's
 * keyboard, dressed for the deck. When it opens, where it hangs and what a
 * key does to the field are the portal's; what is left here is the look.
 */

/** How wide the board is, in px. */
export const KEYBOARD_WIDTH = 440;

const surfaceStyle = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    width: ${KEYBOARD_WIDTH}px;
    padding: 8px;
    font-family: ${fontFamily};
    background-color: rgb(40, 44, 58);
    border-radius: 12px;
  }
`;

const boardStyle = className`
  gap: 4px;
`;

const rowStyle = className`
  gap: 4px;
`;

const keyStyle = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    padding: 9px 0;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    color: rgb(240, 242, 248);
    background-color: rgb(70, 76, 94);
    border-radius: 6px;
    cursor: pointer;
  }

  .${CLASS_NAME}:hover {
    background-color: rgb(96, 104, 128);
  }
`;

/** As specific as the hover rule and later, so a held shift stays lit under the ray. */
const keyHeldStyle = stylesheet`
  .${CLASS_NAME}, .${CLASS_NAME}:hover {
    background-color: rgb(0, 123, 255);
  }
`;

const classes = { root: boardStyle, row: rowStyle, key: keyStyle, keyActive: keyHeldStyle };

const Keyboard = component(({ onKey, field }: Pick<KeyboardTarget, "onKey" | "field">) =>
  $("div", [
    set("className", surfaceStyle),
    // What `window.__showcase.locate` looks for when a selector is not on
    // the panel on show.
    attr({ "data-keyboard": "" }),
    // `field` lets the board follow the field it types into: the number
    // field gets the number pad.
    children(keyboard({ classes, onKey, field })),
  ]),
);

export default Keyboard;
