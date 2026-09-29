import { Signal } from "@apendua/signal";

/**
 * The immersive session the page is being shown in, or null while it is
 * only a page.
 *
 * The app is mounted into the page before there is a renderer to ask, and
 * it has no scene context to ask one through, so the scene says it here:
 * `Scene` writes what `getXRSession(ctx)` reads, and the app reads this to
 * show what only makes sense inside a session — the button that ends it.
 */
export const xrSession = Signal.of<XRSession | null>(null);
