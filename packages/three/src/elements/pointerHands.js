/**
 * The hands as pointers on the page, across every panel that is up: each
 * hand's pointer id and buttons, which hand is the primary one, the
 * pointer capture a page asks for and the events that end it, and the
 * pointer and mouse events a ray sends. A panel's forwarder
 * (`createPanelForwarder` in `pointerForwarding.js`) reads and writes
 * these as its rays move; what they hold outlives any one panel. `track`,
 * which the comments below cite, is the forwarder's, in that file.
 */

import { writeClient } from "./dragAndDrop.js";

/**
 * @import {Object3D, XRTargetRaySpace} from 'three';
 */

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
 * A swallowed press is silent to its end: the page hears no `pointerdown`,
 * no `pointerup` and no click of it, and the hand feels neither its press
 * nor its release. Not even from a control still around the element, which
 * would otherwise hear a release it heard no press for. That differs from
 * an element that goes during a press: the page heard that press, and the
 * next control up sends its release. The button stays held all the same,
 * so the hand's moves while it holds a swallowed press say `buttons` 1, as
 * a browser's moves do for a button pressed outside its window.
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
 * @property {number} x Where on the page the page last heard the hand's
 *   pointer was, in client coordinates: the point of the last of its
 *   events that said one, its `pointerdown`, `pointermove` and placed
 *   `pointerup`, the crossings of its pointer or the mouse from element
 *   to element (see `track` and `ForwarderEntry.bringUp`), and the drag
 *   events its press sends, `dragstart` to `dragend` (see
 *   `DragAndDrop.begin`). One point for every panel, since the panels'
 *   points are all on the one page, wherever the event that wrote it was
 *   sent. A release is placed when it is captured, or when its ray is on
 *   its panel; one with no capture off its panel says 0, 0, which is
 *   nowhere rather than a place, and is left out, as are the crossings
 *   after it that say 0, 0 too.
 *
 *   The events that no ray places say this point (see `atPointer`), so a
 *   page hears the pointer go on from where it last heard it and never
 *   from the corner:
 *
 *   - `gotpointercapture` and `lostpointercapture`, as a capture changes
 *     between two of the pointer's events: the `pointerdown` for a capture
 *     taken in its handler, the release for the capture it ends.
 *   - `pointercancel`, and the leaves after it on every panel (see
 *     `cancelPointer`). Under a scroll, the page has heard the pointer's
 *     moves and crossings up to the frame the press became one, so the
 *     cancel says the last of them. Under a drag and drop, it has heard no
 *     move since the press, and `dragstart` says the press's point, so the
 *     cancel says that; the drag's own events go on from there, and the
 *     point with them.
 *   - The crossings a `selectend` sends with the ray off its panel (see
 *     `track`): where a placed release said, or, after a press that sent
 *     no `pointerup`, where the page last heard the pointer: the cancel's
 *     point after a scroll, the `dragend`'s after a drag and drop, and the
 *     last move's after a press swallowed on an element that had gone.
 *     After a release that said 0, 0, they say 0, 0 too (see
 *     `releasedNowhere`), as they say what the release said.
 *   - The leaves of a ray that has left a panel, onto nothing or onto
 *     another panel, which no point of the ray's own places there (see
 *     `track`, and `writePoint` in `dragAndDrop.js` for why not where it
 *     crosses the panel's plane); and the crossings that bring a panel up
 *     to date for a hand that is over nothing on it, whose ray is on
 *     another panel or has gone, or that is captured to an element of it
 *     with a ray that crosses its plane nowhere (see
 *     `ForwarderEntry.bringUp`).
 *   - The leaves of a hand that has gone, which has no ray left to place
 *     them, on its own panel and on the others (see `track` and
 *     `BringUp.nowhere`).
 *   - A captured release whose ray crosses the captor's plane nowhere,
 *     the hand turned round (see `placeCapturedRelease`).
 * @property {number} y See `x`.
 * @property {boolean} releasedNowhere Whether the release a `selectend` is
 *   finishing went out at 0, 0 (see `x`), from its `pointerup` to the
 *   crossings the same `selectend` sends after it, which then say 0, 0 too
 *   (see `track`); false at any other time. Set as the `pointerup` goes
 *   out, and cleared once those crossings have read it. A `selectend` that
 *   sends no `pointerup` never sets it.
 */

/** @type {WeakMap<XRTargetRaySpace, Hand>} */
export const hands = new WeakMap();

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
export const HAND_BITS = /** @type {const} */ ({ select: 1, squeeze: 2 });

/** @param {XRTargetRaySpace} controller */
export function handOf(controller) {
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
      x: 0,
      y: 0,
      releasedNowhere: false,
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
      lose(controller);
      endPress(controller);
      // The hand is over nothing now, on any panel: its pointer, which a
      // cancel has already taken out wherever there was a press, and then
      // the mouse, as a browser's leaves come. A capture held them over its
      // captor wherever the ray was, and the ray's own leave reaches only
      // the panel it was on.
      bringUpElsewhere(controller, undefined, { pointer: true, nowhere: true });
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
export function heldButtons(controller, released = 0) {
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
export let primary = null;

/**
 * @typedef {object} ForwarderEntry
 * @property {(controller: XRTargetRaySpace) => void} rehover Flag
 *   `data-xr-hover` where the hand's pointer is over in the panel, as its
 *   capture has just begun or ended.
 * @property {(controller: XRTargetRaySpace) => boolean} pointsAt Whether
 *   the hand's ray is on the panel.
 * @property {(controller: XRTargetRaySpace, captor: Element) => void} follow
 *   Follow a hand captured to an element of the panel.
 * @property {(controller: XRTargetRaySpace, captor: Element, init: PointerEventInit) => boolean} placeRelease
 *   Write the point where the ray of a hand captured to an element of the
 *   panel crosses the panel's plane into its release's init; false, with
 *   nothing written, for a captor elsewhere or a ray that crosses the
 *   plane nowhere.
 * @property {(controller: XRTargetRaySpace, init: PointerEventInit) => void} leave
 *   Take the hand's pointer out of everything it is over in the panel.
 * @property {(controller: XRTargetRaySpace, how: BringUp) => void} bringUp
 *   Cross the mouse, if the hand is the primary one, and its pointer if
 *   `how` says so, to the element the hand is over in the panel now, at
 *   the point where its ray crosses the panel's plane, or, for a hand
 *   over nothing in the panel, or captured to an element of it with a ray
 *   that crosses its plane nowhere, where the page last heard its pointer
 *   was.
 */

/**
 * How `bringUpElsewhere` brings a hand up to date.
 *
 * @typedef {object} BringUp
 * @property {boolean} pointer Whether the hand's pointer crosses too, and
 *   not the mouse alone.
 * @property {number} buttons What the crossings say the hand holds.
 * @property {boolean} nowhere Whether the hand is over nothing at all, as
 *   one that has gone is, wherever its ray was left. Its crossings then say
 *   where the page last heard its pointer was (see `Hand.x`).
 */

/**
 * The forwarders of the panels that are up, each able to say whether a
 * hand's ray is on its panel, for `isIdle`, to follow a hand captured to
 * one of its elements (see `settleCapture`), and to bring what the page
 * knows of a hand up to date in it (see `cancelPointer`, `elect` and
 * `bringUpElsewhere`). An array, walked by index, since it is asked every
 * frame a hand that is not the primary one moves.
 *
 * @type {ForwarderEntry[]}
 */
export const forwarders = [];

/**
 * Place the release of a hand captured to `captor` as its moves under the
 * capture are placed: where its ray crosses the plane of the captor's
 * panel (see `ForwarderEntry.placeRelease`), wherever the ray is. A ray
 * that crosses that plane nowhere, the hand turned round, leaves the
 * pointer where the page last heard it was, as a browser's release says
 * the pointer's last position.
 *
 * @param {XRTargetRaySpace} controller
 * @param {Hand} hand
 * @param {Element} captor
 * @param {PointerEventInit} init Written in place.
 * @returns {void}
 */
function placeCapturedRelease(controller, hand, captor, init) {
  for (let i = 0; i < forwarders.length; i += 1) {
    if (forwarders[i].placeRelease(controller, captor, init)) {
      return;
    }
  }
  writeLastPoint(init, hand);
}

/**
 * Write where the page last heard a hand's pointer was (see `Hand.x`) into
 * an event's init.
 *
 * @param {PointerEventInit} init
 * @param {Hand} hand
 * @returns {void}
 */
export function writeLastPoint(init, hand) {
  writeClient(init, hand.x, hand.y);
}

/**
 * Record an event's point, in client coordinates, as where the page last
 * heard a hand's pointer was (see `Hand.x`), as `writeLastPoint` reads it
 * back. The only writer of `Hand.x`.
 *
 * @param {Hand} hand
 * @param {number} x
 * @param {number} y
 * @returns {void}
 */
export function recordPoint(hand, x, y) {
  hand.x = x;
  hand.y = y;
}

/**
 * Record the point of a drag event a hand's press sent, as the drag and
 * drop tells it (see `DragAndDrop.begin`).
 *
 * @param {XRTargetRaySpace} controller
 * @param {number} x
 * @param {number} y
 * @returns {void}
 */
export function recordDragPoint(controller, x, y) {
  recordPoint(handOf(controller), x, y);
}

/**
 * Bring what the page knows of a hand up to date on every panel but one,
 * where that one does it itself (see `ForwarderEntry.bringUp`).
 *
 * @param {XRTargetRaySpace} controller
 * @param {ForwarderEntry | undefined} except
 * @param {object} [options]
 * @param {boolean} [options.pointer] See `BringUp`.
 * @param {number} [options.released] The bit of a button that has opened
 *   though the hand's own record has not heard so yet, as at a release
 *   (see `heldButtons`).
 * @param {boolean} [options.nowhere] See `BringUp`.
 * @returns {void}
 */
export function bringUpElsewhere(
  controller,
  except,
  { pointer = false, released = 0, nowhere = false } = {},
) {
  /** @type {BringUp} */
  const how = { pointer, buttons: heldButtons(controller, released), nowhere };
  for (let i = 0; i < forwarders.length; i += 1) {
    if (forwarders[i] !== except) {
      forwarders[i].bringUp(controller, how);
    }
  }
}

/**
 * Make a hand the primary one if it may be (see `primary`). The mouse goes
 * with it, on every panel, whichever way the election came: it leaves
 * what the hand that was primary left it over and is over what the new
 * one is over, the captor where the new hand holds a capture, before
 * anything the new hand sends. So no panel keeps a mouse over an element
 * the page has no mouse on any more, and no mouse event goes out from
 * where the mouse never came.
 *
 * @param {XRTargetRaySpace} controller
 * @param {boolean} pressing Whether its trigger is closing.
 * @param {ForwarderEntry} [asking] The panel asking, which crosses its own
 *   mouse itself (see `track`).
 * @returns {boolean} Whether it is the primary hand now.
 */
export function elect(controller, pressing, asking) {
  if (
    primary !== controller &&
    (!primary || (pressing && heldButtons(primary) === 0) || isIdle(primary))
  ) {
    primary = controller;
    bringUpElsewhere(controller, asking);
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
export function holdPointerCapture() {
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
 * The init of the events no ray event places on the page,
 * `gotpointercapture`, `lostpointercapture` and `pointercancel`, the leaves
 * that follow a cancel, and the crossings that bring another panel up to
 * date (see `bringUpElsewhere`), which may come while a ray event's own
 * init, the one `pressInit` and its siblings write, is being sent. Written
 * in place by `atPointer`, always at where the page last heard the hand's
 * pointer was; `bringUp` then moves its crossings onto its panel's plane
 * where the hand is over an element there and its ray crosses that plane.
 *
 * @type {PointerEventInit}
 */
const atPointerInit = {
  bubbles: true,
  cancelable: false,
  button: -1,
  buttons: 0,
  clientX: 0,
  clientY: 0,
  screenX: 0,
  screenY: 0,
  pointerId: 0,
  pointerType: "mouse",
  isPrimary: false,
  relatedTarget: null,
};

/**
 * `atPointerInit` written for one hand's pointer, at where the page last
 * heard it was, for the events no ray places (see `Hand.x`), which carry
 * the pointer's position as a browser's do.
 *
 * @param {XRTargetRaySpace} controller
 * @param {Hand} hand
 * @param {number} buttons What the event says the hand holds: none for a
 *   pointer the page has lost.
 * @returns {PointerEventInit}
 */
export function atPointer(controller, hand, buttons) {
  atPointerInit.bubbles = true;
  atPointerInit.cancelable = false;
  atPointerInit.button = -1;
  atPointerInit.buttons = buttons;
  atPointerInit.pointerId = hand.pointerId;
  atPointerInit.isPrimary = controller === primary;
  atPointerInit.relatedTarget = null;
  writeLastPoint(atPointerInit, hand);
  return atPointerInit;
}

/**
 * Process a hand's pending capture, as a browser does before it sends the
 * pointer's next event: if the element the page last asked for is not the
 * one that has the pointer, the one that has it hears `lostpointercapture`
 * and the new one `gotpointercapture`, both where the pointer last was
 * (see `atPointer`). An element that left the page has no capture to get,
 * and the document hears that one that left lost it.
 *
 * @param {XRTargetRaySpace} controller
 * @returns {void}
 */
export function settleCapture(controller) {
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
      new PointerEvent("lostpointercapture", atPointer(controller, hand, hand.buttons)),
    );
  }
  if (hand.captor) {
    hand.captor.dispatchEvent(
      new PointerEvent("gotpointercapture", atPointer(controller, hand, hand.buttons)),
    );
  }
  const captor = hand.captor;
  for (let i = 0; i < forwarders.length; i += 1) {
    if (captor) {
      forwarders[i].follow(controller, captor);
    }
    forwarders[i].rehover(controller);
  }
}

/**
 * A hand's press has become a scroll or a drag and drop, or the hand has
 * gone, and the page loses the pointer, as a browser cancels one whose
 * press it takes for a gesture of its own or whose device goes away:
 * `pointercancel` where the press went, the element that captured it or
 * the one pressed, then `lostpointercapture`, and the pointer leaves
 * everything it was over, on every panel, all where the page last heard
 * the pointer was (see `Hand.x`). Nothing more of the pointer reaches the
 * page until the trigger opens, the mouse included, which holds still as
 * it does under a drag; the release catches both up. The scroll gesture
 * and drag and drop are handed this as their `onTaken`.
 *
 * @param {XRTargetRaySpace} controller
 * @returns {void}
 */
export function cancelPointer(controller) {
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
    target.dispatchEvent(new PointerEvent("pointercancel", atPointer(controller, hand, 0)));
  }
  releaseCapture(controller);
  for (let i = 0; i < forwarders.length; i += 1) {
    forwarders[i].leave(controller, atPointer(controller, hand, 0));
  }
}

/**
 * A hand has gone: it holds no button, and its pointer is cancelled if it
 * held anything a release would have ended, a press or a capture (see
 * `cancelPointer`). Run from the first of the events that say so, a `lost`
 * end or leave from the manager or the controller's own `disconnected`,
 * whichever reaches the forwarder first, and harmless again after it.
 *
 * @param {XRTargetRaySpace} controller
 * @returns {void}
 */
export function lose(controller) {
  const hand = hands.get(controller);
  if (!hand) {
    return;
  }
  hand.buttons = 0;
  if (hand.pressed || hand.captor || hand.pending) {
    cancelPointer(controller);
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
export function endPress(controller) {
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
 * move that changes none. A captured `pointerup` has its point rewritten
 * once the capture has settled, from the captor it then goes to (see
 * `placeCapturedRelease`). Each event records its point as where the
 * hand's pointer is (`Hand.x`, `Hand.y`), but a release that is not
 * placed: uncaptured, with its ray off its panel, which says 0, 0.
 *
 * @param {HTMLElement} element
 * @param {"pointerdown" | "pointermove" | "pointerup"} type
 * @param {PointerEventInit} init
 * @param {XRTargetRaySpace} controller
 * @param {boolean} [onPanel] Whether the ray is on the panel the event
 *   went to, which a release has to be asked (see `releaseInit`).
 * @returns {boolean} Whether the mouse event, if it was sent, was not
 *   cancelled.
 */
export function sendPointerAndMouse(element, type, init, controller, onPanel = true) {
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
  // The capture is settled now, so the release's point and its target
  // come from the same one.
  const captor = hand.captor?.isConnected ? hand.captor : null;
  const target = captor ?? element;
  if (type === "pointerup") {
    hand.releasedNowhere = captor === null && !onPanel;
    if (captor) {
      placeCapturedRelease(controller, hand, captor, init);
    }
  }
  if (type !== "pointerup" || !hand.releasedNowhere) {
    recordPoint(hand, init.clientX ?? 0, init.clientY ?? 0);
  }
  const pointer = typeof PointerEvent === "function" ? new PointerEvent(type, init) : null;
  init.button = button;
  const mouse = new MouseEvent(MOUSE_EVENT[type], init);
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
