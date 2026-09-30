import { createProperty } from "@apendua/signal";

/**
 * @import {Object3D} from 'three';
 */

/**
 * One knock of a controller's motors: how long it runs, in milliseconds,
 * and how hard each motor is driven, from 0 to 1. `strong` is the
 * low-frequency motor, which thumps; `weak` is the high-frequency one,
 * which ticks. A runtime with the older single-motor `pulse` is driven at
 * the larger of the two.
 *
 * @typedef {object} HapticPulse
 * @property {number} duration
 * @property {number} strong
 * @property {number} weak
 */

/**
 * What a control feels like: the pulse for the ray arriving on it, the
 * pulse for the trigger closing, and, for a flavor that has one, the pulse
 * for the trigger opening again.
 *
 * @typedef {object} HapticFlavor
 * @property {HapticPulse} hover
 * @property {HapticPulse} press
 * @property {HapticPulse} [release]
 */

/**
 * The flavors that come with the package, by name. `tick` is a light
 * high-frequency click, the least a hand can be told and the default.
 * `knock` is the low motor, a thump for a button that does something.
 * `buzz` is longer and softer, a rumble rather than a click. `key` is a
 * mechanical key: a hard press and a lighter release.
 *
 * @typedef {"tick" | "knock" | "buzz" | "key"} HapticFlavorName
 */

/**
 * The named flavors, for a scene that wants to start from one and change
 * a pulse: `{ ...HAPTIC_FLAVORS.tick, press: { duration: 40, strong: 0.5, weak: 1 } }`.
 *
 * @type {Readonly<Record<HapticFlavorName, HapticFlavor>>}
 */
export const HAPTIC_FLAVORS = Object.freeze({
  tick: {
    hover: { duration: 12, strong: 0, weak: 0.4 },
    press: { duration: 24, strong: 0.25, weak: 0.8 },
  },
  knock: {
    hover: { duration: 18, strong: 0.45, weak: 0.15 },
    press: { duration: 48, strong: 1, weak: 0.4 },
  },
  buzz: {
    hover: { duration: 45, strong: 0.1, weak: 0.3 },
    press: { duration: 100, strong: 0.35, weak: 0.6 },
  },
  key: {
    hover: { duration: 12, strong: 0, weak: 0.3 },
    press: { duration: 30, strong: 0.5, weak: 0.9 },
    release: { duration: 18, strong: 0.15, weak: 0.5 },
  },
});

/**
 * How the controls in a panel feel: every element with `cursor: pointer`,
 * the rule that makes one a ray target. Set for the scene through
 * `PanelOptions.haptics`, for one panel through `PortalOptions.haptics`,
 * and left out for the defaults: both events, at full strength, as a
 * `tick`.
 *
 * @typedef {object} HapticOptions
 * @property {boolean} [hover] Whether the ray arriving on a control is
 *   felt. True by default.
 * @property {boolean} [active] Whether a press on a control is felt, and
 *   its release where the flavor has one. True by default.
 * @property {number} [strength] What every pulse's magnitudes are multiplied
 *   by, clamped to the motors' range afterwards. 1 by default; 0 is the
 *   same as turning both events off.
 * @property {HapticFlavorName | HapticFlavor} [flavor] The pulses, by name
 *   or spelled out. `tick` by default.
 */

/**
 * What the motors are asked for, in the shape `playEffect` takes. Worked
 * out once per panel rather than per event, so that a hover costs the call
 * and nothing else.
 *
 * @typedef {object} HapticEffect
 * @property {number} duration
 * @property {number} strongMagnitude
 * @property {number} weakMagnitude
 */

/**
 * A panel's haptics, resolved: what to play for each of the three events,
 * given the hand that caused it.
 *
 * @typedef {object} Haptics
 * @property {(source: XRInputSource | null) => void} hover
 * @property {(source: XRInputSource | null) => void} press
 * @property {(source: XRInputSource | null) => void} release
 */

/**
 * The haptics of the panel an element is built in, or null for a panel
 * that has none, and for an element built outside any panel.
 */
export const HapticsContext = createProperty(
  /**
   * @returns {Haptics | null}
   */
  () => null,
);

/**
 * A controller's motor, as the two generations of the gamepad extensions
 * expose it. `playEffect` is the current interface; `pulse` is what older
 * runtimes have instead. Neither is worth an app-wide feature check, so
 * both are tried, per actuator.
 *
 * @typedef {object} HapticActuator
 * @property {(type: string, params: HapticEffect) => Promise<unknown>} [playEffect]
 * @property {(intensity: number, duration: number) => Promise<unknown>} [pulse]
 */

/**
 * Whether a ray arriving on a control's object from `relatedTarget`, the
 * registered object it was on before, counts as arriving on the control at
 * all, and so is worth one pulse.
 *
 * `cursor` is inherited, so the label or the icon inside a button is a ray
 * target of its own, and the ray crossing from it onto the button's own
 * background is an enter as far as the manager can tell. It is not an
 * arrival: the hand has been on the button the whole time. So a ray coming
 * from something nested in the control is moving within it, and so is a
 * ray coming from the thing the control's `cursor` was inherited from, the
 * button the label is in. A ray coming from any other ancestor has
 * arrived: a scrollable list registers itself to be dragged by and is not
 * a control, so a button entered from the gap between its rows is entered.
 * `cursorInherited` says which, asked only when it matters. What the rule
 * gives up is a distinct control nested in another, a delete button inside
 * a clickable row, whose hover from the row is not an arrival; its press
 * still is.
 *
 * Containment is asked of the objects rather than the elements, since a
 * panel's objects are arranged as its elements are.
 *
 * @param {Object3D} object
 * @param {Object3D | null} relatedTarget
 * @param {() => boolean} cursorInherited Whether the control's `cursor` is
 *   its parent element's rather than its own, which is what makes it part
 *   of the control above it.
 * @returns {boolean}
 */
export function isArrival(object, relatedTarget, cursorInherited) {
  if (relatedTarget === null) {
    return true;
  }
  if (contains(object, relatedTarget)) {
    return false;
  }
  return !(contains(relatedTarget, object) && cursorInherited());
}

/**
 * Whether `object` is `ancestor` or under it.
 *
 * @param {Object3D} ancestor
 * @param {Object3D} object
 * @returns {boolean}
 */
function contains(ancestor, object) {
  for (let node = /** @type {Object3D | null} */ (object); node; node = node.parent) {
    if (node === ancestor) {
      return true;
    }
  }
  return false;
}

/**
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * A pulse at a strength, as the motors take it; null for one that would
 * drive neither motor, which is not worth a call.
 *
 * @param {HapticPulse} pulse
 * @param {number} strength
 * @returns {HapticEffect | null}
 */
function scaled(pulse, strength) {
  const strongMagnitude = clamp01(pulse.strong * strength);
  const weakMagnitude = clamp01(pulse.weak * strength);
  if (strongMagnitude === 0 && weakMagnitude === 0) {
    return null;
  }
  return { duration: pulse.duration, strongMagnitude, weakMagnitude };
}

/**
 * The motors of the hand that caused an event. None for a hand with no
 * gamepad, which is what a tracked hand is, and for an event a test
 * dispatched with no hand at all.
 *
 * @param {XRInputSource | null} source
 * @returns {readonly HapticActuator[]}
 */
function actuatorsOf(source) {
  return /** @type {readonly HapticActuator[]} */ (
    /** @type {unknown} */ (source?.gamepad?.hapticActuators ?? [])
  );
}

/**
 * A refused effect is not news: a runtime that has `playEffect` and does
 * not know `dual-rumble` rejects, and the hand simply feels nothing.
 */
const ignore = () => {};

/**
 * Play an effect on every motor of a hand. Nothing for a hand with no
 * gamepad, which is what a tracked hand is, and nothing for an actuator
 * that refuses, however it refuses: a rejection and a throw both leave the
 * frame alone, since a hand that feels nothing is the worst a motor should
 * cost. For a scene's own haptics as much as for a panel's, so that one
 * place knows the two actuator interfaces.
 *
 * @param {XRInputSource | null} source
 * @param {HapticEffect} effect
 * @returns {void}
 */
export function playHaptic(source, effect) {
  for (const actuator of actuatorsOf(source)) {
    try {
      if (typeof actuator.playEffect === "function") {
        Promise.resolve(actuator.playEffect("dual-rumble", effect)).catch(ignore);
      } else if (typeof actuator.pulse === "function") {
        Promise.resolve(
          actuator.pulse(Math.max(effect.strongMagnitude, effect.weakMagnitude), effect.duration),
        ).catch(ignore);
      }
    } catch {
      // Refused before a promise was made; the same silence.
    }
  }
}

/**
 * A panel's haptics from its options, or null when there is nothing to
 * feel: `false`, both events off, or a strength of 0.
 *
 * @param {HapticOptions | false | undefined} options
 * @returns {Haptics | null}
 */
export function createHaptics(options) {
  if (options === false) {
    return null;
  }
  const { hover = true, active = true, strength = 1, flavor = "tick" } = options ?? {};
  const recipe = typeof flavor === "string" ? HAPTIC_FLAVORS[flavor] : flavor;
  const onHover = hover ? scaled(recipe.hover, strength) : null;
  const onPress = active ? scaled(recipe.press, strength) : null;
  const onRelease = active && recipe.release ? scaled(recipe.release, strength) : null;
  if (!onHover && !onPress && !onRelease) {
    return null;
  }
  /**
   * @param {HapticEffect | null} effect
   * @returns {(source: XRInputSource | null) => void}
   */
  const feel = (effect) => (source) => {
    if (effect) {
      playHaptic(source, effect);
    }
  };
  return { hover: feel(onHover), press: feel(onPress), release: feel(onRelease) };
}
