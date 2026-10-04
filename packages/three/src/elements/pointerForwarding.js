import { createProperty, onCleanup } from "@apendua/signal";
import { interactions } from "../interactions.js";
import { getParentObject } from "./contentGroup.js";
import {
  dragAndDrop,
  isDragSource,
  lazyPanel,
  moveInit,
  pressInit,
  probePanel,
  releaseInit,
} from "./dragAndDrop.js";
import { HapticsContext, isArrival } from "./haptics.js";
import { getComputedStyleCached } from "./mirror.js";
import { movesList, ScrollDragsContext } from "./scroll.js";

/**
 * @import {EntityEffect} from '@apendua/signal';
 * @import {Object3D, XRTargetRaySpace} from 'three';
 * @import {Reactive} from '../interactions.js';
 * @import {InteractionEvent, XREventMap} from '../core.js';
 */

/**
 * Whether the element asks to be a ray target of its own. `cursor: pointer`
 * is the same signal the ordinary web uses to mark an element clickable, so
 * buttons opt in through their stylesheet with no extra attribute. Everything
 * else — cards, labels, layout wrappers — stays out of the raycast set; the
 * portal's blocker plane keeps the panel as a whole opaque to rays. SVG
 * shapes, and the `<g>`, `<a>` and nested `<svg>` that group them, follow
 * the same rule, and `cursor` is inherited into them from the page around
 * the `<svg>`.
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
 * What a hand is to the page as a pointer, whichever panel its ray is on: a
 * page knows a pointer by its id, and the capture and the cancelled
 * `pointerdown` below go with the pointer, across panels, as a browser's
 * go with the mouse across the document.
 *
 * @typedef {object} Hand
 * @property {number} pointerId Given out as the hand first sends a pointer
 *   event: a page that follows a press by its pointer, as a drag does,
 *   follows that hand, and the other ray moving over the same element is
 *   another pointer hovering, not the press wandering off. 1 is the
 *   mouse's in a browser, so the hands count on from 2.
 * @property {Element | null} captor The element the page captured the
 *   pointer to (see `acceptPointerCapture`).
 * @property {boolean} pointerOnly Whether the page cancelled the hand's
 *   `pointerdown`, until its trigger opens. A page that does is saying it
 *   handles the press as a pointer, and a browser then sends none of the
 *   mouse events that would otherwise follow it, `mousedown`, `mousemove`
 *   and `mouseup`, until the button is let go. The `click` still goes.
 */

/** @type {WeakMap<XRTargetRaySpace, Hand>} */
const hands = new WeakMap();

/**
 * The same hands by `pointerId`, which is all `setPointerCapture` is given.
 * A strong map, deliberately: a page may capture a hand's pointer at any
 * time, so every hand that was ever given an id has to be found by it.
 * There are as many as the session has controllers, and a hand's `captor`
 * is let go of with its press (see `endPress`).
 *
 * @type {Map<number, Hand>}
 */
const handsById = new Map();

let nextPointerId = 2;

/** @param {XRTargetRaySpace} controller */
function handOf(controller) {
  let hand = hands.get(controller);
  if (!hand) {
    hand = { pointerId: nextPointerId, captor: null, pointerOnly: false };
    nextPointerId += 1;
    hands.set(controller, hand);
    handsById.set(hand.pointerId, hand);
    acceptPointerCapture();
  }
  return hand;
}

/** Whether `acceptPointerCapture` has run. */
let capturing = false;

/**
 * Let the page capture a hand's pointer. A browser knows nothing of the
 * hands' pointers, so `setPointerCapture` with a hand's `pointerId` throws
 * that there is no such pointer, from the `pointerdown` handler of every
 * page that drags by capture. So, once a hand has a pointer, the three
 * capture methods are wrapped: a call the browser refuses for a hand's
 * pointer is kept on the hand instead, and while it holds, the hand's moves
 * and its release are sent to the capturing element, whichever control on
 * the panels the ray is over, as a browser sends a captured pointer's. A
 * pointer the browser knows is the browser's, as before.
 *
 * Capture ends as a browser ends it: with the release, or with
 * `releasePointerCapture`, or when the press becomes a drag and drop, which
 * sends no `pointerup` (see `endPress`). Releasing a hand's pointer that
 * holds no capture does nothing, as it does for a pointer a browser knows,
 * so a page's own `pointerup` handler may release what the release already
 * ended. Neither `gotpointercapture` nor `lostpointercapture` is sent.
 */
function acceptPointerCapture() {
  if (capturing || typeof Element === "undefined") {
    return;
  }
  capturing = true;
  const proto = Element.prototype;
  const { setPointerCapture, releasePointerCapture, hasPointerCapture } = proto;
  proto.setPointerCapture = function (id) {
    try {
      setPointerCapture.call(this, id);
    } catch (err) {
      const hand = handsById.get(id);
      if (!hand) {
        throw err;
      }
      hand.captor = this;
    }
  };
  proto.releasePointerCapture = function (id) {
    const hand = handsById.get(id);
    if (!hand) {
      releasePointerCapture.call(this, id);
    } else if (hand.captor === this) {
      hand.captor = null;
    }
  };
  proto.hasPointerCapture = function (id) {
    return handsById.get(id)?.captor === this || hasPointerCapture.call(this, id);
  };
}

/**
 * End what a hand's press asked for, as its trigger opens: the mouse events
 * a cancelled `pointerdown` held back come back, and a capture ends. The
 * release's `pointerup` ends the capture itself, but a press that became a
 * drag and drop, or whose element left the page, sends none, and the
 * capture would otherwise take the hand's moves over every other control
 * until its next press.
 *
 * @param {XRTargetRaySpace} controller
 */
function endPress(controller) {
  const hand = hands.get(controller);
  if (hand) {
    hand.pointerOnly = false;
    hand.captor = null;
  }
}

/**
 * Send a pointer event and the mouse event a browser sends after it, as
 * one: both made before either is sent, from the one init `pressInit` and
 * its siblings write in place, which a handler that the first runs may
 * write again. The mouse event is left out for a hand whose `pointerdown`
 * was cancelled (see `Hand.pointerOnly`), and the pointer event where the
 * page has no `PointerEvent` at all, as under a test environment without
 * one. A move's pointer event names no button, as a browser's says `-1`
 * for a move that changes none.
 *
 * @param {HTMLElement} element
 * @param {"pointerdown" | "pointermove" | "pointerup"} type
 * @param {PointerEventInit} init
 * @param {XRTargetRaySpace} controller
 * @returns {boolean} Whether the mouse event, if it was sent, was not
 *   cancelled.
 */
function sendPointerAndMouse(element, type, init, controller) {
  const button = init.button;
  if (type === "pointermove") {
    init.button = -1;
  }
  const hand = handOf(controller);
  init.pointerId = hand.pointerId;
  const pointer = typeof PointerEvent === "function" ? new PointerEvent(type, init) : null;
  init.button = button;
  const mouse = new MouseEvent(MOUSE_EVENT[type], init);
  if (type === "pointerdown") {
    // A press of its own, whatever became of the last one's release.
    hand.pointerOnly = false;
    hand.captor = null;
  }
  const captor = hand.captor;
  const target = captor?.isConnected ? captor : element;
  if (type === "pointerup") {
    hand.captor = null;
  }
  if (pointer && !target.dispatchEvent(pointer) && type === "pointerdown") {
    hand.pointerOnly = true;
  }
  return hand.pointerOnly || target.dispatchEvent(mouse);
}

/** The mouse event a browser sends after each pointer event a ray sends. */
const MOUSE_EVENT = /** @type {const} */ ({
  pointerdown: "mousedown",
  pointermove: "mousemove",
  pointerup: "mouseup",
});

/**
 * An element of a panel that rays act on: a control, which is anything a
 * ray targets of its own (see `isRayTarget`), or a scrolling list that is
 * no control, which a ray takes hold of by the gaps between its rows.
 *
 * @typedef {object} Target
 * @property {HTMLElement} element
 * @property {Object3D} object The element's object, which is registered
 *   with the interaction manager.
 * @property {boolean} list Whether this is a list rather than a control.
 * @property {(() => void) | undefined} onPress See `ForwardingOptions`.
 */

/**
 * What one hand has done on one panel, which the events that follow it
 * read: the objects its last press of each button went through, and the
 * objects its hover went through. The manager sends a release along the
 * press's path and a leave along the hover's, not along a walk from what
 * was hit, since that may have left the scene meanwhile (see
 * `addController` in `interactions.js`), so the panel keeps the same paths
 * and reads which of its targets were on them. Each path stops below the
 * panel's container, and is written in place, so a hand moving from mesh
 * to mesh allocates nothing.
 *
 * @typedef {object} PanelHand
 * @property {Object3D[]} hover
 * @property {Object3D | null} hovered The mesh `hover` was walked from.
 * @property {XREventMap["pointerenter"] | null} held The enter that came
 *   while the hand held something draggable, kept for the first move after
 *   the hold, or the control the drag ended on would show no hover until
 *   the ray left it and came back.
 * @property {Object3D[]} select
 * @property {Object3D[]} squeeze
 */

/**
 * The forwarder of one panel; see `createPanelForwarder`.
 *
 * @typedef {object} Forwarder
 * @property {(object: Object3D, element: HTMLElement, onPress?: () => void) => () => void} control
 *   Take an element as a control, until the function it returns is called,
 *   which also takes its `data-xr-*` flags off.
 * @property {(object: Object3D, element: HTMLElement) => () => void} list
 *   Take an element as a list that is no control.
 * @property {() => void} dispose Stop listening on the container.
 */

/**
 * The forwarder the elements of a panel register with. The portal makes
 * one per panel (`createPanelForwarder`) and sets it as it sets its scroll
 * gesture. An element is forwarded by the panel it is in, so one built
 * outside any portal has none: it is still a ray target, and its events go
 * on past it as they came.
 */
export const PointerForwarderContext = createProperty(
  /**
   * @returns {Forwarder | null}
   */
  () => null,
);

/**
 * What a grip start became, decided as it closes:
 *
 * - `"swallowed"`: it closed on an element that had gone (see `isGone`),
 *   and the panel stopped it. The events that end it ask whether something
 *   took its start, and the manager's `isStopped` alone cannot tell a start
 *   the panel stopped from one the scene took; this can.
 * - `"owned"`: it closed on a control that was there, by a hand neither
 *   carrying nor moving a list. Asked by everything that follows the grip,
 *   the right-click and both pulses, so that they follow one decision
 *   whatever the hand does before it opens. The panel owns it when,
 *   besides, nothing above took it, which is settled by the time anything
 *   asks (see `owns`).
 * - `"felt"`: owned, and its closing pulse has played. That waits for the
 *   start's dispatch to finish, in a microtask, and the grip's end plays it
 *   first if it comes sooner, as it does where a runtime sends both in one
 *   task; either way it plays once, before the opening.
 *
 * A start in none of them closed while the hand was busy: nothing of it is
 * the panel's but the stopping of its end.
 *
 * @typedef {"swallowed" | "owned" | "felt"} Grip
 */

/**
 * Forward what rays do on one panel back to the page, from one listener per
 * ray event on the panel's container object. The interaction manager sends
 * every ray event along the objects from what the ray met up to the
 * controller, and the container is on that path for anything in the panel,
 * so it hears them all; the elements only register (see
 * `forwardPointerEvents`).
 *
 * A browser hit-tests once, picks the innermost element, dispatches once
 * and bubbles, and so does this. For each event the forwarder reads which
 * of its targets the event went through, innermost first. A press arrives
 * as `mousedown`, `mouseup` and `click`, a ray moving over a control as
 * `mousemove`, and a press of the grip as `contextmenu`, which is the grip
 * standing in for the mouse's other button. Each `mousedown`, `mouseup`
 * and `mousemove` has the pointer event a browser sends ahead of it, from
 * the hand's own pointer (see `sendPointerAndMouse`). Each carries the
 * point the ray met, on the page, as its `clientX` and `clientY` (see
 * `pressInit` in `dragAndDrop.js`). While the ray is on a control the
 * element carries `data-xr-hover`, and while it is held, `data-xr-active`.
 * A stylesheet answers those flags where a page would use `:hover` and
 * `:active`. Where the panel has haptics, the hand feels a press and its
 * release, of the grip as of the trigger, and an arrival on a control where
 * the panel asks for one. A press on something draggable that the hand
 * carries away is a drag and drop instead, and its release is a `drop` and
 * a `dragend` rather than a `mouseup` and a `click` (see `dragAndDrop.js`).
 * A grip that closes while the trigger carries something that way, or
 * moves a list, on this panel or another, is no press on anything: it sends
 * no `contextmenu` and is not felt, closing or opening. One that closed
 * before and opens while the hand is busy sends no `contextmenu` either,
 * but is felt opening, as its closing was: the pulses follow the closing,
 * and the right-click asks again as it opens.
 *
 * Controls nest, if only because `cursor` is inherited: the label in a
 * button, the icon in it, a button on a clickable card. A press goes where
 * it goes on a page. The innermost control is the target of the DOM
 * events, sent once, and they bubble through the DOM from there. Every
 * control around it is pressed too, the way `:active` applies to the
 * ancestors of what is pressed, so each one takes `data-xr-active` and
 * hears its own `onPress`. The ray event stops at the container, so nothing
 * outside the panel sees a press the panel took. The one ray event let past
 * is the grip's start, so that a scene can pick up with the grip what the
 * panel hangs from, a `drag()` with `squeeze` among its buttons. A grip
 * something above took that way is that grab's, and the panel neither
 * sends nor feels it; a grip nothing took is the panel's, and its end, its
 * completion and its miss stop at the container too, as a trigger's do.
 *
 * A press whose innermost target is a list, between its rows or on its
 * padding, is the list's: it may become a scroll, a press that never did
 * still reports a `click` on the list, which is what the panel's background
 * would have reported had the list not been in the way, and no flag is
 * written, since the list is draggable rather than clickable.
 *
 * An event that went through none of the panel's targets, a hit on the
 * panel's own blocker or on what a plugin hangs in the panel, goes on as
 * it came.
 *
 * @param {WeakKey} ctx The panel's context, with its haptics and its scroll
 *   gesture.
 * @param {Object3D} container The panel's container object.
 * @returns {Forwarder}
 */
export function createPanelForwarder(ctx, container) {
  const { stopPropagation, isStopped } = interactions(ctx);
  const drags = ScrollDragsContext.get(ctx);
  const dnd = dragAndDrop(ctx);
  /** What the hand feels on a control, if the panel has haptics at all. */
  const haptics = HapticsContext.get(ctx);

  /** @type {Map<Object3D, Target>} */
  const targets = new Map();

  /** @type {Map<XRTargetRaySpace, PanelHand>} */
  const panelHands = new Map();

  /** @type {WeakMap<object, Grip>} */
  const grips = new WeakMap();

  /**
   * The panel, for where its events are on the page: the one registered
   * under the container, found on the first event that needs it, since the
   * portal registers the panel after it builds the forwarder.
   */
  const panel = lazyPanel(container);

  /**
   * @param {XRTargetRaySpace} controller
   * @returns {PanelHand}
   */
  const panelHand = (controller) => {
    let hand = panelHands.get(controller);
    if (!hand) {
      hand = { hover: [], hovered: null, held: null, select: [], squeeze: [] };
      panelHands.set(controller, hand);
    }
    return hand;
  };

  /**
   * Write the objects from `object` up to the container, the container
   * left out, into `path`.
   *
   * @param {Object3D} object
   * @param {Object3D[]} path
   * @returns {void}
   */
  const walk = (object, path) => {
    path.length = 0;
    for (let node = /** @type {Object3D | null} */ (object); node && node !== container; ) {
      path.push(node);
      node = node.parent;
    }
  };

  /**
   * The path an event that ends a press or a hover went through: the one
   * recorded as it began, which reaches the objects it went through even
   * after the one it began on has left the scene. One that began before
   * this forwarder heard it is walked from where it began.
   *
   * @param {Object3D[]} path
   * @param {{ originalTarget: Object3D }} e
   * @returns {Object3D[]}
   */
  const recorded = (path, e) => {
    if (path[0] !== e.originalTarget) {
      walk(e.originalTarget, path);
    }
    return path;
  };

  /**
   * The innermost target on a path, control or list, or the innermost
   * control, passing over any list below it.
   *
   * @param {Object3D[]} path
   * @param {boolean} [controlsOnly]
   * @returns {Target | undefined}
   */
  const innermost = (path, controlsOnly = false) => {
    for (const object of path) {
      const target = targets.get(object);
      if (target && !(controlsOnly && target.list)) {
        return target;
      }
    }
    return undefined;
  };

  /**
   * Whether an enter is the ray arriving on this control, which is what
   * plays the pulse and reads where the page lays the panel out. Not the
   * ray moving between this element and something clickable inside it,
   * which `isArrival` says is not an arrival at all; and not while the
   * hand is scrolling a list, when the rows pass under a ray that is aimed
   * at none of them, glide included.
   *
   * @param {Target} target
   * @param {XREventMap["pointerenter"]} e
   * @returns {boolean}
   */
  const arrived = (target, e) =>
    !drags.scrolling(e.controller) &&
    isArrival(getControlRoot(target.element, target.object), e.relatedTarget);

  /**
   * The ray arriving on a control: the hover flag, and the pulse an arrival
   * on a control plays, once per arrival, by the control that was hit and
   * not by the ones around it.
   *
   * @param {Target} target
   * @param {XREventMap["pointerenter"]} e
   * @param {boolean} [arrival] `arrived` for this target and enter, if it
   *   is known already.
   * @returns {void}
   */
  const enter = (target, e, arrival) => {
    target.element.dataset.xrHover = "true";
    if (haptics && e.registeredTarget === target.object && (arrival ?? arrived(target, e))) {
      haptics.hover(e.inputSource);
    }
  };

  /**
   * Whether something above the panel took the grip's start, a `drag()`
   * that picks things up with the grip. Then the press was a grab, and the
   * events that end it are the carry's, whatever became of the control in
   * the meantime: a row the page took out while the hand carried the panel
   * by it still has to hand the carry its end. Asked of the start itself,
   * which the manager hands over.
   *
   * @param {InteractionEvent} start
   * @returns {boolean}
   */
  const taken = (start) => isStopped(start) && grips.get(start) !== "swallowed";

  /**
   * Whether the panel owns the grip that began with this start: the start
   * was `owned` as it closed, and nothing above took it.
   *
   * @param {InteractionEvent} start
   * @returns {boolean}
   */
  const owns = (start) => {
    const state = grips.get(start);
    return (state === "owned" || state === "felt") && !isStopped(start);
  };

  /**
   * The closing pulse of an owned grip, once.
   *
   * @param {InteractionEvent} start
   * @returns {void}
   */
  const feelClosing = (start) => {
    if (haptics && grips.get(start) === "owned") {
      grips.set(start, "felt");
      haptics.press(start.inputSource);
    }
  };

  /**
   * Whether the hand's trigger is, right now, carrying something or moving
   * a list, anywhere in the scene: a drag whose `dragstart` went out and
   * that has not dropped, or a list dragged past the threshold and still
   * held or gliding. A grip meanwhile is no right-click: a page in the
   * middle of a drag hears no other button, and a list being scrolled is
   * not a row being pressed. Asked as the grip closes, for the grip's
   * whole state, and again as it opens, for the right-click alone. A
   * trigger only resting on a row or a card, which may yet become a click,
   * is neither, and a grip under it is a right-click as a mouse's would be.
   *
   * The trigger's own completion asks something else, in another tense:
   * whether its press turned into one of these (`didScroll`, `didDrag`).
   * This is a second press asking about the trigger's, so it asks about
   * now.
   *
   * @param {XRTargetRaySpace} controller
   * @returns {boolean}
   */
  const busy = (controller) => dnd.carrying(controller) || movesList(ctx, controller);

  /**
   * One listener per ray event. Each reads what the ray met from the
   * event's `originalTarget`: three writes `target` as the object whose
   * listener is running, which here is the container.
   *
   * @type {{ [K in keyof import('../core.js').InteractionEventMap]: (e: XREventMap[K]) => void }}
   */
  const listeners = {
    pointerenter(e) {
      const hand = panelHand(e.controller);
      walk(e.originalTarget, hand.hover);
      hand.hovered = e.originalTarget;
      // Nothing is hovered under a drag, as `:hover` holds still under one
      // on a page; the targets the drag passes over hear `dragenter`. From
      // the press, since the ray has already moved in the frame the press
      // becomes a drag.
      if (dnd.holding(e.controller)) {
        hand.held = e;
        return;
      }
      const first = innermost(hand.hover, true);
      if (!first) {
        return;
      }
      // An arrival on a control is one event, so it is where the moves
      // that follow take their point from: the panel is asked where the
      // page lays it out now, and a hover starts exact. Only for an
      // arrival by `arrived`'s rule, the pulse's: the rows passing under a
      // scroll move nothing the root's rect depends on, and the press that
      // began the scroll read it. Not under a drag, which probes the panels
      // it crosses itself and whose drop reads the one it ends on again.
      const arrival = arrived(first, e);
      const own = arrival ? panel() : null;
      if (own) {
        probePanel(own);
      }
      for (const object of hand.hover) {
        const target = targets.get(object);
        if (target && !target.list) {
          enter(target, e, target === first ? arrival : undefined);
        }
      }
    },
    pointermove(e) {
      const hand = panelHand(e.controller);
      if (e.originalTarget !== hand.hovered) {
        walk(e.originalTarget, hand.hover);
        hand.hovered = e.originalTarget;
      }
      if (dnd.holding(e.controller)) {
        return;
      }
      // The first move after a hold on a control the ray came onto during
      // it, which is when a page's `:hover` catches up after a drag.
      const held = hand.held;
      hand.held = null;
      // Once, from the innermost control the ray is over, and it bubbles
      // from there, as a mouse's does: the controls around it hear it on
      // the way up. Not from one that has left the document, which the
      // panel still draws until the commit: the next control up sends it,
      // as it sends a release whose target has gone.
      let sent = false;
      for (const object of hand.hover) {
        const target = targets.get(object);
        if (!target || target.list) {
          continue;
        }
        if (held) {
          enter(target, held);
        }
        if (!sent && !isGone(target.element)) {
          sent = true;
          sendPointerAndMouse(target.element, "pointermove", moveInit(panel(), e), e.controller);
        }
      }
    },
    pointerleave(e) {
      const hand = panelHand(e.controller);
      hand.held = null;
      for (const object of recorded(hand.hover, e)) {
        const target = targets.get(object);
        if (target && !target.list) {
          delete target.element.dataset.xrHover;
        }
      }
      hand.hover.length = 0;
      hand.hovered = null;
    },
    selectstart(e) {
      const hand = panelHand(e.controller);
      walk(e.originalTarget, hand.select);
      const first = innermost(hand.select);
      if (!first) {
        return;
      }
      // A press that lands on an element that has gone is swallowed (see
      // `isGone`), and goes no further than the panel.
      if (first.list) {
        if (!isGone(first.element)) {
          // The press is one event, so it reads where the page lays the
          // panel out, as a press on a control does through its
          // `mousedown`. The controls the ray reaches while the list
          // scrolls, and while it glides after, read nothing on arrival
          // (see `arrived`), and their moves take this corner.
          const own = panel();
          if (own) {
            probePanel(own);
          }
          drags.begin(e.controller, first.element, first.object);
        }
        stopPropagation(e);
        return;
      }
      if (isGone(first.element)) {
        stopPropagation(e);
        return;
      }
      // Cancelable, as a real one is: a page that cancels its `mousedown`
      // is saying that nothing is to be dragged from here. A cancelled
      // `pointerdown` says something else, that the page takes the press
      // as a pointer, and holds no drag back on a page either.
      const pressed = sendPointerAndMouse(
        first.element,
        "pointerdown",
        pressInit(panel(), e, true),
        e.controller,
      );
      // A press on something draggable may become a drag and drop, and
      // otherwise a press over a list may become a scroll; only holding it
      // will tell. The page's own gesture comes first, as it does under a
      // mouse, where dragging a row drags the row and not the list.
      if (!dnd.begin(e.controller, first.element, first.object, pressed)) {
        drags.begin(e.controller, first.element, first.object);
      }
      haptics?.press(e.inputSource);
      for (const object of hand.select) {
        const target = targets.get(object);
        if (target && !target.list) {
          target.element.dataset.xrActive = "true";
        }
      }
      stopPropagation(e);
    },
    selectend(e) {
      const path = recorded(panelHand(e.controller).select, e);
      const first = innermost(path);
      if (!first) {
        return;
      }
      // The drag a press on a list began ends with the controller's own
      // release, whatever became of the list (see `begin` in `scroll.js`);
      // the list's part is only to keep the release from going on past the
      // panel.
      if (first.list) {
        stopPropagation(e);
        return;
      }
      // A release is owed to whatever still holds the press. A control
      // that has left the document sends no `mouseup` of its own, and the
      // next control up sends it on itself, which is where a page sends a
      // release whose target has gone. The scroll a press may have become
      // ends with the controller's own release, whatever became of the
      // control.
      let sent = false;
      for (const object of path) {
        const target = targets.get(object);
        if (!target || target.list) {
          continue;
        }
        delete target.element.dataset.xrActive;
        if (!sent && !isGone(target.element)) {
          sent = true;
          // A drag's release is its `drop` and its `dragend`, which the
          // drag sends from the controller's own `selectend`.
          if (!dnd.didDrag(e.controller)) {
            sendPointerAndMouse(target.element, "pointerup", releaseInit(panel(), e), e.controller);
          }
          haptics?.release(e.inputSource);
        }
      }
      endPress(e.controller);
      stopPropagation(e);
    },
    select(e) {
      const path = recorded(panelHand(e.controller).select, e);
      const first = innermost(path);
      if (!first) {
        return;
      }
      if (first.list) {
        if (!isGone(first.element) && !drags.didScroll(e.controller)) {
          first.element.dispatchEvent(new MouseEvent("click", pressInit(panel(), e, false)));
        }
        stopPropagation(e);
        return;
      }
      // A press that turned into a drag was the player scrolling the list
      // this control sits in, not pressing the control: the same bargain a
      // touchscreen strikes, and for the same reason, since there is
      // nowhere else to grab a list that is made of buttons. A press that
      // became a drag and drop is no click either, as a mouse drag is not.
      if (isGone(first.element) || drags.didScroll(e.controller) || dnd.didDrag(e.controller)) {
        stopPropagation(e);
        return;
      }
      first.element.dispatchEvent(new MouseEvent("click", pressInit(panel(), e, false)));
      for (const object of path) {
        const target = targets.get(object);
        if (target && !target.list) {
          target.onPress?.();
        }
      }
      stopPropagation(e);
    },
    selectmissed(e) {
      // The panel took the press at its start, so its miss is the panel's
      // as its end is.
      if (innermost(recorded(panelHand(e.controller).select, e))) {
        stopPropagation(e);
      }
    },
    squeezestart(e) {
      const hand = panelHand(e.controller);
      walk(e.originalTarget, hand.squeeze);
      const first = innermost(hand.squeeze, true);
      if (!first) {
        return;
      }
      // Swallowed as a trigger's press on such an element is, and before
      // the scene can grab the panel by a row the page has let go of.
      if (isGone(first.element)) {
        grips.set(e, "swallowed");
        stopPropagation(e);
        return;
      }
      if (busy(e.controller)) {
        return;
      }
      grips.set(e, "owned");
      // Felt once as the grip closes on a control, as a trigger's press is,
      // but only once the dispatch has run, since the start goes on past
      // the panel and only then is it known whether something above took
      // it. A grab is felt by nothing here.
      if (haptics) {
        queueMicrotask(() => {
          if (owns(e)) {
            feelClosing(e);
          }
        });
      }
    },
    squeeze(e) {
      const first = innermost(recorded(panelHand(e.controller).squeeze, e), true);
      // A grab's completion goes on up to the carry.
      if (!first || taken(e.start)) {
        return;
      }
      // The grip is the ray's other button. A page hears the mouse's other
      // button as `contextmenu`, and that is where it flags a tile or opens
      // a menu of its own, so that is what the grip sends: on what the ray
      // is on, once however many controls the press holds, and only for a
      // press let go where it started, as a click is. Nothing for a grip
      // that closed while the hand carried or moved a list, whatever it
      // does now, nor for one that opens while it does.
      if (!isGone(first.element) && owns(e.start) && !busy(e.controller)) {
        first.element.dispatchEvent(new MouseEvent("contextmenu", pressInit(panel(), e, true, 2)));
      }
      stopPropagation(e);
    },
    squeezemissed(e) {
      // Let past for a grab, as its end is, so that every event of a taken
      // grip leaves the panel alike; nothing above listens for a miss
      // today, `drag()` and `carry()` taking the start and the end alone.
      // The panel's own miss stops where a press's does.
      if (innermost(recorded(panelHand(e.controller).squeeze, e), true) && !taken(e.start)) {
        stopPropagation(e);
      }
    },
    squeezeend(e) {
      // A grab's end goes on up to the carry.
      if (!innermost(recorded(panelHand(e.controller).squeeze, e), true) || taken(e.start)) {
        return;
      }
      // Felt once as the grip opens, on a hit and a miss alike, as a
      // trigger's release is, for exactly the grips whose closing is felt:
      // a grip swallowed on a gone row, or closed while the hand carried or
      // moved a list, is felt neither way, whatever the hand is doing as it
      // opens. A closing not felt yet, its microtask still to come, is felt
      // first.
      if (haptics && owns(e.start)) {
        feelClosing(e.start);
        haptics.release(e.inputSource);
      }
      stopPropagation(e);
    },
  };

  const listened = /** @type {Object3D<XREventMap>} */ (container);
  const types = /** @type {(keyof typeof listeners)[]} */ (Object.keys(listeners));
  for (const type of types) {
    listened.addEventListener(type, /** @type {never} */ (listeners[type]));
  }

  /**
   * Take a target until the function returned is called, which also takes
   * a control's `data-xr-*` flags off; a list writes none.
   *
   * @param {Target} target
   * @returns {() => void}
   */
  const register = (target) => {
    targets.set(target.object, target);
    return () => {
      if (targets.get(target.object) === target) {
        targets.delete(target.object);
      }
      if (!target.list) {
        delete target.element.dataset.xrHover;
        delete target.element.dataset.xrActive;
      }
    };
  };

  return {
    control: (object, element, onPress) => register({ element, object, list: false, onPress }),
    list: (object, element) => register({ element, object, list: true, onPress: undefined }),
    dispose() {
      for (const type of types) {
        listened.removeEventListener(type, /** @type {never} */ (listeners[type]));
      }
      panelHands.clear();
    },
  };
}

/**
 * @typedef {object} ForwardingOptions
 * @property {Reactive<boolean>} enabled Whether rays can hit the object at
 *   all, handed to `makeInteractive`.
 * @property {() => void} [onPress] Told when a press on the element, or on
 *   a control inside it, has been delivered as a click; see
 *   `BoxOptions.onPress`.
 */

/**
 * Being a control: a ray target, whose events the panel's forwarder sends
 * back to the DOM (see `createPanelForwarder`). Boxes, SVG shapes and
 * clickable SVG groups all register this way, so a panel's stylesheet and
 * its click handlers see the same events whichever of them the ray met.
 *
 * An element that stops being clickable has to stop being forwarded too,
 * not just stop being registered: the manager dispatches up the parent
 * chain, so an element left forwarded would still take events bubbling out
 * of a control inside it and press itself. Mount and unmount the returned
 * list as a whole. Unmounting it clears the flags, since the `pointerleave`
 * that would have cleared them goes with it.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {Object3D<XREventMap>} object The registered object. A press that
 *   turns into a drag is measured from its frame.
 * @param {ForwardingOptions} options
 * @returns {EntityEffect<Object3D<XREventMap>>[]}
 */
export function forwardPointerEvents(ctx, element, object, { enabled, onPress }) {
  const { makeInteractive } = interactions(ctx);
  const forwarder = PointerForwarderContext.get(ctx);
  return [
    makeInteractive(enabled),
    () => {
      if (forwarder) {
        onCleanup(forwarder.control(object, element, onPress));
      }
    },
  ];
}

/**
 * Being a list a ray takes hold of: a ray target for the gaps between its
 * rows and for its own padding, whose presses the panel's forwarder hands
 * to the scroll gesture (see `createPanelForwarder`). As
 * `forwardPointerEvents` is for a control, and mounted and unmounted the
 * same way.
 *
 * @param {WeakKey} ctx
 * @param {HTMLElement} element
 * @param {Object3D<XREventMap>} object
 * @param {Reactive<boolean>} enabled
 * @returns {EntityEffect<Object3D<XREventMap>>[]}
 */
export function forwardListEvents(ctx, element, object, enabled) {
  const { makeInteractive } = interactions(ctx);
  const forwarder = PointerForwarderContext.get(ctx);
  return [
    makeInteractive(enabled),
    () => {
      if (forwarder) {
        onCleanup(forwarder.list(object, element));
      }
    },
  ];
}
