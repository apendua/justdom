/**
 * The cast and the scan, side by side: for each paint order scene, a grid
 * of rays, straight on and slanting, each asked of the interaction
 * manager's cast and of `hitElement`'s scan. _Two hit tests, one order_ in
 * `docs/freedom-paint-order.md` says where the two may differ and which is
 * right; every difference found here is put in one of those cases, and the
 * counts per scene are held to `EXPECTED`. A difference in no case fails.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  BENCH_SCENES,
  HIDDEN_SCENES,
  LAYER_SCENES,
  mountScene,
} from "../../test/paintOrderScenes.js";
import { getBoxDrawOrder, getObjectDrawOrder } from "../../drawOrder.js";
import { getPanel, hitElement } from "./dragAndDrop.js";
import { isInRayTarget } from "./pointerForwarding.js";

/**
 * @import { Scene } from "../../test/paintOrderScenes.js";
 * @import { Panel } from "./dragAndDrop.js";
 */

/** Rays across the scene, a side, for each slant. */
const GRID = 24;

/**
 * Where in its cell of the grid each ray lands: off the half and off any
 * round fraction, so that no ray falls on an edge two boxes share, where a
 * triangle test and a box test may each round the other way.
 */
const OFFSET = 0.381966;

/**
 * How far the ray's origin is moved sideways, in metres, a metre in front
 * of the panel: straight on, and at about 27 degrees.
 */
const SLANTS = [0, 0.5];

/**
 * Where the two may differ (see the doc's list):
 *
 * - `tie`: both elements' boxes are drawn at one order. The cast keeps the
 *   first it found, the scan the later in tree order, which is right. In
 *   jsdom no frame walks the layers, so every layer here keeps the base its
 *   nesting gives it (`getElevation`), and coplanar sibling layers tie too.
 * - `content`: the cast met what an element draws a level past its box,
 *   a run of text or a picture, over the box of the element the scan
 *   names. The cast is right.
 *
 * @typedef {"tie" | "content"} Case
 */

/**
 * The differences each scene holds, by case, out of the rays the two were
 * compared on. Every element is made a ray target (`cursor: pointer`), so
 * the cast meets every box: as the scenes are built they hold no ray
 * target, and the two would be compared nowhere. A scene not listed holds
 * none.
 *
 * Every tie here is between boxes the stand-in layout lays over each other
 * at one order: labels wider than their cards, and two layers on one plane
 * whose bases no walk has set apart. Every content difference is a card's
 * label drawn over a card piled on it, or the faded menu's content, which
 * the stand-in layout puts over the label before the menu. A page hit-tests
 * what `opacity: 0` hides, and so do both.
 *
 * @type {Record<string, Partial<Record<Case, number>>>}
 */
const EXPECTED = {
  "100 cards, apart": { tie: 84 },
  "100 cards, piled": { content: 4 },
  "100 cards, translucent": { content: 4 },
  "three lifted side by side": { tie: 4 },
  "a menu faded to opacity 0": { content: 22 },
};

/**
 * Every element under `element`, itself included.
 *
 * @param {Element} element
 * @returns {Element[]}
 */
function subtree(element) {
  return [element, ...element.querySelectorAll("*")];
}

/**
 * Which case of the doc's list a difference is, or `null` for one in none.
 *
 * @param {THREE.Intersection} hit The cast's.
 * @param {Element | null} cast The element the cast's hit is in.
 * @param {Element} scanned
 * @returns {Case | null}
 */
function caseOf(hit, cast, scanned) {
  if (!cast) {
    return null;
  }
  const scannedOrder = getBoxDrawOrder(scanned);
  if (scannedOrder === undefined) {
    return null;
  }
  if (getObjectDrawOrder(hit.object) > scannedOrder && getBoxDrawOrder(cast) !== undefined) {
    return "content";
  }
  // Of two boxes at one order, the scan's is to be the later in tree order.
  if (
    getBoxDrawOrder(cast) === scannedOrder &&
    cast.compareDocumentPosition(scanned) & Node.DOCUMENT_POSITION_FOLLOWING
  ) {
    return "tie";
  }
  return null;
}

/**
 * Cast and scan a grid of rays over a scene, with every element made a
 * ray target, and count where the two name different elements, by case,
 * with the place of each difference in no case. Compared only where the
 * scan's element is a ray target or inside one (`isInRayTarget`), while
 * the box over a ray target is undecided; here that is wherever the scan
 * names an element other than the root.
 *
 * @param {Scene["build"]} build
 * @returns {Promise<{ counts: Partial<Record<Case, number>>, compared: number, odd: string[] }>}
 */
async function differences(build) {
  const { root, manager, panel, dispose } = await mountScene((root) => {
    build(root);
    for (const element of root.querySelectorAll("*")) {
      if (element instanceof window.HTMLElement || element instanceof window.SVGElement) {
        element.style.cursor = "pointer";
      }
    }
  });
  const registered = /** @type {Panel} */ (getPanel(panel));
  /** @type {Map<THREE.Object3D, Element>} */
  const elementOf = new Map();
  for (const element of subtree(root)) {
    const object = registered.objectOf(element);
    if (object) {
      elementOf.set(object, element);
    }
  }
  /** @param {THREE.Object3D} object */
  const owner = (object) => {
    for (let node = /** @type {THREE.Object3D | null} */ (object); node; node = node.parent) {
      const element = elementOf.get(node);
      if (element) {
        return element;
      }
    }
    return null;
  };
  // The root's own box can be narrower than what it holds: the grid spans
  // every element's.
  let width = 0;
  let height = 0;
  for (const element of subtree(root)) {
    const rect = element.getBoundingClientRect();
    width = Math.max(width, rect.right);
    height = Math.max(height, rect.bottom);
  }
  const controller = /** @type {THREE.XRTargetRaySpace} */ (
    /** @type {unknown} */ (new THREE.Object3D())
  );
  const ray = new THREE.Ray();
  /** @type {Partial<Record<Case, number>>} */
  const counts = {};
  /** @type {string[]} */
  const odd = [];
  let compared = 0;
  panel.updateWorldMatrix(true, true);
  for (const slant of SLANTS) {
    for (let i = 0; i < GRID; i += 1) {
      for (let j = 0; j < GRID; j += 1) {
        const x = ((i + OFFSET) * width) / GRID;
        const y = ((j + OFFSET) * height) / GRID;
        const target = panel.localToWorld(new THREE.Vector3(x, y, 0));
        controller.position.copy(target).add(new THREE.Vector3(-slant, 0, 1));
        // An object's +z turns to what it looks at, and a ray runs down -z.
        controller.lookAt(controller.position.clone().multiplyScalar(2).sub(target));
        controller.updateMatrixWorld(true);
        ray.origin.setFromMatrixPosition(controller.matrixWorld);
        ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
        const scanned = hitElement(registered, ray);
        if (!scanned || !isInRayTarget(scanned)) {
          continue;
        }
        compared += 1;
        const hit = manager.getIntersection(controller);
        const cast = hit ? owner(hit.object) : null;
        if (cast === scanned) {
          continue;
        }
        const found = hit ? caseOf(hit, cast, scanned) : null;
        if (found) {
          counts[found] = (counts[found] ?? 0) + 1;
        } else {
          odd.push(`${Math.round(x)},${Math.round(y)} slant ${slant}`);
        }
      }
    }
  }
  dispose();
  return { counts, compared, odd };
}

describe("the cast and the scan", () => {
  for (const scene of [...BENCH_SCENES, ...LAYER_SCENES, ...HIDDEN_SCENES]) {
    test(`differ on ${scene.name} only where the hit test rules say`, async () => {
      const { counts, compared, odd } = await differences(scene.build);
      assert.ok(compared > 0, "the two were compared somewhere");
      assert.deepEqual(odd, [], "every difference is a case the rules name");
      assert.deepEqual(counts, EXPECTED[scene.name] ?? {});
    });
  }
});
