import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createHaptics, HAPTIC_FLAVORS, isArrival } from "./haptics.js";
import { recordingSource } from "../test/rumble.js";

/**
 * @import {HapticOptions} from './haptics.js';
 */

describe("isArrival", () => {
  /**
   * A row with a button in it, and a button beside the row, arranged as a
   * panel arranges its objects: each element's object under its parent's.
   */
  const row = new THREE.Object3D();
  const button = new THREE.Object3D();
  const label = new THREE.Object3D();
  row.add(button);
  button.add(label);
  const other = new THREE.Object3D();

  test("is one from nothing, and from another control", () => {
    assert.equal(isArrival(button, null), true);
    assert.equal(isArrival(button, other), true);
  });

  test("is not one from something nested in the control, nor onto it", () => {
    assert.equal(isArrival(button, label), false, "the label is part of the button");
    assert.equal(isArrival(label, button), false, "and going back onto it is the same");
    assert.equal(isArrival(button, row), false, "a control inside a control is the price");
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
      { type: "dual-rumble", duration: 12, strongMagnitude: 0, weakMagnitude: 0.4 },
      { type: "dual-rumble", duration: 24, strongMagnitude: 0.25, weakMagnitude: 0.8 },
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
      [30, 18],
      "a key is felt closing and opening",
    );
  });

  test("scales every pulse by the strength, within the motors' range", () => {
    const { source, played } = recordingSource();

    const half = createHaptics({ strength: 0.5, flavor: "knock" });
    assert.ok(half);
    half.press(source);
    assert.deepEqual(played, [
      { type: "dual-rumble", duration: 48, strongMagnitude: 0.5, weakMagnitude: 0.2 },
    ]);

    played.length = 0;
    const loud = createHaptics({ strength: 2, flavor: "knock" });
    assert.ok(loud);
    loud.press(source);
    assert.deepEqual(played, [
      { type: "dual-rumble", duration: 48, strongMagnitude: 1, weakMagnitude: 0.8 },
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
    assert.deepEqual(pulsed, [[1, 48]]);
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
