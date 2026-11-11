/**
 * The cast and the scan, side by side: for each paint order scene, and for
 * scenes of its own where draw order, the clip or culling decides, a grid
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
 * @import { XREventMap } from "../../core.js";
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
 * - `content`: the cast met what an element draws a level past its box,
 *   a run of text or a picture, over the box of the element the scan
 *   names. The cast is right.
 *
 * Of two level boxes at one order, both name the later in tree order, so
 * a tie is no difference. In jsdom no frame walks the layers, so every
 * layer here keeps the base its nesting gives it (`getElevation`), and
 * coplanar sibling layers tie too.
 *
 * @typedef {"content"} Case
 */

/**
 * The rays each scene's two were compared on, and the differences it
 * holds, by case. Every element is made a ray target (`cursor: pointer`), so
 * the cast meets every box: as the scenes are built they hold no ray
 * target, and the two would be compared nowhere. The count of rays compared
 * is held too, so that a scan that loses an element, and falls through to
 * the root where no ray is compared, fails.
 *
 * Every content difference here is text or a picture the stand-in layout
 * lays over another element's box: a label wider than its card, a card's
 * label over a card piled on it, the options' text, which the stand-in
 * measures from the page's corner, and the faded menu's text and picture
 * over the label before it. A page hit-tests what `opacity: 0` hides, and
 * so do both.
 *
 * @type {Record<string, { compared: number } & Partial<Record<Case, number>>>}
 */
const EXPECTED = {
  "800-row list": { compared: 1152 },
  "100 cards, apart": { compared: 1020, content: 2 },
  "100 cards, piled": { compared: 1152, content: 4 },
  "100 cards, translucent": { compared: 1152, content: 4 },
  "lifted by translateZ": { compared: 1152 },
  "swung about its centre": { compared: 1152 },
  "swung about its edge": { compared: 1152 },
  "a swing in a swing": { compared: 1152 },
  "two crossing in an X": { compared: 1152 },
  "three lifted side by side": { compared: 1152 },
  "three tilted about one centre": { compared: 1152 },
  "a closed overlay": { compared: 1152 },
  "a hidden group, one child shown": { compared: 1152 },
  "a select of ten options": { compared: 1152, content: 32 },
  "a menu faded to opacity 0": { compared: 1152, content: 132 },
  "an svg with a clip, a symbol and a use": { compared: 1152 },
  "a positioned badge over later flow siblings": { compared: 1152 },
  "a row cut by its scroller's edge": { compared: 1152 },
  "rows under a rounded scroller corner": { compared: 1152 },
  "a menu in a culled row": { compared: 1152 },
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
 * A box of a given size and place, with a background so that it draws, and
 * no text: the stand-in layout measures every run from the page's corner. A
 * `left` or `top` makes it absolutely positioned.
 *
 * @param {HTMLElement} parent
 * @param {{ width: number, height: number, left?: number, top?: number }} box
 * @returns {HTMLElement}
 */
function addBox(parent, { width, height, left, top }) {
  const box = document.createElement("div");
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  box.style.background = "rgb(255, 255, 255)";
  if (left !== undefined || top !== undefined) {
    box.style.position = "absolute";
    box.style.left = `${left ?? 0}px`;
    box.style.top = `${top ?? 0}px`;
  }
  parent.appendChild(box);
  return box;
}

/**
 * A scroller of three 20 px rows on a positioned board, 30 px tall, so
 * that it cuts its second row and culls its third.
 *
 * @param {HTMLElement} root
 * @returns {{ board: HTMLElement, scroller: HTMLElement, rows: HTMLElement[] }}
 */
function addScroller(root) {
  const board = addBox(root, { width: 200, height: 120 });
  board.style.position = "relative";
  const scroller = addBox(board, { width: 120, height: 30 });
  scroller.style.overflow = "hidden";
  const rows = [0, 1, 2].map(() => addBox(scroller, { width: 120, height: 20 }));
  return { board, scroller, rows };
}

/**
 * Scenes where tree order, the clip or culling decides the hit, which the
 * paint order scenes have none of: in each of those, the later element in
 * tree order is also the one drawn last, and no ray lands where a clip cuts
 * a box. Each fails on a scan that ignores the rule its comment names.
 *
 * @type {Scene[]}
 */
const RULE_SCENES = [
  {
    // Draw order: positioned, the badge draws over the rows after it.
    name: "a positioned badge over later flow siblings",
    build(root) {
      const board = addBox(root, { width: 200, height: 60 });
      addBox(board, { width: 100, height: 30, left: 20, top: 10 });
      addBox(board, { width: 200, height: 20 });
      addBox(board, { width: 200, height: 20 });
    },
  },
  {
    // The clip: the second row runs past the scroller's bottom edge.
    name: "a row cut by its scroller's edge",
    build(root) {
      addScroller(root);
    },
  },
  {
    // The clip's corners: the scroller rounds what it clips, not its own box.
    name: "rows under a rounded scroller corner",
    build(root) {
      const { scroller } = addScroller(root);
      scroller.style.height = "60px";
      for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
        scroller.style.setProperty(`border-${corner}-radius`, "30px");
      }
    },
  },
  {
    // Culling: the menu escapes the scroller's clip to the board, its
    // containing block, but the row it is in is culled, and takes the menu
    // with it (see `shown` in `controls/div.js`).
    name: "a menu in a culled row",
    build(root) {
      const { rows } = addScroller(root);
      addBox(rows[2], { width: 60, height: 40, left: 130, top: 0 });
    },
  },
];

/**
 * Which case of the doc's list a difference is, or `null` for one in none.
 *
 * @param {THREE.Intersection} hit The cast's.
 * @param {Element | null} cast The element the cast's hit is in.
 * @param {Element} scanned
 * @returns {"content" | null}
 */
function caseOf(hit, cast, scanned) {
  if (!cast) {
    return null;
  }
  const scannedOrder = getBoxDrawOrder(scanned);
  if (scannedOrder === undefined) {
    return null;
  }
  // Content is what an element draws past its own box: the hit is drawn
  // after the scanned box, and after the cast element's own box too.
  const castOrder = getBoxDrawOrder(cast);
  const hitOrder = getObjectDrawOrder(hit.object);
  if (castOrder !== undefined && hitOrder > scannedOrder && hitOrder > castOrder) {
    return "content";
  }
  return null;
}

/**
 * Cast and scan a grid of rays over a scene, with every element made a
 * ray target, and count where the two name different elements, by case,
 * with the place of each difference in no case. Compared only where the
 * scan's element is a ray target or inside one (`isInRayTarget`), since a
 * box over a ray target is to take the press, as on a page, and that is
 * not built; here that is wherever the scan names an element other than
 * the root.
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
  for (const scene of [...BENCH_SCENES, ...LAYER_SCENES, ...HIDDEN_SCENES, ...RULE_SCENES]) {
    test(`differ on ${scene.name} only where the hit test rules say`, async () => {
      const { counts, compared, odd } = await differences(scene.build);
      assert.deepEqual(odd, [], "every difference is a case the rules name");
      assert.deepEqual({ compared, ...counts }, EXPECTED[scene.name]);
    });
  }
});
