import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { OVERLAY_PANEL_ORDER } from "../../drawOrder.js";
import { pagePanel } from "../../test/pagePanel.js";
import { settle } from "../../test/portalHarness.js";
import { stubGlRenderer } from "../../test/stubGl.js";
import { getLayerOrder, OVERLAY_SLOT } from "./layerOrder.js";

// No frame source, so a portal mounts synchronously.
globalThis.requestAnimationFrame = /** @type {never} */ (undefined);
globalThis.cancelAnimationFrame = /** @type {never} */ (undefined);

const CARD = "position: absolute; background: rgb(255, 255, 255)";

/**
 * A panel with one card on it, `distance` metres in front of a camera at
 * the origin looking down -z.
 *
 * @param {THREE.Scene} scene
 * @param {number} distance
 * @param {boolean} overlay
 */
async function panelAt(scene, distance, overlay) {
  const page = await pagePanel([{ id: "card", style: CARD, at: [100, 100, 100, 100] }], {
    portal: { overlay },
  });
  page.scene.position.set(0, 0, -distance);
  scene.add(page.scene);
  return {
    ...page,
    order: /** @type {import("./layerOrder.js").LayerOrder} */ (getLayerOrder(page.root)),
  };
}

/**
 * Every mesh of a panel that draws colour, which is everything it draws but
 * its depth quad and an overlay's depth clear.
 *
 * @param {THREE.Object3D} panel
 * @returns {THREE.Mesh[]}
 */
function colourMeshes(panel) {
  /** @type {THREE.Mesh[]} */
  const meshes = [];
  panel.traverse((object) => {
    const mesh = /** @type {THREE.Mesh} */ (object);
    if (mesh.isMesh && /** @type {THREE.Material} */ (mesh.material).colorWrite !== false) {
      meshes.push(mesh);
    }
  });
  return meshes;
}

describe("overlay panels", () => {
  test("draw after every ordinary panel, nearer or not, and clear the depth buffer first", async () => {
    // A HUD three metres out and an ordinary panel at one: sorted far to
    // near, the HUD would draw first and the panel over it, and the
    // scene's depth would hide it. Goes red with the overlay sorted as an
    // ordinary panel, or drawn with no clear before it.
    const { renderer, restoreContext } = stubGlRenderer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const hud = await panelAt(scene, 3, true);
    const board = await panelAt(scene, 1, false);

    // Two frames: the first sorts before the second panel has joined.
    for (const time of [1, 2]) {
      for (const each of [hud, board]) {
        each.order.frame(time, /** @type {any} */ (renderer), camera);
      }
    }
    for (const each of [hud, board]) {
      await settle(each.portal);
      each.order.cut();
    }

    /** @type {string[]} */
    const drawn = [];
    for (const [each, name] of /** @type {const} */ ([
      [hud, "overlay"],
      [board, "panel"],
    ])) {
      for (const mesh of colourMeshes(each.panel)) {
        mesh.onBeforeRender = () => {
          drawn.push(name);
        };
      }
    }
    const clearDepth = renderer.clearDepth.bind(renderer);
    renderer.clearDepth = () => {
      drawn.push("clear");
      clearDepth();
    };
    renderer.render(scene, camera);

    const firstOverlay = drawn.indexOf("overlay");
    assert.ok(firstOverlay > 0, `the overlay drawn, after the panel: ${drawn.join(", ")}`);
    assert.equal(drawn.indexOf("clear"), firstOverlay - 1, "one clear, just before the overlay");
    assert.equal(drawn.lastIndexOf("clear"), firstOverlay - 1);
    assert.ok(drawn.lastIndexOf("panel") < firstOverlay, "every panel draw before it");
    for (const mesh of colourMeshes(hud.panel)) {
      assert.ok(mesh.renderOrder >= OVERLAY_PANEL_ORDER, `overlay at ${mesh.renderOrder}`);
    }
    for (const mesh of colourMeshes(board.panel)) {
      assert.ok(mesh.renderOrder < OVERLAY_PANEL_ORDER, `panel at ${mesh.renderOrder}`);
    }

    hud.portal.disconnect();
    board.portal.disconnect();
    restoreContext();
  });

  test("draw far to near among themselves, from the first overlay slot", async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const renderer = { xr: { isPresenting: false } };
    const near = await panelAt(scene, 1, true);
    const far = await panelAt(scene, 2, true);
    for (const time of [1, 2]) {
      for (const each of [near, far]) {
        each.order.frame(time, /** @type {any} */ (renderer), camera);
      }
    }
    for (const each of [near, far]) {
      await settle(each.portal);
    }
    const lowest = (/** @type {THREE.Object3D} */ panel) =>
      Math.min(...colourMeshes(panel).map((mesh) => mesh.renderOrder));
    assert.ok(lowest(far.panel) >= OVERLAY_PANEL_ORDER);
    assert.ok(lowest(near.panel) > lowest(far.panel), "the nearer drawn over the farther");
    assert.equal(OVERLAY_SLOT, 48, "the first slot at 5e7 or past it");

    near.portal.disconnect();
    far.portal.disconnect();
  });
});
