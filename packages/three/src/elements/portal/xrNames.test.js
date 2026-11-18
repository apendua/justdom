/**
 * `data-xr-name` (`xrNames.js`): an element's name on every object a panel
 * draws it with, and on nothing that is another node's, kept as the
 * attribute changes and as parts come and go.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../../interactions.js";
import { objectNodes } from "../../drawOrder.js";
import { getContentGroup } from "../contentGroup.js";
import { rectGeometry } from "../paint/sdfRect.js";
import { createPortal, pump, settle } from "../../test/portalHarness.js";

/**
 * A panel over a page's own card: a clickable box with a painted box in
 * it, and a plain box beside it, which the tests name and restyle. Boxes
 * and no text, which jsdom does not lay out (see `pageCard`).
 *
 * @param {string} [buttonAttributes]
 */
async function namedPanel(buttonAttributes = "") {
  const root = document.createElement("div");
  root.innerHTML =
    `<div class="button" style="cursor: pointer" ${buttonAttributes}>` +
    `<div class="icon" style="background-color: rgb(0, 0, 255)"></div></div>` +
    `<div class="plain"></div>`;
  document.body.appendChild(root);
  const ctx = InteractionContext.set({}, new InteractionManager());
  const portal = createPortal(ctx, { root });
  const parent = new THREE.Group();
  portal.addTo(parent);
  await settle(portal);
  const query = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (root.querySelector(selector));
  return {
    parent,
    button: query(".button"),
    icon: query(".icon"),
    plain: query(".plain"),
    /**
     * The object the panel maps back to `node`.
     *
     * @param {Node} node
     * @returns {THREE.Object3D}
     */
    objectOf(node) {
      /** @type {THREE.Object3D | undefined} */
      let found;
      parent.traverse((object) => {
        if (objectNodes.get(object) === node) {
          found = object;
        }
      });
      assert.ok(found, "the node has an object");
      return found;
    },
    /**
     * The quad among a node's object's own children, if it has one up.
     *
     * @param {THREE.Object3D} object
     * @returns {THREE.Object3D | undefined}
     */
    quadOf(object) {
      return object.children.find(
        (child) => child instanceof THREE.Mesh && child.geometry === rectGeometry,
      );
    },
    cleanup() {
      portal.disconnect();
      root.remove();
    },
  };
}

describe("data-xr-name", () => {
  test("names an element's object and its quad, and nothing of its children", async () => {
    const panel = await namedPanel('data-xr-name="ok"');
    const object = panel.objectOf(panel.button);
    const quad = panel.quadOf(object);
    assert.ok(quad, "a clickable box mounts its quad");

    assert.equal(object.name, "ok");
    assert.equal(quad.name, "ok");
    // The scene is searched as any scene is, and the first object found is
    // the element's own, the one its parts hang under.
    assert.equal(panel.parent.getObjectByName("ok"), object);

    // What is under the content group is other nodes': the icon box and
    // its quad.
    const content = getContentGroup(object);
    assert.notEqual(content, object);
    assert.equal(content.name, "");
    const icon = panel.objectOf(panel.icon);
    assert.equal(icon.name, "");
    assert.equal(panel.quadOf(icon)?.name, "");
    assert.equal(panel.objectOf(panel.plain).name, "");
    panel.cleanup();
  });

  test("follows the attribute as it is set, changed and taken off", async () => {
    const panel = await namedPanel();
    const object = panel.objectOf(panel.button);
    const quad = panel.quadOf(object);
    assert.ok(quad);
    assert.equal(object.name, "");

    panel.button.setAttribute("data-xr-name", "first");
    await pump();
    assert.deepEqual([object.name, quad.name], ["first", "first"]);

    panel.button.setAttribute("data-xr-name", "second");
    await pump();
    assert.deepEqual([object.name, quad.name], ["second", "second"]);
    assert.equal(panel.parent.getObjectByName("first"), undefined);

    panel.button.removeAttribute("data-xr-name");
    await pump();
    assert.deepEqual([object.name, quad.name], ["", ""]);
    assert.equal(panel.parent.getObjectByName("second"), undefined);
    panel.cleanup();
  });

  test("names a part mounted after the name, and not one mounted after it went", async () => {
    // A plain box paints nothing and takes no ray, so it mounts no quad
    // until a style gives it a colour.
    const panel = await namedPanel();
    panel.plain.setAttribute("data-xr-name", "plain");
    await pump();
    const object = panel.objectOf(panel.plain);
    assert.equal(object.name, "plain");
    assert.equal(panel.quadOf(object), undefined);

    panel.plain.style.backgroundColor = "rgb(255, 0, 0)";
    await pump();
    const quad = panel.quadOf(object);
    assert.ok(quad, "the colour mounts the quad");
    assert.equal(quad.name, "plain");

    // Taken off while named, it gets its own name back, so that the name
    // taken off while it is down does not stay on it.
    panel.plain.style.backgroundColor = "";
    await pump();
    assert.equal(panel.quadOf(object), undefined);
    assert.equal(quad.name, "");
    panel.plain.removeAttribute("data-xr-name");
    await pump();
    panel.plain.style.backgroundColor = "rgb(255, 0, 0)";
    await pump();
    assert.equal(panel.quadOf(object), quad, "the same quad mounts again");
    assert.equal(quad.name, "");

    // And named again while it is up, the name reaches it.
    panel.plain.setAttribute("data-xr-name", "again");
    await pump();
    assert.deepEqual([object.name, quad.name], ["again", "again"]);
    panel.cleanup();
  });

  test("leaves a child element mounted later under a named element alone", async () => {
    const panel = await namedPanel('data-xr-name="ok"');
    const child = document.createElement("div");
    child.style.cursor = "pointer";
    panel.button.appendChild(child);
    await pump();
    const object = panel.objectOf(child);
    assert.equal(object.name, "");
    assert.equal(panel.quadOf(object)?.name, "");
    panel.cleanup();
  });

  test("does not name the objects of the panel's own container", async () => {
    const panel = await namedPanel();
    const container = /** @type {HTMLElement} */ (panel.button.parentElement);
    container.setAttribute("data-xr-name", "panel");
    await pump();
    assert.equal(panel.parent.getObjectByName("panel"), undefined);
    panel.cleanup();
  });
});
