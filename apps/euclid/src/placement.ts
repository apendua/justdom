/**
 * Where the three panels hang in a session, in metres from a head at the
 * origin: the session asks for a `local` reference space, which puts the
 * head there when it starts. Kept apart from the scene, in plain numbers,
 * so that `tests/xr-check.mjs` aims the controller from the same figures
 * the scene places the panels by.
 *
 * A panel is a centimetre a px before it is scaled, and each is scaled as
 * the session starts from the size its element was laid out at.
 */

export type Vec3 = readonly [number, number, number];

/**
 * The most room the drawing takes, whatever size its element was laid out
 * at: it is fitted inside this box, keeping its aspect.
 */
export const BOARD_WIDTH = 0.8;
export const BOARD_HEIGHT = 0.62;

/** The drawing's scale, for a drawing element laid out `width` by `height` px. */
export function boardScale(width: number, height: number): number {
  return Math.min(
    BOARD_WIDTH / (0.01 * Math.max(1, width)),
    BOARD_HEIGHT / (0.01 * Math.max(1, height)),
  );
}

/** The middle of the drawing: straight ahead, a little under eye level. */
export const BOARD_AT: Vec3 = [0, -0.12, -0.9];

/**
 * The program's scale: 0.8 mm a px, which makes a 480px editor about
 * 38 cm wide and its 13px code about a centimetre tall.
 */
export const EDITOR_SCALE = 0.08;

/**
 * The middle of the program: to the left of the drawing and nearer, so
 * that the two read as one desk curving round the viewer.
 */
export const EDITOR_AT: Vec3 = [-(BOARD_WIDTH / 2 + 0.24), -0.12, -0.74];

/**
 * How wide the toolbar hangs, whatever width its element was laid out at:
 * about as wide as the drawing and the program together, which in a window
 * as wide as a headset's browser makes its 13px labels about a centimetre
 * tall.
 */
export const TOOLBAR_WIDTH = 1.0;

/** The toolbar's scale, for a toolbar element laid out `width` px wide. */
export function toolbarScale(width: number): number {
  return TOOLBAR_WIDTH / (0.01 * Math.max(1, width));
}

/**
 * The middle of the toolbar: over the top edge of the drawing and of the
 * program, and nearer than either, so that the construction picker's menu,
 * which opens downwards, hangs in front of the drawing rather than into
 * it.
 */
export const TOOLBAR_AT: Vec3 = [-0.18, BOARD_AT[1] + BOARD_HEIGHT / 2 + 0.04, -0.72];

/**
 * A panel at `at` turned to face the head. The yaw points its face back
 * along the floor at the head, and the pitch tilts it by as much as it
 * hangs above or below the eye; a positive pitch tilts a panel's face
 * downwards, hence the sign. Applied yaw first, as the Euler order `YXZ`
 * says.
 */
export function facing([x, y, z]: Vec3): { pitch: number; yaw: number } {
  return {
    pitch: -Math.atan2(-y, Math.hypot(x, z)),
    yaw: Math.atan2(-x, -z),
  };
}
