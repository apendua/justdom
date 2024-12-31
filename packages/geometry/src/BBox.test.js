/* eslint-env jest */
import BBox from "./BBox.js";

/**
 * @param {number} minX
 * @param {number} minY
 * @param {number} maxX
 * @param {number} maxY
 * @returns {BBox}
 */
function bbox(minX, minY, maxX, maxY) {
  return new BBox({
    minX,
    minY,
    maxX,
    maxY,
  });
}
describe("Test BBox", () => {
  /** @type {BBox} */
  let bbox1;
  /** @type {BBox} */
  let bbox2;
  beforeEach(() => {
    bbox1 = bbox(1, 2, 3, 4);
    bbox2 = bbox(5, 6, 7, 8);
  });
  describe("BBox.isEqual", () => {
    test("should check if bounding boxes are equal", () => {
      expect(bbox1.isEqual(bbox1)).toBe(true);
    });
    test("should check if bounding boxes are not equal", () => {
      expect(bbox1.isEqual(bbox2)).toBe(false);
    });
  });
  describe("BBox.addBBox", () => {
    test('should evaluate a "sum" of two bounding boxes', () => {
      expect(bbox1.addBBox(bbox2).isEqual(bbox(1, 2, 7, 8))).toBe(true);
    });
  });
});
