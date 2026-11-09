import { Signal } from "justdom-signal";

/**
 * Where the toolbar stops fitting on one line: a phone held upright. Wider
 * than this, the bar has every item; narrower, it keeps the menu, the main
 * button and the round, and the menu behind ☰ takes the rest.
 */
const NARROW = "(max-width: 600px)";

const query = window.matchMedia(NARROW);

/**
 * Whether the page is narrow, kept up as the window is resized or the phone
 * turned. A signal rather than a media query in the styles, so that the
 * items it moves are mounted and taken down rather than hidden: a headset
 * panel measures the toolbar again when its children change, and not when
 * one of them is hidden.
 */
export const narrow = Signal.of(query.matches);

query.addEventListener("change", (event) => {
  narrow.set(event.matches);
});
