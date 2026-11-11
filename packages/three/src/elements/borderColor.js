import { parseAlpha } from "./css/cssColor.js";

/**
 * The sides of a box, in the order CSS lists them, by the names of their
 * width and colour in a computed style.
 */
const BORDER_SIDES = /** @type {const} */ ([
  ["borderTopWidth", "borderTopColor"],
  ["borderRightWidth", "borderRightColor"],
  ["borderBottomWidth", "borderBottomColor"],
  ["borderLeftWidth", "borderLeftColor"],
]);

/** What a box is drawn with when no side of it draws a border. */
const NO_BORDER = "rgba(0, 0, 0, 0)";

/**
 * The one colour a box's border is drawn in: the colour of the first side
 * that draws one, top, right, bottom, left.
 *
 * A box is drawn with a width per side but a single border colour, and the
 * computed `border-color` shorthand is no answer to which. It lists every
 * side's colour, and a side with no border still has one, `currentColor`
 * by default. Read from the front, `border-bottom: 1px solid #eee` was the
 * text colour of the top edge, which has no border, and a divider was drawn
 * in the colour of the text. A side whose computed width is 0 is one CSS
 * draws nothing on, `border-style: none` included, so it has no say here.
 * Nor does a side that is there and transparent: a row of tabs keeps their
 * heights equal with `border-top: 2px solid transparent` over a coloured
 * `border-bottom`, and the underline is the border that is drawn. A box
 * with no side that draws one, an unchosen tab whose only border is a
 * transparent underline, is drawn with no border at all.
 *
 * Paid by every box on every restyle, so a side's colour is read only once
 * its width says it has a border, and only its alpha is parsed.
 *
 * Borders on several sides in different colours still share the first of
 * them; drawing each in its own would need a colour per side in the shader.
 *
 * @param {CSSStyleDeclaration} style
 * @returns {string}
 */
export function getDrawnBorderColor(style) {
  for (const [width, color] of BORDER_SIDES) {
    if (parseFloat(style[width]) > 0) {
      const value = style[color];
      if (parseAlpha(value) > 0) {
        return value;
      }
    }
  }
  return NO_BORDER;
}
