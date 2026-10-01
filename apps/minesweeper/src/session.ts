import { Signal } from "@apendua/signal";

/**
 * The session the game is being shown in, or null while it is the page.
 *
 * Written by the scene from `getXRSession`, through `enterSession`, and read
 * by the menu for the two controls that only make sense in a headset: the
 * × that ends the session and the passthrough switch. The menu is mounted
 * before there is a renderer to ask, so the scene tells it.
 */
export const xrSession = Signal.of<XRSession | null>(null);

/**
 * Whether the room shows through behind the board. Off unless asked for, in
 * every session: the board starts in a room of its own.
 */
export const passthrough = Signal.of(false);

/**
 * Record a session starting or ending. A session always starts with the
 * passthrough off, whatever the last one was left at.
 */
export function enterSession(session: XRSession | null): void {
  xrSession.set(session);
  passthrough.set(false);
}

/**
 * Whether this session can show the room and hide it again: only an
 * `alpha-blend` one, which is a headset compositing its cameras behind
 * whatever the frame leaves transparent. An `opaque` session has no room to
 * show, and an `additive` one, a see-through display, cannot hide it, since
 * black is what it draws as clear.
 */
export function canPassThrough(): boolean {
  return xrSession.get()?.environmentBlendMode === "alpha-blend";
}

/**
 * Whether the backdrop stands round the viewer: in every session, unless the
 * room has been asked for and can be had.
 */
export function backdropShown(): boolean {
  return xrSession.get() !== null && !(passthrough.get() && canPassThrough());
}
