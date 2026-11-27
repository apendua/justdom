/**
 * Where things stand in a session, in metres from a head at the origin: the
 * session asks for a `local` reference space, which puts the head there
 * when it starts. Kept apart from the scene, in plain numbers.
 */

/**
 * The width the table is laid out at during a session, in px, on any device:
 * a wide window's, so that a phone's session shows the wide table too.
 */
export const SESSION_LAYOUT_WIDTH = 1240;

/** How wide the table stands, whatever width its element was laid out at. */
export const TABLE_WIDTH = 1.5;

/**
 * The table's scale, for a card laid out `width` px wide: a panel is a
 * centimetre a px, and the card is fitted to `TABLE_WIDTH`.
 */
export function tableScale(width: number): number {
  return TABLE_WIDTH / (0.01 * Math.max(1, width));
}

/** The middle of the table: straight ahead, a little under eye level. */
export const TABLE_AT = [0, -0.08, -1.25] as const;

/** The radius of the innermost electron shell, and the step to each next one. */
export const FIRST_SHELL = 0.08;
export const SHELL_STEP = 0.026;

/** The radius of the outermost shell any element has, its seventh. */
export const ATOM_RADIUS = FIRST_SHELL + 6 * SHELL_STEP;

/**
 * The atom of the element the table shows: just off the table's left edge,
 * a little nearer and at eye level, where it turns in the space beside the
 * table rather than in front of it.
 */
export const ATOM_AT = [-(TABLE_WIDTH / 2 + ATOM_RADIUS + 0.04), 0.06, -1.05] as const;

/** A nucleon's radius. A nucleus of A nucleons is about `cbrt(A)` of them across. */
export const NUCLEON = 0.008;
