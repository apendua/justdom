import { createMirror } from "../elements/mirror.js";
import { PORTAL_ATTRIBUTE } from "../elements/portalRoot.js";
import { clientRect } from "./clientRect.js";

/**
 * A panel's root with one child in it, inside a stage on the page: what a
 * test of the panel frame needs, since the frame is the scale of the chain
 * above the root. jsdom lays nothing out, so `place` hands an element a
 * client rect, and `setScale` draws the stage or the root at a scale. Every
 * rect `place` gave out is drawn at the product of the two from then on,
 * as a browser draws a scaled root on a scaled page.
 *
 * @param {object} [options]
 * @param {[number, number]} [options.at] Where the page lays the root's
 *   corner out, the page's corner unless given. Every rect is scaled about
 *   it.
 * @param {boolean} [options.claimed] Whether the root wears
 *   `PORTAL_ATTRIBUTE` already, as a root a portal claimed does. False for
 *   a test that hands the root to a portal of its own.
 */
export function stagedRoot({ at = [0, 0], claimed = false } = {}) {
  const stage = document.createElement("div");
  const root = document.createElement("div");
  if (claimed) {
    root.setAttribute(PORTAL_ATTRIBUTE, "");
  }
  const child = document.createElement("div");
  root.appendChild(child);
  stage.appendChild(root);
  document.body.appendChild(stage);
  /** @type {Map<HTMLElement, number>} */
  const scales = new Map();
  const scale = () => (scales.get(stage) ?? 1) * (scales.get(root) ?? 1);
  return {
    stage,
    root,
    child,
    /**
     * Lay `element` out at layout px (x, y), w by h, inside the root, at
     * the product of the scales the stage and the root are drawn at when it
     * is read.
     *
     * @param {Element} element
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     */
    place(element, x, y, w, h) {
      element.getBoundingClientRect = () => {
        const s = scale();
        return clientRect(at[0] + x * s, at[1] + y * s, w * s, h * s);
      };
    },
    /**
     * Draw `element`, the stage or the root, at `value` in both directions,
     * in place of the scale it was drawn at before.
     *
     * @param {HTMLElement} element
     * @param {number} value
     */
    setScale(element, value) {
      scales.set(element, value);
      element.style.transform = `matrix(${value}, 0, 0, ${value}, 0, 0)`;
    },
    /** A fresh mirror that has adopted the root and the child. */
    adopt() {
      const mirror = createMirror();
      mirror.adopt(root);
      mirror.adopt(child);
      return mirror;
    },
  };
}
