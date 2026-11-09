import { CLASS_NAME, stylesheet } from "justdom-core";

/**
 * The blocky, monospaced button the whole interface is built from.
 *
 * The variants are driven by data attributes rather than by extra class names,
 * so a component only ever sets one class and toggles an attribute — which is
 * something the dom package can bind to a signal directly.
 *
 * Custom properties let the toolbar and the menu size their buttons
 * differently: the toolbar scales with the viewport height, but no wider than
 * lets its five items fit across the page and no lower than a fingertip, and
 * the full screen menu scales with its width. A narrow toolbar
 * fixes the size and draws the padding in with `--menu-item-padding`.
 *
 * The rules are written for `:hover` alone: in a headset session,
 * justdom-three rewrites them to answer its ray as well (`data-xr-hover`).
 */
export const menuItem = stylesheet`
  .${CLASS_NAME} {
    --menu-item-hatch: repeating-linear-gradient(
      45deg,
      transparent,
      transparent 10px,
      rgba(0, 0, 0, 0.2) 10px,
      rgba(0, 0, 0, 0.2) 20px
    );
    --size: var(--menu-item-size, max(32px, min(5vh, 6vw)));
    flex-grow: 0;
    display: inline-block;
    white-space: nowrap;
    cursor: pointer;
    background: rgba(0, 0, 0, 1);
    border: var(--menu-item-border, 3px solid #333);
    color: white;
    text-align: center;
    font-family: monospace;
    line-height: var(--size);
    font-size: calc(var(--size) * 0.4);
    margin: calc(var(--size) * 0.2);
    padding: 0 calc(var(--size) * var(--menu-item-padding, 0.6));
  }

  .${CLASS_NAME}:hover {
    background: #777;
  }

  /*
   * A label that fills the bar gives way first when the bar is short of room,
   * cutting its caption rather than pushing the bar past the page's edge.
   */
  .${CLASS_NAME}[data-fill] {
    flex-grow: 1;
    min-width: 0;
    overflow: hidden;
  }

  .${CLASS_NAME}[data-inverted] {
    color: black;
    background: rgba(255, 255, 255, 1);
    border-color: #333;
  }

  .${CLASS_NAME}[data-disabled],
  .${CLASS_NAME}[data-disabled]:hover {
    background: var(--menu-item-hatch);
    border-color: #222;
    cursor: auto;
    color: #222;
  }

  /*
   * Something to read rather than something to press: same hatched bar as a
   * disabled button, but the text has to stay legible on it.
   */
  .${CLASS_NAME}[data-readonly],
  .${CLASS_NAME}[data-readonly]:hover {
    background: var(--menu-item-hatch);
    border-color: #222;
    cursor: auto;
    color: white;
  }
`;

export const menuItems = stylesheet`
  .${CLASS_NAME} {
    list-style: none;
    width: 100%;
    margin: auto;
    display: flex;
    padding: 0;
  }
`;

/**
 * Stands in for the spinning cog of the original, without pulling in an icon
 * font for a single glyph.
 */
export const spinner = stylesheet`
  @keyframes knights-spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .${CLASS_NAME} {
    display: inline-block;
    animation: knights-spin 1s linear infinite;
  }
`;

/**
 * The full screen backdrop shared by the menu and the consent notice.
 */
export const modal = stylesheet`
  .${CLASS_NAME} {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 999;
    display: flex;
    flex-direction: column;
  }

  .${CLASS_NAME}[hidden] {
    display: none;
  }
`;

export const modalFill = stylesheet`
  .${CLASS_NAME} {
    flex-grow: 1;
  }
`;
