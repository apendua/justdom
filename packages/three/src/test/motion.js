import { syntheticEvent } from "./events.js";

/**
 * What a test of the motion step (`div.js`) moves an element by: the
 * computed transform a running transition would report on each frame, the
 * events that start and end it, and a timer that keeps the panel's
 * channel from emptying, so that its commit waits.
 */

/**
 * A timer at zero delay that flips the element's colour on every turn,
 * faster than any frame reads it: a panel a timer keeps busy. Returns
 * what stops it.
 *
 * @param {HTMLElement} element
 * @returns {() => void}
 */
export function flicker(element) {
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    element.style.color = tick % 2 ? "red" : "blue";
  }, 0);
  return () => clearInterval(timer);
}

/**
 * The computed transform of `element`, as a frame of an animation would
 * have the browser report it: jsdom has no transitions, and writing the
 * style would be a mutation. Set `value` for the next frame's sample, and
 * give `window.getComputedStyle` back with `restore`, in a `finally`.
 *
 * @param {HTMLElement} element
 * @param {string} value The transform it starts at.
 */
export function reportTransform(element, value) {
  const getComputedStyle = window.getComputedStyle;
  const reported = {
    value,
    restore() {
      window.getComputedStyle = getComputedStyle;
    },
  };
  window.getComputedStyle = (target, pseudoElement) => {
    const style = getComputedStyle.call(window, target, pseudoElement);
    if (target !== element) {
      return style;
    }
    return new Proxy(style, {
      get(styles, key) {
        if (key === "transform") {
          return reported.value;
        }
        const read = Reflect.get(styles, key);
        return typeof read === "function" ? read.bind(styles) : read;
      },
    });
  };
  return reported;
}

/**
 * @param {HTMLElement} element
 * @param {string} type
 */
export function transformTransition(element, type) {
  element.dispatchEvent(syntheticEvent(type, { propertyName: "transform" }));
}

/** @param {number} x */
export function shifted(x) {
  return `matrix(1, 0, 0, 1, ${x}, 0)`;
}
