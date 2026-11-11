import { Signal } from "justdom-signal";

/**
 * Whether the page is known to be unable to open a headset session, set by
 * `main.ts` once `offerHeadset` has answered. False until then, so nothing
 * that is meant for a page alone starts before the answer is in.
 *
 * The soundtrack goes by it. A page that can open a session plays the music
 * in the session only, from the scene, and stops it when the session ends;
 * a page that cannot plays it on the page.
 */
export const pageOnly = Signal.of(false);
