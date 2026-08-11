/**
 * The panel's dressing.
 *
 * Every other panel in this repo is dressed by the app that shows it, because
 * a game's UI has to look like that game. This one is deliberately the
 * exception: it is the same instrument in twelve scenes, it is read at a
 * glance rather than looked at, and an instrument that changed its face
 * between apps would have to be learned twelve times. It is also the one panel
 * that must not draw the eye — so no colour it does not need, no border it
 * could do without, and enough transparency that the room reads straight
 * through it.
 */
import { stylesheet, CLASS_NAME } from "@apendua/justdom";

/**
 * Authored at roughly twice the size it is read at, and scaled back down: text
 * is rasterized at the pixel size the stylesheet asks for, so the larger
 * source is what keeps a 9 mm-tall reading from being a blur. See `UI_SCALE`.
 */
export const CARD_WIDTH = 300;

/**
 * Panel px to metres, on top of the hundredth the portal already applies. The
 * card comes out 18 cm across, which at the metre it floats at is about the
 * size of a credit card held at arm's length — big enough to read a
 * two-digit number off, small enough to forget about.
 */
export const UI_SCALE = 0.06;

/**
 * Monospaced on purpose, and by generic family rather than by a font this
 * package would have to ship: a proportional 8 next to a proportional 1 makes
 * the reading twitch sideways twice a second, and re-measures the panel each
 * time it does.
 */
const FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export const hudCard = stylesheet`
  .${CLASS_NAME} {
    font-family: ${FONT_STACK};
    width: ${CARD_WIDTH}px;
    box-sizing: border-box;
    padding: 14px 16px 12px;
    border: 2px solid rgba(255, 255, 255, 0.16);
    border-radius: 16px;
    background: rgba(6, 10, 18, 0.34);
    color: rgba(255, 255, 255, 0.82);
  }
`;

export const readingRow = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
`;

/**
 * Wide enough for three digits at this size, so that 9 fps and 120 fps put the
 * unit in the same place. A reading that moved its own label would re-lay-out
 * the panel twice a second.
 */
export const reading = stylesheet`
  .${CLASS_NAME} {
    flex: 0 0 auto;
    width: 92px;
    text-align: right;
    font-size: 44px;
    line-height: 1;
    letter-spacing: -0.02em;
  }
`;

export const unit = stylesheet`
  .${CLASS_NAME} {
    flex: 1 1 auto;
    font-size: 16px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.5);
  }
`;

export const chart = stylesheet`
  .${CLASS_NAME} {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 52px;
    margin-top: 12px;
    border-bottom: 2px solid rgba(255, 255, 255, 0.12);
  }
`;

/**
 * Every bar is full height and squashed to the reading it stands for, rather
 * than being given a height of its own: a transform is a matrix write, where a
 * height is a re-measure of the whole panel — thirty of them, every two
 * seconds, for a panel whose only job is to tell you what is slowing the scene
 * down.
 */
export const bar = stylesheet`
  .${CLASS_NAME} {
    flex: 1 1 0;
    height: 100%;
    border-radius: 2px 2px 0 0;
    transform-origin: bottom center;
    transform: scaleY(0);
  }
`;

export const caption = stylesheet`
  .${CLASS_NAME} {
    margin-top: 8px;
    font-size: 15px;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.42);
  }
`;
