import { describe, expect, it } from "vitest";
import { layoutPalette, PALETTE_BRICK_SCALE } from "./paletteLayout.js";
import { allBrickTypes, brickShape } from "../components/types.js";

describe("layoutPalette", () => {
  const layout = layoutPalette();

  it("shows every brick in the catalogue once", () => {
    expect(layout.slots.map((slot) => slot.type)).toEqual(allBrickTypes);
    expect(layout.labels.map((label) => label.label)).toEqual(
      allBrickTypes.map((type) => brickShape(type).label),
    );
  });

  it("stands every brick on the plate", () => {
    for (const slot of layout.slots) {
      const [, height] = brickShape(slot.type).size;
      expect(slot.y).toBeCloseTo((height * PALETTE_BRICK_SCALE) / 2);
    }
  });

  it("keeps the bricks apart and inside the plate", () => {
    const spans = layout.slots.map((slot) => {
      const [width] = brickShape(slot.type).size;
      const half = (width * PALETTE_BRICK_SCALE) / 2;
      return { min: slot.x - half, max: slot.x + half };
    });
    for (const span of spans) {
      expect(span.min).toBeGreaterThan(-layout.plateWidth / 2);
      expect(span.max).toBeLessThan(layout.plateWidth / 2);
    }
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].min).toBeGreaterThan(spans[i - 1].max);
    }
  });

  it("writes each label directly in front of its brick", () => {
    for (const [index, label] of layout.labels.entries()) {
      expect(label.x).toBeCloseTo(layout.slots[index].x);
      expect(label.z).toBeGreaterThan(layout.slots[index].z);
      expect(label.z).toBeLessThan(layout.plateDepth / 2);
    }
  });

  it("puts a rail on either side of the plate", () => {
    expect(layout.handles).toHaveLength(2);
    const [left, right] = layout.handles;
    expect(left.x).toBeCloseTo(-right.x);
    expect(Math.abs(left.x)).toBeGreaterThan(layout.plateWidth / 2);
    expect(left.depth).toBeCloseTo(layout.plateDepth);
  });
});
