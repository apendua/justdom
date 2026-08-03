/**
 * One palette for the whole game — the panels, the board and the bricks all
 * draw from here, so nothing has to be matched by eye twice.
 *
 * It is built around the teal and cyan the panels already use. The board is the
 * darkest end of that same family, which leaves the bricks free to be the one
 * warm thing in the scene: sandstone against deep teal, with terracotta for the
 * roofs and a single amber for winning. Cyan is reserved for what the player is
 * *about* to do — the ghost of a brick, the edges of a panel — so it never has
 * to compete with anything already built.
 */
export const palette = {
  // Panels
  panel: "#124553",
  panelEdge: "#4bd3ff",
  panelWash: "rgba(75, 211, 255, 0.2)",
  panelWashEdge: "rgba(75, 211, 255, 0.7)",
  panelText: "#f6fcff",
  panelLabel: "#cdeffd",
  button: "#1c5f86",
  buttonEdge: "#6fc6e8",
  buttonHover: "#2a7fae",
  buttonMuted: "#173c4b",
  buttonMutedEdge: "#345d6d",
  buttonMutedText: "#6d8ea3",
  banner: "#e8a93c",
  bannerEdge: "#ffe3ac",
  bannerText: "#3a2505",

  // The board
  ground: "#0d3440",
  gridLine: "#3f93a8",
  trayPlate: "#123039",
  trayRail: "#2f7f9c",

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
} as const;

export default palette;
