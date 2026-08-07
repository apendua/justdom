import { renderText, stylesheet, CLASS_NAME } from "@apendua/justdom";
import type { DropdownClasses } from "@apendua/freedom";
import { palette } from "./palette.js";

export const panelStack = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 300px;
  }
`;

export const panelCard = stylesheet`
  .${CLASS_NAME} {
    font-family: -apple-system, 'Segoe UI', 'Helvetica Neue', sans-serif;
    background: ${palette.panel};
    border: 3px solid ${palette.panelEdge};
    border-radius: 12px;
    padding: 10px;
    color: ${palette.panelText};
  }
`;

export const panelTitle = stylesheet`
  .${CLASS_NAME} {
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 12px;
    color: ${palette.panelMuted};
    padding: 2px 4px 8px 4px;
  }
`;

export const buttonRow = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
`;

export const iconButton = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    width: 50px;
    height: 50px;
    background: ${palette.button};
    border: 2px solid ${palette.buttonEdge};
    border-radius: 10px;
    color: ${palette.panelText};
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: ${palette.buttonHover};
    border-color: #8d7f5c;
  }
`;

export const buttonGlyph = stylesheet`
  .${CLASS_NAME} {
    font-size: 19px;
    line-height: 1;
  }
`;

export const buttonLabel = stylesheet`
  .${CLASS_NAME} {
    font-size: 10px;
    line-height: 1;
    color: ${palette.panelMuted};
  }
`;

export const exampleButton = stylesheet`
  .${CLASS_NAME} {
    background: ${palette.button};
    border: 2px solid ${palette.buttonEdge};
    border-radius: 8px;
    padding: 7px 10px;
    margin: 3px 0;
    font-size: 13px;
    color: ${palette.panelText};
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: ${palette.buttonHover};
    border-color: #8d7f5c;
  }
`;

// Doubled class selector so the active state outranks the base button rules
// regardless of the order their <style> elements were injected in.
export const buttonActive = stylesheet`
  .${CLASS_NAME}.${CLASS_NAME} {
    background: ${palette.buttonActive};
    border-color: #8d7f5c;
    color: #ffffff;
  }

  .${CLASS_NAME}.${CLASS_NAME}:hover, .${CLASS_NAME}.${CLASS_NAME}[data-xr-hover] {
    background: ${palette.buttonActive};
  }

  .${CLASS_NAME}.${CLASS_NAME} div {
    color: #ffffff;
  }
`;

export const musicRow = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    align-items: stretch;
    gap: 6px;
  }
`;

/**
 * Narrow enough for two of them to flank the reading, wide enough to be an easy
 * target at arm's length through a controller ray.
 */
export const stepButton = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    flex: 0 0 50px;
    background: ${palette.button};
    border: 2px solid ${palette.buttonEdge};
    border-radius: 10px;
    padding: 10px 0;
    font-size: 15px;
    line-height: 1;
    text-align: center;
    color: ${palette.panelText};
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: ${palette.buttonHover};
    border-color: #8d7f5c;
  }
`;

export const stepValue = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    flex: 1 1 auto;
    background: rgba(255, 255, 255, 0.05);
    border: 2px solid ${palette.buttonEdge};
    border-radius: 10px;
    padding: 10px 8px;
    font-size: 13px;
    line-height: 1;
    text-align: center;
    color: ${palette.panelText};
  }
`;

const dropdownRoot = stylesheet`
  .${CLASS_NAME} {
    position: relative;
  }
`;

const dropdownTrigger = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 38px;
    padding: 6px 10px;
    background: ${palette.button};
    border: 2px solid ${palette.buttonEdge};
    border-radius: 8px;
    font-size: 13px;
    color: ${palette.panelText};
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: ${palette.buttonHover};
    border-color: #8d7f5c;
  }
`;

const dropdownCaret = stylesheet`
  .${CLASS_NAME} {
    font-size: 10px;
    line-height: 1;
    color: ${palette.panelMuted};
  }
`;

/**
 * Positioned and stacked above: on the flat build that is what puts the menu
 * over the page, and in the portal it is what makes it a layer of its own —
 * drawn in front of the panel, opaque to rays, and clear of it in depth.
 *
 * Absolute rather than in flow for a reason that only shows in XR: an in-flow
 * menu would grow the panel, and the portal centers a panel on its own bounds,
 * so opening one would slide the whole thing out from under the ray that
 * opened it.
 */
const dropdownMenu = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    position: absolute;
    z-index: 1;
    left: 0;
    right: 0;
    top: 100%;
    margin-top: 6px;
    padding: 4px;
    background: ${palette.panel};
    border: 3px solid ${palette.panelEdge};
    border-radius: 10px;
  }
`;

// Doubled, like buttonActive, so it outranks the base rules whichever order
// the two <style> elements were injected in.
const dropdownMenuUp = stylesheet`
  .${CLASS_NAME}.${CLASS_NAME} {
    top: auto;
    bottom: 100%;
    margin-top: 0;
    margin-bottom: 6px;
  }
`;

const dropdownOption = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    /* A ray is a blunter instrument than a mouse. At the distance a panel is
       mounted at this is around three degrees of arc, which is about where
       pointing stops being fiddly. */
    min-height: 36px;
    padding: 0 8px;
    border-radius: 6px;
    font-size: 13px;
    color: ${palette.panelText};
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: ${palette.buttonHover};
  }
`;

const dropdownOptionSelected = stylesheet`
  .${CLASS_NAME}.${CLASS_NAME} {
    background: ${palette.buttonActive};
    color: #ffffff;
  }
`;

/**
 * The construction picker's dress. It opens upward, which is not a matter of
 * taste: the card sits at the foot of the panel, and a menu hanging off the
 * bottom would trail into the room in front of the board.
 */
export const dropdownClasses: DropdownClasses = {
  root: dropdownRoot,
  trigger: dropdownTrigger,
  caret: dropdownCaret,
  menu: renderText`${dropdownMenu} ${dropdownMenuUp}`,
  option: dropdownOption,
  optionSelected: dropdownOptionSelected,
};

// The picker follows the volume row inside its card rather than a title, so it
// carries the gap between the two itself.
const dropdownRootSpaced = stylesheet`
  .${CLASS_NAME} {
    position: relative;
    margin-top: 6px;
  }
`;

/**
 * The output picker's dress: the construction picker's, and it opens upward for
 * the same reason — the music card is the last one in the stack.
 */
export const outputClasses: DropdownClasses = {
  ...dropdownClasses,
  root: dropdownRootSpaced,
};

export const hintLine = stylesheet`
  .${CLASS_NAME} {
    font-size: 12.5px;
    color: ${palette.panelMuted};
    padding: 6px 4px 0 4px;
  }
`;
