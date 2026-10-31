/**
 * A growable, possibly empty, axis-aligned bounding box.
 */
export default class BBox {
  /**
   * @public
   * @readonly
   * @type {number}
   */
  minX;

  /**
   * @public
   * @readonly
   * @type {number}
   */
  minY;

  /**
   * @public
   * @readonly
   * @type {number}
   */
  maxX;

  /**
   * @public
   * @readonly
   * @type {number}
   */
  maxY;

  /**
   * @param {number} [minX]
   * @param {number} [minY]
   * @param {number} [maxX]
   * @param {number} [maxY]
   */
  constructor(minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity) {
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
  }

  /**
   * @returns {boolean}
   */
  isEmpty() {
    return this.minX > this.maxX || this.minY > this.maxY;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {BBox}
   */
  addPoint(x, y) {
    return new BBox(
      Math.min(this.minX, x),
      Math.min(this.minY, y),
      Math.max(this.maxX, x),
      Math.max(this.maxY, y),
    );
  }

  /**
   * @param {BBox} other
   * @returns {BBox}
   */
  union(other) {
    return new BBox(
      Math.min(this.minX, other.minX),
      Math.min(this.minY, other.minY),
      Math.max(this.maxX, other.maxX),
      Math.max(this.maxY, other.maxY),
    );
  }

  /**
   * @param {number} margin
   * @returns {BBox}
   */
  grow(margin) {
    if (this.isEmpty()) {
      return this;
    }
    return new BBox(this.minX - margin, this.minY - margin, this.maxX + margin, this.maxY + margin);
  }

  /**
   * @returns {number}
   */
  width() {
    return this.isEmpty() ? 0 : this.maxX - this.minX;
  }

  /**
   * @returns {number}
   */
  height() {
    return this.isEmpty() ? 0 : this.maxY - this.minY;
  }
}
