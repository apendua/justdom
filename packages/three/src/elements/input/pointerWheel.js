/**
 * A hand's thumbstick heard as a mouse wheel, on a panel that asks for it
 * (`PortalOptions.thumbstickWheel` in `portal.js`): read once a frame while
 * a hand with a stick has its ray on the panel, and sent as `wheel` to the
 * element under the ray. A panel's forwarder (`createPanelForwarder` in
 * `pointerForwarding.js`) starts it from its ray events.
 */

import { isBlocker } from "../blocker.js";
import { hitElement } from "./dragAndDrop.js";
import { HAND_BITS, handOf, heldButtons, isGone } from "./pointerHands.js";
import { samplePlane, writeSampled } from "./pointerPlane.js";

/**
 * @import {XRTargetRaySpace} from 'three';
 * @import {XREventMap} from '../../core.js';
 * @import {Panel} from './dragAndDrop.js';
 * @import {ForwarderState, PanelHand} from './pointerForwarding.js';
 */

/**
 * How far a hand's thumbstick turns the wheel, in px a second with the
 * stick held at its stop. A browser turns about 100 px a notch, so this is
 * ten notches a second.
 */
const WHEEL_SPEED = 1000;

/**
 * How far off its centre the stick has to be before it turns the wheel,
 * as a fraction of its travel. A stick let go of reads a little off zero,
 * and a wheel turned by that would creep under a hand that is not on it.
 * The travel past it is the wheel's whole range, so the wheel turns from
 * nothing as the stick leaves the zone.
 */
const STICK_DEAD_ZONE = 0.15;

/**
 * The most a frame counts for in turning the wheel, in ms. A frame that
 * stalled, on a commit that read a whole panel at once say, would
 * otherwise turn it as far as the stall was long, all at once.
 */
const MAX_WHEEL_FRAME = 100;

/**
 * Where a hand's thumbstick is along its vertical axis: -1 pushed forward,
 * 1 pulled back, as a gamepad says it, and 0 inside the dead zone (see
 * `STICK_DEAD_ZONE`). The `xr-standard` mapping puts the thumbstick on
 * axes 2 and 3, with a touchpad's, or zeros, on 0 and 1; a gamepad with
 * only two axes has its stick on those.
 *
 * @param {XRInputSource | null} source
 * @returns {number}
 */
function stickY(source) {
  const axes = source?.gamepad?.axes;
  const y = axes ? (axes.length >= 4 ? axes[3] : (axes[1] ?? 0)) : 0;
  const travel = (Math.abs(y) - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE);
  return travel > 0 ? Math.sign(y) * Math.min(travel, 1) : 0;
}

/**
 * The buttons a gamepad says are pressed now, as `Hand.buttons` says them:
 * the trigger and the grip, which the `xr-standard` mapping puts at 0 and
 * 1.
 *
 * @param {Gamepad} gamepad
 * @returns {number}
 */
function pressedBits(gamepad) {
  const { buttons } = gamepad;
  return (
    (buttons[0]?.pressed ? HAND_BITS.select : 0) | (buttons[1]?.pressed ? HAND_BITS.squeeze : 0)
  );
}

/**
 * The init of every `wheel` a thumbstick turns, written in place for each,
 * since one goes out every frame the stick is held over a panel. Pixels,
 * vertical, and cancelable, as a browser's is: a page that zooms on the
 * wheel cancels it.
 *
 * @type {WheelEventInit}
 */
const wheelInit = {
  bubbles: true,
  cancelable: true,
  deltaMode: 0,
  deltaX: 0,
  deltaY: 0,
  deltaZ: 0,
  clientX: 0,
  clientY: 0,
  screenX: 0,
  screenY: 0,
};

/**
 * The element a hand's wheel goes to: the innermost control its ray is
 * on that the page still has, found as its moves find it, without a
 * walk. On a list's gaps, on a gone row in a list, which the walk then
 * finds whatever replaced, or on the panel's background, it is the
 * deepest element at the point `samplePlane` last found (see
 * `hitElement`); a move passes over the list to a control outside it
 * instead. Nothing where the ray is on something a plugin hangs in the
 * panel, which is the scene's, as the scene's object is in front of the
 * page there; and, on a panel that stops no rays, nothing between its
 * controls and lists, where it has no background for the ray to be on.
 *
 * @param {ForwarderState} state
 * @param {PanelHand} hand
 * @param {Panel} own
 * @returns {HTMLElement | null}
 */
function wheelTarget(state, hand, own) {
  let onList = false;
  for (const object of hand.hover) {
    const target = state.targets.get(object);
    if (!target) {
      continue;
    }
    if (target.list) {
      onList = true;
      break;
    }
    if (!isGone(target.element)) {
      return target.element;
    }
  }
  const hovered = hand.hovered;
  const onBackground = hovered?.parent === state.container && isBlocker(hovered);
  return onList || onBackground ? hitElement(own, state.onPlane) : null;
}

/**
 * One hand's turn of the wheel this frame, if its ray is on the panel,
 * it holds no button, and its stick is out of the dead zone. Held is what
 * the hand's record says or what its gamepad says: the record hears only
 * the buttons that close after it is made, and a trigger held on
 * something the scene carries since before the ray came to any panel is
 * held all the same. The `wheel` goes to the element under the ray (see
 * `wheelTarget`), at the point where the ray crosses the panel's plane,
 * against the corner last probed, as a move is placed.
 *
 * Called by `wheelTick` through `forEach` on the panel's hands, with the
 * forwarder's state as `this`, so that a frame makes no closure to pass
 * it.
 *
 * @this {ForwarderState}
 * @param {PanelHand} hand
 * @param {XRTargetRaySpace} controller
 * @returns {void}
 */
function turnWheel(hand, controller) {
  const state = this;
  if (hand.hover.length === 0 || !hand.source?.gamepad) {
    return;
  }
  state.wheelHeld = true;
  const y = stickY(hand.source);
  const own = state.panel();
  if (
    y === 0 ||
    state.wheelFrame === 0 ||
    heldButtons(controller) !== 0 ||
    pressedBits(hand.source.gamepad) !== 0 ||
    !own
  ) {
    return;
  }
  const element = samplePlane(state, controller) ? wheelTarget(state, hand, own) : null;
  if (!element) {
    return;
  }
  writeSampled(state, own, wheelInit);
  wheelInit.deltaY = (y * WHEEL_SPEED * state.wheelFrame) / 1000;
  element.dispatchEvent(new WheelEvent("wheel", wheelInit));
}

/**
 * The frames the thumbstick is read on, while a hand with one is here.
 *
 * @param {ForwarderState} state
 */
function wheelTick(state) {
  const now = performance.now();
  state.wheelFrame = Math.min(now - state.wheelTime, MAX_WHEEL_FRAME);
  state.wheelTime = now;
  state.wheelHeld = false;
  state.panelHands.forEach(turnWheel, state);
  if (!state.wheelHeld && state.stopWheel) {
    state.stopWheel();
    state.stopWheel = null;
  }
}

/**
 * Read the stick of a hand whose ray is on the panel, if the panel asks
 * for a wheel and the hand has a stick: the mouse has none, and so starts
 * nothing before a session. Asked on every enter and move, so a hand
 * whose source comes back while its ray rests here starts the frames too.
 * The hand's record of its buttons starts here at the latest.
 *
 * @param {ForwarderState} state
 * @param {XREventMap["pointerenter"] | XREventMap["pointermove"]} e
 * @returns {void}
 */
export function watchStick(state, e) {
  if (!state.thumbstickWheel || !e.inputSource?.gamepad) {
    return;
  }
  handOf(e.controller);
  if (!state.stopWheel) {
    state.wheelTime = performance.now();
    state.stopWheel = state.requestFrames(() => wheelTick(state));
  }
}
