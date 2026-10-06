import * as THREE from "three";
import { createProperty, onCleanup } from "@apendua/signal";
import { interactions } from "../interactions.js";
import { isBlocker } from "./blocker.js";
import { getParentObject } from "./contentGroup.js";
import {
  dragAndDrop,
  getPanel,
  hitElement,
  isDragSource,
  lazyPanel,
  moveInit,
  planeInit,
  pressInit,
  probePanel,
  releaseInit,
} from "./dragAndDrop.js";
import { createFrameRequester } from "./frameRequester.js";
import { HapticsContext, isArrival } from "./haptics.js";
import { getComputedStyleCached, isPortalRoot } from "./mirror.js";
import { describeElement } from "./panelFrame.js";
import { movesList, sampleRay, ScrollDragsContext } from "./scroll.js";

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
 * Whether the page runs in development: what Vite says as
 * `import.meta.env.DEV` where Vite served or built it, and `NODE_ENV`
 * under Node, as under a test runner.
 *
 * @returns {boolean}
 */
function isDevelopment() {
  // Written out whole, since Vite's dev server gives a module its `env`
  // only where it reads `import.meta.env`, and a build replaces only that.
  const env = import.meta.env;
  if (env) {
    return env.DEV === true;
  }
  // Read off `globalThis`, since a page has no `process` and a types build
  // knows of none.
  const { process } = /** @type {{ process?: { env?: Record<string, string | undefined> } }} */ (
    /** @type {unknown} */ (globalThis)
  );
  return process?.env?.NODE_ENV === "development";
}

/** The elements `noteMissedPress` has named, each once. */
const named = new WeakSet();

/**
 * In development, name an element a press landed on that no ray targets,
 * once. A page marks what it handles presses on with `cursor: pointer`
 * for a mouse's sake, and the ray follows that, so a board that listens
 * for clicks and sets no cursor fails without a sound: the press reaches
 * nothing. The listeners cannot be found to warn about them before a
 * session, since a page attaches them through means nothing outside a
 * browser's devtools lists, so the note comes from the ray's side, the
 * first time it lands there.
 *
 * @param {Element | null} element What the press landed on.
 * @returns {void}
 */
function noteMissedPress(element) {
  if (!element || named.has(element)) {
    return;
  }
  named.add(element);
  console.warn(
    `freedom: a press landed on ${describeElement(element)}, which no ray targets, so the ` +
      "page heard nothing of it. An element is a ray target when its computed cursor is " +
      '"pointer" or it is draggable="true".',
    element,
  );
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
 * @property {Element | null} captor The element the pointer is captured to,
 *   which its moves and its release go to (see `wrapPointerCapture`).
 * @property {Element | null} pending The element the page last asked to
 *   capture the pointer, or null once it let go: `captor` follows it, with
 *   `gotpointercapture` and `lostpointercapture`, before the hand's next
 *   event, as a browser processes a pending capture (see `settleCapture`).
 * @property {boolean} pointerOnly Whether the page cancelled the hand's
 *   `pointerdown`, until its trigger opens. A page that does is saying it
 *   handles the press as a pointer, and a browser then sends none of the
 *   mouse events that would otherwise follow it, `mousedown`, `mousemove`
 *   and `mouseup`, until the button is let go. The `click` still goes.
 * @property {HTMLElement | null} pressed The element the hand's press went
 *   to, until its trigger opens, which hears the press's `pointercancel`
 *   if nothing captured the pointer.
 * @property {boolean} cancelled Whether the hand's press became a scroll or
 *   a drag and drop, until its trigger opens. A browser cancels the pointer
 *   then, and sends nothing more of it until its button is let go.
 * @property {number} buttons The buttons the hand holds, as a mouse event's
 *   `buttons` says them: the trigger as the main button, 1, and the grip
 *   as the secondary one, 2, as its `contextmenu` says `button` 2. Kept
 *   from the controller's own events, wherever its ray is when a button
 *   closes, from the hand's first pointer event on.
 */

/** @type {WeakMap<XRTargetRaySpace, Hand>} */
const hands = new WeakMap();

/**
 * The same hands by `pointerId`, which is all `setPointerCapture` is given.
 * A strong map, deliberately: a page may capture a hand's pointer at any
 * time, so every hand that was ever given an id has to be found by it.
 * There are as many as the session has controllers, and a hand's capture
 * is let go of with its press (see `endPress`).
 *
 * @type {Map<number, Hand>}
 */
const handsById = new Map();

let nextPointerId = 2;

/**
 * The bit each of a hand's buttons sets in `Hand.buttons`, which is the bit
 * a mouse's main button and its secondary one set in a mouse event's.
 */
const HAND_BITS = /** @type {const} */ ({ select: 1, squeeze: 2 });

/** @param {XRTargetRaySpace} controller */
function handOf(controller) {
  wrapWhileHeld();
  let hand = hands.get(controller);
  if (!hand) {
    /** @type {Hand} */
    const created = {
      pointerId: nextPointerId,
      captor: null,
      pending: null,
      pressed: null,
      pointerOnly: false,
      cancelled: false,
      buttons: 0,
    };
    hand = created;
    nextPointerId += 1;
    hands.set(controller, hand);
    handsById.set(hand.pointerId, hand);
    // The controller's own events, which three sends wherever the ray is,
    // and the manager passes on into the scene only when it is on
    // something. A press on a panel writes its bit before these come,
    // since the manager hears them first (see `sendPointerAndMouse`).
    const listened = /** @type {Object3D<any>} */ (controller);
    for (const button of /** @type {const} */ (["select", "squeeze"])) {
      const bit = HAND_BITS[button];
      listened.addEventListener(`${button}start`, () => {
        created.buttons |= bit;
      });
      listened.addEventListener(`${button}end`, () => {
        created.buttons &= ~bit;
      });
    }
    // A hand that goes, at the end of a session say, sends no release, and
    // a browser cancels a pointer it loses: the press and any capture end
    // here, and the pointer leaves what it was over.
    listened.addEventListener("disconnected", () => {
      created.buttons = 0;
      if (created.pressed || created.captor || created.pending) {
        cancelPointer(controller);
      }
      created.pressed = null;
      created.pointerOnly = false;
      created.cancelled = false;
    });
  }
  return hand;
}

/**
 * The buttons a hand holds as one of its events goes out, with the one the
 * event releases let go of already: a `click` or a `contextmenu` comes
 * after its button opened, as a browser's do, though the hand's own record
 * hears the opening only after the panel has sent them.
 *
 * @param {XRTargetRaySpace} controller
 * @param {number} [released] The bit of the button the event releases.
 * @returns {number}
 */
function heldButtons(controller, released = 0) {
  return (hands.get(controller)?.buttons ?? 0) & ~released;
}

/**
 * The hand whose pointer is the primary one, as a browser has a primary
 * touch among several. A touch is primary when it lands with no other
 * touch down, and a hand when it sends a pointer event with the primary
 * one idle: holding no button, with its ray on no panel. A hand whose
 * trigger closes while the primary one holds no button takes over too,
 * whatever that one's ray is on, since the hand that presses is the one
 * the player is using. A hand that presses while the primary one holds a
 * button is a second touch. Only the primary hand sends mouse events, as
 * only the primary touch does, so a page that follows the mouse alone
 * follows one hand and not two rays taking turns.
 *
 * @type {XRTargetRaySpace | null}
 */
let primary = null;

/**
 * The forwarders of the panels that are up, each able to say whether a
 * hand's ray is on its panel, for `isIdle`, to follow a hand captured to
 * one of its elements (see `settleCapture`), and to take a pointer or the
 * mouse out of it (see `cancelPointer` and `elect`). An array, walked by
 * index, since it is asked every frame a hand that is not the primary one
 * moves.
 */

/**
 * @typedef {object} ForwarderEntry
 * @property {(controller: XRTargetRaySpace) => boolean} pointsAt Whether
 *   the hand's ray is on the panel.
 * @property {(controller: XRTargetRaySpace, captor: Element) => void} follow
 *   Follow a hand captured to an element of the panel.
 * @property {(controller: XRTargetRaySpace, init: PointerEventInit) => void} leave
 *   Take the hand's pointer out of everything it is over in the panel.
 * @property {(init: PointerEventInit) => void} mouseOut Take the mouse out
 *   of everything it is over in the panel.
 */

/** @type {ForwarderEntry[]} */
const forwarders = [];

/**
 * Make a hand the primary one if it may be (see `primary`). The mouse goes
 * with it: it leaves what the hand that was primary left it over, on every
 * panel, so that no panel keeps a mouse over an element the page has no
 * mouse on any more.
 *
 * @param {XRTargetRaySpace} controller
 * @param {boolean} pressing Whether its trigger is closing.
 * @param {ForwarderEntry} [asking] The panel asking, which crosses its own
 *   mouse from that element to the new hand's itself (see `track`).
 * @returns {boolean} Whether it is the primary hand now.
 */
function elect(controller, pressing, asking) {
  if (
    primary !== controller &&
    (!primary || (pressing && heldButtons(primary) === 0) || isIdle(primary))
  ) {
    const init = primary ? placeless(primary, heldButtons(primary)) : null;
    primary = controller;
    if (init) {
      for (let i = 0; i < forwarders.length; i += 1) {
        if (forwarders[i] !== asking) {
          forwarders[i].mouseOut(init);
        }
      }
    }
  }
  return primary === controller;
}

/**
 * Whether a hand holds no button and its ray is on no panel.
 *
 * @param {XRTargetRaySpace} controller
 * @returns {boolean}
 */
function isIdle(controller) {
  if (heldButtons(controller) !== 0) {
    return false;
  }
  for (let i = 0; i < forwarders.length; i += 1) {
    if (forwarders[i].pointsAt(controller)) {
      return false;
    }
  }
  return true;
}

/** How many panels are up, each holding the wrap (see `holdPointerCapture`). */
let wrapHolders = 0;

/** Whether the capture methods are wrapped now. */
let wrapped = false;

/** Undo `wrapPointerCapture`, while the wrap is on. */
let unwrapPointerCapture = () => {};

/**
 * Let the page capture a hand's pointer while any panel is up, and give
 * the capture methods back after the last one goes, as `trackValue` gives
 * a field's `value` back after its last watcher. Each forwarder holds it
 * for its panel's life. The methods are wrapped only once a hand sends
 * something while a panel is up (see `wrapWhileHeld`), so a page that
 * mirrors a panel and opens no session runs with the browser's own.
 *
 * @returns {() => void} Let go of it.
 */
function holdPointerCapture() {
  if (typeof Element === "undefined") {
    return () => {};
  }
  wrapHolders += 1;
  let held = true;
  return () => {
    if (!held) {
      return;
    }
    held = false;
    wrapHolders -= 1;
    if (wrapHolders === 0 && wrapped) {
      wrapped = false;
      unwrapPointerCapture();
    }
  };
}

/**
 * Wrap the capture methods if a panel is up and they are not wrapped yet,
 * as a hand sends something. Asked of every one of a hand's events, which
 * costs two reads once they are.
 *
 * @returns {void}
 */
function wrapWhileHeld() {
  if (!wrapped && wrapHolders > 0) {
    wrapped = true;
    unwrapPointerCapture = wrapPointerCapture();
  }
}

/**
 * Let the page capture a hand's pointer. A browser knows nothing of the
 * hands' pointers, so `setPointerCapture` with a hand's `pointerId` throws
 * that there is no such pointer, from the `pointerdown` handler of every
 * page that drags by capture. So the three capture methods are wrapped: a
 * call the browser refuses for a hand's pointer is kept on the hand
 * instead, and while it holds, the hand's moves and its release are sent
 * to the capturing element, whichever control on the panels the ray is
 * over, as a browser sends a captured pointer's. A pointer the browser
 * knows is the browser's, as before.
 *
 * A capture starts and ends as a browser's does: it is pending until the
 * hand's next event, and then the element hears `gotpointercapture`, and
 * `lostpointercapture` as it ends (see `settleCapture`). It ends with the
 * release, after its `pointerup` and `mouseup`, with
 * `releasePointerCapture`, or when the press becomes a scroll or a drag and
 * drop, which cancels it (see `cancelPointer`). A press
 * that sends no `pointerup` ends it as the trigger opens (see `endPress`).
 * Releasing a hand's pointer
 * that holds no capture does nothing, as it does for a pointer a browser
 * knows, so a page's own `pointerup` handler may release what the release
 * already ended.
 *
 * @returns {() => void} Put the methods back, and let go of every capture
 *   the hands hold, since no panel is left to send their events.
 */
function wrapPointerCapture() {
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
      hand.pending = this;
    }
  };
  proto.releasePointerCapture = function (id) {
    const hand = handsById.get(id);
    if (!hand) {
      releasePointerCapture.call(this, id);
    } else if (hand.pending === this) {
      hand.pending = null;
    }
  };
  proto.hasPointerCapture = function (id) {
    return handsById.get(id)?.pending === this || hasPointerCapture.call(this, id);
  };
  return () => {
    Object.assign(proto, { setPointerCapture, releasePointerCapture, hasPointerCapture });
    for (const hand of handsById.values()) {
      hand.captor = null;
      hand.pending = null;
    }
  };
}

/**
 * The init of the events about no place on the page, `gotpointercapture`,
 * `lostpointercapture` and `pointercancel`, and of the leaves that follow
 * a hand that goes. Written in place by `placeless`.
 *
 * @type {PointerEventInit}
 */
const placelessInit = {
  bubbles: true,
  cancelable: false,
  button: -1,
  buttons: 0,
  pointerId: 0,
  pointerType: "mouse",
  isPrimary: false,
  relatedTarget: null,
};

/**
 * `placelessInit` written for one hand's pointer.
 *
 * @param {XRTargetRaySpace} controller
 * @param {number} buttons What the event says the hand holds: none for a
 *   pointer the page has lost.
 * @returns {PointerEventInit}
 */
function placeless(controller, buttons) {
  const hand = hands.get(controller);
  placelessInit.bubbles = true;
  placelessInit.cancelable = false;
  placelessInit.button = -1;
  placelessInit.buttons = buttons;
  placelessInit.pointerId = hand?.pointerId ?? 0;
  placelessInit.isPrimary = controller === primary;
  placelessInit.relatedTarget = null;
  return placelessInit;
}

/**
 * Process a hand's pending capture, as a browser does before it sends the
 * pointer's next event: if the element the page last asked for is not the
 * one that has the pointer, the one that has it hears `lostpointercapture`
 * and the new one `gotpointercapture`. An element that left the page has
 * no capture to get, and the document hears that one that left lost it.
 *
 * @param {XRTargetRaySpace} controller
 * @returns {void}
 */
function settleCapture(controller) {
  const hand = hands.get(controller);
  if (!hand) {
    return;
  }
  if (hand.pending && !hand.pending.isConnected) {
    hand.pending = null;
  }
  if (hand.pending === hand.captor) {
    return;
  }
  const lost = hand.captor;
  hand.captor = hand.pending;
  if (typeof PointerEvent !== "function") {
    return;
  }
  if (lost) {
    const target = lost.isConnected ? lost : lost.ownerDocument;
    target.dispatchEvent(
      new PointerEvent("lostpointercapture", placeless(controller, hand.buttons)),
    );
  }
  if (hand.captor) {
    hand.captor.dispatchEvent(
      new PointerEvent("gotpointercapture", placeless(controller, hand.buttons)),
    );
  }
  const captor = hand.captor;
  if (captor) {
    for (let i = 0; i < forwarders.length; i += 1) {
      forwarders[i].follow(controller, captor);
    }
  }
}

/**
 * A hand's press has become a scroll or a drag and drop, or the hand has
 * gone, and the page loses the pointer, as a browser cancels one whose
 * press it takes for a gesture of its own or whose device goes away:
 * `pointercancel` where the press went, the element that captured it or
 * the one pressed, then `lostpointercapture`, and the pointer leaves
 * everything it was over, on every panel. Nothing more of the pointer
 * reaches the page until the trigger opens, the mouse included, which
 * holds still as it does under a drag; the release catches both up. The
 * scroll gesture and drag and drop are handed this as their `onTaken`.
 *
 * @param {XRTargetRaySpace} controller
 * @returns {void}
 */
function cancelPointer(controller) {
  const hand = hands.get(controller);
  if (!hand || hand.cancelled) {
    return;
  }
  settleCapture(controller);
  hand.cancelled = true;
  if (typeof PointerEvent !== "function") {
    releaseCapture(controller);
    return;
  }
  const target = hand.captor?.isConnected ? hand.captor : hand.pressed;
  if (target?.isConnected) {
    target.dispatchEvent(new PointerEvent("pointercancel", placeless(controller, 0)));
  }
  releaseCapture(controller);
  for (let i = 0; i < forwarders.length; i += 1) {
    forwarders[i].leave(controller, placeless(controller, 0));
  }
}

/**
 * Let go of a hand's capture now, as the end of its press does.
 *
 * @param {XRTargetRaySpace} controller
 * @returns {void}
 */
function releaseCapture(controller) {
  const hand = hands.get(controller);
  if (hand) {
    hand.pending = null;
    settleCapture(controller);
  }
}

/**
 * End what a hand's press asked for, as its trigger opens: the mouse events
 * a cancelled `pointerdown` held back come back, a press the page lost to a
 * scroll or a drag sends again, and a capture ends. The release's
 * `pointerup` ends the capture itself, and so does a cancel, but a press
 * whose element left the page sends neither, and the capture would
 * otherwise take the hand's moves over every other control until its next
 * press.
 *
 * @param {XRTargetRaySpace} controller
 */
function endPress(controller) {
  const hand = hands.get(controller);
  if (hand) {
    hand.pressed = null;
    hand.pointerOnly = false;
    hand.cancelled = false;
    releaseCapture(controller);
  }
}

/**
 * Send a pointer event and the mouse event a browser sends after it, as
 * one: both made before either is sent, from the one init `pressInit` and
 * its siblings write in place, which a handler that the first runs may
 * write again. The mouse event is left out for a hand that is not the
 * primary one (see `primary`) and for one whose `pointerdown` was
 * cancelled (see `Hand.pointerOnly`), and the pointer event where the page
 * has no `PointerEvent` at all, as under a test environment without one.
 * A hand whose press the browser would have cancelled sends neither (see
 * `Hand.cancelled`).
 * A move's pointer event names no button, as a browser's says `-1` for a
 * move that changes none.
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
  if (type === "pointerdown") {
    // A press of its own, whatever became of the last one's release.
    hand.pressed = element;
    hand.pointerOnly = false;
    hand.cancelled = false;
    hand.pending = null;
  } else if (hand.cancelled) {
    return true;
  }
  const isPrimary = elect(controller, type === "pointerdown");
  settleCapture(controller);
  // A press says the button it closed, and a release no longer says the
  // one it opened, as a browser's do; and the hand's record holds them
  // from here, since the controller's own events come after the panel's.
  // Only the trigger presses and releases: the grip sends a `contextmenu`
  // alone.
  if (type === "pointerdown") {
    hand.buttons |= HAND_BITS.select;
  } else if (type === "pointerup") {
    hand.buttons &= ~HAND_BITS.select;
  }
  init.buttons = hand.buttons;
  init.pointerId = hand.pointerId;
  init.isPrimary = isPrimary;
  const pointer = typeof PointerEvent === "function" ? new PointerEvent(type, init) : null;
  init.button = button;
  const mouse = new MouseEvent(MOUSE_EVENT[type], init);
  const captor = hand.captor;
  const target = captor?.isConnected ? captor : element;
  if (pointer && !target.dispatchEvent(pointer) && type === "pointerdown") {
    hand.pointerOnly = true;
  }
  const proceed = hand.pointerOnly || !isPrimary || target.dispatchEvent(mouse);
  if (type === "pointerup") {
    // The release ends the capture, once it has been sent where the
    // capture sent it.
    releaseCapture(controller);
  }
  return proceed;
}

/** The mouse event a browser sends after each pointer event a ray sends. */
const MOUSE_EVENT = /** @type {const} */ ({
  pointerdown: "mousedown",
  pointermove: "mousemove",
  pointerup: "mouseup",
});

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
const NOWHERE = {};

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
 * @returns {void}
 */
function cross(chain, element, init, kind) {
  let gone = 0;
  while (gone < chain.length && !chain[gone].isConnected) {
    gone += 1;
  }
  chain.splice(0, gone);
  if (gone === 0 && (chain[0] ?? null) === element) {
    return;
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
}

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
 * @property {Press} select The trigger's last press.
 * @property {Press} squeeze The grip's, as `select` is the trigger's.
 * @property {Element[]} chain The element the page was last told the
 *   hand's pointer is over, and the elements around it up to the panel's
 *   root, innermost first (see `track`).
 */

/**
 * A press of one button, as it began: the objects it went through, and the
 * innermost target among them, which decides how the events that end it
 * finish. That target is not asked again of what is registered on the path
 * by then: a row removed during the hold, and its update committed, has
 * let go of its registration, and the list under it, or nothing, would
 * otherwise finish a press that was the row's.
 *
 * @typedef {object} Press
 * @property {Object3D[]} path
 * @property {Target | null} target A control or a list for the trigger, a
 *   control alone for the grip, which no list takes.
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
 * `pressInit` in `dragAndDrop.js`). The page also hears where the ray
 * crosses from element to element (see `track`), a press that becomes a
 * scroll or a drag cancelled (see `cancelPointer`), and a captured hand's moves
 * wherever its ray goes (see `following`). While the ray is on a control the
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
      hand = {
        hover: [],
        hovered: null,
        held: null,
        select: { path: [], target: null },
        squeeze: { path: [], target: null },
        chain: [],
      };
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
    for (let node = /** @type {Object3D | null} */ (object); node && node !== container;) {
      path.push(node);
      node = node.parent;
    }
  };

  /**
   * The path a leave goes through: the one the hover recorded, which
   * reaches the objects it went through even after the one it began on has
   * left the scene. A hover that began before this forwarder heard it is
   * walked from where it began. A press keeps its own (see `pressOf`).
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
   * Record a press as it begins, from what the ray met.
   *
   * @param {Press} press
   * @param {Object3D} object
   * @param {boolean} controlsOnly Whether a list can take the press.
   * @returns {Target | null}
   */
  const begin = (press, object, controlsOnly) => {
    walk(object, press.path);
    press.target = innermost(press.path, controlsOnly) ?? null;
    return press.target;
  };

  /**
   * The press an event of one button ends, as its start recorded it. A
   * press that began before this forwarder heard it is walked from where it
   * began, and was pressed on what is registered there now.
   *
   * @param {{ controller: XRTargetRaySpace, originalTarget: Object3D }} e
   * @param {"select" | "squeeze"} button
   * @returns {Press}
   */
  const pressOf = (e, button) => {
    const press = panelHand(e.controller)[button];
    if (press.path[0] !== e.originalTarget) {
      begin(press, e.originalTarget, button === "squeeze");
    }
    return press;
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
   * What the mouse was last told it is over in this panel, as
   * `PanelHand.chain` is for a hand's pointer. One for the panel, since a
   * page has one mouse: it follows the primary hand, and moves to where
   * the other hand is when that one takes over.
   *
   * @type {Element[]}
   */
  const mouseChain = [];

  /**
   * The element a hand's pointer is over in this panel, as a browser would
   * have it: the element that captured it while it holds a capture, if
   * that is in this panel, and nothing here if it is in another; otherwise
   * the innermost control the ray is on that the page still has, the one
   * its moves go to.
   *
   * @param {XRTargetRaySpace} controller
   * @param {PanelHand} hand
   * @returns {Element | null}
   */
  const elementUnder = (controller, hand) => {
    settleCapture(controller);
    const captor = hands.get(controller)?.captor;
    if (captor?.isConnected) {
      const own = panel();
      return !own || own.element.contains(captor) ? captor : null;
    }
    for (const object of hand.hover) {
      const target = targets.get(object);
      if (target && !target.list && !isGone(target.element)) {
        return target.element;
      }
    }
    return null;
  };

  /**
   * The hands whose pointer an element of this panel has captured, each
   * with where in the panel's px its last move was sent from. A browser
   * sends a captured pointer's moves to its captor wherever the pointer
   * goes, and a ray reaches this panel's listeners only while it is on
   * something here; so while a hand is captured, its moves come from where
   * its ray crosses this panel's plane (see `sampleRay`), once a frame the
   * ray has moved, whether it is on a control here, on the panel's
   * background, on another panel or on nothing at all.
   *
   * @type {Map<XRTargetRaySpace, { x: number, y: number, sent: boolean }>}
   */
  const following = new Map();
  const requestFrames = createFrameRequester(ctx);
  /** @type {(() => void) | null} */
  let stopFollowing = null;
  const onPlane = new THREE.Vector3();
  const inPanel = new THREE.Vector2();

  /**
   * One captured hand's move, if its ray has moved across this panel's
   * plane since the last; and let go of a hand no longer captured here.
   *
   * @param {{ x: number, y: number, sent: boolean }} last
   * @param {XRTargetRaySpace} controller
   * @returns {void}
   */
  const moveCaptured = (last, controller) => {
    const captor = hands.get(controller)?.captor;
    const own = panel();
    if (!own || !captor?.isConnected || !own.element.contains(captor)) {
      following.delete(controller);
      return;
    }
    if (!sampleRay(controller, container, onPlane, inPanel)) {
      return;
    }
    if (last.sent && last.x === inPanel.x && last.y === inPanel.y) {
      return;
    }
    last.x = inPanel.x;
    last.y = inPanel.y;
    last.sent = true;
    sendPointerAndMouse(
      /** @type {HTMLElement} */ (captor),
      "pointermove",
      planeInit(own, inPanel.x, inPanel.y),
      controller,
    );
  };

  /** The frames a captured hand is followed on, while any is. */
  const followFrame = () => {
    following.forEach(moveCaptured);
    if (following.size === 0 && stopFollowing) {
      stopFollowing();
      stopFollowing = null;
    }
  };

  /**
   * Bring what the page knows of where a hand's pointer is up to date with
   * where its ray is, before anything else the ray sends: `cross` from the
   * element it was over to `elementUnder`, for its pointer, and for the
   * mouse if it is the primary hand. Not while it holds something
   * draggable, since what is under a pointer holds still under a drag on a
   * page too; the release, or the first move after it, catches up.
   *
   * @param {{ controller: XRTargetRaySpace, intersection?: import('three').Intersection }} e
   * @param {PanelHand} hand
   * @param {boolean} [released] Whether the trigger has just opened, which
   *   ends a hold whatever the drag has still to hear of it.
   * @param {boolean} [pressing] Whether the trigger is closing, which may
   *   make the hand the primary one (see `primary`).
   * @returns {void}
   */
  const track = (e, hand, released = false, pressing = false) => {
    const { controller } = e;
    if (!released && (dnd.holding(controller) || hands.get(controller)?.cancelled)) {
      return;
    }
    const element = elementUnder(controller, hand);
    // A hand whose ray is on nothing here, and was on nothing, is not made
    // the primary one by this panel; one that was the primary one still is.
    const isPrimary =
      hand.chain.length > 0 || element !== null
        ? elect(controller, pressing, registered)
        : primary === controller;
    if (
      (hand.chain[0] ?? null) === element &&
      (!isPrimary || (mouseChain[0] ?? null) === element)
    ) {
      return;
    }
    const pointer = handOf(controller);
    // A point only where the ray is on this panel: a release may come with
    // it on another.
    const own = panel();
    const on = own !== null && getPanel(e.intersection?.object ?? null) === own;
    const init = moveInit(own, on ? e : NOWHERE);
    init.pointerId = pointer.pointerId;
    init.isPrimary = isPrimary;
    init.buttons = heldButtons(controller, released ? HAND_BITS.select : 0);
    if (typeof PointerEvent === "function") {
      cross(hand.chain, element, init, "pointer");
    }
    if (isPrimary) {
      cross(mouseChain, element, init, "mouse");
    }
  };

  /**
   * The init of the `click` a trigger's press completes with, which comes
   * after the trigger opened.
   *
   * @param {XREventMap["select"]} e
   * @returns {MouseEventInit}
   */
  const clickInit = (e) => {
    const init = pressInit(panel(), e, false);
    init.buttons = heldButtons(e.controller, HAND_BITS.select);
    return init;
  };

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
      track(e, hand);
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
      track(e, hand);
      // The first move after a hold on a control the ray came onto during
      // it, which is when a page's `:hover` catches up after a drag.
      const held = hand.held;
      hand.held = null;
      // A captured hand's moves come from the captor's panel, from where
      // the ray crosses its plane: from here at once if that is this one.
      const captured = !!hands.get(e.controller)?.captor?.isConnected;
      const last = following.get(e.controller);
      if (last) {
        moveCaptured(last, e.controller);
      }
      // Once, from the innermost control the ray is over, and it bubbles
      // from there, as a mouse's does: the controls around it hear it on
      // the way up. Not from one that has left the document, which the
      // panel still draws until the commit: the next control up sends it,
      // as it sends a release whose target has gone.
      let sent = captured;
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
      // Onto something else in this panel, its enter crosses over to it.
      const own = panel();
      if (!own || getPanel(e.relatedTarget) !== own) {
        track(e, hand);
      }
    },
    selectstart(e) {
      const hand = panelHand(e.controller);
      const { select } = hand;
      const first = begin(select, e.originalTarget, false);
      if (!first) {
        // A press on the panel's background where the page has an element,
        // and not on a plugin's own object, which the scene takes, nor on
        // the panel's empty root.
        const own = panel();
        if (own && isBlocker(e.originalTarget) && isDevelopment()) {
          const element = hitElement(own, e.intersection.point);
          if (element !== own.element) {
            noteMissedPress(element);
          }
        }
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
      // The hand that presses may take over as the primary one, and then
      // the mouse is over what it presses before it presses it.
      track(e, hand, false, true);
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
      if (!dnd.begin(e.controller, first.element, first.object, pressed, cancelPointer)) {
        drags.begin(e.controller, first.element, first.object, cancelPointer);
      }
      haptics?.press(e.inputSource);
      for (const object of select.path) {
        const target = targets.get(object);
        if (target && !target.list) {
          target.element.dataset.xrActive = "true";
        }
      }
      stopPropagation(e);
    },
    selectend(e) {
      const { path, target: pressed } = pressOf(e, "select");
      if (!pressed) {
        return;
      }
      // The drag a press on a list began ends with the controller's own
      // release, whatever became of the list (see `begin` in `scroll.js`);
      // the list's part is only to keep the release from going on past the
      // panel.
      if (pressed.list) {
        stopPropagation(e);
        return;
      }
      // A release is owed to whatever still holds the press. A control
      // that has left the document, or let go of its registration once its
      // removal committed, sends no `mouseup` of its own, and the next
      // control up sends it on itself, which is where a page sends a
      // release whose target has gone. With none left, the press still
      // ends here. The scroll a press may have become ends with the
      // controller's own release, whatever became of the control.
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
      // A capture, a hold of something draggable: what the press held the
      // pointer to has let go of it. A drag's `drop` and `dragend` come
      // first, from the controller's own release, which follows this one
      // in the same task.
      const hand = panelHand(e.controller);
      if (dnd.holding(e.controller)) {
        queueMicrotask(() => track(e, hand, true));
      } else {
        track(e, hand, true);
      }
      stopPropagation(e);
    },
    select(e) {
      const { path, target: pressed } = pressOf(e, "select");
      if (!pressed) {
        return;
      }
      if (pressed.list) {
        if (!isGone(pressed.element) && !drags.didScroll(e.controller)) {
          pressed.element.dispatchEvent(new MouseEvent("click", clickInit(e)));
        }
        stopPropagation(e);
        return;
      }
      // A press that turned into a drag was the player scrolling the list
      // this control sits in, not pressing the control: the same bargain a
      // touchscreen strikes, and for the same reason, since there is
      // nowhere else to grab a list that is made of buttons. A press that
      // became a drag and drop is no click either, as a mouse drag is not.
      const first = innermost(path, true);
      if (
        !first ||
        isGone(pressed.element) ||
        drags.didScroll(e.controller) ||
        dnd.didDrag(e.controller)
      ) {
        stopPropagation(e);
        return;
      }
      first.element.dispatchEvent(new MouseEvent("click", clickInit(e)));
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
      if (pressOf(e, "select").target) {
        stopPropagation(e);
      }
    },
    squeezestart(e) {
      const first = begin(panelHand(e.controller).squeeze, e.originalTarget, true);
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
      const { path, target: gripped } = pressOf(e, "squeeze");
      // A grab's completion goes on up to the carry.
      if (!gripped || taken(e.start)) {
        return;
      }
      // The grip is the ray's other button. A page hears the mouse's other
      // button as `contextmenu`, and that is where it flags a tile or opens
      // a menu of its own, so that is what the grip sends: on what the ray
      // is on, once however many controls the press holds, and only for a
      // press let go where it started, as a click is. Nothing for a grip
      // that closed while the hand carried or moved a list, whatever it
      // does now, nor for one that opens while it does.
      const first = innermost(path, true);
      if (first && !isGone(gripped.element) && owns(e.start) && !busy(e.controller)) {
        const init = pressInit(panel(), e, true, 2);
        init.buttons = heldButtons(e.controller, HAND_BITS.squeeze);
        first.element.dispatchEvent(new MouseEvent("contextmenu", init));
      }
      stopPropagation(e);
    },
    squeezemissed(e) {
      // Let past for a grab, as its end is, so that every event of a taken
      // grip leaves the panel alike; nothing above listens for a miss
      // today, `drag()` and `carry()` taking the start and the end alone.
      // The panel's own miss stops where a press's does.
      if (pressOf(e, "squeeze").target && !taken(e.start)) {
        stopPropagation(e);
      }
    },
    squeezeend(e) {
      // A grab's end goes on up to the carry.
      if (!pressOf(e, "squeeze").target || taken(e.start)) {
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

  const letGoOfCapture = holdPointerCapture();

  /**
   * This panel, among the panels that are up (see `forwarders`).
   *
   * @type {ForwarderEntry}
   */
  const registered = {
    /** @param {XRTargetRaySpace} controller */
    pointsAt: (controller) => (panelHands.get(controller)?.hover.length ?? 0) > 0,
    /**
     * @param {XRTargetRaySpace} controller
     * @param {Element} captor
     */
    follow: (controller, captor) => {
      if (!panel()?.element.contains(captor)) {
        return;
      }
      // A capture of its own, whose first move goes out wherever the last
      // one's last move was.
      const last = following.get(controller);
      if (last) {
        last.sent = false;
      } else {
        following.set(controller, { x: 0, y: 0, sent: false });
      }
      stopFollowing ??= requestFrames(followFrame);
    },
    leave: (controller, init) => {
      const hand = panelHands.get(controller);
      if (hand) {
        cross(hand.chain, null, init, "pointer");
      }
    },
    mouseOut: (init) => cross(mouseChain, null, init, "mouse"),
  };
  forwarders.push(registered);

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
      const index = forwarders.indexOf(registered);
      if (index !== -1) {
        forwarders.splice(index, 1);
      }
      letGoOfCapture();
      following.clear();
      stopFollowing?.();
      stopFollowing = null;
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
