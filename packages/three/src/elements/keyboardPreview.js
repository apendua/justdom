import { Effect, withChannel, withComputation } from "@apendua/signal";
import { getCaretOffset, getShownValue, setCaretOffset } from "./typing.js";
import { placeCaretIn, touchValue, watchValue } from "./textInput.js";

/**
 * @import {Mountable} from '../core.js';
 * @import {InputFocus} from './textInput.js';
 */

/**
 * A copy of the field being typed into, just above the keys.
 *
 * A board opened in front of the player is where their hands are, and the
 * field it types into is wherever its panel is: a glance up to the field
 * and back down to the keys for every word. The preview puts what the field
 * holds where the eyes already are — the value as it is being typed, the
 * caret where the next key goes — so the typing can be watched without
 * looking away from the keys.
 *
 * It is an `<input>` of its own, mounted into the board's panel above the
 * app's board, and drawn by the same mirror as every other field: the value,
 * the caret, the scrolling that keeps the caret in view. It is never typed
 * into; it follows the real field, which is the one the keys type into, and
 * the real field follows it back in one thing only — where the caret is,
 * which a ray on the preview places, exactly as it would on the field (see
 * `caretByRay` in textInput.js).
 *
 * It shows the value as it is, a password's included. The masking is there
 * for whoever is looking over the player's shoulder at the panel; the
 * preview is under the player's nose and only ever seen in the headset,
 * which nobody else is looking into — and a password typed on a board of
 * boxes, one aimed click at a time, is the one field where seeing what was
 * typed matters most.
 *
 * It wears the field's own look — its type, its colours, its border and its
 * padding — so that it reads as the field it stands for, on a board whose
 * look the app chose and this package cannot know; or, given a class name,
 * the app's look for it instead. It leans toward the player by `tilt`,
 * hinged at its bottom edge, the way a phone's text strip sits over its
 * keyboard: the keys recline toward the hands, and what is read is turned a
 * little further up toward the eyes.
 */

/**
 * The attribute the preview's field carries, for a stylesheet — or a test —
 * to find it by.
 */
export const PREVIEW_ATTRIBUTE = "data-xr-keyboard-preview";

/**
 * How far the preview leans toward the player, in radians, beyond the
 * board's own recline: a little, so it stays a strip over the keys rather
 * than becoming a screen of its own.
 */
export const DEFAULT_PREVIEW_TILT = (15 * Math.PI) / 180;

/**
 * The room between the preview and the keys, in the board's px.
 */
export const DEFAULT_PREVIEW_GAP = 8;

/**
 * The properties of the field's look the preview copies: what it is written
 * in and what it is drawn as. Not its size, which is the board's width and
 * its own type's height, and not its alignment, which is a writing strip's.
 *
 * @type {readonly string[]}
 */
const COPIED_PROPERTIES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "color",
  "backgroundColor",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopStyle",
  "borderRightStyle",
  "borderBottomStyle",
  "borderLeftStyle",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
];

/**
 * @typedef {object} KeyboardPreviewOptions
 * @property {number} [tilt] How far the preview leans toward the player,
 *   in radians, hinged at its bottom edge. 15° by default; 0 keeps it in
 *   the plane of the keys.
 * @property {number} [gap] The room between the preview and the keys, in
 *   the board's px. 8 by default.
 * @property {string} [className] What to dress the preview in instead of
 *   the field's own look: a class name the app's stylesheet defines, as a
 *   board's own classes are.
 */

/**
 * @typedef {object} KeyboardPreview
 * @property {Mountable} mountable The preview and, under it, room for the
 *   board: what the board's panel mounts.
 * @property {(board: Mountable) => void} mountBoard Put the app's board
 *   under the preview, in place of the one there before.
 * @property {InputFocus} focus What the preview's field is drawn with:
 *   focused, so its caret shows, and placing its caret in the real field.
 * @property {HTMLInputElement} element The preview's field.
 * @property {() => void} dispose
 */

/**
 * @param {object} options
 * @param {() => HTMLInputElement | null} options.field The field being typed
 *   into. Reactive.
 * @param {KeyboardPreviewOptions} [options.options]
 * @returns {KeyboardPreview}
 */
export function createKeyboardPreview({ field, options = {} }) {
  const { tilt = DEFAULT_PREVIEW_TILT, gap = DEFAULT_PREVIEW_GAP, className } = options;

  const wrapper = document.createElement("div");
  // A column the board's width, the preview stretched across the top of it.
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.alignItems = "stretch";

  const element = document.createElement("input");
  element.type = "text";
  element.setAttribute(PREVIEW_ATTRIBUTE, "");
  element.tabIndex = -1;
  // As narrow as it can be on its own, so that it never widens the board;
  // stretched to the board's width by the column it is in.
  element.size = 1;
  element.style.boxSizing = "border-box";
  element.style.minWidth = "0";
  element.style.margin = `0 0 ${gap}px 0`;
  if (tilt) {
    // Hinged at the bottom edge, the top coming toward the player: in CSS's
    // frame, where y runs down and z toward the viewer, that is a negative
    // turn about x. Written as the matrix a browser computes `rotateX` to,
    // which is the form the mirror reads a transform in.
    const cos = Math.cos(-tilt);
    const sin = Math.sin(-tilt);
    element.style.transformOrigin = "50% 100%";
    element.style.transform = `matrix3d(1, 0, 0, 0, 0, ${cos}, ${sin}, 0, 0, ${-sin}, ${cos}, 0, 0, 0, 0, 1)`;
  }
  if (className) {
    element.className = className;
  }

  const slot = document.createComment("");
  wrapper.append(element, slot);
  /** @type {[Node, Node]} */
  let boardSegment = [slot, slot];

  /** @type {Mountable} */
  const mountable = {
    replace([first, last]) {
      const parent = first.parentNode;
      if (!parent) {
        throw new Error("Cannot mount the keyboard's preview outside a document.");
      }
      parent.insertBefore(wrapper, first);
      removeRange(first, last);
      return [wrapper, wrapper];
    },
  };

  /** @type {InputFocus} */
  const focus = {
    isFocused: (input) => input === element,
    press: () => {},
    placeCaret: (input, offset) => {
      const target = withComputation(null, field);
      if (input === element && target) {
        placeCaretIn(target, offset);
      }
    },
  };

  // In the default channel, like the board in the room: the preview is no
  // panel's, and follows nothing but the field.
  const effects = withChannel(null, () => [
    // The value and the caret, whenever the field says either moved.
    new Effect(
      () => {
        const current = field();
        if (!current) {
          return;
        }
        watchValue(current);
        withComputation(null, () => {
          const value = getShownValue(current);
          if (element.value !== value) {
            element.value = value;
          }
          if (element.placeholder !== current.placeholder) {
            element.placeholder = current.placeholder;
          }
          setCaretOffset(element, getCaretOffset(current));
          touchValue(element);
        });
      },
      { name: "portal-keyboard-preview" },
    ),
    // The field's look, whenever the typing moves to another field.
    ...(className
      ? []
      : [
          new Effect(
            () => {
              const current = field();
              if (current) {
                withComputation(null, () => copyLook(current, element));
              }
            },
            { name: "portal-keyboard-preview-look" },
          ),
        ]),
  ]);

  return {
    mountable,
    mountBoard(board) {
      boardSegment = board.replace(boardSegment);
    },
    focus,
    element,
    dispose() {
      for (const effect of effects) {
        effect.dispose();
      }
    },
  };
}

/**
 * Remove the nodes from `first` to `last`, both included, siblings in that
 * order.
 *
 * @param {Node} first
 * @param {Node} last
 */
function removeRange(first, last) {
  /** @type {Node | null} */
  let node = first;
  while (node) {
    const next = /** @type {Node | null} */ (node === last ? null : node.nextSibling);
    node.parentNode?.removeChild(node);
    node = next;
  }
}

/**
 * Dress the preview in the field's own look, inline.
 *
 * @param {HTMLInputElement} field
 * @param {HTMLInputElement} preview
 */
function copyLook(field, preview) {
  const view = field.ownerDocument?.defaultView;
  if (!view) {
    return;
  }
  const computed = /** @type {Record<string, string>} */ (
    /** @type {unknown} */ (view.getComputedStyle(field))
  );
  const style = /** @type {Record<string, string>} */ (/** @type {unknown} */ (preview.style));
  for (const property of COPIED_PROPERTIES) {
    const value = computed[property];
    if (value && style[property] !== value) {
      style[property] = value;
    }
  }
}
