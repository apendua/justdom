import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../../test/layoutOffsets.js";
import { pagePanel } from "../../test/pagePanel.js";
import { getPanel, hitElement } from "./dragAndDrop.js";

/**
 * @import { PageSpec } from "../../test/pagePanel.js";
 */

/**
 * The ray through the point (x, y) on the panel's plane, in world space:
 * from a metre in front of it, or from `from` in the panel's px.
 *
 * @param {THREE.Object3D} panel
 * @param {number} x
 * @param {number} y
 * @param {[number, number, number]} [from]
 * @returns {THREE.Ray}
 */
function rayAt(panel, x, y, from) {
  panel.updateWorldMatrix(true, true);
  const target = panel.localToWorld(new THREE.Vector3(x, y, 0));
  const origin = from
    ? panel.localToWorld(new THREE.Vector3(...from))
    : target.clone().add(new THREE.Vector3(0, 0, 1));
  return new THREE.Ray(origin, target.clone().sub(origin).normalize());
}

/**
 * The id of what the scan finds under a ray, on a panel built from `page`.
 *
 * @param {PageSpec[]} page
 * @param {(panel: THREE.Object3D) => THREE.Ray} ray
 */
async function scanned(page, ray) {
  const s = await pagePanel(page);
  const found = hitElement(
    /** @type {import('./dragAndDrop.js').Panel} */ (getPanel(s.panel)),
    ray(s.panel),
  );
  s.portal.disconnect();
  s.root.remove();
  return found?.id ?? null;
}

describe("the scan", () => {
  test("gives a positioned box painted over a later flow sibling the hit", async () => {
    // A page paints the flow before any positioned box, so the badge is
    // over the row that follows it in the tree, as the panel draws it.
    const page = [
      {
        id: "badge",
        style: "position: relative; background: red",
        at: /** @type {const} */ ([0, 0, 200, 100]),
      },
      { id: "row", style: "background: blue", at: /** @type {const} */ ([100, 0, 200, 100]) },
    ];
    assert.equal(await scanned(page, (panel) => rayAt(panel, 150, 50)), "badge");
    assert.equal(await scanned(page, (panel) => rayAt(panel, 250, 50)), "row");
  });

  test("gives the later of two level flow siblings the hit, as a page does", async () => {
    const page = [
      { id: "first", style: "background: red", at: /** @type {const} */ ([0, 0, 200, 100]) },
      { id: "second", style: "background: blue", at: /** @type {const} */ ([100, 0, 200, 100]) },
    ];
    assert.equal(await scanned(page, (panel) => rayAt(panel, 150, 50)), "second");
  });

  test("meets a layer in front of the panel along the ray, not under the point", async () => {
    // The card stands 100px in front of the root's plane. The ray comes in
    // from the left at 45 degrees, so it crosses the card's plane at x 50
    // and the root's at x 150, which is past the card's right edge.
    const page = [
      {
        id: "card",
        style: "background: red; transform: matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,100,1)",
        at: /** @type {const} */ ([0, 0, 100, 100]),
      },
    ];
    // The panel's px run y down, so its z runs away from the viewer and
    // the card's plane is at z -100. A ray from (-50, 50, -200) through
    // (150, 50, 0) is at x 50 where it crosses it.
    assert.equal(await scanned(page, (panel) => rayAt(panel, 150, 50, [-50, 50, -200])), "card");
    // Straight on at the same point, the ray misses the card.
    assert.equal(await scanned(page, (panel) => rayAt(panel, 150, 50)), "root");
  });

  test("finds nothing on a plane behind the ray's origin", async () => {
    const page = [
      { id: "row", style: "background: blue", at: /** @type {const} */ ([0, 0, 200, 100]) },
    ];
    assert.equal(
      await scanned(page, (panel) => {
        const ray = rayAt(panel, 50, 50);
        ray.direction.negate();
        return ray;
      }),
      null,
    );
  });
});
