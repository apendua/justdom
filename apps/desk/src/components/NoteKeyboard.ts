import { $, children, stylesheet, className, CLASS_NAME } from "@apendua/justdom";
import { set, component } from "@apendua/signal";
import { keyboard } from "@apendua/justui";
import type { KeyboardTarget } from "@apendua/freedom";

/**
 * The board's surface, in the beige of the desk's own keyboard, so that the
 * board that opens for the note field reads as part of the same machine.
 */
const surfaceStyle = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    width: 448px;
    padding: 8px;
    font-family: "IBM Plex Mono", monospace;
    background: linear-gradient(180deg, #e7dfc8, #d2c7ab);
    border: 2px solid #9e937a;
    border-radius: 12px;
  }
`;

const boardStyle = className`
  gap: 5px;
`;

const rowStyle = className`
  gap: 5px;
`;

const keyStyle = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    padding: 9px 0;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    color: #4a4232;
    background: linear-gradient(180deg, #faf6ea, #dfd6c0);
    border: 1px solid #8c836c;
    border-bottom-width: 4px;
    border-radius: 5px;
    cursor: pointer;
    /* Proud of the board, and pushed into it by a press: the board is only
       ever in a session, where a press goes along z. */
    transform: translateZ(3px);
    transition: transform 0.07s;
  }

  .${CLASS_NAME}:active, .${CLASS_NAME}[data-xr-active] {
    transform: translateZ(0.5px);
  }
`;

// Same specificity as the press rule and later in the document, so a held
// shift stays lit while the ray is on it.
const keyHeldStyle = stylesheet`
  .${CLASS_NAME}, .${CLASS_NAME}[data-xr-active] {
    color: #fff3e6;
    background: linear-gradient(180deg, #e88a5a, #c6512b);
    border-color: #7d2e14;
  }
`;

const classes = {
  root: boardStyle,
  row: rowStyle,
  key: keyStyle,
  keyActive: keyHeldStyle,
};

/**
 * The keyboard a session opens for the note field on the board: justui's
 * board, dressed as the desk. The desk's own keyboard types on the monitor;
 * where this one opens and when it goes are freedom's.
 */
const NoteKeyboard = component(({ onKey, field }: Pick<KeyboardTarget, "onKey" | "field">) =>
  $("div", [set("className", surfaceStyle), children(keyboard({ classes, onKey, field }))]),
);

export default NoteKeyboard;
