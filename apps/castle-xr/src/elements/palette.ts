import { volatileStore } from "@apendua/signal";

/**
 * One palette for the whole game — the panels, the board and the bricks all
 * draw from here, so nothing has to be matched by eye twice.
 *
 * The board is deep teal and the bricks are the one warm thing standing on it:
 * sandstone, with terracotta for the roofs and a single amber for winning.
 * The panels take the bricks' side of that split rather than the board's — a
 * sheet of parchment in a bronze frame, walnut ink to read, oak-and-gilt
 * buttons to press — so the interface belongs with the castle being built,
 * not with the table it stands on. Cyan is reserved for what the player is
 * *about* to do — the ghost of a brick, the pointer — so it never has to
 * compete with anything already built.
 *
 * A `volatileStore`, so that a colour edited in dev
 * reaches the things wearing that colour rather than reloading every module
 * that reads this one. Its contents come from source, so a hot reload is
 * exactly what should move them — see `docs/signal-user-guide.md`, section
 * 1.7. A colour has to be *read* inside a computation to follow an edit: a
 * `set({ get material() {…} })`, an `effects(…)`, or a `${() => palette.x}`
 * interpolation. Read at module scope it is captured, as any constant would
 * be.
 */
export const palette = volatileStore({
  // Panels: parchment in a bronze frame
  panel: "#f5ead0",
  panelEdge: "#9a7440",
  panelWash: "rgba(62, 44, 20, 0.08)",
  panelWashEdge: "rgba(62, 44, 20, 0.28)",
  panelText: "#3d2c15",
  panelLabel: "#87703f",
  button: "#6f4f26",
  buttonEdge: "#c8a45e",
  buttonHover: "#8a6532",
  buttonText: "#faf1da",
  buttonMuted: "#e9decb",
  buttonMutedEdge: "#cfc2a4",
  buttonMutedText: "#a1926e",
  banner: "#e8a93c",
  bannerEdge: "#8a6a44",
  bannerText: "#3a2505",

  // The board
  ground: "#0d3440",
  gridLine: "#3f93a8",
  trayPlate: "#123039",
  trayRail: "#2f7f9c",
  /** The bricks' names, written on the dark tray rather than on parchment. */
  trayLabel: "#cdeffd",

  // Bricks: warm stone, the one warm thing on a cold board
  brick: {
    cube: "#cdb992",
    block: "#b3946a",
    plate: "#9c8462",
    pillar: "#ddd0b1",
    roof: "#a94f38",
  },

  // The slingshot and what it throws
  forkFrame: "#8a6a44",
  band: "#20313a",
  stone: "#5b6a72",

  // What the player is about to do
  ghost: "#bfe3ff",
  refused: "#e8503c",
  pointer: "#4bd3ff",
});

export default palette;
