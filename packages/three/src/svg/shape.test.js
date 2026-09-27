import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createMirror } from "../elements/mirror.js";
import { shape } from "./shape.js";

/**
 * @import { Mesh, MeshBasicMaterial, Object3D } from "three";
 */

// jsdom-env installs the common DOM globals, but not DOMParser, which three's
// SVGLoader parses its document with.
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = window.DOMParser;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A shape inside an `<svg>` root, wired the way the portal wires one: the
 * root's box measured by a stub, since jsdom lays nothing out, and a mirror
 * standing in for the portal's own so an attribute change can be announced.
 *
 * @param {string} tag
 * @param {Record<string, string>} attributes
 * @param {object} [options]
 * @param {string} [options.viewBox]
 * @param {number} [options.width] The root's border-box width, in px.
 * @param {number} [options.height]
 * @param {string} [options.wrap] A `<g>` to put the shape in, as its
 *   attributes.
 */
function setup(tag, attributes, { viewBox, width = 100, height = 50 } = {}) {
  const root = document.createElementNS(SVG_NS, "svg");
  if (viewBox) {
    root.setAttribute("viewBox", viewBox);
  }
  root.getBoundingClientRect = () =>
    /** @type {DOMRect} */ ({
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  root.appendChild(element);
  document.body.appendChild(root);

  const mirror = createMirror();
  mirror.adopt(root);
  mirror.adopt(element);

  /** @type {Object3D} */
  let object;
  const subscription = shape({}, element).subscribe((value) => {
    object = value;
  });

  return {
    root,
    element,
    subscription,
    get object() {
      return object;
    },
    /** @returns {Mesh[]} */
    get meshes() {
      return /** @type {Mesh[]} */ (object.children.filter((child) => child instanceof THREE.Mesh));
    },
    /**
     * @param {string} name
     * @param {string | null} value
     */
    setAttribute(name, value) {
      if (value === null) {
        element.removeAttribute(name);
      } else {
        element.setAttribute(name, value);
      }
      mirror.attributeChanged(element);
    },
    teardown() {
      subscription.unsubscribe();
      root.remove();
    },
  };
}

/**
 * The extent of a mesh's vertices.
 *
 * @param {Mesh} mesh
 */
function bounds(mesh) {
  const position = mesh.geometry.getAttribute("position");
  const box = new THREE.Box2();
  for (let i = 0; i < position.count; i++) {
    box.expandByPoint(new THREE.Vector2(position.getX(i), position.getY(i)));
  }
  return {
    left: round(box.min.x),
    top: round(box.min.y),
    right: round(box.max.x),
    bottom: round(box.max.y),
  };
}

/**
 * @param {number} value
 */
function round(value) {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Bounds within a tolerance: a curve is sampled, so its extent is a few
 * hundredths off the ideal, and a mitred corner overshoots by as much.
 *
 * @param {ReturnType<typeof bounds>} actual
 * @param {ReturnType<typeof bounds>} expected
 * @param {number} [tolerance]
 */
function assertBounds(actual, expected, tolerance = 0.1) {
  for (const key of /** @type {const} */ (["left", "top", "right", "bottom"])) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) <= tolerance,
      `${key}: ${actual[key]}, expected ${expected[key]} ± ${tolerance}`,
    );
  }
}

/**
 * @param {Mesh} mesh
 */
function material(mesh) {
  return /** @type {MeshBasicMaterial} */ (mesh.material);
}

describe("svg shape", () => {
  test("a filled rect is one mesh covering the rect, in the root's px", () => {
    const s = setup("rect", { x: "10", y: "10", width: "30", height: "20", fill: "red" });
    assert.equal(s.meshes.length, 1);
    const [fill] = s.meshes;
    assert.deepEqual(bounds(fill), { left: 10, top: 10, right: 40, bottom: 30 });
    assert.equal(material(fill).color.getHexString(), "ff0000");
    assert.equal(material(fill).opacity, 1);
    assert.equal(material(fill).side, THREE.DoubleSide);
    assert.equal(material(fill).depthWrite, false);
    s.teardown();
  });

  test("the viewBox scales user space into the root's box", () => {
    // A 10×5 box in a 100×50 root: ten px per user unit.
    const s = setup(
      "rect",
      { x: "1", y: "1", width: "2", height: "1", fill: "red" },
      { viewBox: "0 0 10 5" },
    );
    assert.deepEqual(bounds(s.meshes[0]), { left: 10, top: 10, right: 30, bottom: 20 });
    s.teardown();
  });

  test("a stroke is a second mesh, half its width outside the fill", () => {
    const s = setup("rect", {
      x: "10",
      y: "10",
      width: "30",
      height: "20",
      fill: "red",
      stroke: "blue",
      "stroke-width": "4",
    });
    assert.equal(s.meshes.length, 2);
    const [fill, stroke] = s.meshes;
    assert.deepEqual(bounds(fill), { left: 10, top: 10, right: 40, bottom: 30 });
    assert.deepEqual(bounds(stroke), { left: 8, top: 8, right: 42, bottom: 32 });
    assert.equal(material(stroke).color.getHexString(), "0000ff");
    // Fill first, stroke after: at equal render order and depth the sort
    // falls back to id, and the stroke has to cover the fill's edge.
    assert.ok(stroke.id > fill.id);
    assert.ok(stroke.renderOrder > fill.renderOrder);
    assert.equal(Math.floor(stroke.renderOrder), Math.floor(fill.renderOrder));
    s.teardown();
  });

  test("fill: none leaves only the stroke", () => {
    const s = setup("circle", { cx: "50", cy: "25", r: "10", fill: "none", stroke: "black" });
    assert.equal(s.meshes.length, 1);
    const [stroke] = s.meshes;
    assertBounds(bounds(stroke), { left: 39.5, top: 14.5, right: 60.5, bottom: 35.5 });
    s.teardown();
  });

  test("a line has no fill to draw, only its stroke", () => {
    const s = setup("line", { x1: "0", y1: "25", x2: "100", y2: "25", stroke: "black" });
    // The default fill is black and a line encloses nothing, so the fill
    // mesh is there and empty; the stroke is the one with vertices.
    const drawn = s.meshes.filter((mesh) => mesh.geometry.getAttribute("position").count > 0);
    assert.equal(drawn.length, 1);
    assert.deepEqual(bounds(drawn[0]), { left: 0, top: 24.5, right: 100, bottom: 25.5 });
    s.teardown();
  });

  test("a dashed line is stroked in pieces", () => {
    const s = setup("line", {
      x1: "0",
      y1: "25",
      x2: "10",
      y2: "25",
      stroke: "black",
      "stroke-width": "1",
      "stroke-dasharray": "1 1",
    });
    const stroke = s.meshes.find((mesh) => mesh.geometry.getAttribute("position").count > 0);
    assert.ok(stroke);
    // Five dashes of a ten-unit line, each a butt-capped quad of two
    // triangles.
    assert.equal(stroke.geometry.getAttribute("position").count, 5 * 6);
    s.teardown();
  });

  test("a dotted line under round caps draws its dots", () => {
    const s = setup("line", {
      x1: "0",
      y1: "25",
      x2: "10",
      y2: "25",
      stroke: "black",
      "stroke-width": "2",
      "stroke-dasharray": "0 5",
      "stroke-linecap": "round",
    });
    const stroke = s.meshes.find((mesh) => mesh.geometry.getAttribute("position").count > 0);
    assert.ok(stroke, "zero-length dashes with round caps draw something");
    // Dots at 0, 5 and 10, each a stroke's width across — the last one on
    // the line's end, where the browser draws it too.
    assertBounds(bounds(stroke), { left: -1, top: 24, right: 11, bottom: 26 });
    s.teardown();
  });

  test("square caps on a dashed line cap every dash", () => {
    // The stroker's square caps rewrite vertices by absolute index, which
    // is what made a dashed line stroked into one shared buffer throw; each
    // dash is stroked on its own and grows half a width at both ends.
    const s = setup("line", {
      x1: "0",
      y1: "25",
      x2: "10",
      y2: "25",
      stroke: "black",
      "stroke-width": "2",
      "stroke-dasharray": "2 2",
      "stroke-linecap": "square",
    });
    const stroke = s.meshes.find((mesh) => mesh.geometry.getAttribute("position").count > 0);
    assert.ok(stroke);
    assert.equal(stroke.geometry.getAttribute("position").count, 3 * 6);
    assertBounds(bounds(stroke), { left: -1, top: 24, right: 11, bottom: 26 });
    s.teardown();
  });

  test("the geometry follows the attributes", () => {
    const s = setup("rect", { x: "0", y: "0", width: "10", height: "10", fill: "red" });
    const before = s.meshes[0].geometry;
    s.setAttribute("width", "50");
    assert.deepEqual(bounds(s.meshes[0]), { left: 0, top: 0, right: 50, bottom: 10 });
    assert.notEqual(s.meshes[0].geometry, before, "the geometry was rebuilt");
    s.teardown();
  });

  test("a path's d is followed too, and an empty one draws nothing", () => {
    const s = setup("path", { d: "M0 0 H20 V10 Z", fill: "red" });
    assert.deepEqual(bounds(s.meshes[0]), { left: 0, top: 0, right: 20, bottom: 10 });
    s.setAttribute("d", "M0 0 H40 V10 Z");
    assert.deepEqual(bounds(s.meshes[0]), { left: 0, top: 0, right: 40, bottom: 10 });
    s.setAttribute("d", null);
    assert.equal(s.meshes[0].geometry.getAttribute("position").count, 0);
    s.teardown();
  });

  test("the colour follows the style without rebuilding the geometry", () => {
    const s = setup("rect", { x: "0", y: "0", width: "10", height: "10", fill: "red" });
    const geometry = s.meshes[0].geometry;
    s.setAttribute("fill", "blue");
    assert.equal(material(s.meshes[0]).color.getHexString(), "0000ff");
    assert.equal(s.meshes[0].geometry, geometry, "the geometry was kept");
    s.setAttribute("fill", "none");
    assert.equal(s.meshes.length, 0, "no fill, no fill mesh");
    s.setAttribute("fill", "red");
    assert.equal(s.meshes.length, 1);
    s.teardown();
  });

  test("opacities multiply into the material", () => {
    const s = setup("rect", {
      x: "0",
      y: "0",
      width: "10",
      height: "10",
      fill: "rgba(255, 0, 0, 0.5)",
      "fill-opacity": "0.5",
    });
    assert.equal(material(s.meshes[0]).opacity, 0.25);
    s.teardown();
  });

  test("the even-odd rule leaves a hole", () => {
    // Two nested squares wound the same way: nonzero fills the whole outer
    // square, evenodd leaves the inner one empty — fewer triangles.
    const d = "M0 0 H40 V40 H0 Z M10 10 H30 V30 H10 Z";
    const nonzero = setup("path", { d, fill: "red" });
    const evenodd = setup("path", { d, fill: "red", "fill-rule": "evenodd" });
    const area = (/** @type {Mesh} */ mesh) => {
      const position = mesh.geometry.getAttribute("position");
      const index = mesh.geometry.getIndex();
      let total = 0;
      const count = index ? index.count : position.count;
      for (let i = 0; i < count; i += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => (index ? index.getX(i + k) : i + k));
        const ax = position.getX(a);
        const ay = position.getY(a);
        total +=
          Math.abs(
            (position.getX(b) - ax) * (position.getY(c) - ay) -
              (position.getX(c) - ax) * (position.getY(b) - ay),
          ) / 2;
      }
      return round(total);
    };
    assert.equal(area(nonzero.meshes[0]), 1600);
    assert.equal(area(evenodd.meshes[0]), 1200);
    nonzero.teardown();
    evenodd.teardown();
  });

  test("shapes keep document order in the draw order, whatever order their meshes were made in", () => {
    // Two rects under one root; the first has no fill to begin with, so its
    // fill mesh is created after the second's. With a shared render order
    // three would fall back to mesh id and draw it on top; the fraction from
    // document order keeps it underneath.
    const root = document.createElementNS(SVG_NS, "svg");
    root.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 });
    const first = document.createElementNS(SVG_NS, "rect");
    first.setAttribute("width", "10");
    first.setAttribute("height", "10");
    first.setAttribute("fill", "none");
    first.setAttribute("stroke", "black");
    const second = document.createElementNS(SVG_NS, "rect");
    second.setAttribute("width", "10");
    second.setAttribute("height", "10");
    second.setAttribute("fill", "red");
    root.append(first, second);
    document.body.appendChild(root);
    const mirror = createMirror();
    mirror.adopt(root);
    mirror.adopt(first);
    mirror.adopt(second);
    /** @type {Object3D[]} */
    const objects = [];
    const subscriptions = [first, second].map((el, i) =>
      shape({}, el).subscribe((value) => {
        objects[i] = value;
      }),
    );
    const meshesOf = (/** @type {Object3D} */ object) =>
      /** @type {Mesh[]} */ (object.children.filter((child) => child instanceof THREE.Mesh));

    first.setAttribute("fill", "blue");
    mirror.attributeChanged(first);
    // The fill mesh arrived after the stroke's, so it is the later child;
    // tell them apart by colour rather than by position.
    const firstMeshes = meshesOf(objects[0]);
    const firstFill = /** @type {Mesh} */ (
      firstMeshes.find((mesh) => material(mesh).color.getHexString() === "0000ff")
    );
    const firstStroke = /** @type {Mesh} */ (firstMeshes.find((mesh) => mesh !== firstFill));
    const [secondFill] = meshesOf(objects[1]);
    assert.ok(firstFill.id > secondFill.id, "the first rect's fill mesh was made later");
    assert.ok(firstFill.renderOrder < firstStroke.renderOrder, "fill under its own stroke");
    assert.ok(firstStroke.renderOrder < secondFill.renderOrder, "the first rect under the second");
    const base = Math.floor(secondFill.renderOrder);
    assert.ok(secondFill.renderOrder < base + 1, "all of it inside the root's own step");

    // A shape inserted before both takes the bottom, and the others move up.
    const zeroth = document.createElementNS(SVG_NS, "rect");
    zeroth.setAttribute("width", "10");
    zeroth.setAttribute("height", "10");
    zeroth.setAttribute("fill", "green");
    root.insertBefore(zeroth, first);
    mirror.adopt(zeroth);
    mirror.childListChanged(root, zeroth);
    /** @type {Object3D | undefined} */
    let zerothObject;
    subscriptions.push(
      shape({}, zeroth).subscribe((value) => {
        zerothObject = value;
      }),
    );
    assert.ok(zerothObject);
    const [zerothFill] = meshesOf(zerothObject);
    assert.ok(
      zerothFill.renderOrder < meshesOf(objects[0])[0].renderOrder,
      "inserted first, drawn first",
    );

    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    root.remove();
  });

  test("visibility hides the meshes, and a shape that says visible is drawn under a hidden group", () => {
    const s = setup("rect", { x: "0", y: "0", width: "10", height: "10", fill: "red" });
    assert.equal(s.meshes[0].visible, true);
    s.setAttribute("style", "visibility: hidden");
    assert.equal(s.meshes[0].visible, false, "a hidden shape draws nothing");
    assert.equal(s.object.visible, true, "and its object stays, as a box's does");
    s.setAttribute("style", null);
    assert.equal(s.meshes[0].visible, true);
    s.teardown();

    // Inherited from a group, and overridden by the shape.
    const root = document.createElementNS(SVG_NS, "svg");
    root.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 });
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("style", "visibility: hidden");
    const inherits = document.createElementNS(SVG_NS, "rect");
    const overrides = document.createElementNS(SVG_NS, "rect");
    for (const rect of [inherits, overrides]) {
      rect.setAttribute("width", "10");
      rect.setAttribute("height", "10");
      rect.setAttribute("fill", "red");
      group.appendChild(rect);
    }
    overrides.setAttribute("style", "visibility: visible");
    root.appendChild(group);
    document.body.appendChild(root);
    const mirror = createMirror();
    for (const node of [root, group, inherits, overrides]) {
      mirror.adopt(node);
    }
    /** @type {Object3D[]} */
    const objects = [];
    const subscriptions = [inherits, overrides].map((el, i) =>
      shape({}, el).subscribe((value) => {
        objects[i] = value;
      }),
    );
    const fillOf = (/** @type {Object3D} */ object) =>
      /** @type {Mesh} */ (object.children.find((child) => child instanceof THREE.Mesh));
    assert.equal(fillOf(objects[0]).visible, false, "hidden by its group");
    assert.equal(fillOf(objects[1]).visible, true, "visible for itself");
    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    root.remove();
  });

  test("teardown disposes what it made", () => {
    const s = setup("rect", {
      x: "0",
      y: "0",
      width: "10",
      height: "10",
      fill: "red",
      stroke: "blue",
    });
    const disposed = /** @type {string[]} */ ([]);
    for (const mesh of s.meshes) {
      mesh.geometry.addEventListener("dispose", () => disposed.push("geometry"));
      material(mesh).addEventListener("dispose", () => disposed.push("material"));
    }
    s.teardown();
    assert.deepEqual(disposed.sort(), ["geometry", "geometry", "material", "material"]);
  });
});
