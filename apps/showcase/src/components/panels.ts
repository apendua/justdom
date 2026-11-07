import { fromObservable, observable, type Source, type Subscribable } from "justdom-signal";
import { stylesheet, className, CLASS_NAME } from "justdom-core";

/**
 * Whatever the machine already has. The panels used to be set in Zen Dots,
 * mounted as a `@font-face`. They no longer are: a web font is one more thing
 * the measuring has to wait for before a panel can be built, and nothing here
 * asks for anything a system sans does not do.
 */
export const fontFamily = 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * Class names are observables (they register their stylesheet on first
 * subscription), so putting several on one element means combining them —
 * interpolating them into a plain template string would stringify the
 * observable, not the name.
 */
export function classes(...names: Subscribable<string>[]): Source<string> {
  const nodes = names.map((name) => fromObservable(name));
  return observable(() => nodes.map((node) => node.get()).join(" "));
}

/** The size of every card in the deck, in px. */
export const CARD_WIDTH = 600;
export const CARD_HEIGHT = 560;

/**
 * The shared look of every panel. Rounded corners and a real border, so each
 * card is itself a demonstration of the SDF box path.
 *
 * Every card is the same size, as slides in a deck are: the panel on show is
 * centred in front of the player with the switcher under it, and a portal is
 * placed by its centre, so a card of its own height would move the switcher
 * or leave a gap under it from one panel to the next. The height is the
 * tallest panel's, and a shorter one leaves room at the bottom.
 */
export const cardStyle = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    position: relative;
    font-family: ${fontFamily};
    width: ${CARD_WIDTH}px;
    height: ${CARD_HEIGHT}px;
    padding: 20px 26px 24px;
    background-color: rgb(250, 250, 253);
    border: 2px solid rgb(214, 218, 230);
    border-radius: 18px;
    color: rgb(40, 44, 58);
  }

  .${CLASS_NAME} * {
    box-sizing: border-box;
  }
`;

export const headingStyle = className`
  margin: 0 0 6px;
  font-size: 24px;
`;

export const captionStyle = className`
  margin: 14px 0 6px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgb(110, 116, 136);
`;

export const rowStyle = className`
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
`;

/**
 * The quiet grey button several panels share, for the controls that are
 * there to change a specimen rather than to be one. The pointer panel's blue
 * buttons are the ones under test.
 */
export const softButtonStyle = stylesheet`
  .${CLASS_NAME} {
    padding: 6px 12px;
    font-family: inherit;
    font-size: 13px;
    background-color: rgb(228, 231, 240);
    color: rgb(40, 44, 58);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .${CLASS_NAME}:hover {
    background-color: rgb(200, 206, 222);
  }
`;
