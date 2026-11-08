// The limits a finger and a drag go by, on the page's pointer (`mouse.js`)
// and on `justdom-xr`'s touch layer alike. A module of their own, importing
// nothing, so the touch layer's chunk takes them without three.js's
// renderer coming along.

/**
 * How long a finger has to stay still on the canvas before its press is the
 * grip's rather than the trigger's, in milliseconds.
 */
export const HOLD_MS = 400;

/**
 * How far a finger may wander, in CSS pixels, and still be a tap or a hold.
 * Further, and it is a drag with the trigger.
 */
export const SLOP_PX = 10;

/**
 * How far the camera may pitch up or down while a drag turns it, in
 * radians: short of straight up and straight down, where yaw stops meaning
 * anything.
 */
export const PITCH_LIMIT = 1.4;

/**
 * The narrowest a pinch zooms the view to: the vertical field of view, in
 * radians. Twenty degrees is two and a half times narrower than a page's
 * usual fifty and four and a half times narrower than a headset's ninety,
 * close enough to read a small panel from where the camera stands.
 */
export const MIN_FOVY = (20 * Math.PI) / 180;
