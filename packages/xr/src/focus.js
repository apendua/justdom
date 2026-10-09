/**
 * An experiment, behind `?realfocus` in the apps that offer it: give the
 * page's focus to the field freedom's keyboard is typing into.
 *
 * A ray's press on a field is a click freedom dispatches itself, and a
 * script's click does not move focus, so in a session
 * `document.activeElement` stays where it was. Freedom keeps its own focus
 * instead and marks the field with `data-xr-focus` while its keyboard types
 * into it. A keyboard paired with the headset, or the laptop's under the
 * emulator, types into whatever has the page's focus, so without this its
 * keys miss the field.
 *
 * The mark leads and the page's focus follows, one way only:
 *
 * - The mark arriving on a field focuses it, without scrolling the page.
 *   Moving from one field to another, freedom takes the mark off the first
 *   before it puts it on the second, so the first is blurred and the
 *   second focused.
 * - The mark leaving a field blurs it, if it still has the page's focus. If
 *   the focus has already gone elsewhere it is left there.
 * - Nothing goes the other way. When the page's focus leaves the field on
 *   its own (Tab on a paired keyboard, a system keyboard closing, a click
 *   on the page) the mark stays, freedom's keyboard stays up and goes on
 *   typing into the field, and a real key goes to wherever the focus went.
 *   Whether a Quest does that is what the todo app's log under
 *   `?realfocus` (`focusout` lines) is there to show; what should happen
 *   then, the keyboard going or the field taking the focus back, is not
 *   decided.
 */

/**
 * The mark freedom puts on the field its keyboard is typing into. Freedom's
 * entry point does not export the name, and the experiment stays out of
 * freedom until it is decided, so it is spelled out here.
 */
const FOCUS_ATTRIBUTE = "data-xr-focus";

/**
 * Follow freedom's focus with the page's, for every field under `root`.
 *
 * @param {HTMLElement} root
 * @returns {() => void} a function that stops following
 */
export function followXRFocus(root) {
  const observer = new MutationObserver((records) => {
    for (const { target } of records) {
      if (!(target instanceof HTMLInputElement)) {
        continue;
      }
      if (target.hasAttribute(FOCUS_ATTRIBUTE)) {
        target.focus({ preventScroll: true });
      } else if (document.activeElement === target) {
        target.blur();
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    attributes: true,
    attributeFilter: [FOCUS_ATTRIBUTE],
  });
  return () => observer.disconnect();
}
