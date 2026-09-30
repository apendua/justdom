import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createHaptics, HAPTIC_FLAVORS, isArrival, playHaptic } from "./haptics.js";
import { recordingSource } from "../test/rumble.js";

/**
 * @import {HapticOptions} from './haptics.js';
 */

describe("isArrival", () => {
  /**
   * A list with a button in it, whose label is a target of its own by the
   * button's cursor, and a button beside the list, arranged as a panel
   * arranges its objects: each element's object under its parent's.
   */
  const list = new THREE.Object3D();
  const button = new THREE.Object3D();
  const label = new THREE.Object3D();
  list.add(button);
  button.add(label);
  const other = new THREE.Object3D();

  test("is one from nothing, and from another control", () => {
    assert.equal(isArrival(button, null), true);
    assert.equal(isArrival(button, other), true);
  });

  test("is not one from within the control, whichever of its parts the ray was on", () => {
    // The control is the button and everything in it, so the button is the
    // root whether the ray lands on its background or on its label.
    assert.equal(isArrival(button, label), false, "onto the background from the label");
    assert.equal(isArrival(button, button), false, "onto the label from the background");
  });

  test("is one from an ancestor the control is not part of", () => {
    // A scrollable list registers itself to be dragged by, and the gap
    // between its rows is the list: a button entered from it is entered,
    // and so is its label, whose root is still the button.
    assert.equal(isArrival(button, list), true);
    // A control inside a control is the price: the row is its root.
    assert.equal(isArrival(list, list), false);
  });
});

describe("playHaptic", () => {
  test("leaves the frame alone when an actuator throws rather than rejects", () => {
    const source = /** @type {XRInputSource} */ (
      /** @type {unknown} */ ({
        gamepad: {
          hapticActuators: [
            {
              playEffect: () => {
                throw new Error("no such effect");
              },
            },
          ],
        },
      })
    );
    playHaptic(source, { duration: 10, strongMagnitude: 0, weakMagnitude: 1 });
  });
});

describe("createHaptics", () => {
  test("is a tick at full strength, on both events, when nothing is said", () => {
    const haptics = createHaptics(undefined);
    assert.ok(haptics);
    const { source, played } = recordingSource();

    haptics.hover(source);
    haptics.press(source);
    haptics.release(source);
    assert.deepEqual(played, [
      { type: "dual-rumble", duration: 30, strongMagnitude: 0.3, weakMagnitude: 0.45 },
      { type: "dual-rumble", duration: 40, strongMagnitude: 0.6, weakMagnitude: 1 },
    ]);
  });

  test("is nothing for `false`, for both events off, and for a strength of 0", () => {
    assert.equal(createHaptics(false), null);
    assert.equal(createHaptics({ hover: false, active: false }), null);
    assert.equal(createHaptics({ strength: 0 }), null);
  });

  test("plays only the events that are on", () => {
    const { source, played } = recordingSource();

    const hoverOnly = createHaptics({ active: false });
    assert.ok(hoverOnly);
    hoverOnly.press(source);
    hoverOnly.release(source);
    assert.equal(played.length, 0, "a press is off");
    hoverOnly.hover(source);
    assert.equal(played.length, 1);

    played.length = 0;
    const pressOnly = createHaptics({ hover: false, flavor: "key" });
    assert.ok(pressOnly);
    pressOnly.hover(source);
    assert.equal(played.length, 0, "a hover is off");
    pressOnly.press(source);
    pressOnly.release(source);
    assert.deepEqual(
      played.map((effect) => effect.duration),
      [45, 30],
      "a key is felt closing and opening",
    );
  });

  test("scales every pulse by the strength, within the motors' range", () => {
    const { source, played } = recordingSource();

    const half = createHaptics({ strength: 0.5, flavor: "knock" });
    assert.ok(half);
    half.press(source);
    assert.deepEqual(played, [
      { type: "dual-rumble", duration: 60, strongMagnitude: 0.5, weakMagnitude: 0.25 },
    ]);

    played.length = 0;
    const loud = createHaptics({ strength: 2, flavor: "knock" });
    assert.ok(loud);
    loud.hover(source);
    assert.deepEqual(played, [
      { type: "dual-rumble", duration: 30, strongMagnitude: 1, weakMagnitude: 0.4 },
    ]);
  });

  test("takes a flavor spelled out", () => {
    const { source, played } = recordingSource();
    const haptics = createHaptics({
      flavor: { ...HAPTIC_FLAVORS.tick, press: { duration: 40, strong: 0.5, weak: 1 } },
    });
    assert.ok(haptics);
    haptics.press(source);
    haptics.release(source);
    assert.deepEqual(played, [
      { type: "dual-rumble", duration: 40, strongMagnitude: 0.5, weakMagnitude: 1 },
    ]);
  });

  test("drives an older runtime's `pulse` at the larger magnitude", () => {
    /** @type {[number, number][]} */
    const pulsed = [];
    const source = /** @type {XRInputSource} */ (
      /** @type {unknown} */ ({
        gamepad: {
          hapticActuators: [
            {
              /**
               * @param {number} intensity
               * @param {number} duration
               */
              pulse: (intensity, duration) => {
                pulsed.push([intensity, duration]);
                return Promise.resolve(true);
              },
            },
          ],
        },
      })
    );
    const haptics = createHaptics({ flavor: "knock" });
    assert.ok(haptics);
    haptics.press(source);
    assert.deepEqual(pulsed, [[1, 60]]);
  });

  test("is silent for no hand, a hand with no gamepad, and a gamepad with no motors", () => {
    const haptics = createHaptics({});
    assert.ok(haptics);
    haptics.hover(null);
    haptics.hover(/** @type {XRInputSource} */ (/** @type {unknown} */ ({})));
    haptics.hover(
      /** @type {XRInputSource} */ (/** @type {unknown} */ ({ gamepad: { hapticActuators: [] } })),
    );
  });

  test("takes `false` or options, and not `true`", () => {
    /** @type {HapticOptions} */
    // @ts-expect-error -- haptics are on when left out; `true` says nothing more.
    const refused = true;
    assert.ok(refused);
  });
});
