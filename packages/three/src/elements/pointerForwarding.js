import * as THREE from "three";
import { on, onCleanup } from "@apendua/signal";
import { interactions } from "../interactions.js";
import { getParentObject } from "./contentGroup.js";
import { clientPointOf, dragAndDrop, getPanel, isDragSource, probePanel } from "./dragAndDrop.js";
import { HapticsContext, isArrival } from "./haptics.js";
import { getComputedStyleCached } from "./mirror.js";
import { scrollDrags } from "./scroll.js";

/**
 * @import {EntityEffect} from '@apendua/signal';
 * @import {Intersection, Object3D, XRTargetRaySpace} from 'three';
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
 * Whether the element is a ray target of its own: something to click, or
 * something to pick up. A `draggable="true"` card is often styled
 * `cursor: grab` rather than `pointer`, and it has to be pressable to be
 * dragged.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
export function isRayTarget(element) {
  return isClickable(element) || isDragSource(element);
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

/** Scratch for where a ray event is on the page. */
const client = new THREE.Vector2();

/**
 * The init every mouse event a ray sends is made from, written in place for
 * each. `MouseEvent` copies what it is given, so one object serves them
 * all, and a ray resting on a button, sending `mousemove` every frame,
 * allocates nothing for it.
 *
 * @type {MouseEventInit}
 */
const init = {
  bubbles: false,
  cancelable: false,
  clientX: 0,
  clientY: 0,
  screenX: 0,
  screenY: 0,
};

/**
 * Write where on the page a ray event happened into `init`: the point the
 * ray met, in client coordinates, as `clientX` and `clientY`, and as
 * `screenX` and `screenY` too, since a panel has no screen of its own. A
 * page that finds what was pressed from where it was pressed, rather than
 * from the event's target, reads them.
 *
 * Only a point on the element's own panel is anywhere on its page. A
 * release whose ray has wandered off the panel, onto nothing, onto another
 * panel or onto the scene, leaves them at 0, as they are on any event a
 * script dispatches. The point is in the page's layout, which is on screen
 * only for a panel mirroring an element the page shows; `clientPointOf`
 * says what that means for a panel built from a tree.
 *
 * @param {Object3D} object
 * @param {{ intersection?: Intersection }} e
 * @param {boolean} probe Whether to read where the page lays the panel out
 *   first; see `probePanel`.
 * @returns {void}
 */
function writePoint(object, e, probe) {
  let x = 0;
  let y = 0;
  const panel = getPanel(object);
  if (e.intersection && panel && getPanel(e.intersection.object) === panel) {
    if (probe) {
      probePanel(panel);
    }
    clientPointOf(panel, e.intersection.point, client);
    x = client.x;
    y = client.y;
  }
  init.clientX = x;
  init.clientY = y;
  init.screenX = x;
  init.screenY = y;
}

/**
 * The init for the mouse event sent for a press, its release or its click:
 * one event each, so the point is taken against the panel where the page
 * lays it out now. Valid until the next call: the event is to be made from
 * it at once.
 *
 * @param {Object3D} object
 * @param {{ intersection?: Intersection }} e
 * @param {boolean} cancelable
 * @returns {MouseEventInit}
 */
function pressInit(object, e, cancelable) {
  init.bubbles = true;
  init.cancelable = cancelable;
  writePoint(object, e, true);
  return init;
}

/**
 * The init for the `mousemove` sent for a ray moving over an element: one
 * a frame, so the point is taken against where the panel was last probed,
 * and reads no layout. Valid until the next call.
 *
 * @param {Object3D} object
 * @param {{ intersection?: Intersection }} e
 * @returns {MouseEventInit}
 */
function moveInit(object, e) {
  init.bubbles = false;
  init.cancelable = false;
  writePoint(object, e, false);
  return init;
}

/**
 * @typedef {object} ForwardingOptions
 * @property {Reactive<boolean>} enabled Whether rays can hit the object at
 *   all, handed to `makeInteractive`.
 * @property {() => void} [onPress] Told when a press on the element, or on
 *   a clickable element inside it, has been delivered as a click; see
 *   `BoxOptions.onPress`.
 */

/**
 * Being a ray target, and forwarding what happens there back to the DOM. A
 * press arrives as `mousedown`, `mouseup` and `click`, and a ray moving over
 * the object as `mousemove`, each carrying the point the ray met, on the
 * page, as its `clientX` and `clientY`. While the ray is on it the element
 * carries
 * `data-xr-hover`, and while it is held, `data-xr-active`. A stylesheet
 * answers those flags where a page would use `:hover` and `:active`.
 * Where the panel has haptics, the hand feels a press and its release, and
 * an arrival on a control where the panel asks for one. A press on
 * something draggable that the hand carries away is a drag and drop
 * instead, and its release is a `drop` and a `dragend` rather than a
 * `mouseup` and a `click` (see `dragAndDrop.js`).
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
  const dnd = dragAndDrop(ctx);
  /**
   * What the hand feels on this element, if it is a control and the panel
   * has haptics at all. The handlers below hand it the hand each event came
   * from.
   */
  const haptics = HapticsContext.get(ctx);

  /**
   * The ray arriving on this element: the hover flag, and the pulse an
   * arrival on a control plays.
   *
   * @param {XREventMap["pointerenter"]} e
   * @returns {void}
   */
  const enter = (e) => {
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
  };

  /**
   * The enters that came while a hand held a press, kept until that hand's
   * hold is over; see `pointerenter` below. One per hand, as the manager
   * tracks enter and leave per hand: the other hand crossing this element
   * neither drops the enter nor lands it.
   *
   * @type {Map<XRTargetRaySpace, XREventMap["pointerenter"]>}
   */
  const heldEnters = new Map();

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
        heldEnters.clear();
        delete element.dataset.xrHover;
        delete element.dataset.xrActive;
      });
    },
    on("select", (e) => {
      // A press that turned into a drag was the player scrolling the list
      // this button sits in, not pressing the button — the same bargain a
      // touchscreen strikes, and for the same reason: there is nowhere else
      // to grab a list that is made of buttons.
      // A press that became a drag and drop is no click either, as a mouse
      // drag is not.
      if (isGone(element) || drags.didScroll(e.controller) || dnd.didDrag(e.controller)) {
        stopPropagation(e);
        return;
      }
      deliverOnce(e, () => {
        element.dispatchEvent(new MouseEvent("click", pressInit(object, e, false)));
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
        // Cancelable, as a real one is: a page that cancels its `mousedown`
        // is saying that nothing is to be dragged from here.
        const pressed = element.dispatchEvent(
          new MouseEvent("mousedown", pressInit(object, e, true)),
        );
        // A press on something draggable may become a drag and drop, and
        // otherwise a press over a list may become a scroll; only holding
        // it will tell. The page's own gesture comes first, as it does
        // under a mouse, where dragging a row drags the row and not the
        // list. Once, by the element the press landed on, since a second
        // `begin` for the same hand would start the gesture over.
        if (!dnd.begin(e.controller, element, object, pressed)) {
          drags.begin(e.controller, element, object);
        }
        // Felt once, however many clickable elements the press holds.
        haptics?.press(e.inputSource);
      });
      element.dataset.xrActive = "true";
      passOn(e);
    }),
    on("selectend", (e) => {
      delete element.dataset.xrActive;
      if (isGone(element)) {
        // A release is owed to whatever still holds the press. An element
        // that has left the document sends no `mouseup` of its own, and the
        // next clickable element up sends it on itself, which is where a
        // page sends a release whose target has gone. The outermost ends the
        // hand's drag when none is left to.
        if (hasForwardingAncestor(object)) {
          return;
        }
        drags.end(e.controller);
        stopPropagation(e);
        return;
      }
      deliverOnce(e, () => {
        drags.end(e.controller);
        // A drag's release is its `drop` and its `dragend`, which the drag
        // sends from the controller's own `selectend`.
        if (!dnd.didDrag(e.controller)) {
          element.dispatchEvent(new MouseEvent("mouseup", pressInit(object, e, false)));
        }
        haptics?.release(e.inputSource);
      });
      passOn(e);
    }),
    on("pointermove", (e) => {
      if (dnd.holding(e.controller)) {
        return;
      }
      // The first move after a hold on a control the ray came onto during
      // it, which is when a page's `:hover` catches up after a drag.
      const held = heldEnters.get(e.controller);
      if (held) {
        heldEnters.delete(e.controller);
        enter(held);
      }
      const event = new MouseEvent("mousemove", moveInit(object, e));
      element.dispatchEvent(event);
    }),
    on("pointerenter", (e) => {
      // Nothing is hovered under a drag, as `:hover` holds still under one
      // on a page; the targets the drag passes over hear `dragenter`. From
      // the press, since the ray has already moved in the frame the press
      // becomes a drag. The enter is kept for the first move after the
      // hold, or the control the drag ended on would show no hover until
      // the ray left it and came back.
      if (dnd.holding(e.controller)) {
        heldEnters.set(e.controller, e);
        return;
      }
      enter(e);
    }),
    on("pointerleave", (e) => {
      heldEnters.delete(e.controller);
      delete element.dataset.xrHover;
    }),
  ];
}
