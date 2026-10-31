import { Signal } from "justdom-signal";

/**
 * Whether this platform can open an immersive session at all, of either
 * kind. Asked before anything for a session is made: a page that cannot go
 * anywhere should not load a scene, run a render loop or wear a button that
 * says it can. An emulator has to be installed before this is asked, since
 * it is what answers.
 *
 * @returns {Promise<boolean>}
 */
export async function canPresent() {
  const xr = navigator.xr;
  if (!xr) {
    return false;
  }
  for (const mode of /** @type {const} */ (["immersive-ar", "immersive-vr"])) {
    if (await xr.isSessionSupported(mode).catch(() => false)) {
      return true;
    }
  }
  return false;
}

/**
 * The immersive session the page is being shown in, or null while it is
 * only a page.
 *
 * Written by the scene from `getXRSession`, through `enterSession`, and
 * read by the page for what only makes sense in a headset: the × that ends
 * the session, and the passthrough switch. The page is mounted before there
 * is a renderer to ask, so the scene tells it here.
 *
 * @type {Signal<XRSession | null>}
 */
export const xrSession = Signal.of(/** @type {XRSession | null} */ (null));

/**
 * Whether the room shows through behind the scene. Off unless asked for, in
 * every session: the scene starts in a room of its own.
 */
export const passthrough = Signal.of(false);

/**
 * Record a session starting or ending. A session always starts with the
 * passthrough off, whatever the last one was left at.
 *
 * @param {XRSession | null} session
 */
export function enterSession(session) {
  xrSession.set(session);
  passthrough.set(false);
}

/**
 * Whether this session can show the room and hide it again: only an
 * `alpha-blend` one, which is a headset compositing its cameras behind
 * whatever the frame leaves transparent. An `opaque` session has no room to
 * show, and an `additive` one, a see-through display, cannot hide it, since
 * black is what it draws as clear.
 *
 * @returns {boolean}
 */
export function canPassThrough() {
  return xrSession.get()?.environmentBlendMode === "alpha-blend";
}

/**
 * Whether a backdrop should stand round the viewer: in every session,
 * unless the room has been asked for and can be had. The page never needs
 * one, since the scene's own background colour covers a flat canvas.
 *
 * @returns {boolean}
 */
export function backdropShown() {
  return xrSession.get() !== null && !(passthrough.get() && canPassThrough());
}
