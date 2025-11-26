/* eslint-env jest */
import BBox from "./BBox.js";
import HexMap from "./HexMap.js";
import Vector from "./Vector.js";

/**
 * @import { VectorLike } from './Vector.js';
 */

/**
 * @param {Vector} v
 * @returns {Vector}
 */
function identity(v) {
  return v;
}
describe("Test HexMap", () => {
  /** @type {HexMap<VectorLike>} */
  let hexMap;
  /** @type {ReturnType<HexMap<VectorLike>["getHexToPixelsMapping"]>} */
  let toPixels;
  /** @type {ReturnType<HexMap<VectorLike>["getPixelsToHexMapping"]>} */
  let toHex;
  describe("Empty HexMap", () => {
    beforeEach(() => {
      hexMap = new HexMap(identity);
    });
    test("should not have any fields", () => {
      expect(hexMap.getSize()).toBe(0);
    });
    test("getField() should return no value", () => {
      expect(hexMap.getField({ x: 0, y: 0, z: 0 })).toBeFalsy();
    });
  });
  describe("Single field HexMap", () => {
    beforeEach(() => {
      hexMap = new HexMap(identity, {
        maxFields: 1,
        predicate: ({ x, y, z }) => x + y + z === 1,
        origin: new Vector(1, 0, 0),
      });
      toPixels = hexMap.getHexToPixelsMapping({
        offsetX: 1,
        offsetY: 1,
        fieldWidth: 4,
        fieldHeight: 4,
      });
      toHex = hexMap.getPixelsToHexMapping({
        offsetX: 1,
        offsetY: 1,
        fieldWidth: 4,
        fieldHeight: 4,
      });
    });
    test("should have exactly one fields", () => {
      expect(hexMap.getSize()).toBe(1);
    });
    test("getField() should return the only field", () => {
      expect(hexMap.getField({ x: 1, y: 0, z: 0 })).toBeTruthy();
    });
    test("should evaluate edges", () => {
      expect(HexMap.getEdges({ x: 1, y: 0, z: 0 })).toEqual([
        [
          { x: 2, y: 0, z: 0 },
          { x: 2, y: 1, z: 0 },
        ],
        [
          { x: 2, y: 1, z: 0 },
          { x: 1, y: 1, z: 0 },
        ],
        [
          { x: 1, y: 1, z: 0 },
          { x: 1, y: 1, z: 1 },
        ],
        [
          { x: 1, y: 1, z: 1 },
          { x: 1, y: 0, z: 1 },
        ],
        [
          { x: 1, y: 0, z: 1 },
          { x: 2, y: 0, z: 1 },
        ],
        [
          { x: 2, y: 0, z: 1 },
          { x: 2, y: 0, z: 0 },
        ],
      ]);
    });
    test("should evaluate bounding box", () => {
      expect(hexMap.bbox).toEqual(
        new BBox({
          minX: -1,
          maxX: 0,
          minY: -1 / 4,
          maxY: 3 / 4,
        }),
      );
    });
    test("should evaluate projected border", () => {
      expect(HexMap.getNodes({ x: 1, y: 0, z: 0 }).map((v) => toPixels(v))).toEqual([
        { x: 1, y: 4 },
        { x: 3, y: 5 },
        { x: 5, y: 4 },
        { x: 5, y: 2 },
        { x: 3, y: 1 },
        { x: 1, y: 2 },
      ]);
    });
    test("should find hex based on pixel (1)", () => {
      expect(toHex({ x: 2, y: 2 })).toEqual({
        hex: { x: 1, y: 0, z: 0 },
        off: { x: 0, y: -1, z: 1 },
      });
    });
    test("should find hex based on pixel (2)", () => {
      expect(toHex({ x: 2, y: 3 })).toEqual({
        hex: { x: 1, y: 0, z: 0 },
        off: { x: 1, y: -1, z: 0 },
      });
    });
    test("should find hex based on pixel (3)", () => {
      expect(toHex({ x: 2, y: 4 })).toEqual({
        hex: { x: 1, y: 0, z: 0 },
        off: { x: 1, y: 0, z: -1 },
      });
    });
    test("should find hex based on pixel (4)", () => {
      expect(toHex({ x: 4, y: 2 })).toEqual({
        hex: { x: 1, y: 0, z: 0 },
        off: { x: -1, y: 0, z: 1 },
      });
    });
    test("should find hex based on pixel (5)", () => {
      expect(toHex({ x: 4, y: 3 })).toEqual({
        hex: { x: 1, y: 0, z: 0 },
        off: { x: -1, y: 1, z: 0 },
      });
    });
    test("should find hex based on pixel (6)", () => {
      expect(toHex({ x: 4, y: 4 })).toEqual({
        hex: { x: 1, y: 0, z: 0 },
        off: { x: 0, y: 1, z: -1 },
      });
    });
  });
  describe("Multiple fields HexMap", () => {
    beforeEach(() => {
      hexMap = new HexMap(identity, {
        maxFields: 100,
        predicate: (v, p) => {
          const { x, y } = p.mulVector(v);
          return x > -0.5 && x < 2 && y > -0.5 && y < 1;
        },
        origin: new Vector(0, 0, 0),
      });
      toPixels = hexMap.getHexToPixelsMapping({
        offsetX: 1,
        offsetY: 1,
        fieldWidth: 4,
        fieldHeight: 4,
      });
      toHex = hexMap.getPixelsToHexMapping({
        offsetX: 1,
        offsetY: 1,
        fieldWidth: 4,
        fieldHeight: 4,
      });
    });
    test("should have 4 fields", () => {
      expect(hexMap.getAllFields().length).toBe(4);
    });
    test("should evaluate bounding box", () => {
      expect(hexMap.bbox).toEqual(
        new BBox({
          minX: -0.5,
          minY: -0.5,
          maxX: 2,
          maxY: 1.25,
        }),
      );
    });
    test("should evaluate projected border", () => {
      expect(HexMap.findBorder(hexMap.getAllFields())[0].map(toPixels)).toEqual([
        { x: 3, y: 5 },
        { x: 3, y: 7 },
        { x: 5, y: 8 },
        { x: 7, y: 7 },
        { x: 9, y: 8 },
        { x: 11, y: 7 },
        { x: 11, y: 5 },
        { x: 9, y: 4 },
        { x: 9, y: 2 },
        { x: 7, y: 1 },
        { x: 5, y: 2 },
        { x: 3, y: 1 },
        { x: 1, y: 2 },
        { x: 1, y: 4 },
      ]);
    });
  });
});
