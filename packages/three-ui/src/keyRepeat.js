/**
 * How long a key is held before it starts typing again, in ms: half a
 * second, about what a desktop and a phone wait by default, and long enough
 * that a press held a little long while the hand settles types once.
 */
export const KEY_REPEAT_DELAY = 500;

/**
 * How often a held key types again once it has started, in ms: twenty
 * characters a second, about a desktop's default rate.
 */
export const KEY_REPEAT_INTERVAL = 50;

/**
 * @typedef {object} KeyRepeatOptions
 * @property {number} [delay] How long a key is held before it starts
 *   typing again, in ms. Defaults to {@link KEY_REPEAT_DELAY}.
 * @property {number} [interval] How often it types again after that, in ms.
 *   Defaults to {@link KEY_REPEAT_INTERVAL}.
 */

/**
 * One board's key repeat: the key held down, and the timer that types it
 * again.
 *
 * @typedef {object} KeyRepeat
 * @property {(element: Element, pointerId: number, type: () => void) => void} hold
 *   Starts repeating a key that has just typed, by the pointer that pressed
 *   it. `type` is what each repeat does, and the board's own to say: the
 *   same thing the press typed.
 * @property {(pointerId: number) => void} release Ends the repeat if that
 *   pointer started it, on whichever key: the pointer went up or was
 *   cancelled. Anything else is left running.
 * @property {(element: Element, pointerId?: number) => void} leave Ends
 *   the repeat if it is this key's, and, given a pointer, the repeat that
 *   pointer started: the pointer left the key, or, with no pointer, the key
 *   was unmounted. Anything else is left running.
 * @property {() => void} stop Ends the repeat, whoever holds it.
 */

/**
 * Key repeat for a board of keys pressed by a pointer, as a hardware key
 * repeats while it is held down. The board types a key at its
 * `pointerdown` and hands it here, which types it again after `delay`, and
 * every `interval` after that, until the key is let go. Both boards in this
 * repository use it: `keyboard` here, and the desk's own keyboard.
 *
 * The rules, which a board keeps by calling `stop`, `release` and `leave`
 * where they say:
 *
 * - One key repeats at a time, the one pressed last, as on a hardware
 *   keyboard. A press on any key ends the repeat that is running, whether
 *   or not the new key repeats: the board calls `stop` before it types.
 * - A repeat is started by one pointer on one key, and ends with that
 *   pointer's `pointerup` or `pointercancel` wherever it arrives, a
 *   `release`: a pointer that is up holds no key, whatever it went up on,
 *   so the board listens where every release of the pointer is heard. A
 *   press that becomes a scroll is cancelled, and ends it so.
 * - It ends with that pointer's `pointerleave` of that key, a `leave` with
 *   the event's pointer, so a ray that glides off the key while it is held
 *   ends it. Another pointer leaving or letting go is not this one's and
 *   ends nothing.
 * - A key that is unmounted while it repeats ends its repeat, a `leave`
 *   with no pointer, so a board that goes, or is built again for another
 *   layout, types nothing more. A board that is torn down calls `stop`.
 * - Each repeat types what the press typed, modifiers included, and is the
 *   caller's closure: a shifted `A` held down goes on typing `A` after the
 *   one-shot shift has let go.
 * - A pause, such as a frame that takes long, does not make up the repeats
 *   it missed: each one is timed from the one before.
 *
 * @param {KeyRepeatOptions} [options]
 * @returns {KeyRepeat}
 */
export function keyRepeat(options = {}) {
  const { delay = KEY_REPEAT_DELAY, interval = KEY_REPEAT_INTERVAL } = options;

  /** @type {Element | null} */
  let heldElement = null;
  let heldPointer = 0;
  /** @type {() => void} */
  let heldType = () => {};
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  const tick = () => {
    const element = heldElement;
    heldType();
    // Typing may have ended the repeat: an `Enter` that closes the board
    // unmounts the key it was typed with. And a key that threw goes no
    // further than the one throw.
    if (heldElement === element) {
      timer = setTimeout(tick, interval);
    }
  };

  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    heldElement = null;
    heldType = () => {};
  };

  return {
    hold(element, pointerId, type) {
      stop();
      heldElement = element;
      heldPointer = pointerId;
      heldType = type;
      timer = setTimeout(tick, delay);
    },
    release(pointerId) {
      if (heldElement && pointerId === heldPointer) {
        stop();
      }
    },
    leave(element, pointerId) {
      if (element === heldElement && (pointerId === undefined || pointerId === heldPointer)) {
        stop();
      }
    },
    stop,
  };
}
