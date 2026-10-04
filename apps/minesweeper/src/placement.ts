/**
 * Where the two panels hang in a session, in metres from a head at the
 * origin: the session asks for a `local` reference space, which puts the
 * head there when it starts. Kept apart from the scene, in plain numbers,
 * so that `tests/xr-check.mjs` aims the controller from the same figures
 * the scene places the panels by.
 */

/**
 * How tall the board stands, whatever size its element was laid out at.
 * The board is fitted to the shorter side of that element, so this is the
 * height of the hexes, not of the element.
 */
export const BOARD_SIZE = 0.6;

/**
 * The board's scale, for a board element laid out `width` by `height` px,
 * as a session starts: a panel is a centimetre a px, and the board is
 * fitted to the shorter side.
 */
export function boardScale(width: number, height: number): number {
  return BOARD_SIZE / (0.01 * Math.max(1, Math.min(width, height)));
}

/** The middle of the board: straight ahead, a little under eye level. */
export const BOARD_AT = [0, -0.12, -0.85] as const;

/**
 * The menu's scale: a millimetre a px, which makes the 248px card about
 * 25 cm wide.
 */
export const MENU_SCALE = 0.1;

/**
 * The middle of the menu: to the left of the board, clear of its widest
 * row, and a little nearer, so that it reads as a card held beside the
 * board. The player can move it from there by its edges.
 */
export const MENU_AT = [-(BOARD_SIZE / 2 + 0.2), -0.08, -0.7] as const;

/**
 * The menu turned to face the head. The yaw points its face back along the
 * floor at the head, and the pitch tilts it up by as much as it hangs below
 * the eye; a positive pitch tilts a panel's face downwards, hence the sign.
 * Applied yaw first, as the Euler order `YXZ` says.
 */
export const MENU_YAW = Math.atan2(-MENU_AT[0], -MENU_AT[2]);
export const MENU_PITCH = -Math.atan2(-MENU_AT[1], Math.hypot(MENU_AT[0], MENU_AT[2]));
