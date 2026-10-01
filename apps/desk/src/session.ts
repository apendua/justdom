import { Signal } from "@apendua/signal";

/**
 * Whether a session is showing the desk.
 *
 * The page is built before there is a renderer to ask, so the scene says it
 * here: `Scene` writes it as a session starts and ends, and the page reads it
 * for the two things it does differently while the desk is being mirrored,
 * the staging (`stage.ts`) and how the monitor types (`screen.ts`).
 */
export const presenting = Signal.of(false);
