import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createMirror } from "../elements/mirror.js";
import { PortalTemplatesContext } from "../elements/plugins.js";
import { drawShape } from "./template.js";

/**
 * @import { Mesh, Object3D } from "three";
 */

// jsdom-env installs the common DOM globals, but not DOMParser, which three's
// SVGLoader parses its document with.
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = window.DOMParser;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @param {string} tag
 * @param {Record<string, string>} attributes
 * @param {Element[]} [children]
 */
function svg(tag, attributes, children = []) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.append(...children);
  return element;
}

/**
 * @param {number} value
 */
function round(value) {
  return Math.round(value * 1e4) / 1e4 + 0;
}

/**
 * The clip patch's matrix, read by letting the material patch a shader: from
 * a mesh's vertices to the root's frame.
 *
 * @param {Mesh} mesh
 * @returns {THREE.Matrix3}
 */
function clipMatrixOf(mesh) {
  const shader = {
    uniforms: /** @type {Record<string, { value: unknown }>} */ ({}),
    vertexShader: "void main() {\n#include <begin_vertex>\n}",
    fragmentShader: "void main() {\n#include <alphatest_fragment>\n}",
  };
  /** @type {THREE.Material} */ (mesh.material).onBeforeCompile(
    /** @type {never} */ (shader),
    /** @type {never} */ (null),
  );
  return /** @type {THREE.Matrix3} */ (shader.uniforms.clipMatrix.value);
}

/**
 * @param {Object3D} object
 * @returns {Mesh[]}
 */
function meshesUnder(object) {
  /** @type {Mesh[]} */
  const found = [];
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      found.push(child);
    }
  });
  return found;
}

/**
 * A line with an arrowhead at its end, in a root twice the size of its
 * `viewBox`, every node adopted by a mirror as the portal adopts a template's.
 * The head is drawn in a 10×10 box with its tip at (10, 5), shown 3×3
 * stroke widths large, and the line is 2 wide, so the head is 6 across.
 */
function setup() {
  const head = svg("path", { d: "M0 0 L10 5 L0 10 z", fill: "red" });
  const marker = svg(
    "marker",
    {
      id: `arrow-${Math.random().toString(36).slice(2)}`,
      viewBox: "0 0 10 10",
      refX: "10",
      refY: "5",
      orient: "auto",
    },
    [head],
  );
  const line = svg("line", {
    x1: "0",
    y1: "10",
    x2: "40",
    y2: "10",
    stroke: "black",
    "stroke-width": "2",
    "marker-end": `url(#${marker.id})`,
  });
  const after = svg("rect", { width: "5", height: "5", fill: "blue" });
  const root = svg("svg", { viewBox: "0 0 50 25" }, [svg("defs", {}, [marker]), line, after]);
  root.getBoundingClientRect = () =>
    /** @type {DOMRect} */ ({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 });
  document.body.appendChild(root);
  const mirror = createMirror();
  root.querySelectorAll("*").forEach((node) => mirror.adopt(node));
  mirror.adopt(root);

  /** @type {Object3D[]} */
  const objects = [];
  const subscriptions = [line, after].map((element) =>
    drawShape({}, element).subscribe((value) => objects.push(value)),
  );
  const [lineObject, afterObject] = objects;
  return {
    root,
    marker,
    head,
    line,
    mirror,
    lineObject,
    afterObject,
    /** The meshes of the marker copies under the line. */
    get markerMeshes() {
      return lineObject.children
        .filter((child) => !(child instanceof THREE.Mesh))
        .flatMap(meshesUnder);
    },
    teardown() {
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      root.remove();
    },
  };
}

describe("markers", () => {
  test("the marker's own opacity fades its copies", () => {
    const s = setup();
    s.marker.setAttribute("style", "opacity: 0.5");
    s.mirror.attributeChanged(s.marker);
    const [mesh] = s.markerMeshes;
    assert.equal(/** @type {THREE.MeshBasicMaterial} */ (mesh.material).opacity, 0.5);
    s.teardown();
  });

  test("an arrowhead is drawn at the end of the line, tip on the vertex, turned along it", () => {
    const s = setup();
    const [mesh] = s.markerMeshes;
    assert.ok(mesh, "a copy of the marker's path");
    const matrix = clipMatrixOf(mesh);
    // The tip (10, 5) lands on the line's end, (40, 10), which is (80, 20)
    // in the root's px; the back of the head is 6 user units behind it.
    const tip = new THREE.Vector3(10, 5, 1).applyMatrix3(matrix);
    const back = new THREE.Vector3(0, 5, 1).applyMatrix3(matrix);
    assert.deepEqual([round(tip.x), round(tip.y)], [80, 20]);
    assert.deepEqual([round(back.x), round(back.y)], [68, 20]);
    s.teardown();
  });

  test("the copy's object carries the marker's matrix, and the scene graph agrees with the clip", () => {
    const s = setup();
    const [mesh] = s.markerMeshes;
    s.lineObject.updateMatrixWorld(true);
    // Relative to the line's object, which is at the root's content origin
    // here: the scene graph leaves out only the root's viewBox scale.
    const tip = new THREE.Vector3(10, 5, 0).applyMatrix4(mesh.matrixWorld);
    assert.deepEqual([round(tip.x), round(tip.y)], [40, 10]);
    s.teardown();
  });

  test("markers are drawn over the stroke and under what comes next", () => {
    const s = setup();
    const [markerMesh] = s.markerMeshes;
    const stroke = /** @type {Mesh} */ (
      s.lineObject.children.find((child) => child instanceof THREE.Mesh)
    );
    const next = /** @type {Mesh} */ (s.afterObject.children[0]);
    assert.ok(
      stroke.renderOrder < markerMesh.renderOrder && markerMesh.renderOrder < next.renderOrder,
      `${stroke.renderOrder} < ${markerMesh.renderOrder} < ${next.renderOrder}`,
    );
    s.teardown();
  });

  test("the marker's own style colours it, not the line's", () => {
    const s = setup();
    const [mesh] = s.markerMeshes;
    const material = /** @type {THREE.MeshBasicMaterial} */ (mesh.material);
    assert.equal(material.color.getHexString(), "ff0000");
    s.teardown();
  });

  test("an edit inside the marker reaches the copy", () => {
    const s = setup();
    const before = s.markerMeshes[0].geometry;
    s.head.setAttribute("d", "M0 0 L10 5 L0 10 L5 5 z");
    s.mirror.attributeChanged(s.head);
    assert.notEqual(s.markerMeshes[0].geometry, before);
    s.teardown();
  });

  test("an edited refX moves the copy without rebuilding it", () => {
    const s = setup();
    const [mesh] = s.markerMeshes;
    const geometry = mesh.geometry;
    s.marker.setAttribute("refX", "0");
    s.mirror.attributeChanged(s.marker);
    const [after] = s.markerMeshes;
    assert.equal(after, mesh, "the same mesh");
    assert.equal(after.geometry, geometry, "the same geometry");
    const back = new THREE.Vector3(0, 5, 1).applyMatrix3(clipMatrixOf(after));
    assert.deepEqual([round(back.x), round(back.y)], [80, 20]);
    s.teardown();
  });

  test("marker-end: none takes the copy away, and a start marker puts one at the start", () => {
    const s = setup();
    s.line.setAttribute("marker-end", "none");
    s.line.setAttribute("marker-start", `url(#${s.marker.id})`);
    s.mirror.attributeChanged(s.line);
    const [mesh] = s.markerMeshes;
    assert.equal(s.markerMeshes.length, 1);
    const tip = new THREE.Vector3(10, 5, 1).applyMatrix3(clipMatrixOf(mesh));
    assert.deepEqual([round(tip.x), round(tip.y)], [0, 20]);
    s.teardown();
  });

  test("a marker that names itself from inside is drawn once, not forever", () => {
    const s = setup();
    // The arrowhead's own path names the marker it is in, as a rule like
    // `path { marker-end: url(#arrow) }` would make it.
    s.head.setAttribute("marker-end", `url(#${s.marker.id})`);
    s.mirror.attributeChanged(s.head);
    assert.equal(s.markerMeshes.length, 1);
    s.teardown();
  });

  test("a hidden line hides its markers", () => {
    const s = setup();
    s.line.setAttribute("style", "visibility: hidden");
    s.mirror.attributeChanged(s.line);
    const copies = s.lineObject.children.filter((child) => !(child instanceof THREE.Mesh));
    assert.equal(copies.length, 1);
    assert.equal(copies[0].visible, false);
    s.teardown();
  });

  test("a marker defined after the line is adopted before it is read, so edits reach it", () => {
    const head = svg("path", { d: "M0 0 L10 5 L0 10 z", fill: "red" });
    const marker = svg("marker", { id: "late-marker", viewBox: "0 0 10 10" }, [head]);
    const line = svg("line", {
      x1: "0",
      y1: "10",
      x2: "40",
      y2: "10",
      stroke: "black",
      "marker-end": "url(#late-marker)",
    });
    // The defs come last, as in many exported drawings: the line is built
    // before the portal's walk reaches them.
    const root = svg("svg", { viewBox: "0 0 50 25" }, [line, svg("defs", {}, [marker])]);
    root.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 });
    document.body.appendChild(root);
    const mirror = createMirror();
    mirror.adopt(root);
    mirror.adopt(line);
    /** @param {Node} node */
    const adopt = (node) => {
      mirror.adopt(node);
      node.childNodes.forEach(adopt);
    };
    /** @type {Object3D | undefined} */
    let object;
    const subscription = drawShape(PortalTemplatesContext.set({}, adopt), line).subscribe(
      (value) => {
        object = value;
      },
    );
    assert.ok(object);
    const copyMeshes = () =>
      /** @type {Object3D} */ (object).children
        .filter((child) => !(child instanceof THREE.Mesh))
        .flatMap(meshesUnder);
    const before = copyMeshes()[0].geometry;
    head.setAttribute("d", "M0 0 L10 5 L0 10 L5 5 z");
    mirror.attributeChanged(head);
    assert.notEqual(copyMeshes()[0].geometry, before, "the edit reached the copy");
    subscription.unsubscribe();
    root.remove();
  });

  test("a marker is drawn and never hit", () => {
    const s = setup();
    const [mesh] = s.markerMeshes;
    s.lineObject.updateMatrixWorld(true);
    // Straight down through the middle of the head.
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(37, 10, 1),
      new THREE.Vector3(0, 0, -1),
    );
    assert.equal(raycaster.intersectObject(mesh).length, 0);
    s.teardown();
  });
});
