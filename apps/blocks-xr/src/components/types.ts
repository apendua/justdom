/**
 * The brick catalogue. Every brick is a box whose sides are whole multiples of
 * half a cell, which is what lets any two of them sit flush on the half grid —
 * see `utils/grid.ts`. The wedge is the one exception: it fills its box only up
 * to a sloping top face, and is treated as a box everywhere placement is
 * decided, so a roof can never be dropped into something it overlaps.
 */
export type BrickType = "cube" | "block" | "plate" | "pillar" | "wedge";

export type BrickStyle = "normal" | "ghost" | "blocked";

export type BrickProfile = "box" | "wedge";

export interface BrickShape {
  type: BrickType;
  label: string;
  /** Extent along x, y and z in board units, unrotated. One unit is one cell. */
  size: readonly [number, number, number];
  colour: string;
  profile: BrickProfile;
}

export const brickShapes: Record<BrickType, BrickShape> = {
  cube: {
    type: "cube",
    label: "Cube",
    size: [1, 1, 1],
    colour: "#9fa7ad",
    profile: "box",
  },
  block: {
    type: "block",
    label: "Block",
    size: [2, 1, 0.5],
    colour: "#c08a5a",
    profile: "box",
  },
  plate: {
    type: "plate",
    label: "Plate",
    size: [2, 0.5, 1],
    colour: "#7f8b93",
    profile: "box",
  },
  pillar: {
    type: "pillar",
    label: "Pillar",
    size: [0.5, 2, 0.5],
    colour: "#cfc3ac",
    profile: "box",
  },
  wedge: {
    type: "wedge",
    label: "Roof",
    size: [1, 1, 1],
    colour: "#8c4a3f",
    profile: "wedge",
  },
};

export const allBrickTypes: BrickType[] = ["cube", "block", "plate", "pillar", "wedge"];

export function brickShape(type: BrickType): BrickShape {
  return brickShapes[type];
}
