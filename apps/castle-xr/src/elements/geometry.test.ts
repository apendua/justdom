import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { bevelledBoxGeometry, bevelledWedgeGeometry } from "./geometry.js";

// The geometry helpers register their disposal with the reactive runtime,
// which a test has none of; the warning about that is the runtime working as
// documented, not something these tests need to hear about.
vi.spyOn(console, "warn").mockImplementation(() => {});

function bounds(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  return geometry.boundingBox!;
}

describe("bevelledBoxGeometry", () => {
  it("stays within the box and keeps its full extent on each face", () => {
    const geometry = bevelledBoxGeometry(2, 1, 0.5, 0.04);
    const box = bounds(geometry);
    expect(box.min.x).toBeCloseTo(-1);
    expect(box.max.x).toBeCloseTo(1);
    expect(box.min.y).toBeCloseTo(-0.5);
    expect(box.max.y).toBeCloseTo(0.5);
    expect(box.min.z).toBeCloseTo(-0.25);
    expect(box.max.z).toBeCloseTo(0.25);
    // A corner of the sharp box is cut off: no vertex reaches it.
    const positions = geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i += 1) {
      const distance = new THREE.Vector3(1, 0.5, 0.25).distanceTo(
        new THREE.Vector3(positions.getX(i), Math.abs(positions.getY(i)), positions.getZ(i)),
      );
      expect(distance).toBeGreaterThan(0.03);
    }
  });
});

describe("bevelledWedgeGeometry", () => {
  it("keeps the wedge's extent and pulls the ridge in", () => {
    const geometry = bevelledWedgeGeometry(1, 1, 1, 0.04);
    const box = bounds(geometry);
    // The flat faces keep their planes, so the extents they bound are exact...
    expect(box.min.x).toBeCloseTo(-0.5);
    expect(box.max.x).toBeCloseTo(0.5);
    expect(box.min.y).toBeCloseTo(-0.5);
    // ...while the ridge and the eaves are edges with no face of their own,
    // so the chamfer cuts them: the hull falls short of the sharp wedge
    // there, but only by the bevel's worth.
    for (const [reached, sharp] of [
      [box.max.y, 0.5],
      [-box.min.z, 0.5],
      [box.max.z, 0.5],
    ]) {
      expect(reached).toBeLessThan(sharp);
      expect(reached).toBeGreaterThan(sharp - 0.06);
    }
  });
});
