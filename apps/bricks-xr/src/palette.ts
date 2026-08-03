/** Every colour in the game, so the panel and the board cannot drift apart. */
export const palette = {
  panel: "#124553",
  panelEdge: "#4bd3ff",
  panelText: "#f6fcff",
  button: "#1c5f86",
  buttonEdge: "#6fc6e8",
  buttonHover: "#2a7fae",

  ground: "#0d3440",
  gridLine: "#3f93a8",
  brick: "#cdb992",
  /** The brick in the hand, at the cell it would land in. */
  ghost: "#bfe3ff",
} as const;
