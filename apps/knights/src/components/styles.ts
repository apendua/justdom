import { CLASS_NAME, stylesheet } from "@apendua.dev/dom";

/**
 * The blocky, monospaced button the whole interface is built from.
 *
 * The variants are driven by data attributes rather than by extra class names,
 * so a component only ever sets one class and toggles an attribute — which is
 * something the dom package can bind to a signal directly.
 *
 * Two custom properties let the toolbar and the menu size their buttons
 * differently: the toolbar scales with the viewport height, the full screen
 * menu with its width.
 */
export const menuItem = stylesheet`
  .${CLASS_NAME} {
    flex-grow: 0;
    display: inline-block;
    cursor: pointer;
    background: rgba(0, 0, 0, 1);
    border: var(--menu-item-border, 3px solid #333);
    color: white;
    text-align: center;
    font-family: monospace;
    line-height: var(--menu-item-size, 5vh);
    font-size: calc(var(--menu-item-size, 5vh) * 0.4);
    margin: calc(var(--menu-item-size, 5vh) * 0.2);
    padding: 0 calc(var(--menu-item-size, 5vh) * 0.6);
  }

  .${CLASS_NAME}:hover {
    background: #777;
  }

  .${CLASS_NAME}[data-fill] {
    flex-grow: 1;
  }

  .${CLASS_NAME}[data-inverted] {
    color: black;
    background: rgba(255, 255, 255, 1);
    border-color: #333;
  }

  .${CLASS_NAME}[data-disabled],
  .${CLASS_NAME}[data-disabled]:hover {
    background: repeating-linear-gradient(
      45deg,
      transparent,
      transparent 10px,
      rgba(0, 0, 0, 0.2) 10px,
      rgba(0, 0, 0, 0.2) 20px
    );
    border-color: #222;
    cursor: auto;
    color: #222;
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
