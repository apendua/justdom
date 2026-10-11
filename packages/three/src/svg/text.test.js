import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createMirror } from "../elements/mirror.js";
import { svgElements } from "./index.js";
import { drawUse } from "./template.js";
import { drawnRange, drawText, layoutScale, measuringScale } from "./text.js";
import { BOX_BUCKET_BIAS } from "../elements/boxBatch.js";
import { getContentRenderOrder } from "../elements/elevation.js";
import { installSvgTextLayout } from "../test/svgTextLayout.js";

/**
 * @import {Mesh, Object3D} from 'three';
 */

// `textHelpers` resolves colours through a bare `getComputedStyle`, which
// jsdom-env installs on `window` and not on the global.
if (typeof globalThis.getComputedStyle === "undefined") {
  globalThis.getComputedStyle = window.getComputedStyle;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {(Node | string)[]} [children]
 * @returns {Element}
 */
function svg(tag, attributes = {}, children = []) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.append(...children);
  return element;
}

/**
 * A root twice the size of its `viewBox` holding `content`, every node
 * adopted, and `draw` drawn through the entry point for it.
 *
 * With `portalOrder`, only the root and `draw` are adopted up front, which
 * is the order a portal builds a `<text>` in: the element first, its
 * children after it. `adoptRest` then adopts the rest, as the portal's walk
 * does once it reaches them.
 *
 * @param {Element[]} content
 * @param {Element} draw
 * @param {{ portalOrder?: boolean, viewBox?: string }} [options]
 */
function scene(content, draw, { portalOrder = false, viewBox = "0 0 50 25" } = {}) {
  const layout = installSvgTextLayout();
  const root = svg("svg", { viewBox }, content);
  root.getBoundingClientRect = () =>
    /** @type {DOMRect} */ ({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 });
  document.body.appendChild(root);
  const mirror = createMirror();
  mirror.adopt(root);
  /** @param {Node} node */
  const adopt = (node) => {
    mirror.adopt(node);
    node.childNodes.forEach(adopt);
  };
  if (portalOrder) {
    mirror.adopt(draw);
  } else {
    root.childNodes.forEach(adopt);
  }
  /** @type {Object3D | undefined} */
  let object;
  const subscription = (
    draw.localName === "use" ? drawUse({}, draw) : drawText({}, draw)
  ).subscribe((value) => {
    object = value;
  });
  assert.ok(object);
  const drawn = object;
  return {
    root,
    mirror,
    object: drawn,
    /** Adopt what `portalOrder` left out, as the portal's walk does. */
    adoptRest() {
      draw.childNodes.forEach(adopt);
    },
    /** One entry per range read: the `transform` the `<text>` had then. */
    transforms: layout.transforms,
    /** Every range made, with the node it points into now. */
    ranges: layout.ranges,
    /** Every measuring svg read: its size, and where it was parked. */
    hosts: layout.hosts,
    /** @returns {Mesh[]} */
    get meshes() {
      /** @type {Mesh[]} */
      const found = [];
      drawn.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          found.push(child);
        }
      });
      return found;
    },
    teardown() {
      subscription.unsubscribe();
      root.remove();
      layout.restore();
    },
  };
}

/**
 * @param {Mesh} mesh
 */
function materialOf(mesh) {
  return /** @type {THREE.MeshBasicMaterial} */ (mesh.material);
}

/**
 * The quad's size, in the `<text>`'s user space.
 *
 * @param {Mesh} mesh
 */
function sizeOf(mesh) {
  mesh.geometry.computeBoundingBox();
  const box = /** @type {THREE.Box3} */ (mesh.geometry.boundingBox);
  return [box.max.x - box.min.x, box.max.y - box.min.y];
}

/**
 * The quad's top-left corner, in the `<text>`'s user space.
 *
 * @param {Mesh} mesh
 */
function cornerOf(mesh) {
  const position = mesh.geometry.getAttribute("position");
  return [position.getX(0), position.getY(0)];
}

describe("drawnRange", () => {
  test("collapsing white space drops it at the ends and folds it inside", () => {
    assert.deepEqual(drawnRange("\n  two   words \t", "normal"), {
      start: 3,
      end: 14,
      text: "two words",
    });
  });

  test("preserved white space is drawn, each tab or line break as a space", () => {
    assert.deepEqual(drawnRange(" a\tb\n", "pre"), { start: 0, end: 5, text: " a b " });
  });

  test("a node of white space alone draws nothing", () => {
    assert.equal(drawnRange(" \n ", "normal"), null);
    assert.equal(drawnRange("", "pre"), null);
  });
});

describe("measuringScale", () => {
  test("a font of 64 units or more is drawn as it is", () => {
    assert.equal(measuringScale(64), 1);
    assert.equal(measuringScale(200), 1);
  });

  test("a smaller one by the power of two that brings it to 64 or more", () => {
    assert.equal(measuringScale(63), 2);
    assert.equal(measuringScale(16), 4);
    assert.equal(measuringScale(0.62), 128);
  });

  test("no more than 1024 times, and once for a font of zero", () => {
    assert.equal(measuringScale(0.01), 1024);
    assert.equal(measuringScale(0), 1);
  });
});

describe("layoutScale", () => {
  test("is the smallest font's, where the measuring svg fits", () => {
    assert.equal(layoutScale(0.62, { width: 1, height: 1 }), 128);
  });

  test("keeps the measuring svg within 2^20 px a side", () => {
    // `font-size: 0.01` in a viewBox 10000 wide asks for 1024, which would
    // make the svg ten million px wide.
    const scale = layoutScale(0.01, { width: 10000, height: 100 });
    assert.equal(scale, 64);
    assert.ok(10000 * scale <= 2 ** 20);
  });
});

describe("svg text", () => {
  test("a run is a quad where the layout put it, in the text's user space, tinted by fill", () => {
    const text = svg("text", { x: "10", y: "20", fill: "red" }, ["Hello"]);
    const s = scene([text], text);
    const [mesh] = s.meshes;
    assert.ok(mesh, "one run");
    // Read relative to the measuring <svg>: x, and the baseline less the
    // ascent the stub gives it.
    assert.deepEqual(cornerOf(mesh), [10, 17]);
    assert.equal(materialOf(mesh).color.getHexString(), "ff0000");
    assert.ok(materialOf(mesh).alphaMap, "drawn as a coverage mask");
    assert.equal(materialOf(mesh).visible, true);
    s.teardown();
  });

  test("a font a fraction of a unit tall is placed as a large one would be", () => {
    // The minesweeper's counts: a 0.62-unit font. Laid out at one pixel per
    // unit, its ascent and descent round to nothing, so the line box sits
    // on the baseline and the glyphs drawn in it hang below.
    const small = svg("text", { x: "0", y: "0.18", "font-size": "0.62", fill: "red" }, ["3"]);
    const s = scene([small], small);
    const [mesh] = s.meshes;
    const [, top] = cornerOf(mesh);
    const [, height] = sizeOf(mesh);
    s.teardown();
    // The same text a hundred times larger, scaled back down.
    const large = svg("text", { x: "0", y: "18", "font-size": "62", fill: "red" }, ["3"]);
    const t = scene([large], large);
    const largeTop = cornerOf(t.meshes[0])[1] / 100;
    const largeHeight = sizeOf(t.meshes[0])[1] / 100;
    t.teardown();
    assert.ok(Math.abs(top - largeTop) < 0.01, `top at ${top}, not ${largeTop}`);
    // Within the texels of bleed a texture is given below its glyphs, which
    // are a few pixels at the size each is drawn at.
    assert.ok(Math.abs(height - largeHeight) < 0.02, `drawn ${height} tall, not ${largeHeight}`);
  });

  test("a small font in a tspan is placed as it is in a text of its own", () => {
    const alone = svg("text", { x: "0", y: "0.18", "font-size": "0.62", fill: "red" }, ["3"]);
    const s = scene([alone], alone);
    const expected = [cornerOf(s.meshes[0]), sizeOf(s.meshes[0])];
    s.teardown();
    const tspan = svg("tspan", { x: "0", y: "0.18", "font-size": "0.62" }, ["3"]);
    const text = svg("text", { "font-size": "64", fill: "red" }, [tspan]);
    const t = scene([text], text);
    assert.deepEqual([cornerOf(t.meshes[0]), sizeOf(t.meshes[0])], expected);
    t.teardown();
  });

  test("a large font in a tspan is drawn as it is in a text of its own", () => {
    // Drawn at the small font's scale, its texture would be read off a font
    // 8192px tall, and its bleed would be 128 times thinner.
    const alone = svg("text", { x: "0", y: "64", "font-size": "64", fill: "red" }, ["3"]);
    const s = scene([alone], alone);
    const expected = sizeOf(s.meshes[0]);
    s.teardown();
    const small = svg("tspan", { x: "0", y: "0.18" }, ["3"]);
    const large = svg("tspan", { x: "10", y: "64", "font-size": "64" }, ["3"]);
    const text = svg("text", { "font-size": "0.62", fill: "red" }, [small, large]);
    const t = scene([text], text);
    assert.deepEqual(sizeOf(t.meshes[1]), expected);
    t.teardown();
  });

  test("the measuring svg stays within 2^20 px a side, parked off the page", () => {
    // A font 0.01 units tall placed by a percentage of a viewport 10000
    // wide. Laid out 8192 times over, the svg would be 81,920,000 px wide,
    // past what Blink lays out in.
    const text = svg("text", { x: "50%", y: "10", "font-size": "0.01", fill: "red" }, ["3"]);
    const s = scene([text], text, { viewBox: "0 0 10000 5000" });
    const [host] = s.hosts;
    s.teardown();
    assert.ok(host.width <= 2 ** 20, `${host.width} px wide`);
    assert.ok(host.height <= 2 ** 20, `${host.height} px tall`);
    // No part of it to the right of the page's left edge or below its top,
    // where it would be scrollable overflow.
    assert.ok(Number.parseFloat(host.left) + host.width < 0, `left at ${host.left}`);
    assert.ok(Number.parseFloat(host.top) + host.height < 0, `top at ${host.top}`);
  });

  test("the text is measured with its own transform off, and the object carries it", () => {
    const text = svg("text", {
      x: "10",
      y: "20",
      fill: "red",
      // `translate(5, 0)`, as computed: jsdom does not resolve it.
      style: "transform: matrix(1, 0, 0, 1, 5, 0)",
    });
    text.append("Hi");
    const s = scene([text], text);
    assert.deepEqual(s.transforms, ["none"], "measured untransformed");
    assert.deepEqual(cornerOf(s.meshes[0]), [10, 17], "in the text's own user space");
    assert.equal(s.object.matrix.elements[12], 5, "the move rides on the object");
    s.teardown();
  });

  test("a percentage is of the viewport the text is in", () => {
    const text = svg("text", { x: "50%", y: "10", fill: "red" }, ["A"]);
    const s = scene([text], text);
    // Half of the root's viewBox, 50 wide.
    assert.deepEqual(cornerOf(s.meshes[0]), [25, 7]);
    s.teardown();
  });

  test("each text node is a run, drawn with its own tspan's fill", () => {
    const text = svg("text", { x: "0", y: "10", fill: "red" }, [
      "A",
      svg("tspan", { x: "20", fill: "blue" }, ["B"]),
    ]);
    const s = scene([text], text);
    const [first, second] = s.meshes;
    assert.deepEqual(cornerOf(first), [0, 7]);
    assert.deepEqual(cornerOf(second), [20, 7]);
    assert.equal(materialOf(first).color.getHexString(), "ff0000");
    assert.equal(materialOf(second).color.getHexString(), "0000ff");
    s.teardown();
  });

  test("a ray meets a run where its fill is painted, and not under fill none", () => {
    const text = svg("text", { x: "10", y: "20", fill: "red" }, ["Hello"]);
    const s = scene([text], text);
    s.object.updateMatrixWorld(true);
    // Off the diagonal the quad's two triangles share, or it counts twice.
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(11, 18, 1),
      new THREE.Vector3(0, 0, -1),
    );
    assert.equal(raycaster.intersectObject(s.object).length, 1);

    text.setAttribute("fill", "none");
    s.mirror.attributeChanged(text);
    assert.equal(raycaster.intersectObject(s.object).length, 0);
    s.teardown();
  });

  test("a ray hits a run by its own fill, not the text's", () => {
    const shown = svg("tspan", { x: "0", fill: "red" }, ["shown"]);
    const unpainted = svg("text", { x: "0", y: "10", fill: "none" }, [shown]);
    const s = scene([unpainted], unpainted);
    s.object.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster(new THREE.Vector3(1, 8, 1), new THREE.Vector3(0, 0, -1));
    assert.equal(raycaster.intersectObject(s.object).length, 1, "the painted tspan is hit");
    s.teardown();

    const hidden = svg("tspan", { x: "0", fill: "none" }, ["none"]);
    const painted = svg("text", { x: "0", y: "10", fill: "red" }, [hidden]);
    const t = scene([painted], painted);
    t.object.updateMatrixWorld(true);
    assert.equal(raycaster.intersectObject(t.object).length, 0, "the unpainted tspan is not");
    t.teardown();
  });

  test("the root's own opacity, and its surroundings', fade the text", () => {
    const text = svg("text", { x: "0", y: "10", fill: "red" }, ["A"]);
    const s = scene([text], text);
    /** @type {SVGElement} */ (s.root).style.opacity = "0.5";
    s.mirror.attributeChanged(s.root);
    assert.equal(materialOf(s.meshes[0]).opacity, 0.5);
    s.teardown();
  });

  test("a fill of none draws nothing", () => {
    const text = svg("text", { x: "0", y: "10", fill: "none" }, ["A"]);
    const s = scene([text], text);
    assert.equal(materialOf(s.meshes[0]).visible, false);
    s.teardown();
  });

  test("an edit to the characters redraws that run, in the order a portal builds", async () => {
    const text = svg("text", { x: "0", y: "10", fill: "red" }, [
      "A",
      svg("tspan", { x: "20" }, ["B"]),
    ]);
    const s = scene([text], text, { portalOrder: true });
    // The runs were read before their nodes had records. The walk adopts
    // them after the `<text>`, and what read them comes round a microtask
    // later (`announceAdoption` in `mirror.js`).
    s.adoptRest();
    await Promise.resolve();
    const [first, second] = s.meshes;
    const before = materialOf(first).alphaMap;
    const untouched = materialOf(second).alphaMap;
    // The same width, so nothing but the characters says it changed.
    const node = /** @type {Text} */ (text.firstChild);
    node.data = "C";
    s.mirror.characterDataChanged(node);
    assert.equal(s.meshes[0], first, "the same mesh");
    assert.notEqual(materialOf(first).alphaMap, before, "drawn again");
    assert.equal(materialOf(second).alphaMap, untouched, "the other run is left alone");

    const tspan = /** @type {Element} */ (text.lastElementChild);
    tspan.setAttribute("x", "30");
    s.mirror.attributeChanged(tspan);
    assert.deepEqual(cornerOf(s.meshes[1]), [30, 7], "a tspan's own attribute is heard");
    assert.equal(materialOf(s.meshes[1]).alphaMap, untouched, "a move is not a redraw");
    s.teardown();
  });

  test("a tspan added mounts its own run and leaves the others as they were", () => {
    const text = svg("text", { x: "0", y: "10", fill: "red" }, ["A"]);
    const s = scene([text], text);
    const [first] = s.meshes;
    const texture = materialOf(first).alphaMap;
    const tspan = svg("tspan", { x: "20" }, ["B"]);
    text.appendChild(tspan);
    s.mirror.adopt(tspan);
    s.mirror.adopt(/** @type {Node} */ (tspan.firstChild));
    s.mirror.childListChanged(text, tspan);
    assert.equal(s.meshes.length, 2);
    assert.equal(s.meshes[0], first, "the first run's mesh stays mounted");
    assert.equal(materialOf(first).alphaMap, texture, "and is not drawn again");
    s.teardown();
  });

  test("every measurement uses the mirror's one range and lets go of the copy", () => {
    // A range is live, so each one the document has handed out is walked on
    // every mutation, and one left in the measuring copy keeps it alive.
    const text = svg("text", { x: "0", y: "10", fill: "red" }, ["A"]);
    const s = scene([text], text);
    const node = /** @type {Text} */ (text.firstChild);
    node.data = "BB";
    s.mirror.characterDataChanged(node);
    assert.equal(s.transforms.length, 2, "measured twice");
    assert.equal(s.ranges.length, 1, "with one range");
    assert.equal(s.ranges[0].container, document, "left pointing at the document");
    s.teardown();
  });

  test("a restyle that changes nothing the layout reads measures nothing", () => {
    const text = svg("text", { x: "0", y: "10", fill: "red" }, ["A"]);
    const s = scene([text], text);
    const reads = s.transforms.length;
    // As the portal reports a hover: a flag of its own, which moves no layout.
    text.setAttribute("data-xr-hover", "");
    s.mirror.attributeChanged(text, { presentational: true, selfScoped: true });
    assert.equal(s.transforms.length, reads);
    s.teardown();
  });

  test("a hover that moves a font's axis measures the text again", () => {
    const text = svg("text", { x: "0", y: "10", fill: "red" }, ["A"]);
    const s = scene([text], text);
    const reads = s.transforms.length;
    // What a `[data-xr-hover]` rule on a variable font does, reported as the
    // portal reports a hover.
    /** @type {SVGElement} */ (text).style.setProperty("font-variation-settings", "'wght' 700");
    s.mirror.attributeChanged(text, { presentational: true, selfScoped: true });
    assert.equal(s.transforms.length, reads + 1);
    s.teardown();
  });

  test("the plugin leaves an a inside a text to the text, and draws one outside", () => {
    const plugin = svgElements();
    const inside = svg("a", { href: "#somewhere" }, ["link"]);
    const outside = svg("a", { href: "#somewhere" });
    svg("svg", {}, [svg("text", {}, [inside]), outside]);
    assert.equal(plugin.element({}, inside), null);
    assert.notEqual(plugin.element({}, outside), null);
  });

  test("text inside an a is drawn like a tspan's", () => {
    const text = svg("text", { x: "0", y: "10", fill: "red" }, [
      svg("a", { href: "#somewhere", x: "20", fill: "blue" }, ["link"]),
    ]);
    const s = scene([text], text);
    const [mesh] = s.meshes;
    assert.ok(mesh, "the link's run");
    assert.equal(materialOf(mesh).color.getHexString(), "0000ff");
    s.teardown();
  });

  test("text in a symbol is drawn by a use, in the use's fill", () => {
    const text = svg("text", { x: "2", y: "8" }, ["Icon"]);
    const symbol = svg("symbol", { id: "text-symbol" }, [text]);
    const use = svg("use", { href: "#text-symbol", x: "10", fill: "red" });
    const s = scene([svg("defs", {}, [symbol]), use], use);
    const [mesh] = s.meshes;
    assert.ok(mesh, "the copy's run");
    assert.deepEqual(cornerOf(mesh), [2, 5]);
    assert.equal(materialOf(mesh).color.getHexString(), "ff0000");
    s.teardown();
  });

  test("a text takes its place in the paint order among the shapes", () => {
    const before = svg("rect", { width: "5", height: "5", fill: "blue" });
    const text = svg("text", { x: "0", y: "10", fill: "red" }, ["A"]);
    const after = svg("rect", { width: "5", height: "5", fill: "blue" });
    const s = scene([before, text, after], text);
    const order = s.meshes[0].renderOrder;
    s.teardown();
    const alone = svg("text", { x: "0", y: "10", fill: "red" }, ["A"]);
    const t = scene([alone], alone);
    assert.notEqual(order, t.meshes[0].renderOrder, "the rect before it moves it on");
    t.teardown();
  });

  test("a text after a shape draws before the boxes at the svg's content level", () => {
    // Night Ops' scribble: an arrow, then "deploy!". A box drawn at the
    // `<svg>`'s content level, there the DONE column it overlaps, draws at that
    // order plus `BOX_BUCKET_BIAS` and writes depth, so a text drawn after it,
    // behind it, is lost.
    const arrow = svg("path", { d: "M0 0 L10 10", stroke: "red" });
    const text = svg("text", { x: "0", y: "10", fill: "red" }, ["deploy!"]);
    const s = scene([arrow, text], text);
    const order = s.meshes[0].renderOrder;
    const level = getContentRenderOrder(
      /** @type {HTMLElement} */ (/** @type {unknown} */ (s.root)),
    );
    s.teardown();
    assert.ok(order > level, "after the root's own content order");
    assert.ok(
      order < level + BOX_BUCKET_BIAS,
      `drawn at ${order}, not before ${level + BOX_BUCKET_BIAS}`,
    );
  });
});
