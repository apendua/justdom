import BBox from "./BBox.js";
import Matrix from "./Matrix.js";
import Vector from "./Vector.js";

/**
 * @import { VectorLike } from './Vector.js'
 */

/**
 * @typedef {[Vector, Vector]} Edge
 */

/**
 * @typedef {Object} HexMapOptions
 * @property {Vector} [origin]
 * @property {number} [maxFields]
 * @property {(v: Vector, m: Matrix) => boolean} [predicate]
 */

const OFFSETS = [
  new Vector(-1, 1, 0),
  new Vector(1, -1, 0),
  new Vector(0, -1, 1),
  new Vector(0, 1, -1),
  new Vector(1, 0, -1),
  new Vector(-1, 0, 1),
];

const VERTICIES = [
  new Vector(1, 0, 0),
  new Vector(1, 1, 0),
  new Vector(0, 1, 0),
  new Vector(0, 1, 1),
  new Vector(0, 0, 1),
  new Vector(1, 0, 1),
];

/** @type {Record<string, Vector>} */
const ORDER_TO_OFFSET = {};
OFFSETS.forEach((v) => {
  ORDER_TO_OFFSET[v.order] = v;
});

const PROJECTION_MATRIX = new Matrix([
  -0.5, 0.5, 0, 0.25, 0.25, -0.5, 1.0, 1.0, 1.0,
]);
// const PROJECTION_MATRIX_INVERSE = new Matrix([
//   -1, 2 / 3, 1 / 3,
//   1, 2 / 3, 1 / 3,
//   0, -4 / 3, 1 / 3,
// ]);

/**
 * @param {string} order
 * @param {{ swap?: boolean }} options
 * @returns {Vector}
 */
function getOffset(order, { swap = false } = {}) {
  const [c1, c2, c3] = order.split("");
  if (swap) {
    return ORDER_TO_OFFSET[`${c2}${c3}${c1}`];
  }
  return ORDER_TO_OFFSET[`${c1}${c2}${c3}`];
}

/**
 * @param {VectorLike} vector
 * @returns {string}
 */
function getKey({ x, y, z }) {
  return `${x},${y},${z}`;
}

/**
 * @template T
 * @param {T} x
 * @returns {T}
 */
function identity(x) {
  return x;
}

/**
 * @template {VectorLike} T
 */
class HexMap {
  /**
   * @type {Map<string, T>}
   */
  #fields;

  /**
   * @type {number}
   */
  #invariant;

  /**
   * @public
   * @param {(v: Vector) => T} generator
   * @param {HexMapOptions} [options={}]
   */
  constructor(generator, options = {}) {
    const {
      origin = new Vector(1, 0, 0),
      maxFields = 1000,
      predicate = () => false,
    } = options;
    this.#fields = new Map();
    this.#invariant = origin.x + origin.y + origin.z;
    let seeds = [Vector.zero().add(origin)];
    while (this.#fields.size < maxFields && seeds.length > 0) {
      const newSeeds = [];
      for (let i = 0; i < seeds.length; i += 1) {
        const seed = seeds[i];
        const key = getKey(seed);
        if (!this.#fields.has(key) && predicate(seed, PROJECTION_MATRIX)) {
          this.#fields.set(key, generator(new Vector(seed.x, seed.y, seed.z)));
          for (let j = 0; j < OFFSETS.length; j += 1) {
            const offset = OFFSETS[j];
            const newSeed = seed.add(offset);
            const newKey = getKey(newSeed);
            if (!this.#fields.has(newKey)) {
              newSeeds.push(newSeed);
            }
          }
        }
      }
      seeds = newSeeds;
    }
  }

  /**
   * @public
   * @returns {BBox}
   */
  get bbox() {
    let bbox = new BBox();
    for (const field of this.#fields.values()) {
      bbox = bbox.addBBox(HexMap.getBBox(field));
    }
    Object.defineProperty(this, "bbox", { value: bbox });
    return bbox;
  }

  /**
   * @public
   * @returns {number}
   */
  getSize() {
    return this.#fields.size;
  }

  /**
   * @public
   * @returns {T[]}
   */
  getAllFields() {
    return Array.from(this.#fields.values());
  }

  /**
   * @public
   * @param {VectorLike} center
   * @returns {T | undefined}
   */
  getField(center) {
    const key = getKey(center);
    return this.#fields.get(key);
  }

  /**
   * @public
   * @param {Vector} field
   * @returns {T[]}
   */
  getNeighbors(field) {
    return OFFSETS.map((offset) => this.getField(offset.add(field))).filter(
      (x) => !!x,
    );
  }

  /**
   * @public
   * @param {{
   *   offsetX: number;
   *   offsetY: number;
   *   fieldWidth: number;
   *   fieldHeight: number;
   * }} options
   * @returns {Matrix}
   */
  getViewportMatrix({ offsetX, offsetY, fieldWidth, fieldHeight }) {
    const A = fieldWidth;
    const B = offsetX - this.bbox.minX * fieldWidth;
    const C = fieldHeight;
    const D = offsetY - this.bbox.minY * fieldHeight;
    return new Matrix([A, 0, B, 0, C, D, 0, 0, 1]);
  }

  /**
   * @public
   * @param {{
   *   offsetX: number;
   *   offsetY: number;
   *   fieldWidth: number;
   *   fieldHeight: number;
   * }} options
   * @returns {(v: VectorLike) => VectorLike}
   */
  getHexToPixelsMapping({ offsetX, offsetY, fieldWidth, fieldHeight }) {
    const V = this.getViewportMatrix({
      offsetX,
      offsetY,
      fieldWidth,
      fieldHeight,
    });
    const P = PROJECTION_MATRIX;
    return (v) => {
      const { x, y } = V.mulVector({
        ...P.mulVector(v),
        z: 1,
      });
      return { x, y };
    };
  }

  /**
   * @public
   * @param {{
   *   offsetX: number;
   *   offsetY: number;
   *   fieldWidth: number;
   *   fieldHeight: number;
   * }} options
   * @returns {(p: VectorLike) => { hex?: VectorLike; off?: VectorLike }}
   */
  getPixelsToHexMapping({ offsetX, offsetY, fieldWidth, fieldHeight }) {
    const P = PROJECTION_MATRIX.inv();
    const V = this.getViewportMatrix({
      offsetX,
      offsetY,
      fieldWidth,
      fieldHeight,
    }).inv();
    return ({ x, y }) => {
      const p = P.mulVector({
        ...V.mulVector({ x, y, z: 1 }),
        z: this.#invariant + 2,
      });
      const q = p.floor();
      const v = p.sub(q);
      const o = v.order;
      const c = Vector.getEmbedding(0, o); // minimal coordinate
      switch (q.x + q.y + q.z - this.#invariant) {
        case 0:
          return { hex: q, off: getOffset(o) };
        case 1:
          return {
            hex: q.add(c(-1)),
            off: getOffset(o, { swap: true }),
          };
        default:
          return {};
      }
    };
  }

  /**
   * @public
   * @static
   * @param {VectorLike} v
   * @returns {VectorLike}
   */
  static to2D(v) {
    const { x, y } = PROJECTION_MATRIX.mulVector(v);
    return { x, y };
  }

  /**
   * @public
   * @static
   * @template {VectorLike} T
   * @param {T[]} fieldSet
   * @returns {Vector[][]}
   */
  static findBorder(fieldSet) {
    /** @type {Record<string, Edge>} */
    const edgesMap = {};
    for (let i = 0; i < fieldSet.length; i += 1) {
      const edges = this.getEdges(fieldSet[i]);
      for (let j = 0; j < edges.length; j += 1) {
        const e = edges[j];
        const nodeKey0 = getKey(e[0]);
        const nodeKey1 = getKey(e[1]);
        const edgeKey0 = `${nodeKey0},${nodeKey1}`;
        const edgeKey1 = `${nodeKey1},${nodeKey0}`;
        if (edgesMap[edgeKey1]) {
          delete edgesMap[edgeKey1];
        } else {
          edgesMap[edgeKey0] = e;
        }
      }
    }
    /** @type {Record<string, Vector>} */
    const nodesMap = {};
    Object.keys(edgesMap).forEach((key) => {
      const [p0, p1] = edgesMap[key];
      nodesMap[getKey(p0)] = p1;
    });
    /** @type {Array<Vector[]>} */
    const loops = [];
    Object.keys(nodesMap).forEach((key) => {
      let nodeKey = key;
      let node = nodesMap[nodeKey];
      if (node) {
        /** @type {Vector[]} */
        const loop = [];
        while (node) {
          delete nodesMap[nodeKey];
          loop.push(node);
          nodeKey = getKey(node);
          node = nodesMap[nodeKey];
        }
        loops.push(loop);
      }
    });
    return loops;
  }

  /**
   * @public
   * @static
   * @param {VectorLike} field
   * @returns {Vector[]}
   */
  static getNodes(field) {
    return VERTICIES.map((n) => n.add(field));
  }

  /**
   * @public
   * @static
   * @param {VectorLike} field
   * @returns {Edge[]}
   */
  static getEdges(field) {
    const [p1, p2, p3, p4, p5, p6] = this.getNodes(field);
    return [
      [p1, p2],
      [p2, p3],
      [p3, p4],
      [p4, p5],
      [p5, p6],
      [p6, p1],
    ];
  }

  /**
   * @public
   * @static
   * @param {VectorLike} field
   * @param {(v: VectorLike) => VectorLike} [to2D=this.to2D]
   * @returns {BBox}
   */
  static getBBox(field, to2D = this.to2D) {
    return BBox.createFromPoints(this.getNodes(field).map(to2D));
  }

  /**
   * @public
   * @static
   * @param {{
   *     nRows: number;
   *     nColumns: number;
   *   }} options
   * @returns {HexMap<Vector>}
   */
  static createRect({ nRows, nColumns }) {
    return new HexMap(identity, {
      maxFields: nRows * nColumns,
      /**
       * @param {VectorLike} v
       */
      predicate: (v) => {
        const { x, y } = PROJECTION_MATRIX.mulVector(v);
        return x > -0.5 && x < nColumns && y > -0.5 && y < 0.75 * nRows;
      },
      origin: new Vector(0, 0, 0),
    });
  }
}

export default HexMap;
