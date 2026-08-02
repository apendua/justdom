import { fontFace, stylesheet, CLASS_NAME } from "@apendua.dev/dom";
import fontFile from "@apendua.dev/media/fonts/ZenDots-Regular.ttf";
import { combineLatest, map, Observable } from "rxjs";

export const fontName = fontFace(fontFile);

export const panelStack = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 360px;
  }
`;

export const panelCard = stylesheet`
  .${CLASS_NAME} {
    font-family: '${fontName}';
    background: #124553;
    border: 4px solid #4bd3ff;
    border-radius: 14px;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
    padding: 10px;
    color: #f6fcff;
  }
`;

export const panelTitle = stylesheet`
  .${CLASS_NAME} {
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 0.78rem;
    background: rgba(75, 211, 255, 0.2);
    border: 2px solid rgba(75, 211, 255, 0.7);
    border-radius: 10px;
    padding: 8px 12px;
    margin-bottom: 8px;
  }
`;

export const actionButton = stylesheet`
  .${CLASS_NAME} {
    background: #165ab8;
    border: 2px solid #8bc9ff;
    text-align: center;
    padding: 12px;
    margin: 6px 0;
    border-radius: 12px;
    color: #f4fbff;
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: #1f79ee;
  }

`;

/**
 * An action button that greys out while there is nothing for it to act on.
 * The class names are observables — each one keeps its own stylesheet mounted —
 * so the two are combined as streams rather than as strings.
 */
export function actionButtonClass(enabled: Observable<boolean>) {
  return combineLatest([actionButton, mutedButton, enabled]).pipe(
    map(([action, muted, isEnabled]) => (isEnabled ? action : `${action} ${muted}`)),
  );
}

/** Added to an action button that currently has nothing to act on. */
const mutedButton = stylesheet`
  .${CLASS_NAME}, .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: #1b3b52;
    border-color: #3f5f75;
    color: #6d8ea3;
  }
`;

export const paletteLabel = stylesheet`
  .${CLASS_NAME} {
    font-family: '${fontName}';
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 13px;
    text-align: right;
    width: 96px;
    color: #cdeffd;
  }
`;

/** Shown once the last brick is on the ground. */
export const victoryBanner = stylesheet`
  .${CLASS_NAME} {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    text-align: center;
    font-size: 0.9rem;
    background: #f6b73c;
    border: 2px solid #fff0c9;
    border-radius: 12px;
    color: #3a2a05;
    padding: 12px;
    margin-bottom: 8px;
  }
`;

export const debugValue = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 10px;
    padding: 8px 10px;
    margin-top: 6px;
  }
`;
