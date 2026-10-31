import * as THREE from "three";
import { getPaintLayer } from "./elevation.js";

/*
 * The tree a panel drawn in paint order orders its layers with: a binary
 * space partition over their planes, in the panel's frame, as Chromium's
 * compositor orders a `preserve-3d` context (`cc/trees/bsp_tree.cc`), by
 * these rules:
 *
 * - Splitters are chosen parent first: of the polygons left, the ones nested
 *   in the fewest layers, then of those the one that splits the fewest
 *   others, and of equal ones the first added, which is tree order.
 * - Two layers are coplanar when every corner of one is within `COPLANAR`
 *   px of the other's plane. They share a node and draw in paint order
 *   (`comparePaintOrder`).
 * - A polygon that crosses a splitter's plane is cut in two along it, and
 *   each piece carries the plane and the side it keeps, a half-plane its
 *   draw tests. The two pieces of one cut keep `>= 0` and `< 0` of one
 *   plane, so no point is drawn twice and none is lost.
 * - The walk visits the pieces from back to front for a viewpoint: at each
 *   node the side the viewpoint is not on, then the node's own pieces, then
 *   the side it is on.
 *
 * Built when a layer appears, goes or moves, and walked every frame. Nothing
 * is allocated once the pools hold what the panel needs: polygons, their
 * points and their half-planes come back to the pools at each build, and
 * the pools only grow.
 */

/** How far apart, in px, two planes may be and still share a node. */
export const COPLANAR = 0.01;

/**
 * A layer's border box in the panel's frame, or a piece of one: a convex
 * polygon, the plane it lies in, and the half-planes that cut it out of its
 * layer.
 */
export class Polygon {
  /** @type {Element} */
  layer = /** @type {Element} */ (/** @type {unknown} */ (null));
  /** How many layers the layer is nested in. */
  depth = 0;
  /** The order the polygon was added in, for ties. */
  index = 0;
  /** The node it ended in, once the tree is built. */
  node = -1;
  /** Its place in the last walk that visited it (`layerOrder.js`). */
  place = -1;
  /** @type {THREE.Vector3[]} */
  points = [];
  count = 0;
  plane = new THREE.Plane();
  /**
   * The planes of the splits that cut it out of its layer, each the plane
   * of the splitter, which the splitter's polygon owns.
   *
   * @type {THREE.Plane[]}
   */
  halfPlanes = [];
  /**
   * For each of `halfPlanes`, the side kept: 1 for the points at or in
   * front of the plane, -1 for those behind it.
   *
   * @type {number[]}
   */
  sides = [];
  /**
   * For each of `halfPlanes`, the node of its splitter, so that two pieces
   * can tell whether they test the same half-planes (`sameHalfPlanes`).
   *
   * @type {number[]}
   */
  splitters = [];

  /**
   * @param {number} n
   * @returns {THREE.Vector3}
   */
  point(n) {
    while (this.points.length <= n) {
      this.points.push(new THREE.Vector3());
    }
    return this.points[n];
  }
}

/**
 * A node of the tree: a plane, the pieces that lie in it in paint order,
 * and the nodes in front of it and behind it.
 */
class TreeNode {
  /** @type {THREE.Plane} */
  plane = /** @type {THREE.Plane} */ (/** @type {unknown} */ (null));
  /** @type {Polygon[]} */
  pieces = [];
  /** @type {TreeNode | null} */
  front = null;
  /** @type {TreeNode | null} */
  back = null;
}

/**
 * Which of two layers' roots a page paints first, negative for `a`. Two
 * roots are compared where their paths from the root split, by the two
 * children of their nearest common ancestor that hold them: by
 * `getPaintLayer`, a negative `z-index` before the rest and a positive one
 * after, and tree order within each. A box in the flow counts as the rest:
 * it forms no stacking context, so the roots inside it are painted with
 * the positioned boxes around it, in tree order, not at its own step. A
 * root paints before the layers inside it.
 *
 * @param {Element} a
 * @param {Element} b
 * @returns {number}
 */
export function comparePaintOrder(a, b) {
  if (a === b) {
    return 0;
  }
  if (a.contains(b)) {
    return -1;
  }
  if (b.contains(a)) {
    return 1;
  }
  let left = a;
  while (!(/** @type {Element} */ (left.parentElement).contains(b))) {
    left = /** @type {Element} */ (left.parentElement);
  }
  let right = b;
  while (right.parentElement !== left.parentElement) {
    right = /** @type {Element} */ (right.parentElement);
  }
  return (
    (getPaintLayer(left) ?? 0) - (getPaintLayer(right) ?? 0) ||
    (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
  );
}

/**
 * @param {Polygon} a
 * @param {Polygon} b
 * @returns {number}
 */
function byPaintOrder(a, b) {
  return comparePaintOrder(a.layer, b.layer) || a.index - b.index;
}

/**
 * Whether two pieces test the same half-planes, and so can be drawn by one
 * draw: the same splitters, on the same sides.
 *
 * @param {Polygon} a
 * @param {Polygon} b
 * @returns {boolean}
 */
export function sameHalfPlanes(a, b) {
  if (a.splitters.length !== b.splitters.length) {
    return false;
  }
  for (let i = 0; i < a.splitters.length; i += 1) {
    if (a.splitters[i] !== b.splitters[i] || a.sides[i] !== b.sides[i]) {
      return false;
    }
  }
  return true;
}

/** Scratch for a corner on its way into the panel's frame. */
const corner = new THREE.Vector4();

/** The corners of a unit box, scaled by a layer's size. */
const CORNERS = /** @type {const} */ ([
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]);

/**
 * A panel's tree, rebuilt in place.
 */
export class LayerTree {
  /** @type {Polygon[]} */
  #pool = [];
  #used = 0;
  /** @type {TreeNode[]} */
  #nodePool = [];
  #nodesUsed = 0;
  /** The polygons added since `begin`, one a layer. @type {Polygon[]} */
  #added = [];
  /** Scratch sets for the build, reused. @type {Polygon[][]} */
  #sets = [];
  #setsUsed = 0;
  /** @type {number[]} */
  #distances = [];
  /** @type {TreeNode | null} */
  root = null;
  /** Every piece, once built, in no particular order. @type {Polygon[]} */
  pieces = [];
  /** How many nodes the tree has. */
  nodes = 0;

  /** Start a build: every polygon and node goes back to its pool. */
  begin() {
    this.#used = 0;
    this.#nodesUsed = 0;
    this.#setsUsed = 0;
    this.#added.length = 0;
    this.pieces.length = 0;
    this.root = null;
    this.nodes = 0;
  }

  /**
   * Add a layer: its border box, `width` by `height` px, through `matrix`,
   * from its own frame into the panel's. Leaves out a box with no area, or
   * one that a perspective takes to or behind the eye, and says so.
   *
   * @param {Element} layer
   * @param {number} depth How many layers it is nested in.
   * @param {THREE.Matrix4} matrix
   * @param {number} width
   * @param {number} height
   * @returns {boolean}
   */
  add(layer, depth, matrix, width, height) {
    if (!(width > 0 && height > 0)) {
      return false;
    }
    const polygon = this.#acquire();
    polygon.layer = layer;
    polygon.depth = depth;
    polygon.index = this.#added.length;
    for (let i = 0; i < CORNERS.length; i += 1) {
      corner.set(CORNERS[i][0] * width, CORNERS[i][1] * height, 0, 1).applyMatrix4(matrix);
      if (corner.w <= 0) {
        this.#used -= 1;
        return false;
      }
      polygon.point(i).set(corner.x / corner.w, corner.y / corner.w, corner.z / corner.w);
    }
    polygon.count = CORNERS.length;
    const [a, b, , d] = polygon.points;
    polygon.plane.setFromCoplanarPoints(a, b, d);
    this.#added.push(polygon);
    return true;
  }

  /** Build the tree over what was added. */
  build() {
    const set = this.#set();
    for (const polygon of this.#added) {
      set.push(polygon);
    }
    this.root = this.#build(set);
  }

  /**
   * Visit every piece from back to front, as seen from `viewpoint`, in the
   * panel's frame.
   *
   * @param {THREE.Vector3} viewpoint
   * @param {(piece: Polygon) => void} visit
   */
  walk(viewpoint, visit) {
    walkNode(this.root, viewpoint, visit);
  }

  /**
   * @param {Polygon[]} set
   * @returns {TreeNode | null}
   */
  #build(set) {
    if (set.length === 0) {
      return null;
    }
    let shallowest = Infinity;
    for (const polygon of set) {
      shallowest = Math.min(shallowest, polygon.depth);
    }
    let splitter = set[0];
    let fewest = Infinity;
    for (const candidate of set) {
      if (candidate.depth !== shallowest) {
        continue;
      }
      let splits = 0;
      for (const other of set) {
        if (other !== candidate && this.#straddles(other, candidate.plane)) {
          splits += 1;
        }
      }
      if (splits < fewest || (splits === fewest && candidate.index < splitter.index)) {
        fewest = splits;
        splitter = candidate;
      }
    }
    const node = this.#acquireNode();
    const id = this.nodes;
    this.nodes += 1;
    node.plane = splitter.plane;
    const front = this.#set();
    const back = this.#set();
    for (const polygon of set) {
      if (polygon === splitter) {
        this.#keep(node, polygon, id);
        continue;
      }
      const side = this.#side(polygon, splitter.plane);
      if (side === 0) {
        this.#keep(node, polygon, id);
      } else if (side === 1) {
        front.push(polygon);
      } else if (side === -1) {
        back.push(polygon);
      } else {
        const [ahead, behind] = this.#split(polygon, splitter.plane, id);
        front.push(ahead);
        back.push(behind);
      }
    }
    node.pieces.sort(byPaintOrder);
    node.front = this.#build(front);
    node.back = this.#build(back);
    return node;
  }

  /**
   * @param {TreeNode} node
   * @param {Polygon} polygon
   * @param {number} id
   */
  #keep(node, polygon, id) {
    polygon.node = id;
    node.pieces.push(polygon);
    this.pieces.push(polygon);
  }

  /**
   * Which side of `plane` a polygon is on: 0 in it, 1 in front, -1 behind,
   * and 2 across it.
   *
   * @param {Polygon} polygon
   * @param {THREE.Plane} plane
   * @returns {number}
   */
  #side(polygon, plane) {
    let ahead = false;
    let behind = false;
    for (let i = 0; i < polygon.count; i += 1) {
      const d = plane.distanceToPoint(polygon.points[i]);
      this.#distances[i] = d;
      ahead ||= d > COPLANAR;
      behind ||= d < -COPLANAR;
    }
    if (ahead && behind) {
      return 2;
    }
    return ahead ? 1 : behind ? -1 : 0;
  }

  /**
   * @param {Polygon} polygon
   * @param {THREE.Plane} plane
   * @returns {boolean}
   */
  #straddles(polygon, plane) {
    return this.#side(polygon, plane) === 2;
  }

  /**
   * Cut a polygon that crosses `plane` in two, from the distances `#side`
   * left.
   *
   * @param {Polygon} polygon
   * @param {THREE.Plane} plane
   * @param {number} splitter The splitter's node.
   * @returns {[Polygon, Polygon]}
   */
  #split(polygon, plane, splitter) {
    const front = this.#piece(polygon, plane, 1, splitter);
    const back = this.#piece(polygon, plane, -1, splitter);
    const distances = this.#distances;
    const n = polygon.count;
    for (let i = 0; i < n; i += 1) {
      const a = polygon.points[i];
      const b = polygon.points[(i + 1) % n];
      const da = distances[i];
      const db = distances[(i + 1) % n];
      if (da >= -COPLANAR) {
        front.point(front.count++).copy(a);
      }
      if (da <= COPLANAR) {
        back.point(back.count++).copy(a);
      }
      if ((da > COPLANAR && db < -COPLANAR) || (da < -COPLANAR && db > COPLANAR)) {
        const t = da / (da - db);
        front.point(front.count++).copy(a).lerp(b, t);
        back.point(back.count++).copy(a).lerp(b, t);
      }
    }
    return [front, back];
  }

  /**
   * A piece of `polygon` on one side of `plane`, with its points still to
   * fill.
   *
   * @param {Polygon} polygon
   * @param {THREE.Plane} plane
   * @param {number} side
   * @param {number} splitter
   * @returns {Polygon}
   */
  #piece(polygon, plane, side, splitter) {
    const piece = this.#acquire();
    piece.layer = polygon.layer;
    piece.depth = polygon.depth;
    piece.index = polygon.index;
    piece.count = 0;
    piece.plane.copy(polygon.plane);
    for (let i = 0; i < polygon.halfPlanes.length; i += 1) {
      piece.halfPlanes.push(polygon.halfPlanes[i]);
      piece.sides.push(polygon.sides[i]);
      piece.splitters.push(polygon.splitters[i]);
    }
    piece.halfPlanes.push(plane);
    piece.sides.push(side);
    piece.splitters.push(splitter);
    return piece;
  }

  /** @returns {Polygon} */
  #acquire() {
    if (this.#used === this.#pool.length) {
      this.#pool.push(new Polygon());
    }
    const polygon = this.#pool[this.#used];
    this.#used += 1;
    polygon.node = -1;
    polygon.count = 0;
    polygon.halfPlanes.length = 0;
    polygon.sides.length = 0;
    polygon.splitters.length = 0;
    return polygon;
  }

  /** @returns {TreeNode} */
  #acquireNode() {
    if (this.#nodesUsed === this.#nodePool.length) {
      this.#nodePool.push(new TreeNode());
    }
    const node = this.#nodePool[this.#nodesUsed];
    this.#nodesUsed += 1;
    node.pieces.length = 0;
    node.front = null;
    node.back = null;
    return node;
  }

  /** @returns {Polygon[]} */
  #set() {
    if (this.#setsUsed === this.#sets.length) {
      this.#sets.push([]);
    }
    const set = this.#sets[this.#setsUsed];
    this.#setsUsed += 1;
    set.length = 0;
    return set;
  }
}

/**
 * @param {TreeNode | null} node
 * @param {THREE.Vector3} viewpoint
 * @param {(piece: Polygon) => void} visit
 */
function walkNode(node, viewpoint, visit) {
  if (!node) {
    return;
  }
  const inFront = node.plane.distanceToPoint(viewpoint) >= 0;
  walkNode(inFront ? node.back : node.front, viewpoint, visit);
  for (const piece of node.pieces) {
    visit(piece);
  }
  walkNode(inFront ? node.front : node.back, viewpoint, visit);
}
