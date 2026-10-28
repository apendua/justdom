import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { comparePaintOrder, LayerTree, sameHalfPlanes } from "./layerTree.js";

/**
 * Elements to stand for layers, under one parent, with the styles given.
 *
 * @param {...string} styles
 * @returns {HTMLElement[]}
 */
function siblings(...styles) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return styles.map((style) => {
    const element = document.createElement("div");
    element.style.cssText = style;
    parent.appendChild(element);
    return element;
  });
}

/**
 * A 100 by 100 layer's matrix into the panel's frame: at `z`, and turned
 * `angle` about the vertical line through its middle.
 *
 * @param {number} z
 * @param {number} [angle]
 * @returns {THREE.Matrix4}
 */
function placed(z, angle = 0) {
  return new THREE.Matrix4()
    .makeTranslation(50, 0, z)
    .multiply(new THREE.Matrix4().makeRotationY(angle))
    .multiply(new THREE.Matrix4().makeTranslation(-50, 0, 0));
}

/**
 * The layers a walk visits, in order.
 *
 * @param {LayerTree} tree
 * @param {THREE.Vector3} viewpoint
 * @returns {Element[]}
 */
function walked(tree, viewpoint) {
  /** @type {Element[]} */
  const order = [];
  tree.walk(viewpoint, (piece) => order.push(piece.layer));
  return order;
}

const IN_FRONT = new THREE.Vector3(50, 50, 1000);
const BEHIND = new THREE.Vector3(50, 50, -1000);

describe("comparePaintOrder", () => {
  test("paints a layer before the layers inside it", () => {
    const [outer] = siblings("");
    const inner = document.createElement("div");
    outer.appendChild(inner);
    assert.ok(comparePaintOrder(outer, inner) < 0);
    assert.ok(comparePaintOrder(inner, outer) > 0);
    assert.equal(comparePaintOrder(outer, outer), 0);
  });

  test("paints siblings in tree order within a stacking layer", () => {
    const [a, b] = siblings("position: absolute", "position: absolute");
    assert.ok(comparePaintOrder(a, b) < 0);
    assert.ok(comparePaintOrder(b, a) > 0);
  });

  test("paints a negative z-index first and a positive one last, whatever the tree order", () => {
    const [over, flat, under] = siblings(
      "position: absolute; z-index: 3",
      "position: absolute",
      "position: absolute; z-index: -2",
    );
    assert.ok(comparePaintOrder(under, flat) < 0);
    assert.ok(comparePaintOrder(flat, over) < 0);
    assert.ok(comparePaintOrder(under, over) < 0);
  });

  test("compares layers in different boxes by the boxes' children that hold them", () => {
    const [first, second] = siblings("position: absolute; z-index: 1", "position: absolute");
    const early = document.createElement("div");
    const late = document.createElement("div");
    first.appendChild(early);
    second.appendChild(late);
    assert.ok(comparePaintOrder(late, early) < 0, "the overlay's subtree paints last");
  });
});

describe("LayerTree", () => {
  test("walks parallel layers back to front from either side", () => {
    const [near, far] = siblings("", "");
    const tree = new LayerTree();
    tree.begin();
    tree.add(near, 1, placed(10), 100, 100);
    tree.add(far, 1, placed(-10), 100, 100);
    tree.build();
    assert.deepEqual(walked(tree, IN_FRONT), [far, near]);
    assert.deepEqual(walked(tree, BEHIND), [near, far]);
  });

  test("puts layers in one plane in one node, in paint order", () => {
    const [root] = siblings("");
    const a = document.createElement("div");
    const b = document.createElement("div");
    root.append(a, b);
    const tree = new LayerTree();
    tree.begin();
    // Added out of paint order, and a hair apart, within `COPLANAR`.
    tree.add(b, 1, placed(0.001), 100, 100);
    tree.add(root, 0, placed(0), 100, 100);
    tree.add(a, 1, placed(-0.001), 100, 100);
    tree.build();
    assert.equal(tree.nodes, 1);
    assert.deepEqual(walked(tree, IN_FRONT), [root, a, b]);
    assert.deepEqual(walked(tree, BEHIND), [root, a, b]);
  });

  test("cuts a layer that crosses another's plane into two pieces with opposite sides", () => {
    const [root] = siblings("");
    const door = document.createElement("div");
    root.appendChild(door);
    const tree = new LayerTree();
    tree.begin();
    tree.add(root, 0, placed(0), 100, 100);
    tree.add(door, 1, placed(0, Math.PI / 3), 100, 100);
    tree.build();

    const pieces = tree.pieces.filter((piece) => piece.layer === door);
    assert.equal(pieces.length, 2);
    const [one, other] = pieces;
    assert.equal(one.halfPlanes.length, 1);
    assert.equal(one.halfPlanes[0], other.halfPlanes[0], "the splitter's own plane");
    assert.deepEqual([one.sides[0], other.sides[0]].sort(), [-1, 1]);
    assert.equal(sameHalfPlanes(one, other), false);
    assert.equal(sameHalfPlanes(one, one), true);
    // Each piece keeps every corner it has on its own side of the cut.
    for (const piece of pieces) {
      for (let i = 0; i < piece.count; i += 1) {
        const d = piece.halfPlanes[0].distanceToPoint(piece.points[i]);
        assert.ok(piece.sides[0] > 0 ? d >= -1e-9 : d <= 1e-9);
      }
    }
    // From in front, the piece behind the root's plane draws before the
    // root, and the one in front after it.
    assert.deepEqual(walked(tree, IN_FRONT), [door, root, door]);
  });

  test("splits by the shallowest layer first", () => {
    const [root] = siblings("");
    const door = document.createElement("div");
    root.appendChild(door);
    const tree = new LayerTree();
    tree.begin();
    // The door is added first, but the root is nested in fewer layers.
    tree.add(door, 1, placed(0, Math.PI / 3), 100, 100);
    tree.add(root, 0, placed(0), 100, 100);
    tree.build();
    assert.equal(tree.root?.pieces[0].layer, root);
    assert.equal(tree.pieces.filter((piece) => piece.layer === door).length, 2);
  });

  test("leaves out a layer with no area, and one a perspective takes behind the eye", () => {
    const [flat, gone] = siblings("", "");
    const behindEye = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1);
    const tree = new LayerTree();
    tree.begin();
    assert.equal(tree.add(flat, 0, placed(0), 0, 100), false);
    assert.equal(tree.add(gone, 0, behindEye, 100, 100), false);
    tree.build();
    assert.equal(tree.root, null);
    assert.deepEqual(walked(tree, IN_FRONT), []);
  });

  test("rebuilds from its pools, making nothing new for a panel it has seen", () => {
    const [root] = siblings("");
    const door = document.createElement("div");
    root.appendChild(door);
    const tree = new LayerTree();
    const build = () => {
      tree.begin();
      tree.add(root, 0, placed(0), 100, 100);
      tree.add(door, 1, placed(0, Math.PI / 3), 100, 100);
      tree.build();
      return new Set(tree.pieces);
    };
    const first = build();
    const second = build();
    assert.deepEqual(second, first, "the same pieces, taken from the pool again");
    for (const piece of second) {
      assert.ok(piece.halfPlanes.length <= 1, "and each starts with no half-planes");
    }
  });
});
