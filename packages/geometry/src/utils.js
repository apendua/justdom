import BBox from "./BBox.js";
import Matrix from "./Matrix.js";
import Vector from "./Vector.js";

/** @import { VectorLike } from './Vector.js' */
/** @typedef {[Vector, Vector]} Edge */

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
 * @param {Vector} vector
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

const PROJECTION_MATRIX = new Matrix([
  -0.5, 0.5, 0, 0.25, 0.25, -0.5, 1.0, 1.0, 1.0,
]);

/**
 * @param {VectorLike} v
 * @returns {VectorLike}
 */
export const to2D = (v) => {
  const { x, y } = PROJECTION_MATRIX.mulVector(v);
  return { x, y };
};

/**
 * @param {VectorLike} field
 * @returns {Vector[]}
 */
export const getNodes = (field) => {
  return VERTICIES.map((n) => n.add(field));
};

/**
 * @param {VectorLike} field
 * @returns {Edge[]}
 */
export const getEdges = (field) => {
  const [p1, p2, p3, p4, p5, p6] = getNodes(field);
  return [
    [p1, p2],
    [p2, p3],
    [p3, p4],
    [p4, p5],
    [p5, p6],
    [p6, p1],
  ];
};
/**
 * @param {VectorLike} field
 * @returns {Vector[]}
 */
export const getNeighbors = (field) => {
  return OFFSETS.map((offset) => offset.add(field));
};
/**
 * @template {VectorLike} T
 * @param {T[]} fieldSet
 * @returns {Vector[][]}
 */
export const findBorder = (fieldSet) => {
  /** @type {Record<string, Edge>} */
  const edgesMap = {};
  for (const field of fieldSet) {
    for (const e of getEdges(field)) {
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
};

/**
 * @param {VectorLike} field
 * @returns {BBox}
 */
export const getFieldBBox = (field) => {
  return BBox.createFromPoints(getNodes(field).map(to2D));
};

/**
 * @param {VectorLike[]} fieldSet
 * @returns {BBox}
 */
export const getFieldSetBBox = (fieldSet) => {
  const points = [];
  for (const field of fieldSet) {
    for (const v of getNodes(field)) {
      points.push(to2D(v));
    }
  }
  return BBox.createFromPoints(points);
};

/**
 * @param {{
 *   origin: VectorLike;
 *   offsetX: number;
 *   offsetY: number;
 *   fieldWidth: number;
 *   fieldHeight: number;
 * }} options
 * @returns {Matrix}
 */
export const getViewportMatrix = ({
  origin,
  offsetX,
  offsetY,
  fieldWidth,
  fieldHeight,
}) => {
  const bbox = getFieldBBox(origin);
  const A = fieldWidth;
  const B = offsetX - bbox.minX * fieldWidth;
  const C = fieldHeight;
  const D = offsetY - bbox.minY * fieldHeight;
  return new Matrix([A, 0, B, 0, C, D, 0, 0, 1]);
};

/**
 * @param {{
 *   origin: VectorLike;
 *   offsetX: number;
 *   offsetY: number;
 *   fieldWidth: number;
 *   fieldHeight: number;
 * }} options
 * @returns {((v: VectorLike) => VectorLike)}
 */
export const getHexToPixelsMapping = ({
  origin,
  offsetX,
  offsetY,
  fieldWidth,
  fieldHeight,
}) => {
  const V = getViewportMatrix({
    origin,
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
};

/**
 * @param {{
 *   origin: VectorLike;
 *   offsetX: number;
 *   offsetY: number;
 *   fieldWidth: number;
 *   fieldHeight: number;
 * }} options
 * @returns {((p: VectorLike) => { hex?: VectorLike; off?: VectorLike })}
 */
export const getPixelsToHexMapping = ({
  origin,
  offsetX,
  offsetY,
  fieldWidth,
  fieldHeight,
}) => {
  const invariant = new Vector(1, 1, 1).dot(origin);
  const P = PROJECTION_MATRIX.inv();
  const V = getViewportMatrix({
    origin,
    offsetX,
    offsetY,
    fieldWidth,
    fieldHeight,
  }).inv();
  return ({ x, y }) => {
    const p = P.mulVector({
      ...V.mulVector({ x, y, z: 1 }),
      z: invariant + 2,
    });
    const q = p.floor();
    const v = p.sub(q);
    const o = v.order;
    const c = Vector.getEmbedding(0, o); // minimal coordinate
    switch (q.x + q.y + q.z - invariant) {
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
};

/**
 * @template {VectorLike} T
 * @param {{
 *   generator: (v: Vector, d: number) => T;
 *   origin?: VectorLike;
 *   maxFields?: number;
 *   predicate?: (v: Vector, d: number) => boolean;
 * }} options
 * @returns {T[]}
 */
export const createFieldSet = (options) => {
  const {
    generator,
    origin = { x: 1, y: 0, z: 0 },
    maxFields = 1000,
    predicate = () => false,
  } = options;
  const fields = new Map();
  let seeds = [Vector.zero().add(origin)];
  let distance = 0;
  while (fields.size < maxFields && seeds.length > 0) {
    const newSeeds = [];
    for (const seed of seeds) {
      const key = getKey(seed);
      if (!fields.has(key) && predicate(seed, distance)) {
        fields.set(
          key,
          generator(new Vector(seed.x, seed.y, seed.z), distance),
        );
        for (const offset of OFFSETS) {
          const newSeed = seed.add(offset);
          const newKey = getKey(newSeed);
          if (!fields.has(newKey)) {
            newSeeds.push(newSeed);
          }
        }
      }
    }
    distance += 1;
    seeds = newSeeds;
  }
  return Array.from(fields.values());
};

/**
 * @param {{ nRows: number; nColumns: number }} options
 * @returns {Vector[]}
 */
export const createRect = ({ nRows, nColumns }) => {
  return createFieldSet({
    generator: identity,
    maxFields: nRows * nColumns,
    predicate: (v) => {
      const { x, y } = PROJECTION_MATRIX.mulVector(v);
      return x > -0.5 && x < nColumns && y > -0.5 && y < 0.75 * nRows;
    },
    origin: new Vector(0, 0, 0),
  });
};
