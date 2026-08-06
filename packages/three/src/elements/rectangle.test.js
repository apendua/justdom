import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { makeRectangleGeometry } from "./rectangle.js";

/**
 * A pill: as wide as a grab handle and as tall as its own corners are round.
 * Rounded corners are what makes the degenerate case below visible, so this
 * is the shape worth testing with.
 */
const pill = {
  left: 0,
  right: 52,
  top: 0,
  bottom: 6,
  leftTop: 3,
  leftBottom: 3,
  topLeft: 3,
  topRight: 49,
  bottomLeft: 3,
  bottomRight: 49,
  rightTop: 3,
  rightBottom: 3,
};

/**
 * How much of the plane a geometry actually covers, in square units.
 *
 * @param {THREE.BufferGeometry} geometry
 * @returns {number}
 */
function area(geometry) {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const count = index ? index.count / 3 : position.count / 3;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let total = 0;
  for (let i = 0; i < count; i++) {
    const [ia, ib, ic] = index
      ? [index.getX(i * 3), index.getX(i * 3 + 1), index.getX(i * 3 + 2)]
      : [i * 3, i * 3 + 1, i * 3 + 2];
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    total += new THREE.Triangle(a, b, c).getArea();
  }
  return total;
}

describe("makeRectangleGeometry", () => {
  test("fills the shape when no border is asked for", () => {
    // A little under 52 x 6, the corners being round.
    assert.ok(area(makeRectangleGeometry(pill)) > 290);
  });

  test("draws nothing for a border of no width", () => {
    // The element with no border at all. Cutting a hole the same size as the
    // outline used to leave the triangulator filling a quarter of the shape
    // with slivers, drawn over the element in the border colour.
    const geometry = makeRectangleGeometry(pill, { left: 0, right: 0, top: 0, bottom: 0 });
    assert.equal(area(geometry), 0);
  });

  test("draws the ring for a border that has width", () => {
    const geometry = makeRectangleGeometry(pill, { left: 2, right: 2, top: 2, bottom: 2 });
    const ring = area(geometry);
    // Somewhere between nothing and the whole shape: a band around the edge.
    assert.ok(ring > 100, `expected a ring, got ${ring}`);
    assert.ok(ring < 290, `expected a ring, got ${ring}`);
  });

  test("draws the ring when only one side has a border", () => {
    const geometry = makeRectangleGeometry(pill, { left: 0, right: 0, top: 2, bottom: 0 });
    assert.ok(area(geometry) > 0);
  });
});
