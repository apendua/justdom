import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHaptics, HAPTIC_ATTRIBUTE, HAPTIC_FLAVORS, wantsHaptics } from "./haptics.js";
import { recordingSource } from "../test/rumble.js";

/**
 * @import {HapticOptions} from './haptics.js';
 */

/**
 * A button that asked to be felt, and one that did not.
 *
 * @returns {{ marked: HTMLElement, plain: HTMLElement }}
 */
function buttons() {
  const marked = document.createElement("button");
  marked.setAttribute(HAPTIC_ATTRIBUTE, "");
  const plain = document.createElement("button");
  document.body.append(marked, plain);
  return { marked, plain };
}

describe("wantsHaptics", () => {
  test("is the attribute on the element, or on anything above it", () => {
    const { marked, plain } = buttons();
    assert.equal(wantsHaptics(marked), true);
    assert.equal(wantsHaptics(plain), false);

    const card = document.createElement("div");
    card.setAttribute(HAPTIC_ATTRIBUTE, "");
    card.appendChild(plain);
    assert.equal(wantsHaptics(plain), true, "a card marks every button in it");
  });
});

describe("createHaptics", () => {
  test("is a tick at full strength, on both events, when nothing is said", () => {
    const haptics = createHaptics(undefined);
    assert.ok(haptics);
    const { source, played } = recordingSource();
    const { marked } = buttons();

    haptics.hover(source, marked);
    haptics.press(source, marked);
    haptics.release(source, marked);
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

  test("plays only on an element that asked, and only on the events that are on", () => {
    const { source, played } = recordingSource();
    const { marked, plain } = buttons();

    const hoverOnly = createHaptics({ active: false });
    assert.ok(hoverOnly);
    hoverOnly.hover(source, plain);
    hoverOnly.press(source, plain);
    assert.equal(played.length, 0, "an unmarked element feels like nothing");
    hoverOnly.press(source, marked);
    hoverOnly.release(source, marked);
    assert.equal(played.length, 0, "a press is off");
    hoverOnly.hover(source, marked);
    assert.equal(played.length, 1);

    played.length = 0;
    const pressOnly = createHaptics({ hover: false, flavor: "key" });
    assert.ok(pressOnly);
    pressOnly.hover(source, marked);
    assert.equal(played.length, 0, "a hover is off");
    pressOnly.press(source, marked);
    pressOnly.release(source, marked);
    assert.deepEqual(
      played.map((effect) => effect.duration),
      [30, 18],
      "a key is felt closing and opening",
    );
  });

  test("scales every pulse by the strength, within the motors' range", () => {
    const { source, played } = recordingSource();
    const { marked } = buttons();

    const half = createHaptics({ strength: 0.5, flavor: "knock" });
    assert.ok(half);
    half.press(source, marked);
    assert.deepEqual(played, [
      { type: "dual-rumble", duration: 48, strongMagnitude: 0.5, weakMagnitude: 0.2 },
    ]);

    played.length = 0;
    const loud = createHaptics({ strength: 2, flavor: "knock" });
    assert.ok(loud);
    loud.press(source, marked);
    assert.deepEqual(played, [
      { type: "dual-rumble", duration: 48, strongMagnitude: 1, weakMagnitude: 0.8 },
    ]);
  });

  test("takes a flavor spelled out", () => {
    const { source, played } = recordingSource();
    const { marked } = buttons();
    const haptics = createHaptics({
      flavor: { ...HAPTIC_FLAVORS.tick, press: { duration: 40, strong: 0.5, weak: 1 } },
    });
    assert.ok(haptics);
    haptics.press(source, marked);
    haptics.release(source, marked);
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
    haptics.press(source, buttons().marked);
    assert.deepEqual(pulsed, [[1, 48]]);
  });

  test("is silent for no hand, a hand with no gamepad, and a gamepad with no motors", () => {
    const haptics = createHaptics({});
    assert.ok(haptics);
    const { marked } = buttons();
    haptics.hover(null, marked);
    haptics.hover(/** @type {XRInputSource} */ (/** @type {unknown} */ ({})), marked);
    haptics.hover(
      /** @type {XRInputSource} */ (/** @type {unknown} */ ({ gamepad: { hapticActuators: [] } })),
      marked,
    );
  });

  test("takes `false` or options, and not `true`", () => {
    /** @type {HapticOptions} */
    // @ts-expect-error -- haptics are on when left out; `true` says nothing more.
    const refused = true;
    assert.ok(refused);
  });
});
