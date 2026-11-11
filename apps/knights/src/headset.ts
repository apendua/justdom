import { Signal } from "justdom-signal";

/**
 * Whether a headset session has started on this page, set by `xr.ts` as the
 * first one starts and never cleared.
 *
 * The soundtrack goes by it. Until then the page plays the battle theme, as
 * a page always has. From the first session on, the scene plays it for the
 * length of each session and the page stays quiet, so the music neither
 * doubles up in a session nor goes on after the player leaves one.
 */
export const sessionStarted = Signal.of(false);
