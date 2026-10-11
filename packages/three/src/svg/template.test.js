import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { UNBOUNDED } from "../elements/clip.js";
import { createMirror } from "../elements/mirror.js";
import { leaveSizesUnmapped } from "../test/unmappedSizes.js";
import { drawShape, drawUse } from "./template.js";

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
 * The clip patch's uniforms, read by letting the material patch a shader.
 *
 * @param {Mesh} mesh
 * @returns {Record<string, { value: unknown }>}
 */
function clipUniformsOf(mesh) {
  const shader = {
    uniforms: /** @type {Record<string, { value: unknown }>} */ ({}),
    vertexShader: "void main() {\n#include <begin_vertex>\n}",
    fragmentShader: "void main() {\n#include <alphatest_fragment>\n}",
  };
  /** @type {THREE.Material} */ (mesh.material).onBeforeCompile(
    /** @type {never} */ (shader),
    /** @type {never} */ (null),
  );
  return shader.uniforms;
}

/**
 * The clip patch's matrix: from a mesh's vertices to the root's frame.
 *
 * @param {Mesh} mesh
 * @returns {THREE.Matrix3}
 */
function clipMatrixOf(mesh) {
  return /** @type {THREE.Matrix3} */ (clipUniformsOf(mesh).clipMatrix.value);
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

  test("a marker defined after the line follows its adoption, so edits reach it", async () => {
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
    const subscription = drawShape({}, line).subscribe((value) => {
      object = value;
    });
    assert.ok(object);
    // The walk reaches the defs after the line is drawn, and what read the
    // marker before then comes round a microtask after it does
    // (`announceAdoption` in `mirror.js`).
    adopt(/** @type {Element} */ (root.lastElementChild));
    await Promise.resolve();
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

/**
 * An `<svg>` root holding `content`, in a root twice the size of its
 * `viewBox`, every node adopted by a mirror as the portal adopts them, and
 * each of `draw` drawn through the plugin's own entry point for it.
 *
 * @param {Element[]} content
 * @param {Element[]} draw
 */
function scene(content, draw) {
  const root = svg("svg", { viewBox: "0 0 50 25" }, content);
  root.getBoundingClientRect = () =>
    /** @type {DOMRect} */ ({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 });
  document.body.appendChild(root);
  const mirror = createMirror();
  mirror.adopt(root);
  root.querySelectorAll("*").forEach((node) => mirror.adopt(node));
  /** @type {Object3D[]} */
  const objects = [];
  const subscriptions = draw.map((element) =>
    (element.localName === "use" ? drawUse({}, element) : drawShape({}, element)).subscribe(
      (value) => objects.push(value),
    ),
  );
  return {
    root,
    mirror,
    objects,
    teardown() {
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      root.remove();
    },
  };
}

/**
 * @param {Mesh} mesh
 * @param {number} x
 * @param {number} y
 */
function toRoot(mesh, x, y) {
  const at = new THREE.Vector3(x, y, 1).applyMatrix3(clipMatrixOf(mesh));
  return [round(at.x), round(at.y)];
}

/**
 * @param {Mesh} mesh
 */
function colourOf(mesh) {
  return /** @type {THREE.MeshBasicMaterial} */ (mesh.material).color.getHexString();
}

describe("use", () => {
  test("a symbol is drawn at the use's x, y, its viewBox fitted to the use's size", () => {
    const symbol = svg("symbol", { id: "use-symbol-a", viewBox: "0 0 10 10" }, [
      svg("rect", { width: "10", height: "10", fill: "red" }),
    ]);
    const use = svg("use", { href: "#use-symbol-a", x: "20", y: "0", width: "20", height: "20" });
    const s = scene([svg("defs", {}, [symbol]), use], [use]);
    const [mesh] = meshesUnder(s.objects[0]);
    assert.ok(mesh, "the symbol's rect is drawn");
    // (10, 10) in the symbol is (40, 20) in the root's user space, twice
    // that in its px.
    assert.deepEqual(toRoot(mesh, 10, 10), [80, 40]);
    s.teardown();
  });

  test("a symbol with no size of its own fills the viewport's viewBox", () => {
    const symbol = svg("symbol", { id: "use-symbol-b", viewBox: "0 0 5 2.5" }, [
      svg("rect", { width: "5", height: "2.5", fill: "red" }),
    ]);
    const use = svg("use", { href: "#use-symbol-b" });
    const s = scene([svg("defs", {}, [symbol]), use], [use]);
    const [mesh] = meshesUnder(s.objects[0]);
    assert.deepEqual(toRoot(mesh, 5, 2.5), [100, 50]);
    s.teardown();
  });

  test("a percentage size on the use is of the viewport it stands in", () => {
    const symbol = svg("symbol", { id: "use-symbol-percent", viewBox: "0 0 10 10" }, [
      svg("rect", { width: "10", height: "10", fill: "red" }),
    ]);
    const use = svg("use", { href: "#use-symbol-percent", x: "20%", width: "40%", height: "80%" });
    const s = scene([svg("defs", {}, [symbol]), use], [use]);
    const [mesh] = meshesUnder(s.objects[0]);
    // 40% of 50 by 80% of 25 is 20 square, starting at 20% of 50: (10, 10)
    // in the symbol is (30, 20) in user space, twice that in px.
    assert.deepEqual(toRoot(mesh, 10, 10), [60, 40]);
    s.teardown();
  });

  test("a use's size reaches the symbol when the browser computes it as auto", () => {
    // Chromium 152 does: the attribute sizes the copy, and only a
    // stylesheet's size is in the computed value.
    const restore = leaveSizesUnmapped();
    try {
      const symbol = svg("symbol", { id: "use-symbol-unmapped", viewBox: "0 0 10 10" }, [
        svg("rect", { width: "10", height: "10", fill: "red" }),
      ]);
      const sized = svg("use", {
        href: "#use-symbol-unmapped",
        x: "20",
        width: "20",
        height: "20",
      });
      const percent = svg("use", { href: "#use-symbol-unmapped", width: "40%", height: "80%" });
      const styled = svg("use", {
        href: "#use-symbol-unmapped",
        width: "20",
        height: "20",
        style: "width: 10px; height: 10px",
      });
      const s = scene(
        [svg("defs", {}, [symbol]), sized, percent, styled],
        [sized, percent, styled],
      );
      const [fromAttribute, fromPercent, fromStyle] = s.objects.map((o) => meshesUnder(o)[0]);
      // As in the first test: (10, 10) is (40, 20), twice that in px.
      assert.deepEqual(toRoot(fromAttribute, 10, 10), [80, 40]);
      // 40% of 50 by 80% of 25 is 20 square at the origin.
      assert.deepEqual(toRoot(fromPercent, 10, 10), [40, 40]);
      // The stylesheet's 10 over the attribute's 20.
      assert.deepEqual(toRoot(fromStyle, 10, 10), [20, 20]);
      s.teardown();
    } finally {
      restore();
    }
  });

  test("a percentage on the use follows a new viewBox on the root", () => {
    const symbol = svg("symbol", { id: "use-symbol-reflow", viewBox: "0 0 10 10" }, [
      svg("rect", { width: "10", height: "10", fill: "red" }),
    ]);
    const use = svg("use", { href: "#use-symbol-reflow", y: "50%", width: "10", height: "10" });
    const s = scene([svg("defs", {}, [symbol]), use], [use]);
    s.root.setAttribute("preserveAspectRatio", "none");
    s.mirror.attributeChanged(s.root);
    const [mesh] = meshesUnder(s.objects[0]);
    // 50% of 25 is 12.5, and the rect's foot 10 below it, doubled to px.
    assert.deepEqual(toRoot(mesh, 0, 10), [0, 45]);
    s.root.setAttribute("viewBox", "0 0 50 50");
    s.mirror.attributeChanged(s.root);
    // 50% of 50 is 25, and px are user units on y now.
    assert.deepEqual(toRoot(meshesUnder(s.objects[0])[0], 0, 10), [0, 35]);
    s.teardown();
  });

  test("the copy inherits the use's paint where the symbol sets none", () => {
    const bare = svg("path", { d: "M0 0 L5 0 L5 5 z" });
    const own = svg("path", { d: "M0 0 L5 0 L5 5 z", fill: "blue" });
    const symbol = svg("symbol", { id: "use-symbol-c" }, [bare, own]);
    const use = svg("use", { href: "#use-symbol-c", fill: "red" });
    const s = scene([svg("defs", {}, [symbol]), use], [use]);
    const [inherited, set] = meshesUnder(s.objects[0]);
    assert.equal(colourOf(inherited), "ff0000", "inherited from the use");
    assert.equal(colourOf(set), "0000ff", "its own");
    s.teardown();
  });

  test("currentColor in a symbol is the use's colour, not where the symbol is defined", () => {
    const symbol = svg("symbol", { id: "use-symbol-current" }, [
      svg("path", { d: "M0 0 L5 0 L5 5 z", fill: "currentColor" }),
    ]);
    const defs = svg("defs", { style: "color: blue" }, [symbol]);
    const use = svg("use", { href: "#use-symbol-current", style: "color: red" });
    const s = scene([defs, use], [use]);
    assert.equal(colourOf(meshesUnder(s.objects[0])[0]), "ff0000");
    s.teardown();
  });

  test("a hidden use hides its copy", () => {
    const symbol = svg("symbol", { id: "use-symbol-hidden" }, [
      svg("rect", { width: "5", height: "5", fill: "red" }),
    ]);
    const use = svg("use", { href: "#use-symbol-hidden", style: "visibility: hidden" });
    const s = scene([svg("defs", {}, [symbol]), use], [use]);
    const [mesh] = meshesUnder(s.objects[0]);
    assert.equal(/** @type {THREE.MeshBasicMaterial} */ (mesh.material).visible, false);
    s.teardown();
  });

  test("a copy that inherits through a keyword inherits from the use", () => {
    const hidden = svg("rect", {
      width: "5",
      height: "5",
      fill: "red",
      style: "visibility: inherit",
    });
    const painted = svg("rect", { width: "5", height: "5", fill: "inherit" });
    const symbol = svg("symbol", { id: "use-symbol-keyword" }, [hidden, painted]);
    const defs = svg("defs", {}, [symbol]);
    const use = svg("use", {
      href: "#use-symbol-keyword",
      fill: "red",
      style: "visibility: hidden",
    });
    const s = scene([defs, use], [use]);
    const [first, second] = meshesUnder(s.objects[0]);
    assert.equal(/** @type {THREE.MeshBasicMaterial} */ (first.material).visible, false);
    assert.equal(colourOf(second), "ff0000");
    s.teardown();
  });

  test("an svg root elsewhere is drawn in a viewport the use gives it", () => {
    const other = svg("svg", { id: "use-other-root", viewBox: "0 0 10 10" }, [
      svg("rect", { width: "10", height: "10", fill: "red" }),
    ]);
    document.body.appendChild(other);
    const use = svg("use", { href: "#use-other-root", x: "20", width: "10", height: "10" });
    const s = scene([use], [use]);
    const [mesh] = meshesUnder(s.objects[0]);
    // (10, 10) in the other root is (30, 10) in this one, twice that in px.
    assert.deepEqual(toRoot(mesh, 0, 0), [40, 0]);
    assert.deepEqual(toRoot(mesh, 10, 10), [60, 20]);
    s.teardown();
    other.remove();
  });

  test("a use inside a symbol sizes against that symbol's viewport", () => {
    const dot = svg("symbol", { id: "use-symbol-dot", viewBox: "0 0 2 2" }, [
      svg("rect", { width: "2", height: "2", fill: "red" }),
    ]);
    const badge = svg("symbol", { id: "use-symbol-badge", viewBox: "0 0 10 10" }, [
      svg("use", { href: "#use-symbol-dot", x: "50%" }),
    ]);
    const use = svg("use", { href: "#use-symbol-badge", width: "10", height: "10" });
    const s = scene([svg("defs", {}, [dot, badge]), use], [use]);
    const [mesh] = meshesUnder(s.objects[0]);
    // The dot fills the badge's 10 by 10, from 50% of its width: its
    // corner (2, 2) is (15, 10) in the badge, and the badge is drawn at
    // its own size, twice that in px.
    assert.deepEqual(toRoot(mesh, 2, 2), [30, 20]);
    s.teardown();
  });

  test("an element that is drawn where it stands is drawn again at the use, own transform and all", () => {
    const original = svg("rect", {
      id: "use-original",
      width: "5",
      height: "5",
      fill: "red",
      // `translate(1, 2)`, as computed: jsdom does not resolve it.
      style: "transform: matrix(1, 0, 0, 1, 1, 2)",
    });
    const use = svg("use", { href: "#use-original", x: "10" });
    const s = scene([original, use], [use]);
    const [mesh] = meshesUnder(s.objects[0]);
    assert.deepEqual(toRoot(mesh, 0, 0), [22, 4]);
    s.teardown();
  });

  test("a transform in a copy turns about the symbol's viewBox origin", () => {
    const rect = svg("rect", {
      x: "10",
      y: "10",
      width: "5",
      height: "5",
      fill: "red",
      // A quarter turn, as computed: jsdom does not resolve `rotate`.
      style: "transform: matrix(0, 1, -1, 0, 0, 0)",
    });
    const symbol = svg("symbol", { id: "use-symbol-origin", viewBox: "10 10 20 20" }, [rect]);
    const use = svg("use", { href: "#use-symbol-origin", width: "20", height: "20" });
    const s = scene([svg("defs", {}, [symbol]), use], [use]);
    // The turn is about (10, 10), the symbol's viewBox origin, which stays
    // put and lands at the use's corner; about the root's (0, 0) it would
    // swing out to (-20, 0) in user space.
    assert.deepEqual(toRoot(meshesUnder(s.objects[0])[0], 10, 10), [0, 0]);
    s.teardown();
  });

  test("a use in a copy turns about the enclosing symbol's viewBox origin", () => {
    const dot = svg("symbol", { id: "use-symbol-turned-dot" }, [
      svg("rect", { width: "5", height: "5", fill: "red" }),
    ]);
    const outer = svg("symbol", { id: "use-symbol-turned", viewBox: "10 10 20 20" }, [
      svg("use", {
        href: "#use-symbol-turned-dot",
        x: "10",
        y: "10",
        // A quarter turn, as computed: jsdom does not resolve `rotate`.
        style: "transform: matrix(0, 1, -1, 0, 0, 0)",
      }),
    ]);
    const use = svg("use", { href: "#use-symbol-turned", width: "20", height: "20" });
    const s = scene([svg("defs", {}, [dot, outer]), use], [use]);
    // The dot's corner is moved to (10, 10), the outer symbol's viewBox
    // origin, which the turn leaves in place: at the outer use's corner,
    // in the clip matrix and in the objects' matrices alike.
    const [mesh] = meshesUnder(s.objects[0]);
    assert.deepEqual(toRoot(mesh, 0, 0), [0, 0]);
    s.objects[0].updateMatrixWorld(true);
    const corner = new THREE.Vector3(0, 0, 0).applyMatrix4(mesh.matrixWorld);
    assert.deepEqual([round(corner.x), round(corner.y)], [0, 0]);
    s.teardown();
  });

  test("a symbol's or an svg target's own opacity fades the copy", () => {
    const symbol = svg("symbol", { id: "use-symbol-faded", style: "opacity: 0.5" }, [
      svg("rect", { width: "5", height: "5", fill: "red" }),
    ]);
    const other = svg("svg", { id: "use-other-faded", style: "opacity: 0.5" }, [
      svg("rect", { width: "5", height: "5", fill: "red" }),
    ]);
    document.body.appendChild(other);
    const first = svg("use", { href: "#use-symbol-faded" });
    const second = svg("use", { href: "#use-other-faded" });
    const s = scene([svg("defs", {}, [symbol]), first, second], [first, second]);
    for (const object of s.objects) {
      const [mesh] = meshesUnder(object);
      assert.equal(/** @type {THREE.MeshBasicMaterial} */ (mesh.material).opacity, 0.5);
    }
    s.teardown();
    other.remove();
  });

  test("a new href draws the target it names", () => {
    const red = svg("symbol", { id: "use-symbol-red" }, [
      svg("rect", { width: "5", height: "5", fill: "red" }),
    ]);
    const blue = svg("symbol", { id: "use-symbol-blue" }, [
      svg("rect", { width: "5", height: "5", fill: "blue" }),
    ]);
    const use = svg("use", { href: "#use-symbol-red" });
    const s = scene([svg("defs", {}, [red, blue]), use], [use]);
    assert.equal(colourOf(meshesUnder(s.objects[0])[0]), "ff0000");
    use.setAttribute("href", "#use-symbol-blue");
    s.mirror.attributeChanged(use);
    const meshes = meshesUnder(s.objects[0]);
    assert.equal(meshes.length, 1, "the old copy is taken down");
    assert.equal(colourOf(meshes[0]), "0000ff");
    s.teardown();
  });

  test("an edit inside the symbol reaches the copy", () => {
    const rect = svg("rect", { width: "5", height: "5", fill: "red" });
    const symbol = svg("symbol", { id: "use-symbol-e" }, [rect]);
    const use = svg("use", { href: "#use-symbol-e" });
    const s = scene([svg("defs", {}, [symbol]), use], [use]);
    rect.setAttribute("fill", "blue");
    s.mirror.attributeChanged(rect);
    assert.equal(colourOf(meshesUnder(s.objects[0])[0]), "0000ff");
    s.teardown();
  });

  test("the copy is drawn where the use stands in the draw order", () => {
    const symbol = svg("symbol", { id: "use-symbol-f" }, [
      svg("rect", { width: "5", height: "5", fill: "red" }),
      svg("rect", { width: "5", height: "5", fill: "blue" }),
    ]);
    const before = svg("rect", { width: "5", height: "5", fill: "black" });
    const use = svg("use", { href: "#use-symbol-f" });
    const after = svg("rect", { width: "5", height: "5", fill: "black" });
    const s = scene([svg("defs", {}, [symbol]), before, use, after], [before, use, after]);
    const [lower, copy, upper] = s.objects;
    const [first, second] = meshesUnder(copy).map((mesh) => mesh.renderOrder);
    const below = meshesUnder(lower)[0].renderOrder;
    const above = meshesUnder(upper)[0].renderOrder;
    assert.ok(
      below < first && first < second && second < above,
      `${below} ${first} ${second} ${above}`,
    );
    s.teardown();
  });

  test("a use that would draw itself draws nothing, directly or through another", () => {
    const direct = svg("use", { href: "#use-loop-g" });
    const g = svg("g", { id: "use-loop-g" }, [direct]);
    const a = svg("use", { href: "#use-loop-b" });
    const b = svg("use", { href: "#use-loop-a" });
    const s = scene(
      [
        g,
        svg("defs", {}, [
          svg("symbol", { id: "use-loop-a" }, [
            a,
            svg("rect", { width: "1", height: "1", fill: "red" }),
          ]),
          svg("symbol", { id: "use-loop-b" }, [b]),
        ]),
      ],
      [direct, a],
    );
    assert.equal(meshesUnder(s.objects[0]).length, 0, "a use inside what it names");
    // `a` draws symbol b, whose `b` draws symbol a, whose `a` would draw b
    // again: that is the cycle, and it stops there, with symbol a's rect
    // drawn once.
    assert.equal(meshesUnder(s.objects[1]).length, 1);
    s.teardown();
  });
});

/**
 * The clip box the clip patch compares a mesh against, in the root's frame.
 *
 * @param {Mesh} mesh
 */
function clipBoxOf(mesh) {
  const box = /** @type {THREE.Vector4} */ (clipUniformsOf(mesh).clipBox.value);
  return [box.x, box.y, box.z, box.w].map(round);
}

describe("viewport clips", () => {
  /** What the clip box holds for nothing clipped. */
  const OPEN = [-UNBOUNDED, -UNBOUNDED, UNBOUNDED, UNBOUNDED];

  test("a nested svg clips what is inside it to its viewport, in the root's px", () => {
    const rect = svg("rect", { width: "100", height: "100", fill: "red" });
    const nested = svg(
      "svg",
      { x: "5", y: "2", width: "10", height: "5", style: "overflow: hidden" },
      [rect],
    );
    const s = scene([nested], [rect]);
    // The root draws its viewBox twice over, so (5, 2)–(15, 7) is (10, 4)–(30, 14).
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [10, 4, 30, 14]);
    s.teardown();
  });

  test("a nested svg of auto or percentage size clips to the viewport around it", () => {
    /** @type {Record<string, string>[]} */
    const sizes = [{}, { width: "100%", height: "100%" }];
    for (const size of sizes) {
      const rect = svg("rect", { width: "100", height: "100", fill: "red" });
      const nested = svg("svg", { x: "5", y: "2", style: "overflow: hidden", ...size }, [rect]);
      const s = scene([nested], [rect]);
      // The whole 50 by 25 of the root's viewBox, from (5, 2), doubled.
      assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [10, 4, 110, 54]);
      s.teardown();
    }
  });

  test("a nested svg's own transform moves its clip with its content", () => {
    const rect = svg("rect", { width: "100", height: "100", fill: "red" });
    const nested = svg(
      "svg",
      {
        x: "5",
        y: "2",
        width: "10",
        height: "5",
        // `translate(20, 0)`, as computed.
        style: "overflow: hidden; transform: matrix(1, 0, 0, 1, 20, 0)",
      },
      [rect],
    );
    const s = scene([nested], [rect]);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [50, 4, 70, 14]);
    s.teardown();
  });

  test("a symbol in a nested svg with no size fills that svg, and is not clipped away", () => {
    const rect = svg("rect", { width: "10", height: "10", fill: "red" });
    const symbol = svg("symbol", { id: "clip-symbol-nested", style: "overflow: hidden" }, [rect]);
    const use = svg("use", { href: "#clip-symbol-nested" });
    const s = scene([svg("defs", {}, [symbol]), svg("svg", {}, [use])], [use]);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [0, 0, 100, 50]);
    s.teardown();
  });

  test("overflow: visible on the nested svg clips nothing", () => {
    const rect = svg("rect", { width: "100", height: "100", fill: "red" });
    const nested = svg(
      "svg",
      { x: "5", y: "2", width: "10", height: "5", style: "overflow: visible" },
      [rect],
    );
    const s = scene([nested], [rect]);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), OPEN);
    s.teardown();
  });

  test("nested viewports intersect, each placed by what is above it", () => {
    const rect = svg("rect", { width: "100", height: "100", fill: "red" });
    const inner = svg(
      "svg",
      { x: "4", y: "0", width: "20", height: "20", style: "overflow: hidden" },
      [rect],
    );
    const outer = svg(
      "svg",
      { x: "5", y: "2", width: "10", height: "5", style: "overflow: hidden" },
      [inner],
    );
    const s = scene([outer], [rect]);
    // The inner viewport starts at x = 5 + 4 = 9 in the root's user space
    // and runs past the outer one, which ends at 15.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [18, 4, 30, 14]);
    s.teardown();
  });

  test("under a rotation the clip is the viewport's bounding box", () => {
    const rect = svg("rect", { width: "100", height: "100", fill: "red" });
    const nested = svg("svg", { width: "10", height: "4", style: "overflow: hidden" }, [rect]);
    // A quarter turn, as computed, and moved right so it stays in view.
    const g = svg("g", { style: "transform: matrix(0, 1, -1, 0, 20, 0)" }, [nested]);
    const s = scene([g], [rect]);
    // (0, 0)–(10, 4) turned is (16, 0)–(20, 10) in user space.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [32, 0, 40, 20]);
    s.teardown();
  });

  test("a marker clips its content to its box", () => {
    const head = svg("rect", { x: "-5", y: "-5", width: "20", height: "20", fill: "red" });
    const marker = svg(
      "marker",
      {
        id: "clip-marker",
        markerWidth: "4",
        markerHeight: "2",
        markerUnits: "userSpaceOnUse",
        style: "overflow: hidden",
      },
      [head],
    );
    const line = svg("line", {
      x1: "0",
      y1: "10",
      x2: "20",
      y2: "10",
      stroke: "black",
      "marker-end": "url(#clip-marker)",
    });
    const s = scene([svg("defs", {}, [marker]), line], [line]);
    const markerMesh = s.objects[0].children
      .filter((child) => !(child instanceof THREE.Mesh))
      .flatMap(meshesUnder)[0];
    // The box is 4×2 at the line's end, (20, 10), not turned (orient 0).
    assert.deepEqual(clipBoxOf(markerMesh), [40, 20, 48, 24]);
    s.teardown();
  });

  test("a nested svg in a symbol sizes against the symbol's viewport", () => {
    const rect = svg("rect", { width: "1000", height: "1000", fill: "red" });
    const symbol = svg("symbol", { id: "clip-symbol-sized", viewBox: "0 0 1000 1000" }, [
      svg("svg", { style: "overflow: hidden" }, [rect]),
    ]);
    const use = svg("use", { href: "#clip-symbol-sized", width: "50", height: "25" });
    const s = scene([svg("defs", {}, [symbol]), use], [use]);
    // The symbol's 1000 square fits 25 square in the middle of 50 by 25,
    // and the nested svg fills it: (12.5, 0)–(37.5, 25), twice that in px.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [25, 0, 75, 50]);
    s.teardown();
  });

  test("a nested svg in a marker sizes against the marker's viewBox", () => {
    const head = svg("rect", { x: "-100", y: "-100", width: "1000", height: "1000", fill: "red" });
    const marker = svg(
      "marker",
      {
        id: "clip-marker-nested",
        viewBox: "0 0 40 20",
        markerWidth: "4",
        markerHeight: "2",
        markerUnits: "userSpaceOnUse",
      },
      [svg("svg", { width: "100%", height: "100%", style: "overflow: hidden" }, [head])],
    );
    const line = svg("line", {
      x1: "0",
      y1: "10",
      x2: "20",
      y2: "10",
      stroke: "black",
      "marker-end": "url(#clip-marker-nested)",
    });
    const s = scene([svg("defs", {}, [marker]), line], [line]);
    const markerMesh = s.objects[0].children
      .filter((child) => !(child instanceof THREE.Mesh))
      .flatMap(meshesUnder)[0];
    // 100% of the 40 by 20 viewBox is the marker's 4 by 2 box at (20, 10).
    assert.deepEqual(clipBoxOf(markerMesh), [40, 20, 48, 24]);
    s.teardown();
  });

  test("a symbol clips its content to the viewport the use gives it", () => {
    const rect = svg("rect", { x: "-5", y: "-5", width: "20", height: "20", fill: "red" });
    const symbol = svg(
      "symbol",
      { id: "clip-symbol", viewBox: "0 0 10 10", style: "overflow: hidden" },
      [rect],
    );
    const use = svg("use", { href: "#clip-symbol", x: "20", y: "0", width: "5", height: "5" });
    const s = scene([svg("defs", {}, [symbol]), use], [use]);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [40, 0, 50, 10]);
    s.teardown();
  });
  test("an svg the use names clips its content to the viewport the use gives it", () => {
    const rect = svg("rect", { x: "-5", y: "-5", width: "20", height: "20", fill: "red" });
    const other = svg(
      "svg",
      { id: "clip-other-root", viewBox: "0 0 10 10", style: "overflow: hidden" },
      [rect],
    );
    document.body.appendChild(other);
    const use = svg("use", { href: "#clip-other-root", x: "20", y: "0", width: "5", height: "5" });
    const s = scene([use], [use]);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [40, 0, 50, 10]);
    s.teardown();
    other.remove();
  });
});

describe("clip-path", () => {
  /** What the clip box holds for nothing clipped. */
  const OPEN = [-UNBOUNDED, -UNBOUNDED, UNBOUNDED, UNBOUNDED];

  /**
   * A `<clipPath>` holding what it is given, with a fresh id.
   *
   * @param {Element[]} content
   * @param {Record<string, string>} [attributes]
   */
  function clipPath(content, attributes = {}) {
    const id = `clip-${Math.random().toString(36).slice(2)}`;
    return svg("clipPath", { id, ...attributes }, content);
  }

  /** @param {Element} path */
  const url = (path) => `url(#${path.id})`;

  test("a clipPath of one rect clips the shape that names it, in the root's px", () => {
    const cp = clipPath([svg("rect", { x: "5", y: "2", width: "10", height: "5" })]);
    const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
    const s = scene([svg("defs", {}, [cp]), rect], [rect]);
    // The root draws its viewBox twice over, so (5, 2)–(15, 7) is (10, 4)–(30, 14).
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [10, 4, 30, 14]);
    s.teardown();
  });

  test("one on a g clips every shape in it", () => {
    const cp = clipPath([svg("rect", { x: "5", y: "2", width: "10", height: "5" })]);
    const rect = svg("rect", { width: "100", height: "100", fill: "red" });
    const g = svg("g", { "clip-path": url(cp) }, [rect]);
    const s = scene([svg("defs", {}, [cp]), g], [rect]);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [10, 4, 30, 14]);
    s.teardown();
  });

  test("the rect is in the user space of the element, which its own transform moves", () => {
    const cp = clipPath([svg("rect", { x: "5", y: "2", width: "10", height: "5" })]);
    const rect = svg("rect", {
      width: "100",
      height: "100",
      fill: "red",
      "clip-path": url(cp),
      // `translate(20, 0)`, as computed.
      style: "transform: matrix(1, 0, 0, 1, 20, 0)",
    });
    const s = scene([svg("defs", {}, [cp]), rect], [rect]);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [50, 4, 70, 14]);
    s.teardown();
  });

  test("the clipPath's and the rect's transforms place it, a quarter turn exactly", () => {
    const cp = clipPath(
      [
        svg("rect", {
          width: "4",
          height: "2",
          // A quarter turn moved right, as computed.
          style: "transform: matrix(0, 1, -1, 0, 10, 0)",
        }),
      ],
      { style: "transform: matrix(2, 0, 0, 2, 0, 0)" },
    );
    const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
    const s = scene([svg("defs", {}, [cp]), rect], [rect]);
    // (0, 0)–(4, 2) turned is (8, 0)–(10, 4), doubled (16, 0)–(20, 8), and
    // doubled again into the root's px.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [32, 0, 40, 16]);
    s.teardown();
  });

  test("under objectBoundingBox the rect is a share of the element's bounding box", () => {
    const cp = clipPath([svg("rect", { x: "0.5", y: "0", width: "50%", height: "1" })], {
      clipPathUnits: "objectBoundingBox",
    });
    const rect = svg("rect", {
      x: "10",
      y: "4",
      width: "20",
      height: "10",
      fill: "red",
      "clip-path": url(cp),
    });
    // jsdom has no geometry to measure; a browser's `getBBox` reports this.
    /** @type {SVGGraphicsElement} */ (/** @type {unknown} */ (rect)).getBBox = () =>
      /** @type {DOMRect} */ ({ x: 10, y: 4, width: 20, height: 10 });
    const s = scene([svg("defs", {}, [cp]), rect], [rect]);
    // The right half of (10, 4)–(30, 14), doubled.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [40, 8, 60, 28]);
    s.teardown();
  });

  test("a percentage on a shape in a nested svg is of the viewport around the clipPath", () => {
    const cp = clipPath([svg("rect", { width: "50%", height: "100%" })]);
    const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
    const nested = svg(
      "svg",
      {
        x: "5",
        y: "2",
        width: "10",
        height: "5",
        viewBox: "0 0 10 10",
        style: "overflow: visible",
      },
      [rect],
    );
    const s = scene([svg("defs", {}, [cp]), nested], [rect]);
    // (0, 0)-(25, 25) of the root's 50 by 25, under the 0.5 fit of the
    // viewBox into 10 by 5, centred: (7.5, 2)-(20, 14.5), doubled.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [15, 4, 40, 29]);
    s.teardown();
  });

  test("a percentage in user space is a share of the viewport around the clipPath", () => {
    const cp = clipPath([svg("rect", { width: "50%", height: "100%" })]);
    const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
    const s = scene([svg("defs", {}, [cp]), rect], [rect]);
    // Half of the 50 by 25 viewBox, doubled.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [0, 0, 50, 50]);
    s.teardown();
  });

  test("it intersects with a nested svg's viewport around it", () => {
    const cp = clipPath([svg("rect", { width: "8", height: "100" })]);
    const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
    const nested = svg(
      "svg",
      { x: "5", y: "2", width: "10", height: "5", style: "overflow: hidden" },
      [rect],
    );
    const s = scene([svg("defs", {}, [cp]), nested], [rect]);
    // The clip is (5, 2)–(13, 102) in the root's user space, the viewport
    // (5, 2)–(15, 7).
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [10, 4, 26, 14]);
    s.teardown();
  });

  test("a use's clip-path clips its copy", () => {
    const cp = clipPath([svg("rect", { x: "5", y: "2", width: "10", height: "5" })]);
    const symbol = svg("symbol", { id: "clip-path-symbol" }, [
      svg("rect", { width: "100", height: "100", fill: "red" }),
    ]);
    const use = svg("use", { href: "#clip-path-symbol", "clip-path": url(cp) });
    const s = scene([svg("defs", {}, [cp, symbol]), use], [use]);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [10, 4, 30, 14]);
    s.teardown();
  });

  test("an edit to the rect moves the clip", () => {
    const edge = svg("rect", { x: "5", y: "2", width: "10", height: "5" });
    const cp = clipPath([edge]);
    const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
    const s = scene([svg("defs", {}, [cp]), rect], [rect]);
    edge.setAttribute("width", "20");
    s.mirror.attributeChanged(edge);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [10, 4, 50, 14]);
    s.teardown();
  });

  test("a rect with no area clips everything away", () => {
    const cp = clipPath([svg("rect", { x: "5", y: "2", width: "0", height: "5" })]);
    const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
    const s = scene([svg("defs", {}, [cp]), rect], [rect]);
    // Inverted from where (5, 2) lands, which clips everything.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [10, 4, -999990, -999996]);
    s.teardown();
  });

  test("a rect turned by some other angle clips to its bounding box", () => {
    const cp = clipPath([
      svg("rect", {
        width: "5",
        height: "5",
        // Turned by 30°, as computed.
        style: "transform: matrix(0.866, 0.5, -0.5, 0.866, 0, 0)",
      }),
    ]);
    const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
    const s = scene([svg("defs", {}, [cp]), rect], [rect]);
    // The corners land at (0, 0), (4.33, 2.5), (1.83, 6.83) and (-2.5, 4.33).
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [-5, 0, 8.66, 13.66]);
    s.teardown();
  });

  test("a flip on the clipPath places the rect where it lands", () => {
    const cp = clipPath([svg("rect", { x: "5", y: "2", width: "10", height: "5" })], {
      style: "transform: matrix(-1, 0, 0, 1, 30, 0)",
    });
    const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
    const s = scene([svg("defs", {}, [cp]), rect], [rect]);
    // (5, 2)–(15, 7) flipped about x = 15 is (15, 2)–(25, 7).
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [30, 4, 50, 14]);
    s.teardown();
  });

  test("a g's transform above the element moves the clip with it", () => {
    const cp = clipPath([svg("rect", { x: "5", y: "2", width: "10", height: "5" })]);
    const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
    const g = svg("g", { style: "transform: matrix(1, 0, 0, 1, 20, 0)" }, [rect]);
    const s = scene([svg("defs", {}, [cp]), g], [rect]);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [50, 4, 70, 14]);
    s.teardown();
  });

  test("one on a nested svg is in the space its x and y are in, which its transform moves", () => {
    const cp = clipPath([svg("rect", { x: "6", y: "2", width: "4", height: "5" })]);
    const rect = svg("rect", { width: "100", height: "100", fill: "red" });
    const nested = svg(
      "svg",
      {
        x: "5",
        y: "2",
        width: "10",
        height: "5",
        "clip-path": url(cp),
        // `translate(20, 0)`, as computed, and no viewport clip of its own.
        style: "overflow: visible; transform: matrix(1, 0, 0, 1, 20, 0)",
      },
      [rect],
    );
    const s = scene([svg("defs", {}, [cp]), nested], [rect]);
    // (6, 2)–(10, 7) moved right by 20, and not offset by the svg's x again.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [52, 4, 60, 14]);
    s.teardown();
  });

  test("a symbol's own clip-path clips the copy a use draws", () => {
    const cp = clipPath([svg("rect", { x: "5", y: "2", width: "10", height: "5" })]);
    const symbol = svg("symbol", { id: "clip-path-own-symbol", "clip-path": url(cp) }, [
      svg("rect", { width: "100", height: "100", fill: "red" }),
    ]);
    const use = svg("use", { href: "#clip-path-own-symbol" });
    const s = scene([svg("defs", {}, [cp, symbol]), use], [use]);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [10, 4, 30, 14]);
    s.teardown();
  });

  test("a symbol's own clip-path is placed by the use's x and y", () => {
    const cp = clipPath([svg("rect", { x: "5", y: "2", width: "10", height: "5" })]);
    const symbol = svg("symbol", { id: "clip-path-own-symbol-moved", "clip-path": url(cp) }, [
      svg("rect", { width: "100", height: "100", fill: "red" }),
    ]);
    const use = svg("use", { href: "#clip-path-own-symbol-moved", x: "10" });
    const s = scene([svg("defs", {}, [cp, symbol]), use], [use]);
    // (5, 2)–(15, 7) in the symbol, moved right by the use's 10.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [30, 4, 50, 14]);
    s.teardown();
  });

  test("a turned rect with no area still clips everything away", () => {
    const cp = clipPath([
      svg("rect", {
        x: "5",
        y: "2",
        width: "0",
        height: "5",
        // Turned by 30°, as computed.
        style: "transform: matrix(0.866, 0.5, -0.5, 0.866, 0, 0)",
      }),
    ]);
    const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
    const s = scene([svg("defs", {}, [cp]), rect], [rect]);
    // Inverted from where (5, 2) lands, (3.33, 4.232).
    assert.deepEqual(
      clipBoxOf(meshesUnder(s.objects[0])[0]),
      [6.66, 8.464, -999993.34, -999991.536],
    );
    s.teardown();
  });

  test("a symbol's clip-path outside its viewport leaves nothing showing", () => {
    // Right of the viewport the use gives the symbol, so the two share nothing.
    const cp = clipPath([svg("rect", { x: "120", width: "30", height: "100" })]);
    const symbol = svg(
      "symbol",
      { id: "clip-path-own-symbol-apart", "clip-path": url(cp), style: "overflow: hidden" },
      [svg("rect", { width: "200", height: "100", fill: "red" })],
    );
    const use = svg("use", { href: "#clip-path-own-symbol-apart", width: "100", height: "100" });
    const s = scene([svg("defs", {}, [cp, symbol]), use], [use]);
    const [left, top, right, bottom] = clipBoxOf(meshesUnder(s.objects[0])[0]);
    assert.ok(right <= left || bottom <= top, `${[left, top, right, bottom]} has area`);
    s.teardown();
  });

  test("an objectBoundingBox clip on an element with a flat box, turned, leaves nothing", () => {
    const cp = clipPath([svg("rect", { width: "1", height: "1" })], {
      clipPathUnits: "objectBoundingBox",
    });
    const line = svg("line", {
      x1: "10",
      y1: "0",
      x2: "10",
      y2: "100",
      stroke: "black",
      "clip-path": url(cp),
      // Turned by 30°, as computed.
      style: "transform: matrix(0.866, 0.5, -0.5, 0.866, 0, 0)",
    });
    // A vertical line's box has no width.
    /** @type {SVGGraphicsElement} */ (/** @type {unknown} */ (line)).getBBox = () =>
      /** @type {DOMRect} */ ({ x: 10, y: 0, width: 0, height: 100 });
    const s = scene([svg("defs", {}, [cp]), line], [line]);
    const [left, top, right, bottom] = clipBoxOf(meshesUnder(s.objects[0])[0]);
    assert.ok(right <= left || bottom <= top, `${[left, top, right, bottom]} has area`);
    s.teardown();
  });

  test("a symbol's own objectBoundingBox clip is a share of the copy's box", () => {
    const cp = clipPath([svg("rect", { width: "0.5", height: "1" })], {
      clipPathUnits: "objectBoundingBox",
    });
    const symbol = svg("symbol", { id: "clip-path-own-symbol-box", "clip-path": url(cp) }, [
      svg("rect", { width: "100", height: "100", fill: "red" }),
    ]);
    const use = svg("use", { href: "#clip-path-own-symbol-box", width: "40", height: "20" });
    const s = scene([svg("defs", {}, [cp, symbol]), use], [use]);
    // The left half of the 40 by 20 the use gives the copy, doubled.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [0, 0, 40, 40]);
    s.teardown();
  });

  test("a percentage in an svg's own clip-path is of the viewport around the clipPath", () => {
    const cp = clipPath([svg("rect", { width: "50%", height: "100%" })]);
    // A root elsewhere on the page, with no viewport around it.
    const icon = svg(
      "svg",
      { id: "clip-path-own-icon", "clip-path": url(cp), style: "overflow: hidden" },
      [svg("rect", { width: "100", height: "100", fill: "red" })],
    );
    document.body.appendChild(icon);
    const use = svg("use", { href: "#clip-path-own-icon", width: "24", height: "12" });
    const s = scene([svg("defs", {}, [cp]), use], [use]);
    // Half the width and all the height of the 50 by 25 around the
    // clipPath, (0, 0)-(25, 25), met by the copy's 24 by 12, doubled.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [0, 0, 48, 24]);
    s.teardown();
    icon.remove();
  });

  test("an objectBoundingBox clip on a nested svg takes its box out past its x and y", () => {
    const cp = clipPath([svg("rect", { width: "0.5", height: "1" })], {
      clipPathUnits: "objectBoundingBox",
    });
    const rect = svg("rect", { width: "100", height: "100", fill: "red" });
    const nested = svg(
      "svg",
      {
        x: "5",
        y: "2",
        width: "10",
        height: "5",
        "clip-path": url(cp),
        style: "overflow: visible",
      },
      [rect],
    );
    // What a browser reports: its content's box, in its own user space.
    /** @type {SVGGraphicsElement} */ (/** @type {unknown} */ (nested)).getBBox = () =>
      /** @type {DOMRect} */ ({ x: 0, y: 0, width: 100, height: 100 });
    const s = scene([svg("defs", {}, [cp]), nested], [rect]);
    // The left half of (5, 2)-(105, 102), doubled.
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [10, 4, 110, 204]);
    s.teardown();
  });

  test("a clipPath with a title beside its rect still clips to the rect", () => {
    const cp = clipPath([
      svg("title", {}, []),
      svg("rect", { x: "5", y: "2", width: "10", height: "5" }),
    ]);
    const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
    const s = scene([svg("defs", {}, [cp]), rect], [rect]);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), [10, 4, 30, 14]);
    s.teardown();
  });

  test("a marker's own clip-path clips its copies, in its box's frame", () => {
    const cp = clipPath([svg("rect", { x: "1", y: "0", width: "2", height: "1" })]);
    const marker = svg(
      "marker",
      {
        id: "clip-path-own-marker",
        markerWidth: "4",
        markerHeight: "2",
        markerUnits: "userSpaceOnUse",
        "clip-path": url(cp),
      },
      [svg("rect", { width: "20", height: "20", fill: "red" })],
    );
    const line = svg("line", {
      x1: "0",
      y1: "10",
      x2: "20",
      y2: "10",
      stroke: "black",
      "marker-end": url(marker),
    });
    const s = scene([svg("defs", {}, [cp, marker]), line], [line]);
    const markerMesh = s.objects[0].children
      .filter((child) => !(child instanceof THREE.Mesh))
      .flatMap(meshesUnder)[0];
    // The box starts at the line's end, (20, 10), so the rect is (21, 10)–(23, 11).
    assert.deepEqual(clipBoxOf(markerMesh), [42, 20, 46, 22]);
    s.teardown();
  });

  test("any other clipPath, or a missing one, clips nothing", () => {
    /** @type {Element[][]} */
    const contents = [
      [svg("circle", { r: "5" })],
      [svg("rect", { width: "5", height: "5" }), svg("rect", { x: "10", width: "5", height: "5" })],
    ];
    for (const content of contents) {
      const cp = clipPath(content);
      const rect = svg("rect", { width: "100", height: "100", fill: "red", "clip-path": url(cp) });
      const s = scene([svg("defs", {}, [cp]), rect], [rect]);
      assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), OPEN, content[0].outerHTML);
      s.teardown();
    }
    const rect = svg("rect", {
      width: "100",
      height: "100",
      fill: "red",
      "clip-path": "url(#clip-path-missing)",
    });
    const s = scene([rect], [rect]);
    assert.deepEqual(clipBoxOf(meshesUnder(s.objects[0])[0]), OPEN);
    s.teardown();
  });
});
