/**
 * A panel drawn in paint order, the `paintOrder` option
 * (`docs/freedom-paint-order.md`): the order within a layer and between
 * layers. Each test names the piece of the mechanism it goes red without,
 * or says it is a guard. A guard that compares the two builds passes on
 * the lift too, and says what paint order must not change.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { batch } from "@apendua/signal";
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
  getDrawLevel,
  getElevation,
  getLayer,
  getLayerBase,
  isPaintOrdered,
  PIECE_BAND,
} from "./elevation.js";
import { isBlocker } from "./blocker.js";
import { halfPlanesOf } from "./halfPlanes.js";
import { getLayerOrder, isProxy, PANEL_PIECES } from "./layerOrder.js";
import { ARRAYS_PER_DRAW, PaintBatch } from "./paintBatch.js";
import { LayerTree } from "./layerTree.js";
import { createPortal } from "./portal.js";
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
 * @param {boolean} [options.paintOrder]
 * @param {string} [options.rootStyle]
 * @param {boolean} [options.opaqueToRays] The panel option of that name.
 * @param {InteractionManager} [options.manager] Another page's, for a test
 *   with two panels in one hand's reach.
 */
async function page(
  children,
  { paintOrder = true, rootStyle = "", opaqueToRays = true, manager: shared } = {},
) {
  const { root, manager, portal, scene, panel, get } = await pagePanel(children, {
    portal: { paintOrder, opaqueToRays },
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
 * The panel's draws of boxes and runs (`paintBatch.js`), in the order they
 * draw.
 *
 * @param {THREE.Object3D} panel
 * @returns {THREE.InstancedMesh[]}
 */
function draws(panel) {
  return drawn(panel)
    .filter((mesh) => mesh instanceof THREE.InstancedMesh && !isProxy(mesh))
    .map((mesh) => /** @type {THREE.InstancedMesh} */ (mesh))
    .sort((a, b) => a.renderOrder - b.renderOrder);
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
 * Every mesh the panel draws: visible, with a material that draws, and with
 * instances to draw if it is instanced.
 *
 * @param {THREE.Object3D} panel
 * @returns {THREE.Mesh[]}
 */
function drawn(panel) {
  /** @type {THREE.Mesh[]} */
  const meshes = [];
  panel.traverseVisible((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }
    const material = /** @type {THREE.Material} */ (object.material);
    if (!material.visible) {
      return;
    }
    if (object instanceof THREE.InstancedMesh && object.count === 0) {
      return;
    }
    meshes.push(object);
  });
  return meshes;
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

  test("leaves depth to every box on the lift, a guard", async () => {
    const g = await page([{ id: "card", style: CARD, at: [20, 20, 100, 100] }], {
      paintOrder: false,
    });
    const writers = drawn(g.panel).filter(
      (mesh) => /** @type {THREE.Material} */ (mesh.material).depthWrite,
    );
    assert.ok(writers.length > 0);
    g.teardown();
  });

  test("puts each box's quad in its object's plane", async () => {
    // A quad behind its object would be behind its parent's text, which the
    // hit test would then meet first though the box draws over it, and off
    // the plane the panel's walk cuts its layer at. Goes red with the
    // lift's quad, 1 px behind its object.
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
    // Goes red with the `isOpaqueQuad` shortcut left in: an opaque card
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
    // A guard for the press, which the lift gives the top card too; the
    // levels go red with the opaque shortcut.
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
    // press, so the footer does. A guard, as the lift does the same: goes
    // red with the lift's ray target untrimmed by its clip.
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
    // meets it first, and the button hears nothing. A guard, as the lift
    // does the same: goes red with the nearest hit not the one taken.
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
    // and the root's button, behind it, is hidden. A guard, as the lift does
    // the same: goes red with the nearest hit not the one taken.
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
    // as a page's is. A guard: what the option must not change, since the
    // lift does the same.
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
    // one beside it the farther panel's row's. A guard, as the lift does
    // the same: goes red with the nearest hit not the one taken.
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
      `${order.pieces().map((piece) => piece.layer.id)}`,
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
    // a draw per render order, as the lift's buckets are.
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
    // The card's box, the label's and the inner box, and then the label's
    // run, which is the label's content and so a level past the boxes.
    assert.deepEqual(kinds(draw), ["box", "box", "box", "run"]);
    g.teardown();
    restoreRange();
    canvas.restore();
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
      order.pieces().map((piece) => `${piece.layer.id}${piece.halfPlanes.length ? "*" : ""}`),
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

  test("ends with the portal that asked for it", async () => {
    // A root mirrored again by a portal that does not ask for paint order
    // is drawn by the lift, whole. Goes red with the panel's mark kept for
    // the element's life rather than the portal's.
    const root = document.createElement("div");
    root.getBoundingClientRect = () => clientRect(0, 0, 400, 300);
    const card = document.createElement("div");
    card.getBoundingClientRect = () => clientRect(20, 20, 100, 100);
    root.appendChild(card);
    document.body.appendChild(root);
    const ctx = InteractionContext.set({}, new InteractionManager());
    const first = createPortal(ctx, { root, budget: 0, paintOrder: true });
    first.addTo(new THREE.Group());
    await settle(first);
    assert.equal(isPaintOrdered(card), true);
    first.disconnect();
    await settle(first);
    const second = createPortal(ctx, { root, budget: 0, paintOrder: false });
    second.addTo(new THREE.Group());
    await settle(second);
    assert.equal(isPaintOrdered(card), false);
    second.disconnect();
    root.remove();
  });
});
