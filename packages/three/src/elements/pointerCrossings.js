/**
 * What a pointer, or the mouse, crossing from one element to another sends
 * and leaves behind: the `over`, `enter`, `out` and `leave` events a
 * browser sends, and the `data-xr-hover` and `data-xr-active` flags a hand
 * writes on the controls it is over or pressing. A panel's forwarder
 * (`createPanelForwarder` in `pointerForwarding.js`) calls these as its
 * rays move.
 */

import { isPortalRoot } from "./mirror/styleReads.js";

/**
 * @import {ACTIVE_ATTRIBUTE, HOVER_ATTRIBUTE} from './portalRoot.js';
 */

/**
 * The events a browser sends as a pointer, or the mouse, crosses from one
 * element to another.
 */
const CROSSINGS = /** @type {const} */ ({
  pointer: { over: "pointerover", enter: "pointerenter", out: "pointerout", leave: "pointerleave" },
  mouse: { over: "mouseover", enter: "mouseenter", out: "mouseout", leave: "mouseleave" },
});

/**
 * Write the element and the elements around it, up to the root of the
 * panel it is in, into `chain`, innermost first; or nothing for no
 * element.
 *
 * @param {Element | null} element
 * @param {Element[]} chain
 * @returns {void}
 */
function fillChain(element, chain) {
  chain.length = 0;
  for (let el = element; el; el = el.parentElement) {
    chain.push(el);
    if (isPortalRoot(el)) {
      return;
    }
  }
}

/** A ray event's place on the page where it has none on the panel. */
export const NOWHERE = {};

/** Scratch for the chain a ray is crossing into (see `cross`). */
const into = /** @type {Element[]} */ ([]);

/**
 * Tell the page that a pointer, or the mouse, has crossed from the element
 * at the head of `chain` to `element`, as a browser does: `out` on the one
 * it left and `leave` on it and on each element around it that does not
 * hold the new one, innermost first; then `over` on the one it is on and
 * `enter` on each element around it that did not hold the old one,
 * outermost first. `over` and `out` bubble and can be cancelled, `enter`
 * and `leave` do neither, and each names the other element as its
 * `relatedTarget`. Elements that have left the page hear nothing: a
 * pointer over an element the page took out is over what is left of what
 * was around it, so a ray on a removed label is still on its button, and
 * nothing was over, so nothing hears `out` and the next `over` names none.
 *
 * @param {Element[]} chain What the page was last told the pointer is
 *   over, written with the new chain once the events are sent.
 * @param {Element | null} element
 * @param {PointerEventInit} init The point, the pointer and its buttons,
 *   for every event sent.
 * @param {"pointer" | "mouse"} kind
 * @returns {boolean} Whether any event went out.
 */
export function cross(chain, element, init, kind) {
  let gone = 0;
  while (gone < chain.length && !chain[gone].isConnected) {
    gone += 1;
  }
  chain.splice(0, gone);
  if (gone === 0 && (chain[0] ?? null) === element) {
    return false;
  }
  fillChain(element, into);
  let shared = 0;
  while (
    shared < chain.length &&
    shared < into.length &&
    chain[chain.length - 1 - shared] === into[into.length - 1 - shared]
  ) {
    shared += 1;
  }
  const from = gone === 0 ? (chain[0] ?? null) : null;
  const types = CROSSINGS[kind];
  const Event = kind === "pointer" ? PointerEvent : MouseEvent;
  init.button = kind === "pointer" ? -1 : 0;
  let sent = false;
  /**
   * @param {string} type
   * @param {Element} target
   * @param {Element | null} related
   * @param {boolean} bubbles
   */
  const send = (type, target, related, bubbles) => {
    init.bubbles = bubbles;
    init.cancelable = bubbles;
    init.relatedTarget = related;
    target.dispatchEvent(new Event(type, init));
    sent = true;
  };
  if (from) {
    send(types.out, from, element, true);
  }
  for (let i = 0; i < chain.length - shared; i += 1) {
    send(types.leave, chain[i], element, false);
  }
  if (element && element !== chain[0]) {
    send(types.over, element, from, true);
  }
  for (let i = into.length - shared - 1; i >= 0; i -= 1) {
    send(types.enter, into[i], from, false);
  }
  init.relatedTarget = null;
  chain.length = 0;
  for (const el of into) {
    chain.push(el);
  }
  return sent;
}

/**
 * One of the flags a hand writes on the controls of a panel,
 * `data-xr-hover` or `data-xr-active`, counted per hand. Each hand keeps
 * the elements it flagged, and an element carries the flag while any hand
 * does: two hands on one button are two hovers, and the first to leave or
 * let go takes neither the other's hover nor its press off it.
 *
 * @typedef {object} Flag
 * @property {(flagged: HTMLElement[], next: HTMLElement[]) => void} replace
 *   Flag `next` for the hand that flagged `flagged`, and let go of the
 *   rest; `flagged` holds `next`'s elements after, and `next` is emptied.
 *   An element in both keeps its flag throughout, so no mutation says it
 *   went.
 * @property {(flagged: HTMLElement[]) => void} clear Let go of every
 *   element a hand flagged.
 * @property {(element: HTMLElement) => void} forget Take the flag off an
 *   element that is no control any more, whoever flagged it.
 */

/**
 * @param {typeof HOVER_ATTRIBUTE | typeof ACTIVE_ATTRIBUTE} name
 * @returns {Flag}
 */
export function createFlag(name) {
  /** @type {Map<HTMLElement, number>} How many hands flag each element. */
  const counts = new Map();
  /** @param {HTMLElement} element */
  const set = (element) => {
    const count = counts.get(element) ?? 0;
    counts.set(element, count + 1);
    if (count === 0) {
      element.setAttribute(name, "true");
    }
  };
  /** @param {HTMLElement} element */
  const unset = (element) => {
    const count = counts.get(element) ?? 0;
    if (count > 1) {
      counts.set(element, count - 1);
    } else if (count === 1) {
      counts.delete(element);
      element.removeAttribute(name);
    }
  };
  return {
    replace(flagged, next) {
      for (const element of next) {
        set(element);
      }
      for (const element of flagged) {
        unset(element);
      }
      flagged.length = 0;
      for (const element of next) {
        flagged.push(element);
      }
      next.length = 0;
    },
    clear(flagged) {
      for (const element of flagged) {
        unset(element);
      }
      flagged.length = 0;
    },
    forget(element) {
      counts.delete(element);
      element.removeAttribute(name);
    },
  };
}

/**
 * Take an element out of a list, if it is in it.
 *
 * @param {HTMLElement[]} list
 * @param {HTMLElement} element
 * @returns {void}
 */
export function drop(list, element) {
  const index = list.indexOf(element);
  if (index !== -1) {
    list.splice(index, 1);
  }
}

/** Scratch for the elements a hand is to flag next (see `Flag.replace`). */
export const nextFlagged = /** @type {HTMLElement[]} */ ([]);
