import { stylesheet, CLASS_NAME } from "@apendua/justdom";
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

export const hintLine = stylesheet`
  .${CLASS_NAME} {
    font-size: 12.5px;
    color: ${palette.panelMuted};
    padding: 6px 4px 0 4px;
  }
`;
