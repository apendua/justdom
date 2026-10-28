import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "./interactions.js";
import { createPortal } from "./elements/portal.js";
import { svgElements } from "./svg/index.js";
import { getObjectDrawOrder } from "./drawOrder.js";
import { BOX_BUCKET_BIAS, UNBATCHED_BOX_BIAS } from "./elements/boxBatch.js";
import { batchedBoxMaterial } from "./elements/sdfRect.js";
import { flushFrame, settle } from "./test/portalHarness.js";
import { stubCanvas } from "./test/stubCanvas.js";
import { installRange } from "./test/textRange.js";
import { clientRect } from "./test/clientRect.js";

const SVG = "http://www.w3.org/2000/svg";

/**
 * What a walked mesh is, to say that the walk met every kind.
 *
 * @param {THREE.Mesh} object
 * @param {THREE.Material} material
 * @returns {string}
 */
function kindOf(object, material) {
  if (object.geometry.getAttribute("aLayer")) {
    return "text batch";
  }
  if (object.geometry.getAttribute("aSize")) {
    return "box batch";
  }
  if (material === batchedBoxMaterial()) {
    return "box";
  }
  if (material instanceof THREE.ShaderMaterial) {
    return "picture";
  }
  if (object.geometry instanceof THREE.ShapeGeometry) {
    return "shape";
  }
  return /** @type {THREE.MeshBasicMaterial} */ (material).alphaMap ? "run" : "tick";
}

/**
 * A panel with one of each kind of thing a panel draws: a box, text, a
 * field with its value, a checkbox's tick, a list item's marker, a picture
 * and an SVG shape.
 */
function everyKind() {
  const root = document.createElement("div");
  root.style.cssText = "width: 400px; background: white; padding: 8px";
  const card = document.createElement("div");
  card.style.cssText = "background: navy; color: white; padding: 4px";
  card.textContent = "A card";
  const field = document.createElement("input");
  field.value = "typed";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = true;
  const list = document.createElement("ul");
  const item = document.createElement("li");
  item.textContent = "an item";
  list.append(item);
  const picture = document.createElement("img");
  picture.src = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  picture.style.cssText = "width: 10px; height: 10px";
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  const rect = document.createElementNS(SVG, "rect");
  rect.setAttribute("width", "10");
  rect.setAttribute("height", "10");
  rect.setAttribute("fill", "red");
  svg.append(rect);
  // jsdom lays out nothing, and an `<svg>` with no box draws nothing.
  svg.getBoundingClientRect = () => clientRect(0, 0, 20, 20);
  root.append(card, field, check, list, picture, svg);
  document.body.append(root);
  return root;
}

/**
 * Mount `everyKind` and hand each mesh that draws colour, other than a
 * batch's own, to `visit`, with its kind.
 *
 * @param {boolean} paintOrder
 * @param {(object: THREE.Mesh, kind: string) => void} visit
 * @returns {Promise<Set<string>>} The kinds walked, batches included.
 */
async function walkEveryKind(paintOrder, visit) {
  const root = everyKind();
  const ctx = InteractionContext.set({}, new InteractionManager());
  const portal = createPortal(ctx, {
    root,
    budget: Infinity,
    loadingFrame: { delay: 0, minimumTime: 0 },
    plugins: [svgElements()],
    paintOrder,
  });
  const scene = new THREE.Group();
  portal.addTo(scene);
  await settle(portal);
  flushFrame();
  /** @type {Set<string>} */
  const kinds = new Set();
  try {
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }
      const material = /** @type {THREE.Material} */ (object.material);
      // The blocker and the depth quad write no colour, and no ray that
      // picks between level hits meets either.
      if (!material.colorWrite) {
        return;
      }
      const kind = kindOf(object, material);
      kinds.add(kind);
      if (!kind.endsWith("batch")) {
        visit(object, kind);
      }
    });
  } finally {
    portal.disconnect();
    root.remove();
  }
  return kinds;
}

describe("the hit test's draw order on every panel mesh", () => {
  // jsdom has no canvas to rasterize a run on and no rects for a `Range`.
  /** @type {Array<() => void>} */
  const restores = [];
  before(() => {
    restores.push(stubCanvas().restore, installRange());
  });
  after(() => {
    for (const restore of restores) {
      restore();
    }
  });

  test("a panel in paint order registers every mesh a ray can meet, at the order it draws", async () => {
    /** @type {string[]} */
    const misordered = [];
    const kinds = await walkEveryKind(true, (object, kind) => {
      // A ray meets the element's own mesh, never a batch's bucket, so that
      // mesh carries the order the hit test reads. A batched box is drawn by
      // its bucket, half a level after its own order. A box that draws
      // itself, a picture's, draws a quarter level after the order of its
      // element, and carries that in its own. Goes red with any kind left
      // unregistered, and with the picture's rung left out.
      const drawn =
        kind === "box"
          ? object.renderOrder + BOX_BUCKET_BIAS
          : kind === "picture"
            ? Math.floor(object.renderOrder) + UNBATCHED_BOX_BIAS
            : object.renderOrder;
      if (getObjectDrawOrder(object) !== drawn) {
        misordered.push(`${kind} at ${getObjectDrawOrder(object)}, drawn at ${drawn}`);
      }
    });
    assert.deepEqual(misordered, []);
    // A field's caret is a mark too, built only under the panel's own
    // focus; `portalKeyboard.test.js` holds it.
    // The batches are left out: a panel in paint order draws its boxes and
    // its runs in one (`paintBatch.js`).
    assert.deepEqual(
      [...kinds].filter((kind) => !kind.endsWith("batch")).sort(),
      ["box", "picture", "run", "shape", "tick"],
      "every kind was walked",
    );
  });

  test("a lifted panel registers none, and its picture draws at its element's order", async () => {
    // Such a panel keeps what it draws apart in depth, so the hit test takes
    // the nearest as it was found. A guard: what the option must not change.
    /** @type {string[]} */
    const registered = [];
    /** @type {number[]} */
    const pictures = [];
    await walkEveryKind(false, (object, kind) => {
      if (getObjectDrawOrder(object) !== -Infinity) {
        registered.push(kind);
      }
      if (kind === "picture") {
        pictures.push(object.renderOrder);
      }
    });
    assert.deepEqual(registered, []);
    assert.equal(pictures.length, 1);
    assert.ok(Number.isInteger(pictures[0]), `the picture at ${pictures[0]}`);
  });
});
