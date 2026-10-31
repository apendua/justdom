/**
 * The animation and transition events a test dispatches. jsdom implements
 * neither `TransitionEvent` nor `AnimationEvent`; a plain bubbling `Event`
 * with the field the clock reads put on it is what the clock reads anyway.
 *
 * @param {string} type
 * @param {Record<string, string>} fields
 * @returns {Event}
 */
export function syntheticEvent(type, fields) {
  return Object.assign(new Event(type, { bubbles: true }), fields);
}
