import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal } from "./portal.js";
import { isSvgElement, isSvgRoot, PortalPluginsContext, projectWithPlugins } from "./plugins.js";
import { svgElements } from "../svg/index.js";

/**
 * @import {PortalPlugin} from './plugins.js';
 */

// jsdom-env exposes the common DOM globals, but not MutationObserver, which
// the portal mirrors the tree with, nor DOMParser, which the SVG plugin
// parses geometry with.
if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = window.DOMParser;
}

// jsdom has no FontFaceSet; VisualProperties consults it for x-height.
if (!document.fonts) {
  Object.defineProperty(document, "fonts", {
    value: {
      status: "loaded",
      ready: Promise.resolve(),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @returns {Promise<void>}
 */
function nextMacrotask() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * A card with an `<svg>` in it: a rect, and the whitespace text an
 * authored document has between its shapes.
 */
function buildTree() {
  const card = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "100");
  svg.setAttribute("height", "50");
  svg.appendChild(document.createTextNode("\n  "));
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("width", "40");
  rect.setAttribute("height", "20");
  rect.setAttribute("fill", "red");
  svg.appendChild(rect);
  svg.appendChild(document.createTextNode("\n"));
  card.appendChild(svg);
  return { card, svg, rect };
}

/**
 * Mount a tree through a portal with no frames to slice across — the test
 * runner has no `requestAnimationFrame` — which is the synchronous path.
 *
 * @param {WeakKey} ctx
 * @param {import('./portal.js').PortalOptions} [options]
 */
async function project(ctx, options = {}) {
  const portal = createPortal(ctx, { loadingFrame: false, ...options });
  const parent = new THREE.Group();
  portal.addTo(parent);
  const tree = buildTree();
  portal.mount({
    replace([first, last]) {
      const container = first.parentNode;
      assert.ok(container);
      container.insertBefore(tree.card, first);
      container.removeChild(first);
      if (last !== first) {
        container.removeChild(last);
      }
      return [tree.card, tree.card];
    },
  });
  // The observer's flush is a microtask; the projection runs inside it.
  await nextMacrotask();
  return { portal, parent, ...tree };
}

/**
 * The meshes a shape draws: ordinary materials with something in them. Not
 * the boxes, which are distance-field quads on a `ShaderMaterial`, and not
 * the blocker, which is a plane.
 *
 * @param {THREE.Object3D} root
 * @returns {THREE.Mesh[]}
 */
function shapeMeshes(root) {
  /** @type {THREE.Mesh[]} */
  const meshes = [];
  root.traverse((object) => {
    if (
      object instanceof THREE.Mesh &&
      object.material instanceof THREE.MeshBasicMaterial &&
      !(object.geometry instanceof THREE.PlaneGeometry) &&
      object.geometry.getAttribute("position")?.count > 0
    ) {
      meshes.push(object);
    }
  });
  return meshes;
}

describe("portal plugins", () => {
  test("isSvgRoot tells the outermost <svg> from a nested one", () => {
    const outer = document.createElementNS(SVG_NS, "svg");
    const inner = document.createElementNS(SVG_NS, "svg");
    const rect = document.createElementNS(SVG_NS, "rect");
    const div = document.createElement("div");
    div.appendChild(outer);
    outer.appendChild(inner);
    inner.appendChild(rect);
    assert.equal(isSvgRoot(outer), true);
    assert.equal(isSvgRoot(inner), false);
    assert.equal(isSvgRoot(rect), false);
    assert.equal(isSvgRoot(div), false);
    assert.equal(isSvgElement(rect), true);
    assert.equal(isSvgElement(div), false);
  });

  test("projectWithPlugins asks in order and stops at the first claim", () => {
    const asked = /** @type {string[]} */ ([]);
    /** @param {string} name @param {boolean} claims */
    const plugin = (name, claims) =>
      /** @type {PortalPlugin} */ ({
        element: () => {
          asked.push(name);
          return claims ? /** @type {any} */ ({ subscribe: () => {} }) : null;
        },
      });
    const div = document.createElement("div");
    assert.equal(projectWithPlugins([plugin("a", false), plugin("b", false)], {}, div), null);
    assert.deepEqual(asked, ["a", "b"]);
    asked.length = 0;
    assert.ok(projectWithPlugins([plugin("a", true), plugin("b", true)], {}, div));
    assert.deepEqual(asked, ["a"]);
  });

  test("without a plugin an <svg> is its box and nothing inside it", async () => {
    const ctx = InteractionContext.set({}, new InteractionManager());
    const { portal, parent } = await project(ctx);
    assert.deepEqual(shapeMeshes(parent), []);
    portal.disconnect();
  });

  test("a plugin given to the portal draws the shapes", async () => {
    const ctx = InteractionContext.set({}, new InteractionManager());
    const { portal, parent } = await project(ctx, { plugins: [svgElements()] });
    const meshes = shapeMeshes(parent);
    assert.equal(meshes.length, 1, "one fill mesh for the one rect");
    assert.equal(
      /** @type {THREE.MeshBasicMaterial} */ (meshes[0].material).color.getHexString(),
      "ff0000",
    );
    portal.disconnect();
  });

  test("a plugin registered on the context reaches every portal under it", async () => {
    let ctx = InteractionContext.set({}, new InteractionManager());
    ctx = PortalPluginsContext.set(ctx, [svgElements()]);
    const { portal, parent } = await project(ctx);
    assert.equal(shapeMeshes(parent).length, 1);
    portal.disconnect();
  });

  test("a shape added later is drawn, and one removed is taken down", async () => {
    const ctx = InteractionContext.set({}, new InteractionManager());
    const { portal, parent, svg, rect } = await project(ctx, { plugins: [svgElements()] });
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("r", "5");
    circle.setAttribute("cx", "50");
    circle.setAttribute("cy", "25");
    circle.setAttribute("fill", "blue");
    svg.appendChild(circle);
    await nextMacrotask();
    assert.equal(shapeMeshes(parent).length, 2);
    rect.remove();
    await nextMacrotask();
    assert.equal(shapeMeshes(parent).length, 1);
    portal.disconnect();
    assert.deepEqual(shapeMeshes(parent), [], "disconnecting takes the shapes with it");
  });
});
