/**
 * The panels. Every colour comes from `elements/palette.ts`, the same place the
 * board and the bricks take theirs from, so the interface and the world it sits
 * in cannot drift apart.
 */
import { fontFace, stylesheet, CLASS_NAME } from "@apendua/justdom";
import fontFile from "@apendua.dev/media/fonts/ZenDots-Regular.ttf";
import { combineLatest, map, Observable } from "rxjs";
import { palette } from "../elements/palette.js";
import type { DropdownClasses } from "@apendua/freedom";

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
    background: ${palette.panel};
    border: 4px solid ${palette.panelEdge};
    border-radius: 14px;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
    padding: 10px;
    color: ${palette.panelText};
  }
`;

export const panelTitle = stylesheet`
  .${CLASS_NAME} {
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 0.78rem;
    background: ${palette.panelWash};
    border: 2px solid ${palette.panelWashEdge};
    border-radius: 10px;
    padding: 8px 12px;
    margin-bottom: 8px;
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
    background: ${palette.buttonMuted};
    border-color: ${palette.buttonMutedEdge};
    color: ${palette.buttonMutedText};
  }
`;

export const musicRow = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    align-items: stretch;
    gap: 8px;
    margin: 6px 0;
  }
`;

/**
 * Narrow enough for two of them to flank the reading, wide enough to be an easy
 * target at arm's length through a controller ray.
 */
export const stepButton = stylesheet`
  .${CLASS_NAME} {
    flex: 0 0 64px;
    background: ${palette.button};
    border: 2px solid ${palette.buttonEdge};
    text-align: center;
    padding: 12px 0;
    border-radius: 12px;
    color: ${palette.panelText};
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: ${palette.buttonHover};
  }
`;

export const stepValue = stylesheet`
  .${CLASS_NAME} {
    flex: 1 1 auto;
    text-align: center;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 10px;
    padding: 12px 8px;
  }
`;

const dropdownRoot = stylesheet`
  .${CLASS_NAME} {
    position: relative;
    margin-top: 6px;
  }
`;

const dropdownTrigger = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    background: ${palette.button};
    border: 2px solid ${palette.buttonEdge};
    border-radius: 12px;
    padding: 12px;
    font-size: 1rem;
    color: ${palette.panelText};
    cursor: pointer;
    user-select: none;
  }

  .${CLASS_NAME}:hover, .${CLASS_NAME}[data-xr-hover] {
    background: ${palette.buttonHover};
  }
`;

const dropdownCaret = stylesheet`
  .${CLASS_NAME} {
    font-size: 0.7rem;
    line-height: 1;
    color: ${palette.panelLabel};
  }
`;

/**
 * Opens upward, which is not a matter of taste: the music section sits at the
 * foot of the panel, and a menu hanging off the bottom would trail into the
 * room. Absolute, so opening one does not grow the panel and slide it out from
 * under the ray that opened it.
 */
const dropdownMenu = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    position: absolute;
    z-index: 1;
    left: 0;
    right: 0;
    bottom: 100%;
    margin-bottom: 6px;
    padding: 4px;
    background: ${palette.panel};
    border: 3px solid ${palette.panelEdge};
    border-radius: 12px;
  }
`;

const dropdownOption = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    /* A ray is a blunter instrument than a mouse; this is about three degrees
       of arc at the distance the panel is mounted at. */
    min-height: 38px;
    padding: 0 8px;
    border-radius: 8px;
    font-size: 1rem;
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
    background: ${palette.button};
    color: #ffffff;
  }
`;

/** The output picker's dress; the widget itself comes from freedom. */
export const outputClasses: DropdownClasses = {
  root: dropdownRoot,
  trigger: dropdownTrigger,
  caret: dropdownCaret,
  menu: dropdownMenu,
  option: dropdownOption,
  optionSelected: dropdownOptionSelected,
};

/**
 * A brick's name, written on the tray under the brick itself. The portal centres
 * whatever it renders on the object holding it, so the text has to be centred in
 * its own box as well — anything else leaves the name sitting off to one side of
 * the brick it belongs to.
 */
export const paletteLabel = stylesheet`
  .${CLASS_NAME} {
    font-family: '${fontName}';
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 13px;
    text-align: center;
    width: 96px;
    color: ${palette.panelLabel};
  }
`;

/** Shown once the last brick is on the ground. */
export const victoryBanner = stylesheet`
  .${CLASS_NAME} {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    text-align: center;
    font-size: 0.9rem;
    background: ${palette.banner};
    border: 2px solid ${palette.bannerEdge};
    border-radius: 12px;
    color: ${palette.bannerText};
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

/** A quieter line: a hint rather than a reading. */
export const hintValue = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px dashed rgba(255, 255, 255, 0.25);
    border-radius: 10px;
    padding: 8px 10px;
    margin-top: 6px;
    color: ${palette.panelLabel};
  }
`;
