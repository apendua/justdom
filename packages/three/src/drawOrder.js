/**
 * Where what goes over everything draws: the cursor and a drag's ghost.
 * Panels draw at `elevation * ELEVATION_BAND + level` (see elevation.js),
 * and a draggable panel's strips at `HANDLE_RENDER_ORDER`, past them; this
 * is past both, with a margin for a scene that orders something of its own.
 */
export const OVERLAY_RENDER_ORDER = 1e9;
