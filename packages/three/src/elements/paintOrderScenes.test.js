/**
 * The panel against the draw count (`test/paintOrderCount.js`), on the
 * count's scenes: a panel cuts each scene into the pieces the count does,
 * and orders every overlap in it in paint order.
 * Apart from `paintOrder.test.js` because the scenes install
 * `benchLayout.js`'s stand-ins, which that file's tests do not mount under.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { BENCH_SCENES, LAYER_SCENES, mountScene } from "../test/paintOrderScenes.js";
import { countPanel } from "../test/paintOrderCount.js";
import { getParentElement } from "./mirror/styleReads.js";
import { getClearedSiblings, getDrawLevel, getLayer } from "./elevation.js";
import { getPaintChildren, isGenerated } from "./pseudoElements.js";
import { getLayerOrder } from "./layerOrder.js";
import { isSvgElement } from "./plugins.js";

/**
 * @import {PaintNode} from "./elevation.js";
 */

/**
 * The elements and pseudo-elements a node paints inside of, in paint order:
 * its paint children (`getPaintChildren`), but for its text.
 *
 * @param {PaintNode} node
 * @returns {PaintNode[]}
 */
function paintChildren(node) {
  if (isGenerated(node) || isSvgElement(node)) {
    return [];
  }
  return /** @type {PaintNode[]} */ (
    getPaintChildren(node).filter(
      (child) => isGenerated(child) || child.nodeType === Node.ELEMENT_NODE,
    )
  );
}

/**
 * The elements and pseudo-elements of a layer under `node`, itself
 * included, left in it: not into a layer nested in it, and not into an
 * `<svg>`, whose content draws within its own content level.
 *
 * @param {PaintNode} node
 * @returns {PaintNode[]}
 */
function layerSubtree(node) {
  /** @type {PaintNode[]} */
  const found = [node];
  for (const child of paintChildren(node)) {
    if (getLayer(child) !== child) {
      found.push(...layerSubtree(child));
    }
  }
  return found;
}

/**
 * The plan's property of a panel's levels, over every element under
 * `root`: a box draws past its parent's, and an element that clears a
 * sibling in its layer draws past the content of everything that sibling's
 * layer subtree draws. Returns what breaks it.
 *
 * @param {Element} root
 * @returns {string[]}
 */
function levelBreaks(root) {
  /** @type {string[]} */
  const breaks = [];
  /**
   * @param {PaintNode} node
   * @returns {string}
   */
  const name = (node) =>
    isGenerated(node) ? `${name(node.element)}${node.pseudo}` : node.id || node.localName;
  /** @param {PaintNode} element */
  const visit = (element) => {
    const parent =
      element === root ? null : isGenerated(element) ? element.element : getParentElement(element);
    const level = getDrawLevel(element);
    const isRoot = getLayer(element) === element;
    if (parent && !isRoot && level <= getDrawLevel(parent)) {
      breaks.push(`${name(element)} at ${level} is not past its parent`);
    }
    if (parent && !isRoot) {
      for (const sibling of getClearedSiblings(element)) {
        if (getLayer(sibling) === sibling) {
          continue;
        }
        const under = Math.max(...layerSubtree(sibling).map((each) => getDrawLevel(each) + 1));
        if (level <= under) {
          breaks.push(`${name(element)} at ${level} is not past ${name(sibling)}'s ${under}`);
        }
      }
    }
    for (const child of paintChildren(element)) {
      visit(child);
    }
  };
  visit(root);
  return breaks;
}

describe("a panel, on the count's scenes", () => {
  for (const scene of LAYER_SCENES) {
    test(`cuts ${scene.name} into the pieces the count does`, async () => {
      // The count reads the same tree (`layerTree.js`) off the page; the
      // panel builds it from the layers it registered and their objects'
      // matrices. A swing in a swing is cut at both planes it crosses, two
      // cards in an X by each other's, and three tilted about one centre,
      // which overlap in a cycle, take the extra cut that orders them. Goes
      // red with a nested layer the panel does not place.
      const { root, dispose } = await mountScene(scene.build);
      const counted = countPanel(root);
      const order = /** @type {import("./layerOrder.js").LayerOrder} */ (getLayerOrder(root));
      order.walk(new THREE.Vector3(0, 0, 2000));
      const pieces = order.pieces();
      assert.deepEqual(
        {
          layers: new Set(pieces.map((piece) => piece.layer)).size,
          pieces: pieces.length,
          mostHalfPlanes: Math.max(...pieces.map((piece) => piece.halfPlanes.length)),
        },
        {
          layers: counted.layers,
          pieces: counted.pieces,
          mostHalfPlanes: counted.mostHalfPlanes,
        },
      );
      dispose();
    });
  }

  for (const scene of [...BENCH_SCENES, ...LAYER_SCENES]) {
    test(`orders every overlap of ${scene.name} in paint order`, async () => {
      const { root, dispose } = await mountScene(scene.build);
      assert.deepEqual(levelBreaks(root), []);
      dispose();
    });
  }
});
