import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { OVERLAY_PANEL_ORDER } from "../../drawOrder.js";
import { pagePanel } from "../../test/pagePanel.js";
import { settle } from "../../test/portalHarness.js";
import { stubGlRenderer } from "../../test/stubGl.js";
import { getLayerOrder } from "./layerOrder.js";

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

  test("draw far to near among themselves after one depth clear, which their depth quads then fill", async () => {
    // A clear before each overlay wiped the depth quads of those drawn
    // before it, so an overlay sorted later drew whole over a nearer part
    // of an earlier one, where the ray was on the earlier. Goes red with a
    // clear for each overlay.
    const { renderer, restoreContext } = stubGlRenderer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const near = await panelAt(scene, 1, true);
    const far = await panelAt(scene, 2, true);
    for (const time of [1, 2]) {
      for (const each of [near, far]) {
        each.order.frame(time, /** @type {any} */ (renderer), camera);
      }
    }
    for (const each of [near, far]) {
      await settle(each.portal);
      each.order.cut();
    }

    /** @type {string[]} */
    const drawn = [];
    for (const [each, name] of /** @type {const} */ ([
      [near, "near"],
      [far, "far"],
    ])) {
      for (const mesh of colourMeshes(each.panel)) {
        mesh.onBeforeRender = () => {
          if (drawn.at(-1) !== name) {
            drawn.push(name);
          }
        };
      }
    }
    const clearDepth = renderer.clearDepth.bind(renderer);
    renderer.clearDepth = () => {
      drawn.push("clear");
      clearDepth();
    };
    renderer.render(scene, camera);
    assert.deepEqual(drawn, ["clear", "far", "near"]);
    drawn.length = 0;
    renderer.render(scene, camera);
    assert.deepEqual(drawn, ["clear", "far", "near"], "and again in the next render");

    near.portal.disconnect();
    far.portal.disconnect();
    restoreContext();
  });

  test("draw the one in front last, where that is not the one with the nearer middle", async () => {
    // A frame rate readout hung off to the upper left of the eye, over a
    // menu card twice as wide, straight ahead and a little farther. Both
    // planes face the eye, the readout's in front, but its middle is the
    // farther of the two since it is off to the side. Goes red with the
    // overlays sorted far to near by their middles: the readout draws
    // first, and its depth quad then hides the card behind it, through
    // its own see-through background.
    const { renderer, restoreContext } = stubGlRenderer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const middle = (/** @type {{ panel: THREE.Object3D }} */ g) =>
      g.panel.localToWorld(new THREE.Vector3(200, 150, 0));
    /** Scale a panel and move it so that its middle is at `to`. */
    const place = (
      /** @type {{ panel: THREE.Object3D, scene: THREE.Object3D }} */ g,
      /** @type {number} */ scale,
      /** @type {THREE.Vector3} */ to,
    ) => {
      g.scene.scale.setScalar(scale);
      scene.updateMatrixWorld(true);
      g.scene.position.add(to.clone().sub(middle(g)));
      scene.updateMatrixWorld(true);
    };
    // The card 800 by 600 across its middle, which the readout's middle
    // is in front of as the eye sees it.
    const card = await panelAt(scene, 1000, true);
    place(card, 2, new THREE.Vector3(0, 0, -1000));
    const readout = await panelAt(scene, 950, true);
    place(readout, 0.25, new THREE.Vector3(-300, 200, -950));
    const from = new THREE.Vector3();
    const middleOf = (/** @type {{ panel: THREE.Object3D }} */ g) => middle(g).distanceTo(from);
    assert.ok(
      middleOf(readout) > middleOf(card),
      `the readout's middle farther: ${middleOf(readout)}, ${middleOf(card)}`,
    );

    for (const time of [1, 2]) {
      for (const each of [card, readout]) {
        each.order.frame(time, /** @type {any} */ (renderer), camera);
      }
    }
    for (const each of [card, readout]) {
      await settle(each.portal);
      each.order.cut();
    }

    /** @type {string[]} */
    const drawn = [];
    for (const [each, name] of /** @type {const} */ ([
      [card, "card"],
      [readout, "readout"],
    ])) {
      for (const mesh of colourMeshes(each.panel)) {
        mesh.onBeforeRender = () => {
          if (drawn.at(-1) !== name) {
            drawn.push(name);
          }
        };
      }
    }
    renderer.render(scene, camera);
    assert.deepEqual(drawn, ["card", "readout"]);

    card.portal.disconnect();
    readout.portal.disconnect();
    restoreContext();
  });

  test("clear before the overlays from the start, not only after a walk", async () => {
    // A portal no walk ever runs for, with no renderer in its context,
    // drawn by the app's own loop. Goes red with the clear left at 0.
    const scene = new THREE.Scene();
    const hud = await panelAt(scene, 1, true);
    /** @type {THREE.Mesh | undefined} */
    let clear;
    hud.panel.traverse((object) => {
      if (object instanceof THREE.Mesh && object.geometry.drawRange.count === 0) {
        clear = object;
      }
    });
    assert.ok(clear, "the overlay's clear");
    assert.ok(clear.renderOrder > OVERLAY_PANEL_ORDER - 1, `the clear at ${clear.renderOrder}`);
    hud.portal.disconnect();
  });
});
