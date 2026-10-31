/**
 * A node's life in a mirror, end to end through a real portal. The tests
 * cover what a panel hears of a node once the node has left it, what a
 * second panel over the same page starts from, and what a plugin hears of a
 * template it draws.
 *
 * They pin R2 in `docs/freedom-architecture-plan.md`, sections 8 and 10:
 * the mirror lets a node go at `detach`, when it leaves the panel, and
 * keeps only its objects drawn until the commit. The fourth test of the
 * set, #454's node read before any portal adopted it, is in
 * `mirror.test.js`, beside the refcount on a checkbox's accessor.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { svgElements } from "../svg/index.js";
import { clientRect } from "../test/clientRect.js";
import {
  countingManager,
  dispatchFontsEvent,
  drain,
  flushFrame,
  nextMacrotask,
  settle,
} from "../test/portalHarness.js";
import { createPortal } from "./portal.js";

// three's SVGLoader parses with DOMParser, which jsdom-env does not install.
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = window.DOMParser;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * How many objects the panel under `scene` is drawn with.
 *
 * @param {THREE.Object3D} scene
 * @returns {number}
 */
function countObjects(scene) {
  let count = 0;
  scene.traverse(() => {
    count += 1;
  });
  return count;
}

describe("a node's life in a mirror", () => {
  test("a departed subtree is quiet", async () => {
    // Once the commit has taken a subtree out of the panel, nothing the
    // page does to it reaches the panel: no measurement, no restyle, no
    // object built or torn down for it.
    const { ctx } = countingManager();
    const root = document.createElement("div");
    root.getBoundingClientRect = () => clientRect(0, 0, 200, 100);
    const card = document.createElement("div");
    card.style.padding = "4px";
    const inner = document.createElement("div");
    inner.style.cursor = "pointer";
    card.appendChild(inner);
    root.appendChild(card);
    document.body.appendChild(root);

    const portal = createPortal(ctx, { root });
    const scene = new THREE.Group();
    portal.addTo(scene);
    await settle(portal);
    const before = countObjects(scene);

    card.remove();
    await drain();
    const after = countObjects(scene);
    assert.ok(after < before, "the commit took the card out");

    let reads = 0;
    for (const element of [card, inner]) {
      element.getBoundingClientRect = () => {
        reads += 1;
        return clientRect(0, 0, 50, 50);
      };
    }
    card.style.padding = "12px";
    inner.setAttribute("class", "changed");
    inner.appendChild(document.createElement("span"));
    inner.style.cursor = "default";
    await drain();
    assert.equal(reads, 0, "nothing in it is measured");
    assert.equal(countObjects(scene), after, "and nothing in the panel moved for it");

    portal.disconnect();
    root.remove();
  });

  test("a departed subtree is quiet while it waits for the commit", async () => {
    // A card leaves while rows arrive, so the commit that takes the card out
    // waits for the rows to be built, a frame each. Until then the card is
    // drawn as it was. Nothing the panel hears in the meantime reaches it,
    // the removal itself included: a font arriving re-measures the panel,
    // and not the card, which is no longer in the document to be measured.
    const { ctx } = countingManager();
    const root = document.createElement("div");
    root.getBoundingClientRect = () => clientRect(0, 0, 200, 100);
    const card = document.createElement("div");
    card.style.padding = "4px";
    const inner = document.createElement("div");
    inner.style.cursor = "pointer";
    card.appendChild(inner);
    root.appendChild(card);
    document.body.appendChild(root);

    const portal = createPortal(ctx, { root, budget: 0 });
    const scene = new THREE.Group();
    portal.addTo(scene);
    await settle(portal);
    const before = countObjects(scene);

    let reads = 0;
    for (const element of [card, inner]) {
      element.getBoundingClientRect = () => {
        reads += 1;
        return clientRect(0, 0, 50, 50);
      };
    }
    card.remove();
    for (let index = 0; index < 20; index++) {
      root.appendChild(document.createElement("div"));
    }
    // The flush that reports both, and a few of the frames that build the
    // rows.
    await nextMacrotask();
    for (let index = 0; index < 4; index++) {
      flushFrame();
      await nextMacrotask();
    }
    assert.equal(countObjects(scene), before, "the card is still drawn: no commit yet");
    assert.equal(reads, 0, "nothing in the card is measured for the removal");

    dispatchFontsEvent("loadingdone");
    for (let index = 0; index < 4; index++) {
      flushFrame();
      await nextMacrotask();
    }
    assert.equal(countObjects(scene), before, "still waiting for the rows");
    assert.equal(reads, 0, "nothing in the card is measured again");

    await drain();
    assert.ok(countObjects(scene) > before, "the rows arrived");
    assert.equal(reads, 0, "nor at the commit that takes it out");

    portal.disconnect();
    root.remove();
  });

  test("a subtree that comes back before the commit is followed again", async () => {
    // Taken out in one task and put back in the next, before the commit:
    // moved rather than removed, so it keeps its objects, and what the page
    // does to it afterwards reaches them.
    const { ctx } = countingManager();
    const root = document.createElement("div");
    root.getBoundingClientRect = () => clientRect(0, 0, 200, 100);
    const card = document.createElement("div");
    const inner = document.createElement("div");
    inner.style.cursor = "pointer";
    inner.getBoundingClientRect = () => clientRect(0, 0, 50, 20);
    card.appendChild(inner);
    root.appendChild(card);
    document.body.appendChild(root);

    const portal = createPortal(ctx, { root, budget: 0 });
    const scene = new THREE.Group();
    portal.addTo(scene);
    await settle(portal);
    const before = countObjects(scene);

    card.remove();
    await nextMacrotask();
    root.appendChild(card);
    await drain();
    assert.equal(countObjects(scene), before, "kept, not rebuilt or doubled");

    let reads = 0;
    inner.getBoundingClientRect = () => {
      reads += 1;
      return clientRect(0, 0, 50, 40);
    };
    inner.setAttribute("class", "taller");
    await drain();
    assert.ok(reads > 0, "an edit after it came back is measured");

    portal.disconnect();
    root.remove();
  });

  test("a subtree that comes back inside a new element is followed again", async () => {
    // Taken out, wrapped in an element the panel has never seen while out
    // of the document, and put back inside it before the commit. The added
    // node the flush names is the wrapper, and the card is under it.
    const { ctx } = countingManager();
    const root = document.createElement("div");
    root.getBoundingClientRect = () => clientRect(0, 0, 200, 100);
    const card = document.createElement("div");
    const inner = document.createElement("div");
    inner.style.cursor = "pointer";
    inner.getBoundingClientRect = () => clientRect(0, 0, 50, 20);
    card.appendChild(inner);
    root.appendChild(card);
    document.body.appendChild(root);

    const portal = createPortal(ctx, { root, budget: 0 });
    portal.addTo(new THREE.Group());
    await settle(portal);

    card.remove();
    await nextMacrotask();
    const wrap = document.createElement("div");
    wrap.appendChild(card);
    root.appendChild(wrap);
    await drain();

    let reads = 0;
    inner.getBoundingClientRect = () => {
      reads += 1;
      return clientRect(0, 0, 50, 40);
    };
    inner.setAttribute("class", "taller");
    await drain();
    assert.ok(reads > 0, "an edit after it came back is measured");

    portal.disconnect();
    root.remove();
  });

  test("a re-claimed checkbox starts clean", async () => {
    // A session over the page, and then another: the second panel follows
    // the box the way the first did, whichever way the state moves, and so
    // does a panel the box leaves and comes back to. The `checked` property
    // is watched by an accessor on the element for as long as anything
    // reads it, and a release forgets the signal behind it.
    const { ctx } = countingManager();
    const root = document.createElement("div");
    root.getBoundingClientRect = () => clientRect(0, 0, 200, 100);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.getBoundingClientRect = () => clientRect(10, 10, 20, 20);
    root.appendChild(box);
    document.body.appendChild(root);

    const first = createPortal(ctx, { root });
    first.addTo(new THREE.Group());
    await settle(first);
    box.checked = true;
    await drain();
    assert.equal(box.dataset.xrChecked, "true", "the first panel follows an assignment");
    assert.ok(Object.hasOwn(box, "checked"), "followed through an accessor on the element");
    first.disconnect();
    assert.equal(box.dataset.xrChecked, undefined, "and leaves nothing behind");
    assert.ok(!Object.hasOwn(box, "checked"), "the accessor included");

    // Moved while no panel is watching.
    box.checked = false;
    const second = createPortal(ctx, { root });
    second.addTo(new THREE.Group());
    await settle(second);
    assert.equal(box.dataset.xrChecked, undefined, "the second reads the box as it is");
    box.checked = true;
    await drain();
    assert.equal(box.dataset.xrChecked, "true", "and follows an assignment");
    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await drain();
    assert.equal(box.checked, false);
    assert.equal(box.dataset.xrChecked, undefined, "and a click");

    // Out of the panel, released at the commit, and back.
    box.remove();
    await drain();
    root.appendChild(box);
    await drain();
    box.checked = true;
    await drain();
    assert.equal(box.dataset.xrChecked, "true", "a box that came back is followed too");

    second.disconnect();
    root.remove();
  });

  test("a plugin hears an edit to a <defs> it draws, with nobody adopting by hand", async () => {
    // A line whose arrowhead is a marker defined after it, as in many
    // exported drawings. The portal's walk has not reached the `<defs>` when
    // the line is drawn, and the marker's path, once edited, has to reach
    // the copy of it the line carries.
    const { ctx } = countingManager();
    const root = document.createElement("div");
    root.getBoundingClientRect = () => clientRect(0, 0, 100, 50);
    /**
     * @param {string} tag
     * @param {Record<string, string>} attributes
     * @param {Element[]} [children]
     */
    const svg = (tag, attributes, children = []) => {
      const element = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attributes)) {
        element.setAttribute(name, value);
      }
      element.append(...children);
      return element;
    };
    const head = svg("path", { d: "M0 0 L10 5 L0 10 z", fill: "red" });
    const line = svg("line", {
      x1: "0",
      y1: "10",
      x2: "40",
      y2: "10",
      stroke: "black",
      "marker-end": "url(#lifecycle-head)",
    });
    const drawing = svg("svg", { width: "100", height: "50", viewBox: "0 0 50 25" }, [
      line,
      svg("defs", {}, [svg("marker", { id: "lifecycle-head", viewBox: "0 0 10 10" }, [head])]),
    ]);
    drawing.getBoundingClientRect = () => clientRect(0, 0, 100, 50);
    root.appendChild(drawing);
    document.body.appendChild(root);

    const portal = createPortal(ctx, { root, plugins: [svgElements()] });
    const scene = new THREE.Group();
    portal.addTo(scene);
    await settle(portal);

    /** The red meshes: the copy of the arrowhead, and only that. */
    const heads = () => {
      /** @type {THREE.Mesh[]} */
      const meshes = [];
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh &&
          object.material instanceof THREE.MeshBasicMaterial &&
          object.material.color.getHexString() === "ff0000"
        ) {
          meshes.push(object);
        }
      });
      return meshes;
    };
    /** @param {THREE.Mesh} mesh */
    const width = (mesh) => {
      mesh.geometry.computeBoundingBox();
      const bounds = /** @type {THREE.Box3} */ (mesh.geometry.boundingBox);
      return bounds.max.x - bounds.min.x;
    };
    assert.equal(heads().length, 1, "the line carries one arrowhead");
    const drawn = width(heads()[0]);

    head.setAttribute("d", "M0 0 L5 5 L0 10 z");
    await drain();
    assert.equal(heads().length, 1);
    assert.equal(width(heads()[0]), drawn / 2, "the edit reached the copy");

    portal.disconnect();
    root.remove();
  });
});
