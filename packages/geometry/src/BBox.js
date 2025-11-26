/**
 * @typedef {Object} Point
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {Object} IBBox
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 */

export default class BBox {
  /**
   * @public
   */
  minX;

  /**
   * @public
   */
  minY;

  /**
   * @public
   */
  maxX;

  /**
   * @public
   */
  maxY;

  /**
   * @public
   * @param {Partial<IBBox>} options
   */
  constructor(options = {}) {
    const { minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity } = options;
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
  }

  /**
   * @public
   * @returns {number}
   */
  get width() {
    return this.maxX - this.minX;
  }

  /**
   * @public
   * @returns {number}
   */
  get height() {
    return this.maxY - this.minY;
  }

  /**
   * @public
   * @param {BBox} bbox
   * @returns {boolean}
   */
  isEqual(bbox) {
    return (
      this.minX === bbox.minX &&
      this.maxX === bbox.maxX &&
      this.maxY === bbox.maxY &&
      this.minY === bbox.minY
    );
  }

  /**
   * @public
   * @param {Point} point
   * @returns {BBox}
   */
  addPoint({ x, y }) {
    return new BBox({
      minX: Math.min(this.minX, x),
      maxX: Math.max(this.maxX, x),
      minY: Math.min(this.minY, y),
      maxY: Math.max(this.maxY, y),
    });
  }

  /**
   * @public
   * @param {BBox} bbox
   * @returns {BBox}
   */
  addBBox(bbox) {
    return new BBox({
      minX: Math.min(this.minX, bbox.minX),
      maxX: Math.max(this.maxX, bbox.maxX),
      minY: Math.min(this.minY, bbox.minY),
      maxY: Math.max(this.maxY, bbox.maxY),
    });
  }

  /**
   * @public
   * @static
   * @param {Point[]} points
   * @returns {BBox}
   */
  static createFromPoints(points) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const { x, y } = points[i];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return new this({
      minX,
      maxX,
      minY,
      maxY,
    });
  }
}
