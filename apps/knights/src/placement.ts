/**
 * Where the game hangs in a session, in metres from a head at the origin:
 * the session asks for a `local` reference space, which puts the head there
 * when it starts. Kept apart from the scene, in plain numbers, so that
 * `tests/xr-check.mjs` aims the controller from the same figures the scene
 * places the panel by.
 *
 * A panel is a centimetre a px before it is scaled, and this one is scaled
 * as the session starts from the size the page was laid out at.
 */

export type Vec3 = readonly [number, number, number];

/**
 * How wide the game hangs, whatever width the page was laid out at: wide
 * enough at arm's length that a hex is a few centimetres across and the
 * toolbar's labels about one tall.
 */
export const GAME_WIDTH = 1.2;

/** The game's scale, for a page laid out `width` px wide. */
export function gameScale(width: number): number {
  return GAME_WIDTH / (0.01 * Math.max(1, width));
}

/** The middle of the game: straight ahead, a little under eye level. */
export const GAME_AT: Vec3 = [0, -0.1, -1.1];
