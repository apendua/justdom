/**
 * The mark freedom puts on the field its keyboard is typing into. Freedom
 * does not export the name, and `TodoApp.ts` spells it out in its stylesheet
 * as well.
 */
const FOCUS_ATTRIBUTE = "data-xr-focus";

/**
 * An experiment, behind `?realfocus`: give the page's focus to the field
 * freedom's keyboard is typing into.
 *
 * A ray's press on the field is a click freedom dispatches itself, and a
 * script's click does not move focus, so in a session `document.activeElement`
 * stays where it was. Freedom keeps its own focus instead and marks the field
 * with `data-xr-focus` while its keyboard types into it. This follows that
 * mark: the field is focused when it gets it and blurred when it loses it, so
 * the page's focus and the scene's agree. A keyboard paired with the headset,
 * or the laptop's under the emulator, then types into the field the way it
 * does on a page.
 *
 * Returns a function that stops following.
 */
export function followXRFocus(root: HTMLElement): () => void {
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
