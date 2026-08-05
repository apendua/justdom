import { stylesheet, CLASS_NAME } from "@apendua/justdom";
import { palette } from "./palette.js";

export const panelStack = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: 340px;
  }
`;

export const panelCard = stylesheet`
  .${CLASS_NAME} {
    font-family: -apple-system, 'Segoe UI', 'Helvetica Neue', sans-serif;
    background: ${palette.panel};
    border: 3px solid ${palette.panelEdge};
    border-radius: 12px;
    padding: 12px;
    color: ${palette.panelText};
  }
`;

export const panelTitle = stylesheet`
  .${CLASS_NAME} {
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 13px;
    color: ${palette.panelMuted};
    padding: 2px 4px 8px 4px;
  }
`;

export const toolButton = stylesheet`
  .${CLASS_NAME} {
    background: ${palette.button};
    border: 2px solid ${palette.buttonEdge};
    text-align: center;
    padding: 10px;
    margin: 4px 0;
    border-radius: 10px;
    font-size: 15px;
    color: ${palette.panelText};
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: ${palette.buttonHover};
  }
`;

export const toolButtonActive = stylesheet`
  .${CLASS_NAME} {
    background: ${palette.buttonActive};
    border-color: #8d7f5c;
    color: #ffffff;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: ${palette.buttonActive};
  }
`;

export const hintLine = stylesheet`
  .${CLASS_NAME} {
    font-size: 12.5px;
    color: ${palette.panelMuted};
    padding: 2px 4px;
  }
`;
