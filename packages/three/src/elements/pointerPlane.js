/**
 * Where a hand's ray crosses a panel's plane, for the events a panel's
 * forwarder places by the plane rather than by what the ray hit: a
 * captured hand's moves and release, the crossings `bringUp` sends, and
 * the thumbstick's wheel.
 */

import { clientPointAt, writeClient } from "./dragAndDrop.js";
import { sampleRay } from "./scroll.js";

/**
 * @import {XRTargetRaySpace} from 'three';
 * @import {Panel} from './dragAndDrop.js';
 * @import {ForwarderState} from './pointerForwarding.js';
 */

/**
 * Where a hand's ray crosses this panel's plane, into `inPanel`, in the
 * panel's px: the one place every event placed by the plane rather than
 * by what the ray hit takes its point from, a captured hand's moves and
 * release and the crossings `bringUp` sends.
 *
 * @param {ForwarderState} state
 * @param {XRTargetRaySpace} controller
 * @returns {boolean} False, with nothing written, where the ray crosses
 *   the plane nowhere.
 */
export function samplePlane(state, controller) {
  return sampleRay(controller, state.container, state.onPlane, state.inPanel);
}

/**
 * Write the point `samplePlane` last found into an event's init, as a
 * point on the page.
 *
 * @param {ForwarderState} state
 * @param {Panel} own
 * @param {MouseEventInit} init
 * @returns {void}
 */
export function writeSampled(state, own, init) {
  clientPointAt(own, state.inPanel.x, state.inPanel.y, state.client);
  writeClient(init, state.client.x, state.client.y);
}
