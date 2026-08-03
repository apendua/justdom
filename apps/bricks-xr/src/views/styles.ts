import { fontFace, stylesheet, CLASS_NAME } from "@apendua.dev/dom";
import fontFile from "@apendua.dev/media/fonts/ZenDots-Regular.ttf";
import { palette } from "../elements/palette.js";

export const fontName = fontFace(fontFile);

export const panelCard = stylesheet`
  .${CLASS_NAME} {
    font-family: '${fontName}';
    background: ${palette.panel};
    border: 4px solid ${palette.panelEdge};
    border-radius: 14px;
    padding: 10px;
    width: 300px;
    color: ${palette.panelText};
  }
`;

export const panelTitle = stylesheet`
  .${CLASS_NAME} {
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 0.78rem;
    text-align: center;
    padding: 8px 12px;
    margin-bottom: 8px;
  }
`;

export const panelValue = stylesheet`
  .${CLASS_NAME} {
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 10px;
    padding: 8px 10px;
    margin-top: 6px;
  }
`;

export const actionButton = stylesheet`
  .${CLASS_NAME} {
    background: ${palette.button};
    border: 2px solid ${palette.buttonEdge};
    text-align: center;
    padding: 12px;
    margin: 6px 0;
    border-radius: 12px;
    color: ${palette.panelText};
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: ${palette.buttonHover};
  }
`;
