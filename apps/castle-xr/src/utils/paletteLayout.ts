/**
 * Where each brick sits on the tray. A pure function, so which brick ends up
 * where can be worked out and tested away from the scene.
 *
 * The tray shows the whole catalogue at once, one brick per column, each in the
 * orientation it will arrive on the board in, standing on the plate rather than
 * floating over it.
 */
import { allBrickTypes, brickShape, BrickType } from "../components/types.js";

/** Bricks on the tray are shown at half size, so the row stays within reach. */
export const PALETTE_BRICK_SCALE = 0.5;

const GAP = 0.5;
const MARGIN = 0.4;
/** The strip along the near edge of the plate that the labels are written in. */
const LABEL_DEPTH = 0.7;
const RAIL_WIDTH = 0.35;
const RAIL_HEIGHT = 0.35;

export interface PaletteSlot {
  type: BrickType;
  x: number;
  y: number;
  z: number;
}

export interface PaletteLabel {
  label: string;
  x: number;
  y: number;
  z: number;
}

export interface PaletteHandle {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
}

export interface PaletteLayout {
  slots: PaletteSlot[];
  labels: PaletteLabel[];
  handles: PaletteHandle[];
  plateWidth: number;
  plateDepth: number;
}

export function layoutPalette(types: BrickType[] = allBrickTypes): PaletteLayout {
  const sizes = types.map((type) => {
    const [x, y, z] = brickShape(type).size;
    return {
      type,
      label: brickShape(type).label,
      width: x * PALETTE_BRICK_SCALE,
      height: y * PALETTE_BRICK_SCALE,
      depth: z * PALETTE_BRICK_SCALE,
    };
  });

  const widths = sizes.reduce((total, size) => total + size.width, 0);
  const maxDepth = sizes.reduce((deepest, size) => Math.max(deepest, size.depth), 0);
  const plateWidth = widths + GAP * Math.max(sizes.length - 1, 0) + 2 * MARGIN;
  const plateDepth = maxDepth + LABEL_DEPTH + 2 * MARGIN;

  const brickZ = -plateDepth / 2 + MARGIN + maxDepth / 2;
  const labelZ = plateDepth / 2 - MARGIN - LABEL_DEPTH / 2;

  const slots: PaletteSlot[] = [];
  const labels: PaletteLabel[] = [];
  let cursor = -plateWidth / 2 + MARGIN;
  for (const size of sizes) {
    const x = cursor + size.width / 2;
    slots.push({ type: size.type, x, y: size.height / 2, z: brickZ });
    labels.push({ label: size.label, x, y: 0.02, z: labelZ });
    cursor += size.width + GAP;
  }

  // The plate itself is scenery; the tray is carried by its rails, so a ray
  // that misses a brick never picks the whole tray up by accident.
  const handles: PaletteHandle[] = [-1, 1].map((side) => ({
    x: side * (plateWidth / 2 + RAIL_WIDTH / 2),
    y: RAIL_HEIGHT / 2 - 0.1,
    z: 0,
    width: RAIL_WIDTH,
    height: RAIL_HEIGHT,
    depth: plateDepth,
  }));

  return { slots, labels, handles, plateWidth, plateDepth };
}
