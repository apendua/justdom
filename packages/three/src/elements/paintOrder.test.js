/**
 * A panel drawn in paint order (`docs/freedom-paint-order.md`): the order
 * within a layer and between layers. Each test names the piece of the
 * mechanism it goes red without, or says it is a guard: a test of what
 * the page asks for that no one piece of the mechanism gives.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { batch } from "justdom-signal";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { clientRect } from "../test/clientRect.js";
import { settle } from "../test/portalHarness.js";
import { pagePanel } from "../test/pagePanel.js";
import { rayHand } from "../test/rayHand.js";
import { stubCanvas } from "../test/stubCanvas.js";
import { installRange } from "../test/textRange.js";
import "../test/layoutOffsets.js";
import { matrix3d } from "../test/matrix3d.js";
import {
  bandBase,
  getDrawLevel,
  getElevation,
  getLayer,
  getLayerBase,
  PIECE_BAND,
} from "./elevation.js";
import { isBlocker } from "./blocker.js";
import { halfPlanesOf } from "./halfPlanes.js";
import { getLayerOrder, isProxy, PANEL_PIECES } from "./layerOrder.js";
import { ARRAYS_PER_DRAW, PaintBatch } from "./paintBatch.js";
import { LayerTree } from "./layerTree.js";
import { createPortal } from "./portal.js";
import { buffers, drawn, draws, watchBatch } from "../test/batchBuffers.js";
import { rectGeometry } from "./sdfRect.js";

/**
 * @import { PageSpec, Rect } from "../test/pagePanel.js";
 * @import { XREventMap } from "../core.js";
 */

// No frame source, so a portal mounts synchronously, which is the path these
// tests follow. `portalHarness.js` installs one that waits for frames.
globalThis.requestAnimationFrame = /** @type {never} */ (undefined);
globalThis.cancelAnimationFrame = /** @type {never} */ (undefined);

/** What makes an element a ray target. */
const POINTER = "cursor: pointer";

/** A card laid on the board, opaque unless its style says otherwise. */
const CARD = `position: absolute; background: rgb(255, 255, 255); ${POINTER}`;

/**
 * Build the page under a 400 by 300 root, mirror it into a panel drawn in
 * paint order, and let a hand press it.
 *
 * @param {PageSpec[]} children
 * @param {object} [options]
 * @param {string} [options.rootStyle]
 * @param {boolean} [options.opaqueToRays] The panel option of that name.
 * @param {InteractionManager} [options.manager] Another page's, for a test
 *   with two panels in one hand's reach.
 */
async function page(children, { rootStyle = "", opaqueToRays = true, manager: shared } = {}) {
  const { root, manager, portal, scene, panel, get } = await pagePanel(children, {
    portal: { opaqueToRays },
    rootStyle,
    manager: shared,
  });
  const hand = rayHand(manager);

  /** @type {string[]} */
  const clicks = [];
  /** @param {Event} event */
  const hear = (event) => clicks.push(/** @type {Element} */ (event.target).id);
  document.addEventListener("click", hear, true);

  return {
    scene,
    panel,
    root,
    manager,
    get,
    /** Let the mirror flush what the page changed, as a frame's would. */
    settle: () => settle(portal),
    /**
     * One frame's walk of the panel's tree from a point in front of it, in
     * its px, as the portal's late frame runs it: the walk, the batches
     * flushing the orders it moved, and the cut.
     *
     * @param {number} [x]
     * @param {number} [y]
     * @param {number} [z] How far in front, as a local -z.
     * @returns {Promise<import("./layerOrder.js").LayerOrder>}
     */
    async walk(x = 200, y = 150, z = -2000) {
      const order = /** @type {import("./layerOrder.js").LayerOrder} */ (getLayerOrder(root));
      panel.updateWorldMatrix(true, true);
      const from = panel.localToWorld(new THREE.Vector3(x, y, z));
      order.walk(from);
      await settle(portal);
      order.cut();
      return order;
    },
    /**
     * Press at a point on the page, in px, and say which element was
     * clicked.
     *
     * @param {number} x
     * @param {number} y
     * @returns {string | undefined}
     */
    press(x, y) {
      clicks.length = 0;
      hand.aim(panel, x, y);
      hand.trigger("selectstart");
      hand.trigger("selectend");
      hand.frame();
      return clicks[0];
    },
    teardown() {
      document.removeEventListener("click", hear, true);
      hand.remove();
      portal.disconnect();
      root.remove();
    },
  };
}

/**
 * A plane the scene registers with the page's interaction manager, facing
 * the hand, over the panel's point at (`x`, `y`) and `toward` world units
 * towards the hand from the panel's plane.
 *
 * @param {{ panel: THREE.Object3D, scene: THREE.Object3D, manager: InteractionManager }} g
 * @param {number} x
 * @param {number} y
 * @param {number} toward
 * @param {number} [size] Its side, in world units.
 * @returns {THREE.Object3D<XREventMap>}
 */
function shield(g, x, y, toward, size = 1000) {
  g.panel.updateWorldMatrix(true, true);
  const point = g.panel.localToWorld(new THREE.Vector3(x, y, 0));
  const mesh = /** @type {THREE.Object3D<XREventMap>} */ (
    /** @type {unknown} */ (new THREE.Mesh(new THREE.PlaneGeometry(size, size)))
  );
  mesh.position.set(point.x, point.y, point.z + toward);
  g.scene.add(mesh);
  mesh.updateMatrixWorld(true);
  g.manager.add(mesh);
  return mesh;
}

/**
 * How far in front of the panel's plane, in world units, a ray from the
 * hand at (`x`, `y`), as `rayHand` aims it, first meets the panel.
 *
 * @param {{ panel: THREE.Object3D }} g
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function depthAt(g, x, y) {
  g.panel.updateWorldMatrix(true, true);
  const point = g.panel.localToWorld(new THREE.Vector3(x, y, 0));
  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(point.x, point.y, point.z + 1),
    new THREE.Vector3(0, 0, -1),
  );
  const [hit] = raycaster.intersectObject(g.panel, true);
  assert.ok(hit, `the ray meets the panel at ${x}, ${y}`);
  return 1 - hit.distance;
}

/**
 * The proxies drawing a panel's further pieces (`layerOrder.js`).
 *
 * @param {THREE.Object3D} panel
 * @returns {THREE.Mesh[]}
 */
function proxiesOf(panel) {
  /** @type {THREE.Mesh[]} */
  const found = [];
  panel.traverse((object) => {
    if (isProxy(object)) {
      found.push(/** @type {THREE.Mesh} */ (object));
    }
  });
  return found;
}

/**
 * What each instance of a draw is, by the sign of its `aSize.z`.
 *
 * @param {THREE.InstancedMesh} draw
 * @returns {string[]}
 */
function kinds(draw) {
  const size = /** @type {THREE.InstancedBufferAttribute} */ (draw.geometry.getAttribute("aSize"));
  return Array.from({ length: draw.count }, (_, i) => (size.getZ(i) < -0.5 ? "run" : "box"));
}

/**
 * The panel's depth quad: of what it draws, the one mesh that writes depth.
 *
 * @param {THREE.Object3D} panel
 * @returns {THREE.Mesh<THREE.BufferGeometry, THREE.Material>}
 */
function depthQuadOf(panel) {
  const writers = drawn(panel).filter(
    (mesh) => /** @type {THREE.Material} */ (mesh.material).depthWrite,
  );
  assert.equal(writers.length, 1, "one mesh writes depth");
  return /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.Material>} */ (writers[0]);
}

describe("a panel drawn in paint order", () => {
  test("writes depth with the root's quad alone, after everything else", async () => {
    // Goes red without `depthWrite` off on the boxes, batched or not.
    const g = await page([
      { id: "card", style: CARD, at: [20, 20, 100, 100] },
      {
        id: "lifted",
        style: `${CARD}; transform: ${matrix3d(["translateZ", 10])}`,
        at: [60, 60, 100, 100],
      },
    ]);
    const meshes = drawn(g.panel);
    const quad = depthQuadOf(g.panel);
    for (const mesh of meshes) {
      if (mesh !== quad) {
        assert.ok(
          mesh.renderOrder < quad.renderOrder,
          `a mesh at ${mesh.renderOrder} draws after the depth quad at ${quad.renderOrder}`,
        );
      }
    }
    g.teardown();
  });

  test("puts each box's quad in its object's plane", async () => {
    // A quad behind its object would be behind its parent's text, which the
    // hit test would then meet first though the box draws over it, and off
    // the plane the panel's walk cuts its layer at. Goes red with the quad
    // 1 px behind its object.
    const g = await page([
      {
        id: "card",
        style: CARD,
        at: [20, 20, 100, 100],
        children: [{ id: "inner", style: CARD, at: [30, 30, 50, 50] }],
      },
    ]);
    /** @type {number[]} */
    const depths = [];
    g.panel.traverse((object) => {
      if (
        object instanceof THREE.Mesh &&
        !(object instanceof THREE.InstancedMesh) &&
        object.geometry === rectGeometry
      ) {
        depths.push(object.position.z);
      }
    });
    assert.equal(depths.length, 2, "both cards' quads");
    assert.deepEqual(
      depths.filter((z) => z !== 0),
      [],
    );
    g.teardown();
  });

  test("climbs a level a card through a pile of opaque cards", async () => {
    // Goes red with an opaque card let off clearing what it covers: it
    // would keep its tree depth.
    const g = await page(
      [0, 1, 2, 3].map((i) => ({ id: `card${i}`, style: CARD, at: [i * 20, i * 20, 100, 100] })),
    );
    const levels = [0, 1, 2, 3].map((i) => getDrawLevel(g.get(`card${i}`)));
    for (let i = 1; i < levels.length; i += 1) {
      assert.ok(levels[i] > levels[i - 1] + 1, `card ${i} at ${levels[i]} after ${levels[i - 1]}`);
    }
    g.teardown();
  });

  test("puts a later card's text past an earlier card's box, and its press on top", async () => {
    // A guard for the press, which the nearest hit gives the top card too;
    // the levels go red with the opaque shortcut.
    const g = await page([
      { id: "under", style: CARD, at: [0, 0, 100, 100] },
      {
        id: "over",
        style: CARD,
        at: [50, 50, 100, 100],
        children: [{ id: "label", at: [55, 55, 40, 10] }],
      },
    ]);
    assert.ok(getDrawLevel(g.get("label")) > getDrawLevel(g.get("under")) + 1);
    assert.equal(g.press(75, 75), "over");
    g.teardown();
  });

  test("puts a later card over an earlier label's text shadow past its box", async () => {
    // The card is clear of the label's box and over its shadow, which is
    // ink: it draws after the label's run. Goes red with the label's
    // painted bounds its border box alone, which leaves the two on one
    // level and the shadow drawn in either order.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      {
        id: "label",
        style: "position: absolute; text-shadow: 8px 8px red",
        at: [20, 20, 60, 20],
        text: "x",
      },
      { id: "card", style: CARD, at: [84, 26, 40, 20] },
    ]);
    assert.ok(getDrawLevel(g.get("card")) > getDrawLevel(g.get("label")));
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("puts a later card over an earlier field's text shadow past its box", async () => {
    // A field's value is drawn as a run styled by the field, which has no
    // text child. Goes red with only a text child counted as text.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      {
        id: "field",
        tag: "input",
        style: "position: absolute; text-shadow: 8px 8px red",
        at: [20, 20, 60, 20],
      },
      { id: "card", style: CARD, at: [84, 26, 40, 20] },
    ]);
    /** @type {HTMLInputElement} */ (g.get("field")).value = "x";
    await g.walk();
    assert.ok(getDrawLevel(g.get("card")) > getDrawLevel(g.get("field")));
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("counts a label's text shadow once its text is filled in", async () => {
    // The label's text starts blank and is written through the text node
    // later, as a framework does. Goes red with the text read once, at
    // the first measure.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      {
        id: "label",
        style: "position: absolute; text-shadow: 8px 8px red",
        at: [20, 20, 60, 20],
        text: " ",
      },
      { id: "card", style: CARD, at: [84, 26, 40, 20] },
    ]);
    const label = g.get("label");
    assert.equal(getDrawLevel(g.get("card")), getDrawLevel(label), "no shadow while blank");
    /** @type {Text} */ (label.firstChild).data = "x";
    await g.walk();
    assert.ok(getDrawLevel(g.get("card")) > getDrawLevel(label));
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("leaves a label without text of its own at its box, a guard", async () => {
    // `text-shadow` is inherited, and inked only where there are glyphs: a
    // wrapper whose text is its child's casts no shadow of its own.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      {
        id: "wrapper",
        style: "position: absolute; text-shadow: 8px 8px red",
        at: [20, 20, 60, 20],
        children: [{ id: "inner", at: [20, 20, 60, 20], text: "x" }],
      },
      { id: "card", style: CARD, at: [84, 26, 40, 20] },
    ]);
    assert.equal(getDrawLevel(g.get("card")), getDrawLevel(g.get("wrapper")));
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("keeps a row of a list at the list's levels however long it is, a guard", async () => {
    // Goes red if a row's level counts its earlier siblings, which only a
    // positioned or transformed sibling may make it do.
    /** @param {number} rows */
    const levels = async (rows) => {
      const g = await page(
        Array.from({ length: rows }, (_, i) => ({
          id: `row${i}`,
          style: "background: rgb(240, 240, 240)",
          at: /** @type {Rect} */ ([0, i * 20, 400, 20]),
        })),
      );
      const found = new Set(Array.from({ length: rows }, (_, i) => getDrawLevel(g.get(`row${i}`))));
      const draws = drawn(g.panel).length;
      g.teardown();
      return { levels: found.size, draws };
    };
    assert.deepEqual(await levels(50), await levels(1));
  });

  for (const [what, background] of /** @type {const} */ ([
    ["an opaque", "rgb(255, 255, 255)"],
    ["a translucent", "rgba(255, 255, 255, 0.6)"],
    ["no", "transparent"],
  ])) {
    test(`draws an earlier sibling lifted by translateZ over a later one, with ${what} background`, async () => {
      // The lifted card is a layer of its own, in the band past the root's,
      // and takes the press where it covers the later card. The press is a
      // guard: with no background, it goes red if a layer's box that paints
      // nothing leaves the raycast.
      const g = await page([
        {
          id: "lifted",
          style: `position: absolute; background: ${background}; ${POINTER}; transform: ${matrix3d(["translateZ", 10])}; transform-origin: 50px 50px 0px`,
          at: [0, 0, 100, 100],
        },
        { id: "later", style: CARD, at: [50, 50, 100, 100] },
      ]);
      const lifted = g.get("lifted");
      assert.equal(getLayer(lifted), lifted);
      assert.ok(getElevation(lifted) > getElevation(g.get("later")));
      assert.equal(g.press(75, 75), "lifted");
      g.teardown();
    });
  }

  test("lets a press past a scroller's clip through a lifted card to the footer, a guard", async () => {
    // A card lifted out of a clipped scroller hangs below its clip, over a
    // footer button. The part past the clip is not drawn and takes no
    // press, so the footer does. A guard: goes red with the card's ray
    // target untrimmed by its clip.
    const g = await page([
      {
        id: "scroller",
        style: "position: absolute; overflow: hidden",
        at: [0, 0, 400, 150],
        children: [
          {
            id: "card",
            style: `${CARD}; transform: ${matrix3d(["translateZ", 10])}`,
            at: [50, 100, 100, 100],
          },
        ],
      },
      { id: "footer", style: CARD, at: [50, 160, 100, 40] },
    ]);
    await g.walk();
    assert.equal(g.press(100, 120), "card", "inside the clip");
    assert.equal(g.press(100, 180), "footer", "past it");
    g.teardown();
  });

  test("lets a scene mesh in front of the panel take the press, a guard", async () => {
    // A plane the scene registers, between the hand and a button: the ray
    // meets it first, and the button hears nothing. A guard: goes red with
    // the nearest hit not the one taken.
    const g = await page([{ id: "button", style: CARD, at: [100, 100, 100, 100] }]);
    await g.walk();
    const mesh = shield(g, 150, 150, 0.5);
    let pressed = 0;
    mesh.addEventListener("select", () => {
      pressed += 1;
    });
    assert.equal(g.press(150, 150), undefined, "not the button");
    assert.equal(pressed, 1, "the scene's mesh");
    g.manager.remove(mesh);
    mesh.removeFromParent();
    g.teardown();
  });

  test("puts a scene mesh between a lifted overlay and the root, a guard", async () => {
    // The overlay floats clear of the root, and a scene plane sits between
    // the two: the overlay's button, in front of the plane, takes its press,
    // and the root's button, behind it, is hidden. A guard: goes red with
    // the nearest hit not the one taken.
    const g = await page([
      { id: "under", style: CARD, at: [20, 20, 100, 100] },
      {
        id: "overlay",
        style: "position: absolute; z-index: 1; background: rgba(255, 255, 255, 0.6)",
        at: [150, 20, 200, 200],
        children: [{ id: "over", style: CARD, at: [170, 40, 60, 60] }],
      },
    ]);
    await g.walk();
    // Halfway between the root's plane and the overlay's, by where the ray
    // meets each.
    const root = depthAt(g, 70, 70);
    const overlay = depthAt(g, 200, 70);
    assert.ok(overlay > root, `the overlay at ${overlay}, the root at ${root}`);
    const mesh = shield(g, 70, 70, (root + overlay) / 2, 10);
    assert.equal(g.press(200, 70), "over", "the overlay's button, in front");
    assert.equal(g.press(70, 70), undefined, "the root's, hidden");
    g.manager.remove(mesh);
    mesh.removeFromParent();
    g.teardown();
  });

  test("gives a press on an overlay wrapper that paints nothing to the wrapper, a guard", async () => {
    // A fixed wrapper over the whole panel, a layer of its own with no
    // background, over a button in the root: the press is the wrapper's,
    // as a page's is. A guard.
    const g = await page([
      { id: "button", style: CARD, at: [100, 100, 100, 100] },
      {
        id: "wrapper",
        style: `position: fixed; z-index: 10; ${POINTER}`,
        at: [0, 0, 400, 300],
      },
    ]);
    await g.walk();
    assert.equal(g.press(150, 150), "wrapper");
    g.teardown();
  });

  test("gives a press through a panel that takes no rays to the panel behind, a guard", async () => {
    // Two panels in one hand's reach, the nearer one transparent to rays
    // but for its one button: a press on the button is the button's, and
    // one beside it the farther panel's row's. A guard: goes red with the
    // nearest hit not the one taken.
    const far = await page([{ id: "row", style: CARD, at: [0, 0, 400, 300] }]);
    const near = await page([{ id: "button", style: CARD, at: [100, 100, 100, 100] }], {
      opaqueToRays: false,
      manager: far.manager,
    });
    near.scene.position.z = 0.5;
    near.scene.updateMatrixWorld(true);
    await far.walk();
    await near.walk();
    assert.equal(near.press(150, 150), "button", "on the button");
    assert.equal(near.press(300, 250), "row", "beside it");
    near.teardown();
    far.teardown();
  });

  test("takes a card's press at its rounded corner, by its box's rectangle, a guard", async () => {
    const g = await page([
      { id: "card", style: `${CARD}; border-radius: 40px`, at: [20, 20, 100, 100] },
    ]);
    assert.equal(g.press(22, 22), "card");
    g.teardown();
  });

  test("paints a rotated card's cleared siblings before it", async () => {
    // Goes red with the opaque shortcut: the rotated card is opaque.
    const g = await page([
      { id: "under", style: CARD, at: [0, 0, 100, 100] },
      { id: "rotated", style: `${CARD}; transform: rotate(10deg)`, at: [40, 40, 100, 100] },
    ]);
    assert.ok(getDrawLevel(g.get("rotated")) > getDrawLevel(g.get("under")) + 1);
    g.teardown();
  });

  test("draws two layers lifted to one plane in paint order", async () => {
    // Two sibling layers in one plane share a node of the tree, and the walk
    // draws the later one after the whole of the earlier. Goes red without
    // the walk: both would start where their depth puts them, together.
    const lift = `transform: ${matrix3d(["translateZ", 10])}; transform-origin: 50px 50px 0px`;
    const g = await page([
      {
        id: "first",
        style: `${CARD}; ${lift}`,
        at: [0, 0, 100, 100],
        children: [{ id: "label", at: [5, 5, 40, 10] }],
      },
      { id: "second", style: `${CARD}; ${lift}`, at: [50, 50, 100, 100] },
    ]);
    await g.walk();
    const first = g.get("first");
    const second = g.get("second");
    assert.ok(
      getLayerBase(second) >= getLayerBase(first) + PIECE_BAND,
      `${getLayerBase(second)} after ${getLayerBase(first)}`,
    );
    assert.equal(g.press(75, 75), "second");
    g.teardown();
  });

  test("cuts a card swung about its centre at its parent's plane", async () => {
    // Two pieces: the half behind the root's plane drawn before the root,
    // the half in front after it, each cut by the one plane from the other
    // side, so the seam has no gap and no doubled pixel. A press beside the
    // pivot goes to what is drawn there: the root over the half behind it,
    // the card on the half in front. Goes red without the tree's cut, the
    // proxy for the second piece, or the half-planes it writes.
    const g = await page(
      [
        {
          id: "card",
          style: `${CARD}; transform: ${matrix3d(["rotateY", 30])}; transform-origin: 50px 50px 0px`,
          at: [100, 100, 100, 100],
        },
      ],
      { rootStyle: "background: rgb(200, 200, 200)" },
    );
    const order = await g.walk();
    const card = g.get("card");
    const layers = order.pieces().map((piece) => piece.layer);
    assert.deepEqual(layers, [card, g.root, card]);
    const [back, , front] = order.pieces();
    assert.equal(back.halfPlanes.length, 1);
    assert.equal(front.halfPlanes[0], back.halfPlanes[0], "one plane");
    assert.deepEqual([back.sides[0], front.sides[0]].sort(), [-1, 1], "from either side");

    // The card's box, in its draw, and the copy of it for the front piece.
    const cut = drawn(g.panel).filter((mesh) => {
      const uniforms = halfPlanesOf(/** @type {THREE.Material} */ (mesh.material));
      return uniforms && uniforms.uHalfPlaneCount.value > 0;
    });
    assert.equal(cut.length, 2, "the card's box, drawn twice");
    const rootBase = getLayerBase(g.root);
    const [first, second] = cut.map((mesh) => mesh.renderOrder).sort((a, b) => a - b);
    assert.ok(first < rootBase && second > rootBase, `${first} and ${second} about ${rootBase}`);

    // The card's left half swings toward the viewer, its right half away.
    assert.equal(g.press(130, 150), "card", "left of the pivot, in front");
    assert.equal(g.press(170, 150), "root", "right of the pivot, behind the root");
    g.teardown();
  });

  for (const reported of [false, true]) {
    test(`leaves a layer gone from the page out until the mirror hears, ${reported ? "with another layer reported" : "with nothing else changed"}`, async () => {
      // A menu, an overlay layer of its own, is taken off the page and the
      // next frame's walk runs before the mirror has flushed the removal, as
      // it can on a headset that draws frames faster than the mirror's
      // budget clears them. Goes red with the gone layer in the tree: drawn
      // where it was on a frame that only walks, and on one that rebuilds
      // because the flush reported another layer, sorted among the rest,
      // whose climb to a common ancestor reads `contains` of a null parent.
      const g = await page([
        {
          id: "under",
          style: "position: absolute; z-index: 1; background: white",
          at: [20, 20, 200, 100],
        },
        {
          id: "menu",
          style: "position: absolute; z-index: 2; background: white",
          at: [60, 60, 200, 100],
        },
        // Above the menu, so that a base past the rest is not the one it had.
        {
          id: "top",
          style: "position: absolute; z-index: 3; background: white",
          at: [100, 100, 200, 100],
        },
      ]);
      const order = await g.walk();
      const menu = g.get("menu");
      assert.ok(
        order.pieces().some((piece) => piece.layer === menu),
        "the menu is a layer",
      );
      const base = getLayerBase(menu);
      menu.remove();
      if (reported) {
        order.addLayer(g.get("under"));
      }
      g.panel.updateWorldMatrix(true, true);
      order.walk(g.panel.localToWorld(new THREE.Vector3(200, 150, -2000)));
      assert.ok(
        order.pieces().every((piece) => piece.layer !== menu),
        "nothing drawn for the gone menu",
      );
      assert.equal(getLayerBase(menu), base, "the menu keeps its base, not one past the rest");
      g.teardown();
    });
  }

  test("cuts a card swung inside a translucent overlay at the overlay's plane", async () => {
    // The overlay floats clear of the root, and the card swung about its
    // centre inside it crosses its plane: the back piece draws before the
    // overlay's box, which tints it, and the front piece after. Goes red
    // with the overlay drawn in the root's layer rather than one of its own.
    const g = await page([
      {
        id: "overlay",
        style: "position: absolute; z-index: 1; background: rgba(255, 255, 255, 0.6)",
        at: [50, 50, 300, 200],
        children: [
          {
            id: "card",
            style: `${CARD}; transform: ${matrix3d(["rotateY", 30])}; transform-origin: 50px 50px 0px`,
            at: [100, 100, 100, 100],
          },
        ],
      },
    ]);
    const order = await g.walk();
    const overlay = g.get("overlay");
    const card = g.get("card");
    const layers = order.pieces().map((piece) => piece.layer);
    const back = layers.indexOf(card);
    assert.deepEqual(
      [back, layers.lastIndexOf(card)].map((i) => i > layers.indexOf(overlay)),
      [false, true],
      `${order.pieces().map((piece) => /** @type {Element} */ (piece.layer).id)}`,
    );
    const [first, second] = order.pieces().filter((piece) => piece.layer === card);
    assert.equal(first.halfPlanes.length, 1);
    assert.equal(second.halfPlanes[0], first.halfPlanes[0], "one plane, from either side");
    g.teardown();
  });

  test("builds its tree once for a panel that moves in the world", async () => {
    // The layers' planes are read in the panel's frame from the local
    // matrices between them and the container, which do not change while
    // only the panel moves. Goes red with them read through the world
    // matrices, whose product differs by rounding from frame to frame.
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform: ${matrix3d(["rotateY", 30])}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
      },
    ]);
    await g.walk();
    const build = LayerTree.prototype.build;
    let builds = 0;
    LayerTree.prototype.build = function () {
      builds += 1;
      build.call(this);
    };
    try {
      for (let i = 0; i < 20; i += 1) {
        g.scene.rotation.y += 0.01;
        g.scene.position.x += 0.37;
        g.scene.updateMatrixWorld(true);
        await g.walk();
      }
    } finally {
      LayerTree.prototype.build = build;
    }
    assert.equal(builds, 0);
    g.teardown();
  });

  test("cuts a run that draws itself in a swung card, as it cuts its box", async () => {
    // A shadowed run is a mesh of its own with a patched material, and the
    // proxy for its second piece gets half-planes of its own the frame it
    // is made. Goes red with the proxy left to get them at its first
    // compile: the walk throws.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform: ${matrix3d(["rotateY", 30])}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
        children: [
          {
            id: "shadowed",
            style: "text-shadow: 1px 1px red",
            at: [110, 110, 80, 20],
            text: "x",
          },
        ],
      },
    ]);
    await g.walk();
    const cut = drawn(g.panel).filter((mesh) => {
      if (mesh instanceof THREE.InstancedMesh) {
        return false;
      }
      const uniforms = halfPlanesOf(/** @type {THREE.Material} */ (mesh.material));
      return uniforms && uniforms.uHalfPlaneCount.value > 0;
    });
    assert.equal(cut.length, 2, "the run, drawn twice");
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("cuts the boxes a walk from the other side moves to a new draw", async () => {
    // A lifted card is drawn before the swung one from behind the panel
    // and after it from in front, so the swung card's first piece changes
    // place, and its box goes to a draw at the new base when the batches
    // flush. Goes red with the cut before the flush: it looks for the box
    // in the old draws, finds nothing at the new base, and cuts nothing.
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform: ${matrix3d(["rotateY", 30])}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
      },
      {
        id: "lifted",
        style: `${CARD}; transform: ${matrix3d(["translateZ", 40])}`,
        at: [250, 100, 50, 50],
      },
    ]);
    const card = g.get("card");
    /** @param {import("./layerOrder.js").LayerOrder} order */
    const cutBoxes = (order) => {
      assert.equal(order.pieces().filter((piece) => piece.layer === card).length, 2);
      return drawn(g.panel).filter((mesh) => {
        const uniforms = halfPlanesOf(/** @type {THREE.Material} */ (mesh.material));
        return uniforms && uniforms.uHalfPlaneCount.value > 0;
      }).length;
    };
    assert.equal(cutBoxes(await g.walk()), 2);
    const base = getLayerBase(card);
    assert.equal(cutBoxes(await g.walk(200, 150, 2000)), 2);
    assert.notEqual(getLayerBase(card), base, "the swung card's first piece moved");
    g.teardown();
  });

  test("cuts a swung card's draw the frame it grows", async () => {
    // A draw grows into a new mesh with the same material, so the old
    // mesh leaves the cut the frame the new one joins it. Goes red with the
    // old mesh's material cleared on its way out: it is the new mesh's, and
    // the card's first piece draws whole for a frame.
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform: ${matrix3d(["rotateY", 30])}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
        children: Array.from({ length: 15 }, (_, i) => ({
          id: `box${i}`,
          style: "position: absolute; background: rgb(0, 0, 255)",
          at: /** @type {Rect} */ ([105 + (i % 5) * 18, 105 + Math.floor(i / 5) * 18, 10, 10]),
        })),
      },
    ]);
    const card = g.get("card");
    /** The planes of the card's draws at its first piece's band. */
    const planes = () => {
      const base = getLayerBase(card);
      return drawn(g.panel)
        .filter(
          (mesh) =>
            mesh instanceof THREE.InstancedMesh &&
            Math.floor(mesh.renderOrder / PIECE_BAND) * PIECE_BAND === base,
        )
        .map((mesh) => {
          const uniforms = halfPlanesOf(/** @type {THREE.Material} */ (mesh.material));
          return uniforms?.uHalfPlaneCount.value;
        });
    };
    await g.walk();
    assert.ok(planes().length > 0);
    assert.ok(
      planes().every((count) => count === 1),
      `${planes()}`,
    );
    // Two more rows, beside the others and so at their level.
    for (let i = 15; i < 25; i += 1) {
      const box = document.createElement("div");
      box.style.cssText = "position: absolute; background: rgb(0, 0, 255)";
      const [x, y] = [105 + (i % 5) * 18, 105 + Math.floor(i / 5) * 18];
      box.getBoundingClientRect = () => clientRect(x, y, 10, 10);
      card.appendChild(box);
    }
    await g.walk();
    assert.ok(
      planes().every((count) => count === 1),
      `${planes()}`,
    );
    g.teardown();
  });

  test("draws a cut layer whole past the panel's last place", async () => {
    // The pieces past the slot share one place and so one band, and the
    // cut finds a layer's meshes by band: cutting a layer there would cut
    // every other layer's boxes in the band with it. Goes red with the
    // layer cut anyway.
    /** @type {PageSpec[]} */
    const far = Array.from({ length: 260 }, (_, i) => ({
      id: `far${i}`,
      style: `${CARD}; transform: ${matrix3d(["translateZ", -100])}`,
      at: [(i % 20) * 20, Math.floor(i / 20) * 20, 10, 10],
    }));
    const g = await page([
      ...far,
      {
        id: "card",
        style: `${CARD}; transform: ${matrix3d(["rotateY", 30])}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
      },
    ]);
    const order = await g.walk();
    const card = g.get("card");
    const places = order.pieces().flatMap((piece, i) => (piece.layer === card ? [i] : []));
    assert.ok(places[0] >= 254, `the card's first piece at ${places[0]}`);
    const cut = drawn(g.panel).filter((mesh) => {
      const uniforms = halfPlanesOf(/** @type {THREE.Material} */ (mesh.material));
      return uniforms && uniforms.uHalfPlaneCount.value > 0;
    });
    assert.equal(cut.length, 0, "nothing cut");
    g.teardown();
  });

  test("copies the draw of a swung card with a label for its further piece", async () => {
    // A swung card is cut in two, and its further piece drawn by a copy of
    // the batch's draw. With a run in the draw, the first of its array
    // slots holds a texture and the rest none, which three's deep copy of a
    // material's uniforms clones slot by slot. Goes red with the proxy's
    // material made by `clone`, which throws on the first empty slot.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform: ${matrix3d(["rotateY", 30])}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
        text: "x",
      },
    ]);
    await g.walk();
    await g.walk();
    const found = proxiesOf(g.panel);
    let batched = 0;
    for (const proxy of found) {
      const own = /** @type {THREE.ShaderMaterial} */ (proxy.material);
      const source = /** @type {THREE.ShaderMaterial} */ (
        /** @type {THREE.Mesh} */ (proxy.parent).material
      );
      if (source.isShaderMaterial) {
        batched += 1;
        assert.equal(own.uniforms.uRuns, source.uniforms.uRuns, "the runs' arrays shared");
        assert.notEqual(own.uniforms.uHalfPlanes, source.uniforms.uHalfPlanes, "its own planes");
      }
    }
    assert.ok(batched > 0, "a proxy of the batch's draw");
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  /**
   * Every mesh of `panel` that draws colour, short of the batch's draws and
   * the proxies, with its order.
   *
   * @param {THREE.Object3D} panel
   * @returns {Map<THREE.Mesh, number>}
   */
  const colourMeshes = (panel) => {
    /** @type {Map<THREE.Mesh, number>} */
    const orders = new Map();
    panel.traverse((object) => {
      const mesh = /** @type {THREE.Mesh} */ (object);
      if (
        mesh.isMesh &&
        !(mesh instanceof THREE.InstancedMesh) &&
        !isProxy(mesh) &&
        /** @type {THREE.Material} */ (mesh.material).colorWrite !== false
      ) {
        orders.set(mesh, mesh.renderOrder);
      }
    });
    return orders;
  };

  test("moves a panel's meshes to its new place among the panels in the walk that moves it", async () => {
    // The panel is sorted behind another as the viewer moves, which moves
    // every layer's base by a slot, and the batch and the cut read the
    // meshes' orders in that frame, before the mirror's next frame runs the
    // effects that give each mesh its layer's base; `batch` holds them as
    // the frame does. Goes red with the meshes left in the old bases, which
    // on a headset lays the swung card's pieces and the sibling over its
    // near half in one draw, in the old place, for a frame; and with a mesh
    // moved anywhere but a slot on, at its own level.
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform: ${matrix3d(["rotateY", -30])}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
      },
      { id: "sibling", style: CARD, at: [80, 120, 60, 60] },
    ]);
    const order = await g.walk();
    await g.walk();
    g.panel.updateWorldMatrix(true, true);
    const from = g.panel.localToWorld(new THREE.Vector3(200, 150, -2000));
    const before = colourMeshes(g.panel);
    assert.ok(before.size > 1, "the root's box and the card's");
    /** @type {Map<THREE.Mesh, number>} */
    let after = new Map();
    batch(() => {
      order.setSlot(1);
      order.walk(from);
      after = colourMeshes(g.panel);
    });
    const slot = PANEL_PIECES * PIECE_BAND;
    for (const [mesh, renderOrder] of before) {
      assert.equal(after.get(mesh), renderOrder + slot, "a slot on, at its level");
    }
    g.teardown();
  });

  test("moves a card that becomes a layer into the panel's slot in the walk that places it", async () => {
    // A card that rises under the ray becomes a layer of its own, and the
    // mirror gives its meshes their order before any walk has placed it:
    // its layer's base falls back to its elevation's band, which in any
    // slot past the first is below the panel's slot, so the board draws
    // its own background over the card. The walk that first places the
    // layer runs inside `batch`, as the headset's frame holds the effects
    // that would follow it. Goes red with the new layer's meshes left in
    // the fallback band, which on a headset hides the card from its first
    // hover until the effects run, up to half a second under a held
    // commit; and with them moved anywhere but the layer's band, at their
    // own level.
    const g = await page([
      {
        id: "card",
        style: CARD,
        at: [100, 100, 100, 100],
        // Content above the card's own box, at a level of its own.
        children: [{ id: "stripe", style: CARD, at: [110, 110, 80, 20] }],
      },
      { id: "sibling", style: CARD, at: [240, 100, 100, 100] },
    ]);
    const order = await g.walk();
    // A slot past the first, where no layer's fallback band can land.
    order.setSlot(1);
    await g.walk();
    const card = g.get("card");
    card.style.transform = matrix3d(["translateZ", 8]);
    // The mirror's flush: the card is a layer, its meshes ordered from
    // the base it falls back to.
    await g.settle();
    const before = colourMeshes(g.panel);
    g.panel.updateWorldMatrix(true, true);
    const from = g.panel.localToWorld(new THREE.Vector3(200, 150, -2000));
    /** @type {Map<THREE.Mesh, number>} */
    let after = new Map();
    batch(() => {
      order.walk(from);
      after = colourMeshes(g.panel);
    });
    const slot = PANEL_PIECES * PIECE_BAND;
    const base = getLayerBase(card);
    assert.ok(base >= slot, `the card's layer placed in the slot, at ${base}`);
    let moved = 0;
    /** @type {Set<number>} */
    const levels = new Set();
    for (const [mesh, renderOrder] of after) {
      assert.ok(renderOrder >= slot, `a mesh in the panel's slot, at ${renderOrder}`);
      const was = /** @type {number} */ (before.get(mesh));
      if (was < slot) {
        levels.add(was % PIECE_BAND);
        assert.equal(renderOrder, base + (was % PIECE_BAND), "in the card's band, at its level");
        moved += 1;
      } else {
        assert.equal(renderOrder, was, "a mesh in the slot already keeps its order");
      }
    }
    assert.ok(moved > 1, "the card's meshes were in the fallback band");
    assert.ok(levels.size > 1, "at levels of their own");
    g.teardown();
  });

  test("moves a layer the page puts back off the base it kept, in the walk that places it", async () => {
    // A layer the page takes out keeps the base it had, and one put back
    // starts from it: the mirror orders its meshes from that base before
    // the walk places the layer again. The panel moves a slot while the
    // layer is out, so the kept base is in the slot before. Goes red with
    // the layer's meshes left there for the frame, behind the depth quad
    // of the panel's new slot.
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform: ${matrix3d(["translateZ", 8])}`,
        at: [100, 100, 100, 100],
        children: [{ id: "stripe", style: CARD, at: [110, 110, 80, 20] }],
      },
    ]);
    const order = await g.walk();
    order.setSlot(1);
    await g.walk();
    const card = g.get("card");
    const parent = /** @type {Element} */ (card.parentElement);
    card.remove();
    await g.settle();
    await g.walk();
    order.setSlot(2);
    await g.walk();
    parent.append(card);
    await g.settle();
    const before = colourMeshes(g.panel);
    g.panel.updateWorldMatrix(true, true);
    const from = g.panel.localToWorld(new THREE.Vector3(200, 150, -2000));
    /** @type {Map<THREE.Mesh, number>} */
    let after = new Map();
    batch(() => {
      order.walk(from);
      after = colourMeshes(g.panel);
    });
    const slot = PANEL_PIECES * PIECE_BAND;
    const base = getLayerBase(card);
    assert.ok(base >= 2 * slot, `the card's layer placed in the new slot, at ${base}`);
    let moved = 0;
    for (const [mesh, renderOrder] of after) {
      assert.ok(renderOrder >= 2 * slot, `a mesh in the panel's new slot, at ${renderOrder}`);
      const was = /** @type {number} */ (before.get(mesh));
      if (was < 2 * slot) {
        assert.equal(renderOrder, base + (was % PIECE_BAND), "in the card's band, at its level");
        moved += 1;
      }
    }
    assert.ok(moved > 1, "the card's meshes were at the base it kept");
    g.teardown();
  });

  test("lays a panel with no cut layer out again in the walk that moves it", async () => {
    // As above, on a panel nothing cuts, so no cut base moves to ask the
    // batch for its draws again, and the meshes' effects, which would, wait
    // for the next frame. Goes red with the walk not asking: the draws stay
    // in the old slot for a frame, behind the depth quad in the new one.
    const g = await page([
      { id: "back", style: CARD, at: [40, 40, 200, 150] },
      { id: "front", style: `${CARD}; position: absolute; z-index: 1`, at: [100, 100, 200, 150] },
    ]);
    const order = await g.walk();
    await g.walk();
    g.panel.updateWorldMatrix(true, true);
    const from = g.panel.localToWorld(new THREE.Vector3(200, 150, -2000));
    const invalidate = PaintBatch.prototype.invalidate;
    let asked = 0;
    PaintBatch.prototype.invalidate = function () {
      asked += 1;
      return invalidate.call(this);
    };
    try {
      batch(() => {
        order.setSlot(1);
        order.walk(from);
        assert.ok(asked > 0, "the batch asked to lay its draws again");
      });
    } finally {
      PaintBatch.prototype.invalidate = invalidate;
    }
    await g.walk();
    const slot = PANEL_PIECES * PIECE_BAND;
    for (const draw of draws(g.panel)) {
      assert.ok(draw.renderOrder >= slot, `a draw in the new slot, ${draw.renderOrder}`);
    }
    g.teardown();
  });

  test("orders a box the page restyles from its layer's base, past the panel's first slot", async () => {
    // The walk that moves a base gives each mesh its order itself, so only
    // an effect that runs after that walk reads the band `VisualProperties`
    // gives a box. Goes red with that band at 0, or at a band counted from
    // the element's elevation alone: either puts the restyled
    // card's box back in the first slot, behind the depth quad of the
    // panel's own.
    const g = await page([{ id: "card", style: CARD, at: [20, 20, 100, 100] }]);
    const order = await g.walk();
    order.setSlot(1);
    await g.walk();
    // The card's look changes, which runs the effect that orders its box.
    g.get("card").style.background = "rgb(0, 0, 255)";
    await g.settle();
    const base = getLayerBase(g.root);
    assert.ok(
      base >= PANEL_PIECES * PIECE_BAND,
      `the root's layer in the panel's slot, at ${base}`,
    );
    const meshes = colourMeshes(g.panel);
    assert.ok(meshes.size > 0, "the card's box");
    for (const [, renderOrder] of meshes) {
      assert.equal(bandBase(renderOrder), base, `the box in the root's band, at ${renderOrder}`);
    }
    g.teardown();
  });

  test("stretches its depth quad over the root, in the root's plane", async () => {
    // Goes red with the quad left at its unit size, which hides nothing
    // drawn after the panel but a pixel at its corner.
    const g = await page([{ id: "card", style: CARD, at: [20, 20, 100, 100] }]);
    const quad = depthQuadOf(g.panel);
    assert.deepEqual(quad.position.toArray(), [200, 150, 0]);
    assert.deepEqual(quad.scale.toArray(), [400, 300, 1]);
    g.teardown();
  });

  test("gives each panel a depth quad with a material of its own, and disposes it", async () => {
    // Something that changes the materials under one panel, as the frame
    // meter's readout turns its depth test off to draw on top, changes no
    // other panel's. Goes red with one material shared among the panels'
    // quads, where turning one's test off turned off every panel's and let
    // what passes behind a panel draw over it.
    const first = await page([{ id: "a", style: CARD, at: [20, 20, 100, 100] }]);
    const second = await page([{ id: "b", style: CARD, at: [20, 20, 100, 100] }]);
    const mine = depthQuadOf(first.panel);
    const theirs = depthQuadOf(second.panel);
    assert.notEqual(mine.material, theirs.material, "a material each");
    mine.material.depthTest = false;
    assert.equal(theirs.material.depthTest, true, "the other panel's quad keeps its test");
    let disposed = false;
    mine.material.addEventListener("dispose", () => {
      disposed = true;
    });
    first.teardown();
    assert.ok(disposed, "the panel disposes its quad's material");
    second.teardown();
  });

  test("takes a flipping card's proxy back from the pool on its next flip", async () => {
    // A card flips about its centre from flat to 30 degrees, a step a frame,
    // back to flat, and again. It is cut from the first step on, with one
    // proxy for its front piece, which the frames of a flip keep and the
    // flat card gives back. Goes red with a proxy made at each cut.
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
      },
    ]);
    const card = g.get("card");
    /** @param {number} angle */
    const turn = async (angle) => {
      // The bench's layout stand-in keeps a snapshot of each element's
      // computed style, which a style that moves has to drop.
      card.style.transform = angle ? matrix3d(["rotateY", angle]) : "";
      await g.walk();
      await g.walk();
      return proxiesOf(g.panel);
    };
    /** @type {Set<THREE.Object3D>} */
    const first = new Set();
    for (const angle of [5, 10, 20, 30]) {
      for (const proxy of await turn(angle)) {
        first.add(proxy);
      }
    }
    assert.equal(first.size, 1, "one proxy across the flip");
    assert.deepEqual(await turn(0), [], "none on the flat card");
    for (const angle of [5, 10, 20, 30]) {
      assert.deepEqual(await turn(angle), [...first], `the first flip's at ${angle} degrees`);
    }
    g.teardown();
  });

  test("places a proxy taken from the pool where its mesh is", async () => {
    // The card flips, goes flat and gives its proxy back, the panel moves
    // while the proxy waits, and the card flips again. The app keeps the
    // panel's matrix itself, so a frame's update forces matrices down only
    // from what moved in it, and has to bring the proxy to its new mesh.
    // Goes red with the proxy left where it was when it was given back.
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
      },
    ]);
    g.panel.matrixAutoUpdate = false;
    const card = g.get("card");
    /** @param {number} angle */
    const turn = async (angle) => {
      card.style.transform = angle ? matrix3d(["rotateY", angle]) : "";
      // The cut follows the walk that finds the new tree.
      await g.walk();
      await g.walk();
      g.panel.updateMatrixWorld();
    };
    await turn(30);
    await turn(0);
    g.panel.position.x += 0.5;
    g.panel.updateMatrix();
    g.panel.updateMatrixWorld();
    await turn(30);
    const found = proxiesOf(g.panel);
    assert.equal(found.length, 1, "the card's one proxy");
    const [proxy] = found;
    const mesh = /** @type {THREE.Object3D} */ (proxy.parent);
    const expected = mesh.matrixWorld.clone().multiply(proxy.matrix);
    assert.ok(proxy.matrixWorld.equals(expected), "the proxy's world is its mesh's");
    g.teardown();
  });

  test("lets a spare proxy hold nothing, and go with its material", async () => {
    // The card flips and goes flat, which gives its proxy back. Goes red
    // with the spare still holding its mesh's geometry, or kept once the
    // material it was copied from is disposed.
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
      },
    ]);
    const card = g.get("card");
    /** @param {number} angle */
    const turn = async (angle) => {
      card.style.transform = angle ? matrix3d(["rotateY", angle]) : "";
      await g.walk();
      await g.walk();
    };
    await turn(30);
    const found = proxiesOf(g.panel);
    assert.equal(found.length, 1, "the card's one proxy");
    const [proxy] = found;
    const mesh = /** @type {THREE.Mesh} */ (proxy.parent);
    let disposed = false;
    /** @type {THREE.Material} */ (proxy.material).addEventListener("dispose", () => {
      disposed = true;
    });
    await turn(0);
    assert.equal(proxy.parent, null, "given back");
    assert.notEqual(proxy.geometry, mesh.geometry, "the mesh's geometry let go");
    // What the renderer hears when a material is disposed.
    /** @type {THREE.Material} */ (mesh.material).dispatchEvent({ type: "dispose" });
    assert.ok(disposed, "the spare's material disposed with its source");
    g.teardown();
  });

  test("disposes a proxy given back after its material was", async () => {
    // An element's own material goes when the element leaves the page, a
    // flush before the cut gives its proxies back. Goes red with the
    // proxy kept as a spare of a material that will not be disposed again.
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
      },
    ]);
    const card = g.get("card");
    /** @param {number} angle */
    const turn = async (angle) => {
      card.style.transform = angle ? matrix3d(["rotateY", angle]) : "";
      await g.walk();
      await g.walk();
    };
    await turn(30);
    const found = proxiesOf(g.panel);
    assert.equal(found.length, 1, "the card's one proxy");
    const [proxy] = found;
    const mesh = /** @type {THREE.Mesh} */ (proxy.parent);
    let disposed = false;
    /** @type {THREE.Material} */ (proxy.material).addEventListener("dispose", () => {
      disposed = true;
    });
    /** @type {THREE.Material} */ (mesh.material).dispatchEvent({ type: "dispose" });
    await turn(0);
    assert.equal(proxy.parent, null, "given back");
    assert.ok(disposed, "disposed rather than kept");
    g.teardown();
  });

  test("draws a card swung about its edge in one piece", async () => {
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform: ${matrix3d(["rotateY", 30])}; transform-origin: 0px 50px 0px`,
        at: [100, 100, 100, 100],
      },
    ]);
    const order = await g.walk();
    assert.equal(order.pieces().length, 2, "the root and the card, uncut");
    assert.ok(order.pieces().every((piece) => piece.halfPlanes.length === 0));
    g.teardown();
  });

  test("tests half-planes in every material that draws the panel", async () => {
    // Goes red for a material built without them: a draw of boxes and runs,
    // a run drawn by itself with a shadow, and a picture's box, which draws
    // itself.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      { id: "card", style: CARD, at: [20, 20, 100, 100] },
      { id: "label", at: [20, 140, 100, 20], text: "label" },
      { id: "shadowed", style: "text-shadow: 1px 1px red", at: [20, 170, 100, 20], text: "x" },
      { id: "picture", tag: "img", at: [140, 20, 100, 100] },
    ]);
    const meshes = drawn(g.panel).filter((mesh) => !isBlocker(mesh));
    const instanced = meshes.filter((mesh) => mesh instanceof THREE.InstancedMesh);
    assert.ok(instanced.length >= 1, "a draw of boxes and runs");
    assert.ok(
      meshes.length - instanced.length >= 3,
      "the shadowed run, the picture, the depth quad",
    );
    const quad = depthQuadOf(g.panel);
    for (const mesh of drawn(g.panel)) {
      if (mesh !== quad && !isBlocker(mesh)) {
        assert.ok(
          halfPlanesOf(/** @type {THREE.Material} */ (mesh.material)),
          `${mesh.type} at ${mesh.renderOrder} has no half-planes`,
        );
      }
    }
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("draws a layer's boxes and runs in one draw", async () => {
    // A card, a label in it and a box nested beside the label: one stretch
    // of the panel's order with nothing drawing itself in it. Goes red with
    // a draw per render order.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      {
        id: "card",
        style: CARD,
        at: [20, 20, 200, 100],
        children: [
          { id: "label", at: [30, 30, 100, 20], text: "label" },
          { id: "inner", style: CARD, at: [30, 60, 100, 40] },
        ],
      },
    ]);
    await g.walk();
    const [draw, ...rest] = draws(g.panel);
    assert.equal(rest.length, 0, "one draw");
    // The card's box and the inner box, and then the label's run, which is
    // the label's content and so a level past the boxes. The label's own
    // box paints nothing and takes no instance.
    assert.deepEqual(kinds(draw), ["box", "box", "run"]);
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("a restyle reaches the batch only when it changes what a box draws", async () => {
    // Every box writes its numbers through `BoxNumbers`, which tells the
    // batch only when a write changed one. A text colour on a box with no
    // text changes none of them, and a background colour is a box's numbers
    // alone, which the batch writes where the box already is.
    const g = await page([{ id: "card", style: CARD, at: [40, 40, 200, 150] }]);
    await g.walk();
    const fill = () => {
      const [draw] = draws(g.panel);
      const color = /** @type {THREE.InstancedBufferAttribute} */ (
        draw.geometry.getAttribute("aFillColor")
      );
      return [color.getX(0), color.getY(0), color.getZ(0)];
    };
    assert.deepEqual(fill(), [1, 1, 1]);
    const watched = watchBatch();
    try {
      g.get("card").style.color = "rgb(255, 0, 0)";
      await g.settle();
      assert.deepEqual([watched.invalidate, watched.changed], [0, 0], "nothing it draws changed");
      g.get("card").style.background = "rgb(0, 0, 255)";
      await g.settle();
      assert.deepEqual([watched.invalidate, watched.changed], [0, 1], "its numbers changed");
      assert.equal(watched.batch?.written, 1, "and only its instance is written");
    } finally {
      watched.restore();
    }
    assert.deepEqual(fill(), [0, 0, 1], "and drawn");
    g.teardown();
  });

  test("a box restyled among many writes its own instances, as a rebuild would", async () => {
    // One card's colour changing among a hundred writes that card's
    // instance and its decorations, not a hundred, marks for upload the
    // buffers of its own draw that changed and no other, and the buffers
    // come out as a rebuild from scratch makes them. A picture in the first
    // card breaks the stretch, so the outlines' rings, which draw after
    // every box, are a second draw, and only their colour stays as it was.
    // Then another card, before any rebuild: a patch after a patch writes
    // its own boxes alone.
    const g = await page(
      Array.from({ length: 100 }, (_, i) => ({
        id: `card${i}`,
        style: `${CARD}; box-shadow: rgb(0, 0, 0) 0px 2px 4px; outline-style: solid; outline-width: 1px; outline-color: rgb(0, 0, 0)`,
        at: /** @type {[number, number, number, number]} */ ([0, i * 20, 200, 20]),
        ...(i === 0 ? { children: [{ id: "picture", tag: "img", at: [10, 2, 16, 16] }] } : {}),
      })),
    );
    await g.walk();
    /**
     * The version of every buffer of every draw, by draw and name.
     *
     * @returns {Record<string, number>[]}
     */
    const versions = () =>
      draws(g.panel).map((draw) => ({
        instanceMatrix: draw.instanceMatrix.version,
        ...Object.fromEntries(
          Object.entries(draw.geometry.attributes).map(([name, attribute]) => [
            name,
            /** @type {THREE.BufferAttribute} */ (attribute).version,
          ]),
        ),
      }));
    const before = versions();
    assert.deepEqual(
      draws(g.panel).map((draw) => draw.count),
      [200, 100],
      "the boxes and shadows, then the rings",
    );
    const watched = watchBatch();
    try {
      g.get("card42").style.background = "rgb(0, 128, 0)";
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      assert.equal(watched.invalidate, 0);
      assert.equal(batch.written, 3, "the box, its shadow and its outline");
      const after = versions();
      assert.deepEqual(
        Object.keys(after[0]).filter((name) => after[0][name] !== before[0][name]),
        ["aFillColor"],
        "the boxes' draw uploads its colours alone",
      );
      assert.deepEqual(after[1], before[1], "the rings' draw uploads nothing");
      g.get("card7").style.background = "rgb(0, 0, 255)";
      await g.settle();
      assert.equal(watched.invalidate, 0);
      assert.equal(batch.written, 3, "the second card's alone");
      const patched = buffers(g.panel);
      batch.rebuild();
      assert.equal(batch.written, 300);
      assert.deepEqual(patched, buffers(g.panel), "what a rebuild writes");
    } finally {
      watched.restore();
    }
    g.teardown();
  });

  test("a change a patch cannot write rebuilds the batch", async () => {
    // Each structural case of the batch's rules (`paintBatch.js`'s header)
    // that reaches the batch as a change to a box's numbers: a shadow
    // layer or an outline gained or lost, and a shadow turning inset. Each
    // rebuilds, and leaves the buffers a rebuild from scratch would.
    const g = await page(
      Array.from({ length: 10 }, (_, i) => ({
        id: `card${i}`,
        style: CARD,
        at: /** @type {[number, number, number, number]} */ ([0, i * 20, 200, 20]),
      })),
    );
    await g.walk();
    const watched = watchBatch();
    const card = g.get("card3");
    try {
      for (const [style, value] of /** @type {[string, string][]} */ ([
        ["boxShadow", "rgb(0, 0, 0) 0px 2px 4px"],
        ["boxShadow", "rgb(0, 0, 0) 0px 2px 4px inset"],
        ["boxShadow", "rgb(0, 0, 0) 0px 2px 4px inset, rgb(0, 0, 0) 0px 1px 2px"],
        ["boxShadow", "none"],
        ["outlineStyle", "solid"],
        ["outlineWidth", "1px"],
        ["outlineStyle", "none"],
      ])) {
        card.style.setProperty(
          style.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
          value,
        );
        await g.settle();
        const batch = /** @type {PaintBatch} */ (watched.batch);
        const count = draws(g.panel).reduce((sum, draw) => sum + draw.count, 0);
        assert.equal(batch.written, count, `${style}: ${value} rebuilds`);
        const flushed = buffers(g.panel);
        batch.rebuild();
        assert.deepEqual(flushed, buffers(g.panel), `${style}: ${value}`);
      }
    } finally {
      watched.restore();
    }
    g.teardown();
  });

  test("a box the last walk did not reach is passed over by a patch", async () => {
    // A hidden card is drawn by nothing, so its colour changing writes
    // nothing, and the other cards' colours are still patched. Showing it
    // rebuilds, and draws it in its new colour.
    const g = await page(
      Array.from({ length: 10 }, (_, i) => ({
        id: `card${i}`,
        style: CARD,
        at: /** @type {[number, number, number, number]} */ ([0, i * 20, 200, 20]),
      })),
    );
    await g.walk();
    g.get("card3").style.visibility = "hidden";
    await g.settle();
    const watched = watchBatch();
    try {
      g.get("card3").style.background = "rgb(0, 128, 0)";
      g.get("card5").style.background = "rgb(0, 0, 255)";
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      assert.equal(watched.invalidate, 0);
      assert.equal(batch.written, 1, "the shown card alone");
      g.get("card3").style.visibility = "visible";
      await g.settle();
      assert.equal(batch.written, 10, "showing it rebuilds");
      const flushed = buffers(g.panel);
      batch.rebuild();
      assert.deepEqual(flushed, buffers(g.panel));
    } finally {
      watched.restore();
    }
    g.teardown();
  });

  test("a box changed past its writer's back is rebuilt, not patched", async () => {
    // Every writer of a box's visibility, order and membership tells the
    // batch by `invalidate`. One that forgot, and then said only that the
    // numbers changed, still gets a rebuild: the patch checks the record.
    const g = await page(
      Array.from({ length: 4 }, (_, i) => ({
        id: `card${i}`,
        style: CARD,
        at: /** @type {[number, number, number, number]} */ ([0, i * 20, 200, 20]),
      })),
    );
    await g.walk();
    const watched = watchBatch();
    try {
      g.get("card1").style.background = "rgb(0, 0, 255)";
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      assert.equal(batch.written, 1, "patched");
      /** @type {THREE.Mesh[]} */
      const members = [];
      g.panel.traverse((object) => {
        if (object instanceof THREE.Mesh && batch.boxes.numbersOf(object)) {
          members.push(object);
        }
      });
      const [mesh] = members;
      const total = () => draws(g.panel).reduce((sum, draw) => sum + draw.count, 0);

      // Told twice in one flush, as a paint and a clip are by a scroll:
      // written once.
      batch.changed(mesh);
      batch.changed(mesh);
      batch.flush();
      assert.equal(batch.written, 1, "told twice, written once");

      mesh.visible = false;
      batch.changed(mesh);
      batch.flush();
      assert.equal(batch.written, total(), "hidden: rebuilt");
      mesh.visible = true;
      batch.invalidate();
      batch.flush();

      mesh.renderOrder += 1;
      batch.changed(mesh);
      batch.flush();
      assert.equal(batch.written, total(), "reordered: rebuilt");
      mesh.renderOrder -= 1;
      batch.invalidate();
      batch.flush();

      const numbersOf = batch.boxes.numbersOf;
      batch.boxes.numbersOf = () => undefined;
      try {
        batch.changed(mesh);
        batch.flush();
        assert.equal(batch.written, total(), "no longer a member: rebuilt");
      } finally {
        batch.boxes.numbersOf = numbersOf;
      }
    } finally {
      watched.restore();
    }
    g.teardown();
  });

  /**
   * Scroll `element` down by `top` px, as the page would, and say so.
   *
   * @param {HTMLElement} element
   * @param {number} top
   */
  const scrollTo = (element, top) => {
    Object.defineProperty(element, "scrollTop", { configurable: true, get: () => top });
    element.dispatchEvent(new Event("scroll"));
  };

  test("a scroll writes the matrices of what scrolls, as a rebuild would", async () => {
    // A scroller of cards beside a card that does not scroll: a scroll
    // moves the content group alone, and the batch writes the matrices of
    // the boxes under it where they are, and nothing else. Goes red with a
    // scroll rebuilding the batch. The scroller sits in a box away from
    // the page's corner, so a move that started its walk from the identity
    // goes red too, and the cards wear an outline and two shadows, so a
    // move that wrote a box's own slot and not its decorations' does.
    const DECORATED = `${CARD}; outline: 2px solid rgb(255, 0, 0); box-shadow: rgb(0, 0, 0) 0px 2px 4px, rgb(0, 0, 0) 0px 1px 2px inset`;
    const g = await page([
      {
        id: "frame",
        style: "position: absolute",
        at: [30, 20, 210, 280],
        children: [
          {
            id: "scroller",
            style: "position: absolute; overflow: hidden",
            at: [40, 30, 190, 260],
            children: Array.from({ length: 10 }, (_, i) => ({
              id: `card${i}`,
              style: DECORATED,
              at: /** @type {[number, number, number, number]} */ ([40, 70 + i * 20, 190, 20]),
            })),
          },
        ],
      },
      { id: "still", style: CARD, at: [250, 0, 100, 100] },
    ]);
    await g.walk();
    const watched = watchBatch();
    const moved = PaintBatch.prototype.moved;
    let movedCalls = 0;
    PaintBatch.prototype.moved = function (object) {
      movedCalls += 1;
      watched.batch = this;
      return moved.call(this, object);
    };
    try {
      scrollTo(/** @type {HTMLElement} */ (g.get("scroller")), 10);
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      assert.ok(movedCalls > 0, "the content group moved");
      assert.equal(watched.invalidate, 0, "nothing structural");
      // Each card's matrix, and its numbers, since its clip is expressed
      // against the scroll; not the card that stays put.
      assert.equal(batch.written, 60, "each card's slots, for the move and again for the clip");
      const patched = buffers(g.panel);
      batch.rebuild();
      assert.deepEqual(patched, buffers(g.panel), "what a rebuild writes");
    } finally {
      PaintBatch.prototype.moved = moved;
      watched.restore();
    }
    g.teardown();
  });

  test("a scroll of text writes its runs' clips and matrices, as a rebuild would", async () => {
    // Labels in a scroller: a scroll moves the content group and changes
    // each label's clip, which is expressed against the scroll. The batch
    // writes both where they are. Goes red with the label's effect asking
    // for a rebuild on every scroll.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      {
        id: "scroller",
        style: "position: absolute; overflow: hidden",
        at: [0, 0, 200, 300],
        children: Array.from({ length: 4 }, (_, i) => ({
          id: `row${i}`,
          style: CARD,
          at: /** @type {[number, number, number, number]} */ ([0, 40 + i * 20, 200, 20]),
          text: `row ${i}`,
        })),
      },
    ]);
    await g.walk();
    const runs = () =>
      draws(g.panel)
        .flatMap(kinds)
        .filter((kind) => kind === "run").length;
    assert.equal(runs(), 4, "the labels are batched");
    const watched = watchBatch();
    try {
      scrollTo(/** @type {HTMLElement} */ (g.get("scroller")), 10);
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      assert.equal(watched.invalidate, 0, "nothing structural");
      assert.ok(watched.changed >= 4, "the labels' clips");
      const patched = buffers(g.panel);
      batch.rebuild();
      assert.deepEqual(patched, buffers(g.panel), "what a rebuild writes");
    } finally {
      watched.restore();
    }
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("a scroll of fields writes their values' runs where they are", async () => {
    // A field's value is a run its box draws (`surfaceRun.js`). The first
    // field sits at the scroller's top edge, so a scroll moves the
    // scroller's clip across it, which its value's clip follows. Goes red
    // with that effect asking for a rebuild on every scroll.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      {
        id: "scroller",
        style: "position: absolute; overflow: hidden",
        at: [0, 0, 200, 300],
        children: Array.from({ length: 3 }, (_, i) => ({
          id: `field${i}`,
          tag: "input",
          style: "position: absolute",
          at: /** @type {[number, number, number, number]} */ ([0, i * 30, 200, 20]),
        })),
      },
    ]);
    for (let i = 0; i < 3; i++) {
      /** @type {HTMLInputElement} */ (g.get(`field${i}`)).value = `value ${i}`;
    }
    await g.walk();
    const runs = () =>
      draws(g.panel)
        .flatMap(kinds)
        .filter((kind) => kind === "run").length;
    assert.equal(runs(), 3, "the values are batched");
    const watched = watchBatch();
    try {
      scrollTo(/** @type {HTMLElement} */ (g.get("scroller")), 10);
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      assert.equal(watched.invalidate, 0, "nothing structural");
      const patched = buffers(g.panel);
      batch.rebuild();
      assert.deepEqual(patched, buffers(g.panel), "what a rebuild writes");
    } finally {
      watched.restore();
    }
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("a scroll of a list item writes its marker's run where it is", async () => {
    // A marker is a run whose origin follows its item's scroll
    // (`listMarker.js` takes the scroll off its y), so a scroll moves the
    // run with nothing structural to rebuild for. Goes red with the run's
    // `moved` deleted from `surfaceRun.js`: its matrix stays where it was.
    // jsdom computes no `::marker`; it takes the item's style, as in
    // `paintOrderScenes.js`.
    const computeStyle = window.getComputedStyle;
    window.getComputedStyle = (element, pseudo) =>
      computeStyle(element, pseudo === "::marker" ? null : pseudo);
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      {
        id: "item",
        tag: "li",
        style: "position: absolute; display: list-item; list-style-type: disc; overflow: hidden",
        at: [40, 40, 200, 40],
        text: "abc",
      },
    ]);
    await g.walk();
    const watched = watchBatch();
    try {
      scrollTo(/** @type {HTMLElement} */ (g.get("item")), 10);
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      assert.ok(batch, "the batch is told");
      assert.equal(watched.invalidate, 0, "nothing structural");
      const patched = buffers(g.panel);
      batch.rebuild();
      assert.deepEqual(patched, buffers(g.panel), "what a rebuild writes");
    } finally {
      watched.restore();
    }
    g.teardown();
    restoreRange();
    canvas.restore();
    window.getComputedStyle = computeStyle;
  });

  test("a text colour writes its run where it is", async () => {
    // A label recoloured, as a hover does: its run's instance is written
    // again, and nothing else. Goes red with the tint asking for a rebuild.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      { id: "card", style: CARD, at: [20, 20, 200, 40], text: "label" },
      { id: "other", style: CARD, at: [20, 100, 200, 40] },
    ]);
    await g.walk();
    const watched = watchBatch();
    try {
      const [draw] = draws(g.panel);
      const fill = /** @type {THREE.BufferAttribute} */ (draw.geometry.getAttribute("aFillColor"));
      const was = fill.version;
      g.get("card").style.color = "rgb(255, 0, 0)";
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      assert.equal(watched.invalidate, 0, "nothing structural");
      assert.equal(batch.written, 1, "the run alone");
      // The arrays alone would match a rebuild's with the draw never
      // marked, and the label would keep its old colour on screen.
      assert.equal(fill.version, was + 1, "uploaded");
      const patched = buffers(g.panel);
      batch.rebuild();
      assert.deepEqual(patched, buffers(g.panel), "what a rebuild writes");
    } finally {
      watched.restore();
    }
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  /**
   * Recolour or restyle one thing on a page of labelled cards and check the
   * batch patched it: nothing structural, `written` instances, and the
   * buffers a rebuild writes.
   *
   * @param {PageSpec[]} spec
   * @param {(g: Awaited<ReturnType<typeof page>>) => void} change
   * @param {number} written
   */
  const patchesText = async (spec, change, written) => {
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page(spec);
    await g.walk();
    const watched = watchBatch();
    try {
      change(g);
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      assert.ok(batch, "the batch is told");
      assert.equal(watched.invalidate, 0, "nothing structural");
      assert.equal(batch.written, written);
      const patched = buffers(g.panel);
      batch.rebuild();
      assert.deepEqual(patched, buffers(g.panel), "what a rebuild writes");
    } finally {
      watched.restore();
      g.teardown();
      restoreRange();
      canvas.restore();
    }
  };

  test("a label of another size is patched in its own size's slot", () => {
    // Two labels of different lengths are two size classes, two arrays in
    // one draw: a patch that wrote the wrong slot would draw the label
    // with the other's glyphs.
    return patchesText(
      [
        { id: "a", style: CARD, at: [20, 20, 200, 40], text: "one" },
        { id: "b", style: CARD, at: [20, 100, 200, 40], text: "another one" },
      ],
      (g) => {
        g.get("b").style.color = "rgb(255, 0, 0)";
      },
      1,
    );
  });

  test("a fade writes its box and its label where they are", () => {
    // The tint tells the batch when the opacity changes as well as the
    // colour; without it the label keeps its alpha while its box fades.
    return patchesText(
      [
        { id: "card", style: CARD, at: [20, 20, 200, 40], text: "label" },
        { id: "other", style: CARD, at: [20, 100, 200, 40] },
      ],
      (g) => {
        g.get("card").style.opacity = "0.5";
      },
      2,
    );
  });

  for (const [axis, dx, dy] of /** @type {const} */ ([
    ["across", 7, 0],
    ["down", 0, 7],
  ])) {
    test(`a label that moves ${axis} in its box is written where it is`, async () => {
      // Its parent gains padding: the lines, and so the raster, stay as
      // they were, and the run's place is all that changes. `text.js` tells
      // the batch it moved; without that the run is drawn where it was.
      let shift = { x: 0, y: 0 };
      const stubbed = document.createRange;
      const restore = () => {
        document.createRange = stubbed;
      };
      const canvas = stubCanvas();
      const restoreRange = installRange();
      const measuring = document.createRange;
      document.createRange = () => {
        const range = measuring();
        const rect = range.getBoundingClientRect.bind(range);
        const shifted = () => {
          const r = rect();
          return /** @type {DOMRect} */ ({
            ...r,
            left: r.left + shift.x,
            right: r.right + shift.x,
            top: r.top + shift.y,
            bottom: r.bottom + shift.y,
          });
        };
        range.getBoundingClientRect = shifted;
        range.getClientRects = () =>
          /** @type {DOMRectList} */ (/** @type {unknown} */ ([shifted()]));
        return range;
      };
      const g = await page([
        { id: "card", style: CARD, at: [20, 20, 200, 40], text: "label" },
        { id: "other", style: CARD, at: [20, 100, 200, 40] },
      ]);
      await g.walk();
      try {
        const result = await patchOf(g, () => {
          shift = { x: dx, y: dy };
          g.get("card").style.padding = `${dy}px 0 0 ${dx}px`;
        });
        assert.equal(result.moved, 1, "the run moved");
        assert.equal(result.invalidate, 0, "nothing structural");
        assert.deepEqual(result.patched, result.rebuilt, "what a rebuild writes");
      } finally {
        g.teardown();
        restoreRange();
        restore();
        canvas.restore();
      }
    });
  }

  test("a run changed past its writer's back is rebuilt, not patched", async () => {
    // The same second guard as a box's, for a run: hidden, reordered or no
    // longer a member, and said only to have changed its colour.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([{ id: "card", style: CARD, at: [20, 20, 200, 40], text: "label" }]);
    await g.walk();
    const watched = watchBatch();
    try {
      g.get("card").style.color = "rgb(255, 0, 0)";
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      /** @type {THREE.Mesh | undefined} */
      let run;
      g.panel.traverse((object) => {
        if (object instanceof THREE.Mesh && batch.runs.memberOf(object)) {
          run = object;
        }
      });
      const mesh = /** @type {THREE.Mesh} */ (run);
      const total = () => draws(g.panel).reduce((sum, draw) => sum + draw.count, 0);

      batch.changed(mesh);
      batch.flush();
      assert.equal(batch.written, 1, "patched");

      mesh.visible = false;
      batch.changed(mesh);
      batch.flush();
      assert.equal(batch.written, total(), "hidden: rebuilt");
      mesh.visible = true;
      batch.invalidate();
      batch.flush();

      mesh.renderOrder += 1;
      batch.changed(mesh);
      batch.flush();
      assert.equal(batch.written, total(), "reordered: rebuilt");
      mesh.renderOrder -= 1;
      batch.invalidate();
      batch.flush();

      const memberOf = batch.runs.memberOf;
      batch.runs.memberOf = () => undefined;
      try {
        batch.changed(mesh);
        batch.flush();
        assert.equal(batch.written, total(), "no longer a member: rebuilt");
      } finally {
        batch.runs.memberOf = memberOf;
      }
    } finally {
      watched.restore();
    }
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("a move writes the matrices of the boxes and runs under the object", async () => {
    // A card with a label in it, moved without the layout knowing, as a
    // transform's motion step moves one: the batch writes the card's
    // matrix and its label's where they are, and the buffers come out as a
    // rebuild makes them.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      { id: "card", style: CARD, at: [20, 20, 200, 40], text: "label" },
      { id: "other", style: CARD, at: [20, 100, 200, 40] },
    ]);
    await g.walk();
    const watched = watchBatch();
    try {
      g.get("other").style.background = "rgb(0, 0, 255)";
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      /** @type {THREE.Mesh[]} */
      const members = [];
      g.panel.traverse((object) => {
        if (object instanceof THREE.Mesh && batch.boxes.numbersOf(object)) {
          members.push(object);
        }
      });
      const card = /** @type {THREE.Object3D} */ (members[0].parent);
      const versions = () => draws(g.panel).map((draw) => draw.instanceMatrix.version);
      const before = versions();
      card.matrix.multiply(new THREE.Matrix4().makeTranslation(5, 7, 0));
      batch.moved(card);
      batch.flush();
      assert.equal(batch.written, 2, "the card and its label");
      assert.ok(
        versions().some((version, d) => version > before[d]),
        "the matrices are marked for upload",
      );
      const patched = buffers(g.panel);
      batch.rebuild();
      assert.deepEqual(patched, buffers(g.panel), "what a rebuild writes");
    } finally {
      watched.restore();
    }
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  /**
   * Run `change`, let the panel settle, and say how often the batch was
   * told of a move and of a structural change, with the buffers it
   * patched and the ones a rebuild writes after.
   *
   * @param {Awaited<ReturnType<typeof page>>} g
   * @param {() => void} change
   */
  const patchOf = async (g, change) => {
    const watched = watchBatch();
    const moved = PaintBatch.prototype.moved;
    let movedCalls = 0;
    PaintBatch.prototype.moved = function (object) {
      movedCalls += 1;
      watched.batch = this;
      return moved.call(this, object);
    };
    try {
      change();
      await g.settle();
      const patched = buffers(g.panel);
      watched.batch?.rebuild();
      return {
        moved: movedCalls,
        invalidate: watched.invalidate,
        patched,
        rebuilt: buffers(g.panel),
      };
    } finally {
      PaintBatch.prototype.moved = moved;
      watched.restore();
    }
  };

  /**
   * Lay `element` out at `rect` from now on, and restyle it so the mirror
   * reads its layout again.
   *
   * @param {HTMLElement} element
   * @param {Rect} rect
   */
  const relayOut = (element, rect) => {
    element.getBoundingClientRect = () => clientRect(...rect);
    element.style.left = `${rect[0]}px`;
  };

  test("a card's transform is drawn where its motion step puts it", async () => {
    // The motion step writes the card's own matrix and tells the batch it
    // moved (`div.js`, the transform branch). Goes red without that call:
    // the card is drawn where it was.
    const g = await page([
      { id: "card", style: `${CARD}; transform: matrix(1, 0, 0, 1, 5, 6)`, at: [20, 20, 100, 40] },
      { id: "other", style: CARD, at: [20, 100, 100, 40] },
    ]);
    await g.walk();
    const result = await patchOf(g, () => {
      g.get("card").style.transform = "matrix(1, 0, 0, 1, 15, 16)";
    });
    assert.ok(result.moved > 0, "the batch is told");
    assert.equal(result.invalidate, 0, "nothing structural");
    assert.deepEqual(result.patched, result.rebuilt, "what a rebuild writes");
    g.teardown();
  });

  test("a card moved by its layout is drawn where it is now", async () => {
    // The plain branch of the place effect (`div.js`) tells the batch the
    // card moved. A card with no text, since a run's clip moving would
    // still ask for a rebuild and hide a missing call. Goes red without it.
    const g = await page([
      { id: "card", style: CARD, at: [20, 20, 100, 40] },
      { id: "other", style: CARD, at: [20, 100, 100, 40] },
    ]);
    await g.walk();
    const result = await patchOf(g, () => relayOut(g.get("card"), [60, 30, 100, 40]));
    assert.ok(result.moved > 0, "the batch is told");
    assert.equal(result.invalidate, 0, "nothing structural");
    assert.deepEqual(result.patched, result.rebuilt, "what a rebuild writes");
    g.teardown();
  });

  test("a card put in another column is drawn in it, at the same offset", async () => {
    // `place(node)` in `portal.js` moves the card's object to its new
    // parent, and a portal with no pump has no commit to rebuild for it.
    // The card's offset in its new column is the one it had in the old, so
    // its own place effect has nothing to say. Goes red without the
    // reparent's `invalidate`: the card is drawn in its old column.
    const g = await page([
      {
        id: "colA",
        style: CARD,
        at: [10, 10, 120, 200],
        children: [
          { id: "a1", style: CARD, at: [18, 18, 100, 30] },
          { id: "a2", style: CARD, at: [18, 58, 100, 30] },
        ],
      },
      {
        id: "colB",
        style: CARD,
        at: [150, 10, 120, 200],
        children: [{ id: "b1", style: CARD, at: [158, 18, 100, 30] }],
      },
    ]);
    await g.walk();
    const result = await patchOf(g, () => {
      const a1 = g.get("a1");
      g.get("colB").insertBefore(a1, g.get("b1"));
      relayOut(a1, [158, 18, 100, 30]);
      relayOut(g.get("a2"), [18, 18, 100, 30]);
      relayOut(g.get("b1"), [158, 58, 100, 30]);
    });
    assert.deepEqual(result.patched, result.rebuilt, "what a rebuild writes");
    g.teardown();
  });

  test("a card its scroller starts to clip away is drawn no more", async () => {
    // The scroller takes `overflow: hidden`, and the card below its box is
    // clipped away whole: its clip changes and nothing moves, so it is
    // `shown` turning false that tells the batch. Goes red without that
    // `invalidate`: the card is still drawn.
    const g = await page([
      {
        id: "scroller",
        style: "position: absolute",
        at: [0, 0, 200, 100],
        children: [
          { id: "inside", style: CARD, at: [0, 0, 200, 40] },
          { id: "below", style: CARD, at: [0, 150, 200, 40] },
        ],
      },
    ]);
    await g.walk();
    const result = await patchOf(g, () => {
      g.get("scroller").style.overflow = "hidden";
    });
    assert.equal(result.moved, 0, "nothing moves");
    assert.deepEqual(result.patched, result.rebuilt, "what a rebuild writes");
    g.teardown();
  });

  test("an object under another moved object is written once", async () => {
    // A move writes the subtree under the object, so an object under
    // another one moved in the same flush is skipped (`#move`).
    const g = await page([
      {
        id: "card",
        style: CARD,
        at: [20, 20, 200, 100],
        children: [{ id: "inner", style: CARD, at: [30, 30, 50, 50] }],
      },
      { id: "other", style: CARD, at: [20, 150, 200, 40] },
    ]);
    await g.walk();
    const watched = watchBatch();
    try {
      g.get("other").style.background = "rgb(0, 0, 255)";
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      /** @type {THREE.Object3D[]} */
      const owners = [];
      g.panel.traverse((object) => {
        if (object instanceof THREE.Mesh && batch.boxes.numbersOf(object) && object.parent) {
          owners.push(object.parent);
        }
      });
      const [card, inner] = owners;
      batch.moved(inner);
      batch.moved(card);
      batch.flush();
      assert.equal(batch.written, 2, "the card and the box in it, once each");
    } finally {
      watched.restore();
    }
    g.teardown();
  });

  test("a move that meets a box the record does not have rebuilds the batch", async () => {
    // A card shown past its writer's back, under a group then said to have
    // moved: its box has no slot to write a matrix to, so the flush
    // rebuilds rather than leave it undrawn. And a move under a hidden
    // ancestor writes nothing, since nothing there is drawn.
    const g = await page([
      {
        id: "group",
        style: "position: absolute",
        at: [0, 0, 400, 300],
        children: Array.from({ length: 3 }, (_, i) => ({
          id: `card${i}`,
          style: CARD,
          at: /** @type {[number, number, number, number]} */ ([0, i * 20, 200, 20]),
        })),
      },
    ]);
    await g.walk();
    const watched = watchBatch();
    try {
      g.get("card1").style.background = "rgb(0, 0, 255)";
      await g.settle();
      const batch = /** @type {PaintBatch} */ (watched.batch);
      /** @type {THREE.Mesh[]} */
      const members = [];
      g.panel.traverse((object) => {
        if (object instanceof THREE.Mesh && batch.boxes.numbersOf(object)) {
          members.push(object);
        }
      });
      const mesh = members[members.length - 1];
      const total = () => draws(g.panel).reduce((sum, draw) => sum + draw.count, 0);

      mesh.visible = false;
      batch.invalidate();
      batch.flush();
      const before = total();
      mesh.visible = true;
      batch.moved(/** @type {THREE.Object3D} */ (mesh.parent));
      batch.flush();
      assert.equal(total(), before + 1, "the card is drawn again");
      assert.equal(batch.written, total(), "by a rebuild");

      const parent = /** @type {THREE.Object3D} */ (mesh.parent);
      parent.visible = false;
      batch.invalidate();
      batch.flush();
      batch.moved(mesh);
      batch.flush();
      assert.equal(batch.written, 0, "a move under a hidden ancestor writes nothing");
      parent.visible = true;
      batch.invalidate();
      batch.flush();
    } finally {
      watched.restore();
    }
    g.teardown();
  });

  test("after any run of restyles, the buffers are what a rebuild makes", async () => {
    // A seeded sequence of restyles of boxes among twenty, patched or
    // rebuilt as each flush decides. Some change only a box's numbers, and
    // some are structural: a box hidden, shown, lifted by a z-index, or
    // taken out of the batch by a transparent background. Compared with a
    // rebuild from scratch every fourth step, so that patches run one after
    // another against an older record in between.
    const g = await page(
      Array.from({ length: 20 }, (_, i) => ({
        id: `card${i}`,
        style: CARD,
        at: /** @type {[number, number, number, number]} */ ([
          (i % 4) * 90,
          Math.floor(i / 4) * 50,
          80,
          40,
        ]),
      })),
    );
    await g.walk();
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = (/** @type {string[]} */ values) => values[Math.floor(random() * values.length)];
    const changes = [
      [
        "background",
        ["rgb(255, 0, 0)", "rgb(0, 0, 255)", "rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)"],
      ],
      ["border-width", ["0px", "2px", "4px"]],
      ["border-style", ["none", "solid"]],
      ["border-color", ["rgb(0, 0, 0)", "rgb(0, 128, 0)"]],
      ["border-top-left-radius", ["0px", "4px", "12px"]],
      ["box-shadow", ["none", "rgb(0, 0, 0) 0px 2px 4px", "rgb(0, 0, 0) 0px 1px 2px inset"]],
      ["outline-style", ["none", "solid"]],
      ["outline-width", ["0px", "1px", "3px"]],
      ["outline-color", ["rgb(255, 0, 0)", "rgb(0, 0, 255)"]],
      ["opacity", ["1", "0.5"]],
      ["visibility", ["visible", "hidden"]],
      ["z-index", ["auto", "1", "2"]],
      ["background", ["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"]],
    ];
    const watched = watchBatch();
    let patched = 0;
    try {
      for (let step = 0; step < 60; step++) {
        const touched = 1 + Math.floor(random() * 3);
        for (let k = 0; k < touched; k++) {
          const [name, values] = /** @type {[string, string[]]} */ (
            changes[Math.floor(random() * changes.length)]
          );
          g.get(`card${Math.floor(random() * 20)}`).style.setProperty(name, pick(values));
        }
        await g.settle();
        const batch = watched.batch;
        if (!batch) {
          continue;
        }
        if (batch.written < draws(g.panel).reduce((sum, draw) => sum + draw.count, 0)) {
          patched += 1;
        }
        if (step % 4 === 3) {
          const flushed = buffers(g.panel);
          batch.rebuild();
          assert.deepEqual(flushed, buffers(g.panel), `step ${step}`);
        }
      }
    } finally {
      watched.restore();
    }
    assert.ok(patched > 10, `most steps patch, ${patched} did`);
    g.teardown();
  });

  test("a box that paints nothing takes no instance until a style gives it a colour", async () => {
    // A hundred wrappers around their text, the shape most of a page has.
    // Each took an instance it drew nothing with.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page(
      Array.from({ length: 100 }, (_, i) => ({
        id: `row${i}`,
        at: /** @type {[number, number, number, number]} */ ([0, i * 20, 200, 20]),
        text: `row ${i}`,
      })),
    );
    await g.walk();
    const boxes = () =>
      draws(g.panel)
        .flatMap(kinds)
        .filter((kind) => kind === "box").length;
    assert.equal(boxes(), 0, "no row paints, so none is drawn");
    // Nor is any of them tested against the frustum every frame, which
    // three does before it sees the material is invisible.
    /** @type {THREE.Mesh[]} */
    const culled = [];
    g.panel.traverse((object) => {
      if (
        object instanceof THREE.Mesh &&
        !(object instanceof THREE.InstancedMesh) &&
        object.geometry === rectGeometry &&
        object.frustumCulled
      ) {
        culled.push(object);
      }
    });
    assert.deepEqual(culled, [], "a box the batch draws, or would draw, is not culled");

    g.get("row3").style.background = "rgb(0, 0, 255)";
    await g.settle();
    await g.walk();
    assert.equal(boxes(), 1, "the row a background was given to");

    g.get("row3").style.background = "";
    g.get("row4").style.border = "1px solid rgb(0, 0, 0)";
    await g.settle();
    await g.walk();
    assert.equal(boxes(), 1, "the first gave it back, and a border is paint too");
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("a box that paints nothing still takes a press", async () => {
    const g = await page([
      { id: "under", style: CARD, at: [0, 0, 200, 200] },
      { id: "blank", style: `position: absolute; ${POINTER}`, at: [50, 50, 100, 100] },
    ]);
    assert.equal(g.press(75, 75), "blank", "over the card it covers");
    assert.equal(g.press(25, 25), "under", "and the card where it does not reach");
    g.teardown();
  });

  test("a blank child of a draggable card takes the press past the card's edge", async () => {
    // On a page the child spills past its card and takes the press there,
    // for the card. It draws nothing and has no cursor, so it is its being
    // inside a ray target that keeps its quad; without it the press falls
    // through to the root.
    const g = await page([
      {
        id: "card",
        style: "position: absolute; background: rgb(255, 255, 255)",
        at: [20, 20, 100, 100],
        children: [{ id: "spill", style: "position: absolute", at: [100, 40, 80, 30] }],
      },
    ]);
    g.get("card").setAttribute("draggable", "true");
    await g.settle();
    assert.equal(g.press(150, 55), "card", "where the child spills past it");
    g.teardown();
  });

  test("a blank cover over a card's button takes the press, as on a page", async () => {
    // The cover comes after the button, so a page's hit test finds it
    // first and the click goes to the card, not the button. Without the
    // cover's quad the press reaches the button.
    const g = await page([
      {
        id: "card",
        style: CARD,
        at: [20, 20, 200, 100],
        children: [
          {
            id: "button",
            style: `position: absolute; ${POINTER}; background: rgb(0, 0, 255)`,
            at: [40, 40, 40, 20],
          },
          { id: "cover", style: "position: absolute", at: [30, 30, 60, 40] },
        ],
      },
    ]);
    assert.equal(g.press(60, 50), "card");
    g.teardown();
  });

  test("a box mounts its quad when it gains a colour and lets it go when it loses it", async () => {
    const g = await page([{ id: "blank", style: "position: absolute", at: [0, 0, 100, 100] }]);
    const quads = () => {
      let count = 0;
      g.panel.traverse((object) => {
        if (
          object instanceof THREE.Mesh &&
          !(object instanceof THREE.InstancedMesh) &&
          object.geometry === rectGeometry
        ) {
          count += 1;
        }
      });
      return count;
    };
    const before = quads();
    g.get("blank").style.background = "rgb(0, 0, 255)";
    await g.settle();
    assert.equal(quads(), before + 1, "a colour mounts it");
    g.get("blank").style.background = "";
    await g.settle();
    assert.equal(quads(), before, "and taking the colour away lets it go");
    g.teardown();
  });

  test("a blank box takes a press only while it has a cursor", async () => {
    const g = await page([
      { id: "under", style: CARD, at: [0, 0, 200, 200] },
      { id: "blank", style: "position: absolute; cursor: default", at: [50, 50, 100, 100] },
    ]);
    assert.equal(g.press(75, 75), "under", "with no cursor, the card behind it");
    g.get("blank").style.cursor = "pointer";
    await g.settle();
    assert.equal(g.press(75, 75), "blank", "given one after it mounted");
    g.get("blank").style.cursor = "default";
    await g.settle();
    assert.equal(g.press(75, 75), "under", "and the card again once it is taken away");
    g.teardown();
  });

  test("draws the layers after the root in the root's draw", async () => {
    // Two cards lifted out of the root's plane are layers of their own, in
    // nodes of their own, and still one stretch of the order: nothing writes
    // depth to undo it. Goes red with a draw per layer.
    const g = await page([
      { id: "flat", style: CARD, at: [20, 200, 80, 80] },
      {
        id: "a",
        style: `${CARD}; transform: ${matrix3d(["translateZ", 10])}`,
        at: [20, 20, 80, 80],
      },
      {
        id: "b",
        style: `${CARD}; transform: ${matrix3d(["translateZ", 20])}`,
        at: [60, 60, 80, 80],
      },
    ]);
    const order = await g.walk();
    assert.equal(order.pieces().length, 3, "the root and two cards, three nodes");
    const all = draws(g.panel);
    assert.equal(all.length, 1, "one draw");
    assert.equal(all[0].count, 3, "the root's card and both lifted ones");
    g.teardown();
  });

  test("breaks the draw at a picture the page paints between boxes", async () => {
    // A card with a picture in it, and a card over both: the picture
    // draws itself, so the cards are two draws, one before it and one
    // after. Goes red with the stretch unbroken: both cards draw before it.
    const g = await page([
      {
        id: "under",
        style: CARD,
        at: [20, 20, 100, 100],
        children: [{ id: "picture", tag: "img", at: [40, 40, 60, 60] }],
      },
      { id: "over", style: CARD, at: [60, 60, 100, 100] },
    ]);
    await g.walk();
    const picture = drawn(g.panel).find(
      (mesh) =>
        !(mesh instanceof THREE.InstancedMesh) && mesh.parent !== g.panel && !isBlocker(mesh),
    );
    assert.ok(picture, "the picture's box");
    const orders = draws(g.panel).map((draw) => draw.renderOrder);
    assert.ok(
      orders.some((order) => order < picture.renderOrder) &&
        orders.some((order) => order > picture.renderOrder),
      `draws at ${orders} about the picture at ${picture.renderOrder}`,
    );
    g.teardown();
  });

  test("breaks the draw at a picture once it is shown", async () => {
    // The same page with the picture hidden at first. A box that draws
    // itself is still read by the batch's walk, so showing it has to reach
    // the batch, though the batch does not draw it. Goes red with the
    // picture's numbers telling only the batch that draws it, which is
    // none: the cards stay one draw, under the picture.
    const g = await page([
      {
        id: "under",
        style: CARD,
        at: [20, 20, 100, 100],
        children: [
          { id: "picture", tag: "img", style: "visibility: hidden", at: [40, 40, 60, 60] },
        ],
      },
      { id: "over", style: CARD, at: [60, 60, 100, 100] },
    ]);
    await g.walk();
    assert.deepEqual(
      draws(g.panel).map((draw) => draw.count),
      [2],
      "both cards in one draw while the picture is hidden",
    );
    g.get("picture").style.visibility = "visible";
    await g.settle();
    await g.walk();
    assert.deepEqual(
      draws(g.panel).map((draw) => draw.count),
      [1, 1],
      "one draw on each side of the picture",
    );
    g.teardown();
  });

  test("keeps a cut layer's draws apart from the root's", async () => {
    // A proxy copies a whole draw to the further piece, so a draw of the
    // swung card holds the card alone and not the root's card drawn after
    // it. Goes red with the stretch run across the card's band.
    const g = await page([
      {
        id: "card",
        style: `${CARD}; transform: ${matrix3d(["rotateY", 30])}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
      },
      { id: "flat", style: CARD, at: [250, 100, 100, 100] },
    ]);
    await g.walk();
    const cut = draws(g.panel).filter((draw) => {
      const uniforms = halfPlanesOf(/** @type {THREE.Material} */ (draw.material));
      return uniforms && uniforms.uHalfPlaneCount.value > 0;
    });
    assert.equal(cut.length, 1, "the card's draw");
    assert.equal(cut[0].count, 1, "the card's box alone");
    g.teardown();
  });

  test("keeps a cut layer's draws apart from the root's before it", async () => {
    // The root's card first, then a lifted card and a lifted sibling, one
    // through the other's plane: the walk cuts the sibling by the card's,
    // and its back piece follows the root, so the band the draws enter is
    // the cut one. Goes red with only the band a draw leaves asked about.
    const g = await page([
      { id: "flat", style: CARD, at: [250, 200, 60, 60] },
      {
        id: "card",
        style: `${CARD}; transform: ${matrix3d(["translateZ", 30], ["rotateY", 30])}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
      },
      {
        id: "sibling",
        style: `${CARD}; transform: ${matrix3d(["translateZ", 30])}`,
        at: [20, 20, 360, 60],
      },
    ]);
    const order = await g.walk();
    assert.deepEqual(
      order
        .pieces()
        .map(
          (piece) =>
            `${/** @type {Element} */ (piece.layer).id}${piece.halfPlanes.length ? "*" : ""}`,
        ),
      ["root", "sibling*", "card", "sibling*"],
      "the sibling cut after the root",
    );
    const cut = draws(g.panel).filter((draw) => {
      const uniforms = halfPlanesOf(/** @type {THREE.Material} */ (draw.material));
      return uniforms && uniforms.uHalfPlaneCount.value > 0;
    });
    assert.equal(cut.length, 1, "the sibling's draw");
    assert.equal(cut[0].count, 1, "the sibling's box alone");
    g.teardown();
  });

  test("breaks the draw at a run the text batch declines", async () => {
    // A card, a shadowed label in it, which draws itself, and a card over
    // both: the cards are two draws about the label. Goes red with the
    // stretch unbroken.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page([
      {
        id: "under",
        style: CARD,
        at: [20, 20, 100, 100],
        children: [
          { id: "shadowed", style: "text-shadow: 1px 1px red", at: [30, 30, 80, 20], text: "x" },
        ],
      },
      { id: "over", style: CARD, at: [40, 30, 100, 100] },
    ]);
    await g.walk();
    const label = drawn(g.panel).find(
      (mesh) =>
        !(mesh instanceof THREE.InstancedMesh) &&
        mesh.parent !== g.panel &&
        /** @type {THREE.MeshBasicMaterial} */ (mesh.material).map,
    );
    assert.ok(label, "the shadowed run, drawing itself");
    const orders = draws(g.panel).map((draw) => draw.renderOrder);
    assert.ok(
      orders.some((order) => order < label.renderOrder) &&
        orders.some((order) => order > label.renderOrder),
      `draws at ${orders} about the run at ${label.renderOrder}`,
    );
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("lays its draws out again when a viewer move changes what is cut, a guard", async () => {
    // 251 lifted cards behind the root fill the slot up to a swung card,
    // whose back piece comes next, then the root, then its front piece and
    // a picture lifted in front of the root, in an order the viewer's side
    // of the swung card's plane decides. With the front piece at the slot's
    // last place but one the card is cut; past it, it is drawn whole. Its
    // base is the same either way. A guard: the picture's place moves too,
    // and its effects ask for the rebuild in the same walk as the order
    // does (`#findCut`). A move that changes what is cut and no base takes
    // two cut layers whose further pieces swap at the slot's edge.
    /** @type {PageSpec[]} */
    const far = Array.from({ length: 251 }, (_, i) => ({
      id: `far${i}`,
      style: `${CARD}; transform: ${matrix3d(["translateZ", -100])}`,
      at: /** @type {Rect} */ ([0, 0, 10, 10]),
    }));
    const g = await page([
      ...far,
      {
        id: "card",
        style: `${CARD}; transform: ${matrix3d(["rotateY", 30])}; transform-origin: 50px 50px 0px`,
        at: [100, 100, 100, 100],
      },
      {
        id: "near",
        tag: "img",
        style: `position: absolute; transform: ${matrix3d(["translateZ", 100])}`,
        at: [0, 250, 20, 20],
      },
    ]);
    const card = g.get("card");
    /** @param {import("./layerOrder.js").LayerOrder} order */
    const places = (order) =>
      order.pieces().flatMap((piece, i) => (piece.layer === card ? [i] : []));
    const cutDraws = () =>
      draws(g.panel).filter((draw) => {
        const uniforms = halfPlanesOf(/** @type {THREE.Material} */ (draw.material));
        return uniforms && uniforms.uHalfPlaneCount.value > 0;
      });
    assert.deepEqual(places(await g.walk(-4000, 150, -2000)), [251, 254], "past the slot");
    const base = getLayerBase(card);
    assert.deepEqual(cutDraws(), [], "drawn whole");
    assert.deepEqual(places(await g.walk(4000, 150, -2000)), [251, 253], "within it");
    assert.equal(getLayerBase(card), base, "the same base");
    // With the draws laid out as they were, the card's box would share a
    // draw that starts in the band before its own, which the cut does not
    // find, and the card would draw whole.
    const cut = cutDraws();
    assert.equal(cut.length, 1, "the card's draw, cut");
    assert.equal(cut[0].count, 1, "the card's box alone");
    g.teardown();
  });

  test("starts a draw at a run whose array is one more than a draw samples", async () => {
    // Sixteen labels, each its own size of run and so its own array. Goes
    // red with every array sampled by one draw.
    const canvas = stubCanvas();
    const restoreRange = installRange();
    const g = await page(
      Array.from({ length: ARRAYS_PER_DRAW + 1 }, (_, i) => ({
        id: `label${i}`,
        at: /** @type {Rect} */ ([10, 10 + i * 16, 300, 14]),
        text: "x".repeat(i + 1),
      })),
    );
    await g.walk();
    const all = draws(g.panel);
    assert.deepEqual(
      all.map((draw) => kinds(draw).filter((kind) => kind === "run").length),
      [ARRAYS_PER_DRAW, 1],
    );
    g.teardown();
    restoreRange();
    canvas.restore();
  });

  test("declares no more attributes than ANGLE will link, boxes and runs together", async () => {
    // As the box batch's budget test counts it: three's `position`,
    // `normal` and `uv`, four for the instance matrix, and the shader's own.
    const g = await page([{ id: "card", style: CARD, at: [20, 20, 100, 100] }]);
    await g.walk();
    const [draw] = draws(g.panel);
    const source = /** @type {THREE.ShaderMaterial} */ (draw.material).vertexShader;
    const own = source.match(/^\s*attribute\s+\w+\s+\w+;/gm)?.length ?? 0;
    assert.ok(3 + 4 + own <= 16, `${3 + 4 + own} attribute slots`);
    g.teardown();
  });

  test("draws the farther of two panels first", async () => {
    // Each panel's layers start in a slot of their own, far to near from the
    // viewer. Goes red without the sort: both panels start at 0.
    const near = await page([{ id: "card", style: CARD, at: [20, 20, 100, 100] }]);
    const far = await page([{ id: "card", style: CARD, at: [20, 20, 100, 100] }]);
    near.scene.position.set(0, 0, -1000);
    far.scene.position.set(0, 0, -3000);
    near.scene.updateMatrixWorld(true);
    far.scene.updateMatrixWorld(true);
    const renderer = /** @type {THREE.WebGLRenderer} */ (
      /** @type {unknown} */ ({ xr: { isPresenting: false } })
    );
    const camera = new THREE.PerspectiveCamera();
    camera.updateMatrixWorld();
    // Two frames: the first is when each panel joins the renderer's.
    for (const time of [1, 2]) {
      for (const g of [near, far]) {
        /** @type {import("./layerOrder.js").LayerOrder} */ (getLayerOrder(g.root)).frame(
          time,
          renderer,
          camera,
        );
      }
    }
    assert.ok(
      getLayerBase(far.root) < getLayerBase(near.root),
      `far at ${getLayerBase(far.root)}, near at ${getLayerBase(near.root)}`,
    );
    near.teardown();
    far.teardown();
  });
});
