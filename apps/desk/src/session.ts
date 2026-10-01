import { Derived, Signal } from "@apendua/signal";

/**
 * The immersive session showing the desk, or null while it is only a page.
 *
 * The page is built before there is a renderer to ask, so the scene says it
 * here: `Scene` writes it as a session starts and ends. The page reads it to
 * end the session from the monitor's power button (`power.ts`).
 */
export const xrSession = Signal.of<XRSession | null>(null);

/**
 * Whether a session is showing the desk, for the two things the page does
 * differently while it is mirrored: the staging (`stage.ts`) and how the
 * monitor types (`screen.ts`).
 */
export const presenting = new Derived(() => xrSession.get() !== null);

/** Something that can be read for a value, as a signal or a derivation can. */
export interface Readable<T> {
  get(): T;
}
