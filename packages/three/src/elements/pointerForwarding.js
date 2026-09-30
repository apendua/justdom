import { on, onCleanup } from "@apendua/signal";
import { interactions } from "../interactions.js";
import { getParentObject } from "./contentGroup.js";
import { HapticsContext, isArrival } from "./haptics.js";
import { getComputedStyleCached } from "./mirror.js";
import { scrollDrags } from "./scroll.js";

/**
 * @import {EntityEffect} from '@apendua/signal';
 * @import {Object3D} from 'three';
 * @import {Reactive} from '../interactions.js';
 * @import {InteractionEvent, XREventMap} from '../core.js';
 */

/**
 * Whether the element asks to be a ray target of its own. `cursor: pointer`
 * is the same signal the ordinary web uses to mark an element clickable, so
 * buttons opt in through their stylesheet with no extra attribute. Everything
 * else — cards, labels, layout wrappers — stays out of the raycast set; the
 * portal's blocker plane keeps the panel as a whole opaque to rays. SVG
 * shapes follow the same rule, and `cursor` is inherited into them from the
 * page around the `<svg>`.
 *
 * `pointer-events: none` says the opposite, as it does on a page, and wins.
 * `cursor` is inherited, so an icon's `<svg>` inside a button computes
 * `pointer` too, and `pointer-events: none` on the icon is how a page makes
 * the button, and not the icon, the target of a press.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isClickable(element) {
  const style = getComputedStyleCached(element);
  return style.cursor === "pointer" && style.getPropertyValue("pointer-events") !== "none";
}

/**
 * The object of the control an element is part of: its own, unless its
 * parent is clickable too, in which case the label is part of the button,
 * and so on up the unbroken run of clickable ancestors. The walk goes one
 * element at a time through `getParentObject`, as the scroll gesture does,
 * so it is right under an SVG `<g>` as well as under a box. Asked once per
 * arrival, off cached computed styles.
 *
 * @param {HTMLElement} element
 * @param {Object3D} object The element's object.
 * @returns {Object3D}
 */
export function getControlRoot(element, object) {
  let root = object;
  for (let el = element.parentElement; el && isClickable(el); el = el.parentElement) {
    root = getParentObject(root) ?? root;
  }
  return root;
}

/**
 * Whether a press on this element is a press on anything. A projected panel
 * keeps a removed element's object in the scene, drawn as it was, until the
 * update that removed it commits — so for those frames the object is still
 * there to hit, and the ray still lands on it. What must not follow is the
 * click: the element is out of the document, the app has already let go of
 * it, and a handler still hanging off it would run against a row the app
 * considers gone. A press that lands on such an element is swallowed —
 * stopped, so that it does not fall through to whatever is behind the row
 * either — and the gesture is not begun.
 *
 * `isConnected` rather than anything reactive, because it is asked from an
 * event handler, at the moment of the press, and the answer is a DOM fact
 * rather than a dependency.
 *
 * @param {Element} element
 * @returns {boolean}
 */
export function isGone(element) {
  return !element.isConnected;
}

/**
 * The objects forwarding a ray's events right now, so that a handler can
 * tell whether another one is above it.
 *
 * @type {WeakSet<Object3D>}
 */
const forwarding = new WeakSet();

/**
 * The ray events whose DOM events have already been sent. The manager hands
 * one event object to every object up the chain, so the first handler to
 * see it sends the DOM event and the ones above only follow it.
 *
 * @type {WeakSet<object>}
 */
const delivered = new WeakSet();

/**
 * Whether another forwarding object is above this one, which makes this
 * one not the outermost of a nest of clickable elements.
 *
 * @param {Object3D} object
 * @returns {boolean}
 */
function hasForwardingAncestor(object) {
  for (let node = object.parent; node; node = node.parent) {
    if (forwarding.has(node)) {
      return true;
    }
  }
  return false;
}

/**
 * @typedef {object} ForwardingOptions
 * @property {Reactive<boolean>} enabled Whether rays can hit the object at
 *   all, handed to `makeInteractive`.
 * @property {() => void} [onPress] Told when a press has been delivered to
 *   the element as a click; see `BoxOptions.onPress`.
 */

/**
 * Being a ray target, and forwarding what happens there back to the DOM. A
 * press arrives as `mousedown`, `mouseup` and `click`, and a ray moving over
 * the object as `mousemove`. While the ray is on it the element carries
 * `data-xr-hover`, and while it is held, `data-xr-active`. A stylesheet
 * answers those flags where a page would use `:hover` and `:active`.
 * Where the panel has haptics, the hand feels a press and its release, and
 * an arrival on a control where the panel asks for one.
 *
 * Boxes and SVG shapes both forward rays through this function, so a
 * panel's stylesheet and its click handlers see the same events whichever
 * of the two the ray met.
 *
 * Clickable elements nest, if only because `cursor` is inherited: the label
 * in a button, the icon in it, a button on a clickable card. A press goes
 * where it goes on a page. The innermost element is the target of the DOM
 * events, sent once, and they bubble through the DOM from there. Every
 * clickable element around it is pressed too, the way `:active` applies to
 * the ancestors of what is pressed, so each one takes `data-xr-active` and
 * hears its own `onPress`. The ray event stops at the outermost of them,
 * so nothing outside the panel sees a press the panel took.
 *
 * These belong together: an element that stops being clickable has to lose
 * the handlers too, not just the registration. The interaction manager
 * dispatches up the parent chain, so a listener left behind on a wrapper
 * that is no longer clickable would still see events bubbling out of a
 * button inside it and synthesise a second, spurious click on the wrapper.
 * Mount and unmount the returned list as a whole. Unmounting it clears the
 * flags, since the `pointerleave` that would have cleared them goes with it.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {Object3D<XREventMap>} object The registered object. A press that
 *   turns into a drag is measured from its frame.
 * @param {ForwardingOptions} options
 * @returns {EntityEffect<Object3D<XREventMap>>[]}
 */
export function forwardPointerEvents(ctx, element, object, { enabled, onPress }) {
  const { makeInteractive, stopPropagation } = interactions(ctx);
  const drags = scrollDrags(ctx);
  /**
   * What the hand feels on this element, if it is a control and the panel
   * has haptics at all. The handlers below hand it the hand each event came
   * from.
   */
  const haptics = HapticsContext.get(ctx);

  /**
   * Send the DOM event for a ray event, unless an element inside this one
   * already has.
   *
   * @param {object} e
   * @param {() => void} send
   * @returns {void}
   */
  const deliverOnce = (e, send) => {
    if (!delivered.has(e)) {
      delivered.add(e);
      send();
    }
  };

  /**
   * Let the ray event go on to the next clickable element up, or stop it
   * here if there is none.
   *
   * @param {InteractionEvent} e
   * @returns {void}
   */
  const passOn = (e) => {
    if (!hasForwardingAncestor(object)) {
      stopPropagation(e);
    }
  };

  return [
    makeInteractive(enabled),
    () => {
      forwarding.add(object);
      onCleanup(() => {
        forwarding.delete(object);
        delete element.dataset.xrHover;
        delete element.dataset.xrActive;
      });
    },
    on("select", (e) => {
      // A press that turned into a drag was the player scrolling the list
      // this button sits in, not pressing the button — the same bargain a
      // touchscreen strikes, and for the same reason: there is nowhere else
      // to grab a list that is made of buttons.
      if (isGone(element) || drags.didScroll(e.controller)) {
        stopPropagation(e);
        return;
      }
      deliverOnce(e, () => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      onPress?.();
      passOn(e);
    }),
    on("selectstart", (e) => {
      if (isGone(element)) {
        stopPropagation(e);
        return;
      }
      deliverOnce(e, () => {
        // Offered to the scroll gesture before anything else: a press over
        // a list may become a drag, and only holding it will tell. Elements
        // with no scrolling ancestor are declined and nothing changes for
        // them. Once, by the element the press landed on, since a second
        // `begin` for the same hand would start the gesture over.
        drags.begin(e.controller, element, object);
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        // Felt once, however many clickable elements the press holds.
        haptics?.press(e.inputSource);
      });
      element.dataset.xrActive = "true";
      passOn(e);
    }),
    on("selectend", (e) => {
      if (isGone(element)) {
        stopPropagation(e);
        return;
      }
      deliverOnce(e, () => {
        drags.end(e.controller);
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        haptics?.release(e.inputSource);
      });
      delete element.dataset.xrActive;
      passOn(e);
    }),
    on("pointermove", () => {
      const event = new MouseEvent("mousemove", {
        bubbles: false,
      });
      element.dispatchEvent(event);
    }),
    on("pointerenter", (e) => {
      element.dataset.xrHover = "true";
      // Once per arrival on this control. Not for an enter bubbling up from
      // a target nested in this one, which plays its own; not for the ray
      // moving between this element and something clickable inside it,
      // which `isArrival` says is not an arrival at all; and not while the
      // hand is scrolling a list, when the rows pass under a ray that is
      // aimed at none of them, glide included.
      if (
        haptics &&
        e.registeredTarget === object &&
        !drags.scrolling(e.controller) &&
        isArrival(getControlRoot(element, object), e.relatedTarget)
      ) {
        haptics.hover(e.inputSource);
      }
    }),
    on("pointerleave", () => {
      delete element.dataset.xrHover;
    }),
  ];
}
