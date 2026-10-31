import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { clientRect } from "../test/clientRect.js";
import { clipMatrixOf, clipUniformsOf } from "../test/clipUniforms.js";
import * as THREE from "three";
import { UpdateChannel, withChannel } from "@apendua/signal";
import { InteractionContext, InteractionManager, intersectVisible } from "../interactions.js";
import { createMirror } from "../elements/mirror.js";
import { setContentGroup } from "../elements/contentGroup.js";
import { getControlRoot } from "../elements/pointerForwarding.js";
import { bubble, forwardedPanel } from "../test/rays.js";
import { leaveSizesUnmapped } from "../test/unmappedSizes.js";
import { OBSERVER_OPTIONS } from "../elements/portal.js";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { buildFillGeometry, buildShapePath, group, paintSlot, shape } from "./shape.js";
import { parsePoints } from "./style.js";
import { BOX_BUCKET_BIAS } from "../elements/boxBatch.js";
import { getContentRenderOrder } from "../elements/elevation.js";
import { LayerOrderContext } from "../elements/layerOrder.js";

/**
 * @import { Mesh, MeshBasicMaterial, Object3D } from "three";
 * @import { XREventMap } from "../core.js";
 */

// jsdom-env installs the common DOM globals, but not DOMParser, which three's
// SVGLoader parses its document with.
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = window.DOMParser;
}

/**
 * A mirror fed by an observer watching `root` as a portal watches its
 * container, so a write reaches the shapes only if a portal would have
 * reported it. `flush` hands the observer's records to the mirror there and
 * then, where a portal would wait for the observer's microtask.
 *
 * @param {Element} root
 */
function observedMirror(root) {
  const mirror = createMirror();
  const observer = new window.MutationObserver(() => {});
  observer.observe(root, OBSERVER_OPTIONS);
  return {
    mirror,
    flush() {
      mirror.ingest(observer.takeRecords());
    },
    disconnect() {
      observer.disconnect();
    },
  };
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A shape inside an `<svg>` root, wired the way the portal wires one: the
 * root's box measured by a stub, since jsdom lays nothing out, and a mirror
 * fed by an observer watching what a portal's watches.
 *
 * @param {string} tag
 * @param {Record<string, string>} attributes
 * @param {object} [options]
 * @param {string} [options.viewBox]
 * @param {number} [options.width] The root's border-box width, in px.
 * @param {number} [options.height]
 * @param {string} [options.wrap] A `<g>` to put the shape in, as its
 *   attributes.
 * @param {InteractionManager} [options.manager] What the shape registers
 *   itself with, if it is ever clickable. With one, the shape's object is
 *   put under a panel's container, which carries the forwarder a portal
 *   puts on its own.
 * @param {HTMLElement} [options.inside] Where the `<svg>` goes on the page,
 *   adopted with it unless it is the body.
 */
function setup(
  tag,
  attributes,
  { viewBox, width = 100, height = 50, manager, inside = document.body } = {},
) {
  const root = document.createElementNS(SVG_NS, "svg");
  if (viewBox) {
    root.setAttribute("viewBox", viewBox);
  }
  root.getBoundingClientRect = () => clientRect(0, 0, width, height);
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  root.appendChild(element);
  inside.appendChild(root);

  const { mirror, flush, disconnect } = observedMirror(root);
  if (inside !== document.body) {
    mirror.adopt(inside);
  }
  mirror.adopt(root);
  mirror.adopt(element);

  /** @type {Object3D} */
  let object;
  const { ctx, container: panel } = manager
    ? forwardedPanel(InteractionContext.set({}, manager))
    : { ctx: {}, container: null };
  const subscription = shape(ctx, element).subscribe((value) => {
    object = value;
    panel?.add(value);
  });

  return {
    root,
    element,
    mirror,
    flush,
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
      flush();
    },
    teardown() {
      subscription.unsubscribe();
      disconnect();
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
  // `+ 0` folds the -0 a rotation's cosine rounds to into 0.
  return Math.round(value * 1e4) / 1e4 + 0;
}

/**
 * The extent of the clip patch's box, taken back through the clip matrix
 * into the mesh's own user space, where a `clip-path` of the shape's own
 * stands still however the shape moves. All four corners are mapped, so a
 * rotation gives the extent of the rotated box.
 *
 * @param {Mesh} mesh
 */
function localClipOf(mesh) {
  const box = /** @type {THREE.Vector4} */ (clipUniformsOf(mesh).clipBox.value);
  const back = clipMatrixOf(mesh).clone().invert();
  const extent = new THREE.Box2();
  for (const [x, y] of [
    [box.x, box.y],
    [box.z, box.y],
    [box.z, box.w],
    [box.x, box.w],
  ]) {
    const at = new THREE.Vector3(x, y, 1).applyMatrix3(back);
    extent.expandByPoint(new THREE.Vector2(at.x, at.y));
  }
  return {
    left: round(extent.min.x),
    top: round(extent.min.y),
    right: round(extent.max.x),
    bottom: round(extent.max.y),
  };
}

/**
 * The extent of a mesh's vertices in the root's frame: taken through its
 * clip matrix, which is where the clip patch compares them against the box.
 *
 * @param {Mesh} mesh
 */
function rootBounds(mesh) {
  const matrix = clipMatrixOf(mesh);
  const position = mesh.geometry.getAttribute("position");
  const box = new THREE.Box2();
  for (let i = 0; i < position.count; i++) {
    const at = new THREE.Vector3(position.getX(i), position.getY(i), 1).applyMatrix3(matrix);
    box.expandByPoint(new THREE.Vector2(at.x, at.y));
  }
  return {
    left: round(box.min.x),
    top: round(box.min.y),
    right: round(box.max.x),
    bottom: round(box.max.y),
  };
}

/**
 * The 2D part of an object's local matrix, as `[a, b, c, d, e, f]`.
 *
 * @param {Object3D} object
 */
function matrix2d(object) {
  const e = object.matrix.elements;
  return [e[0], e[1], e[4], e[5], e[12], e[13]].map(round);
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

  test("the viewBox scales user space into the root's box, through the clip matrix", () => {
    // A 10×5 box in a 100×50 root: ten px per user unit. The vertices stay
    // in user units — the root's content group carries the viewport — and
    // the clip is told how to get from them to the root's px.
    const s = setup(
      "rect",
      { x: "1", y: "1", width: "2", height: "1", fill: "red" },
      { viewBox: "0 0 10 5" },
    );
    assert.deepEqual(bounds(s.meshes[0]), { left: 1, top: 1, right: 3, bottom: 2 });
    assert.deepEqual(rootBounds(s.meshes[0]), { left: 10, top: 10, right: 30, bottom: 20 });
    assert.deepEqual(matrix2d(s.object), [1, 0, 0, 1, 0, 0], "the shape itself is not moved");
    s.teardown();
  });

  test("a shape's own transform is its object's matrix, not its vertices", () => {
    const s = setup("rect", {
      x: "0",
      y: "0",
      width: "10",
      height: "10",
      fill: "red",
      // Written as the computed value Chromium reports for the attribute
      // `translate(20 5) scale(2)`: jsdom maps no presentation attribute
      // into computed style, and the computed style is what is read.
      style: "transform: matrix(2, 0, 0, 2, 20, 5)",
    });
    assert.deepEqual(bounds(s.meshes[0]), { left: 0, top: 0, right: 10, bottom: 10 });
    assert.deepEqual(matrix2d(s.object), [2, 0, 0, 2, 20, 5]);
    assert.deepEqual(rootBounds(s.meshes[0]), { left: 20, top: 5, right: 40, bottom: 25 });

    // Moving it is a matrix write: the same geometry, drawn somewhere else.
    const geometry = s.meshes[0].geometry;
    s.setAttribute("style", "transform: matrix(2, 0, 0, 2, 30, 5)");
    assert.deepEqual(matrix2d(s.object), [2, 0, 0, 2, 30, 5]);
    assert.equal(s.meshes[0].geometry, geometry, "a translation re-samples nothing");
    assert.deepEqual(rootBounds(s.meshes[0]), { left: 30, top: 5, right: 50, bottom: 25 });
    s.teardown();
  });

  test("a move reaches the matrix and the clip together, under a budget of one effect", () => {
    // A clip-path of the shape's own moves with it, so a move changes all
    // three: the object's matrix, the clip matrix and the clip box. A panel
    // that is not atomic runs its effects under a budget, and a clock that
    // moves a whole budget per effect stops every pass after one of them.
    // No pass is let off the budget for having been cut short before.
    let time = 0;
    const channel = new UpdateChannel({
      manual: true,
      now: () => time++,
      maxStalePasses: Infinity,
    });
    const s = withChannel(channel, () =>
      setup("rect", {
        width: "40",
        height: "10",
        fill: "red",
        "clip-path": "url(#one-frame)",
        style: "transform: matrix(1, 0, 0, 1, 0, 0)",
      }),
    );
    const frame = document.createElementNS(SVG_NS, "rect");
    frame.setAttribute("width", "10");
    frame.setAttribute("height", "10");
    const clipPath = document.createElementNS(SVG_NS, "clipPath");
    clipPath.id = "one-frame";
    clipPath.appendChild(frame);
    s.root.appendChild(clipPath);
    s.flush();
    channel.flush({ budget: Infinity });
    const [fill] = s.meshes;
    assert.deepEqual(localClipOf(fill), { left: 0, top: 0, right: 10, bottom: 10 });

    s.setAttribute("style", "transform: matrix(1, 0, 0, 1, -10, 0)");
    let passes = 0;
    while (channel.hasPendingUpdates) {
      channel.flush({ budget: 1 });
      passes += 1;
      const [a, b, c, d, e, f] = matrix2d(s.object);
      const m = clipMatrixOf(fill).elements;
      assert.deepEqual(
        [a, b, c, d, e, f],
        [m[0], m[1], m[3], m[4], m[6], m[7]].map(round),
        `after pass ${passes}, the clip matrix is the matrix the mesh is drawn with`,
      );
      assert.deepEqual(
        localClipOf(fill),
        { left: 0, top: 0, right: 10, bottom: 10 },
        `after pass ${passes}, the clip is where the clip-path is`,
      );
    }
    assert.deepEqual(matrix2d(s.object), [1, 0, 0, 1, -10, 0]);
    s.teardown();
  });

  test("a change to the chain that leaves the matrix alone does not commit it again", () => {
    const s = setup("rect", { width: "10", height: "10", fill: "red", style: "opacity: 1" });
    s.object.matrixWorldNeedsUpdate = false;
    s.setAttribute("style", "opacity: 0.5");
    assert.equal(material(s.meshes[0]).opacity, 0.5, "the change reached the shape");
    assert.equal(
      s.object.matrixWorldNeedsUpdate,
      false,
      "three is not asked to recompute the world matrices under the shape",
    );
    s.teardown();
  });

  test("scaling re-samples curves only when it crosses a rung of the ladder", () => {
    const s = setup("circle", {
      cx: "0",
      cy: "0",
      r: "5",
      fill: "red",
      style: "transform: matrix(1.1, 0, 0, 1.1, 0, 0)",
    });
    const first = s.meshes[0].geometry;
    s.setAttribute("style", "transform: matrix(1.2, 0, 0, 1.2, 0, 0)");
    assert.equal(s.meshes[0].geometry, first, "1.1 and 1.2 sample alike");
    s.setAttribute("style", "transform: matrix(4, 0, 0, 4, 0, 0)");
    assert.notEqual(s.meshes[0].geometry, first, "four times larger is sampled finer");
    assert.ok(
      s.meshes[0].geometry.getAttribute("position").count > first.getAttribute("position").count,
    );
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

  test("a percentage length is a share of the viewport the shape is in", () => {
    // A 10 by 5 viewBox: x and width are shares of 10, y and height of 5.
    const rect = setup(
      "rect",
      { x: "10%", y: "20%", width: "100%", height: "50%", fill: "red" },
      { viewBox: "0 0 10 5" },
    );
    assert.deepEqual(bounds(rect.meshes[0]), { left: 1, top: 1, right: 11, bottom: 3.5 });
    // Without a viewBox, the root's content box, 100 by 50 px.
    rect.root.removeAttribute("viewBox");
    rect.flush();
    assert.deepEqual(bounds(rect.meshes[0]), { left: 10, top: 10, right: 110, bottom: 35 });
    rect.teardown();

    // A radius is a share of the viewport's diagonal over root two: 50 for a
    // 10 by 70 viewBox, so 10% is 5.
    const circle = setup(
      "circle",
      { cx: "50%", cy: "50%", r: "10%", fill: "red" },
      { viewBox: "0 0 10 70" },
    );
    assertBounds(bounds(circle.meshes[0]), { left: 0, top: 30, right: 10, bottom: 40 });
    circle.teardown();

    const line = setup(
      "line",
      { x1: "0", y1: "50%", x2: "100%", y2: "50%", stroke: "red", "stroke-width": "2" },
      { viewBox: "0 0 30 40" },
    );
    const stroked = line.meshes.filter((mesh) => mesh.geometry.getAttribute("position").count > 0);
    assert.equal(stroked.length, 1, "the line's stroke");
    assertBounds(bounds(stroked[0]), { left: 0, top: 19, right: 30, bottom: 21 });
    line.teardown();
  });

  test("a percentage stroke width and dash are shares of the viewport's diagonal", () => {
    // A 100 by 100 viewBox: its diagonal over root two is 100, so 2% is 2
    // units and 10% is 10.
    const s = setup(
      "line",
      {
        x1: "0",
        y1: "50",
        x2: "100",
        y2: "50",
        stroke: "black",
        "stroke-width": "2%",
        "stroke-dasharray": "10%",
        "stroke-dashoffset": "5%",
      },
      { viewBox: "0 0 100 100" },
    );
    const stroke = s.meshes.find((mesh) => mesh.geometry.getAttribute("position").count > 0);
    assert.ok(stroke);
    assertBounds(bounds(stroke), { left: 0, top: 49, right: 100, bottom: 51 });
    // Ten-unit dashes and gaps, shifted back by five: half a dash at 0 to
    // 5, whole ones from 15, 35, 55 and 75, and half of one from 95. Each
    // dash is a quad of two triangles.
    assert.equal(stroke.geometry.getAttribute("position").count, 6 * 6);
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

  test("an element around the <svg> fades its shapes", () => {
    const card = document.createElement("div");
    card.style.opacity = "0.5";
    document.body.appendChild(card);
    const s = setup(
      "rect",
      { x: "0", y: "0", width: "10", height: "10", fill: "red" },
      {
        inside: card,
      },
    );
    assert.equal(material(s.meshes[0]).opacity, 0.5);
    s.teardown();
    card.remove();
  });

  test("an opacity animated around the <svg> does not re-walk the matrices", () => {
    // The clock reports an opacity animation as the element's own, which
    // restyles nothing under it; only the product it fades by moves.
    const card = document.createElement("div");
    document.body.appendChild(card);
    const s = setup(
      "rect",
      { x: "0", y: "0", width: "10", height: "10", fill: "red" },
      {
        inside: card,
      },
    );
    assert.equal(material(s.meshes[0]).opacity, 1);
    let walks = 0;
    const getAttribute = s.root.getAttribute.bind(s.root);
    s.root.getAttribute = (name) => {
      if (name === "viewBox") {
        walks += 1;
      }
      return getAttribute(name);
    };

    card.style.opacity = "0.5";
    s.mirror.animatedStyles([card], { subtree: false });
    assert.equal(material(s.meshes[0]).opacity, 0.5, "the shape fades");
    assert.equal(walks, 0, "and the chain up to the root is not walked again");
    s.teardown();
    card.remove();
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
    root.getBoundingClientRect = () => clientRect(0, 0, 100, 50);
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
    const { mirror, flush, disconnect } = observedMirror(root);
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
    flush();
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
    // Inside the first half of the root's content level, the last element's
    // markers included, so all of it draws before a box at that level.
    const level = getContentRenderOrder(/** @type {HTMLElement} */ (/** @type {unknown} */ (root)));
    assert.ok(firstFill.renderOrder > level, "after the root's own content order");
    const end = paintSlot(second, root, null, 2).start;
    assert.ok(end < level + BOX_BUCKET_BIAS, `the last layer at ${end}, not before the boxes`);

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
    disconnect();
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
    root.getBoundingClientRect = () => clientRect(0, 0, 100, 50);
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

  test("a <g> that moves leaves its shapes' geometry alone", () => {
    const root = document.createElementNS(SVG_NS, "svg");
    root.setAttribute("viewBox", "0 0 50 25");
    root.getBoundingClientRect = () => clientRect(0, 0, 100, 50);
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("style", "transform: matrix(1, 0, 0, 1, 10, 0)");
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("width", "5");
    rect.setAttribute("height", "5");
    rect.setAttribute("fill", "red");
    rect.setAttribute("stroke", "blue");
    g.appendChild(rect);
    root.appendChild(g);
    document.body.appendChild(root);
    const { mirror, flush, disconnect } = observedMirror(root);
    for (const node of [root, g, rect]) {
      mirror.adopt(node);
    }
    /** @type {Object3D | undefined} */
    let groupObject;
    /** @type {Object3D | undefined} */
    let shapeObject;
    const subscriptions = [
      group({}, g).subscribe((value) => {
        groupObject = value;
      }),
      shape({}, rect).subscribe((value) => {
        shapeObject = value;
      }),
    ];
    assert.ok(groupObject && shapeObject);
    const meshes = /** @type {Mesh[]} */ (shapeObject.children);
    const geometries = meshes.map((mesh) => mesh.geometry);
    assert.deepEqual(matrix2d(groupObject), [1, 0, 0, 1, 10, 0], "the group carries its move");
    // Twice the viewBox, then the group's 10 units: 20px in.
    assert.deepEqual(rootBounds(meshes[0]), { left: 20, top: 0, right: 30, bottom: 10 });

    // Every frame of a transform animation on the group, in miniature.
    // `translate(20 5) rotate(90)`, as computed.
    g.setAttribute("style", "transform: matrix(0, 1, -1, 0, 20, 5)");
    flush();
    assert.deepEqual(matrix2d(groupObject), [0, 1, -1, 0, 20, 5]);
    assert.deepEqual(
      meshes.map((mesh) => mesh.geometry),
      geometries,
      "one matrix write: the buffers under the group are the same objects",
    );
    assert.deepEqual(matrix2d(shapeObject), [1, 0, 0, 1, 0, 0]);
    // The clip follows: the rect's corner (5, 5) is now at (20 - 5, 5 + 5)
    // in user units, (30, 20) in the root's px.
    assert.deepEqual(rootBounds(meshes[0]), { left: 30, top: 10, right: 40, bottom: 20 });

    // And the world matrix three composes agrees with the clip matrix.
    const content = new THREE.Object3D();
    content.matrixAutoUpdate = false;
    content.matrix.makeScale(2, 2, 1);
    content.add(groupObject);
    groupObject.add(shapeObject);
    content.updateMatrixWorld(true);
    const corner = new THREE.Vector3(5, 5, 0).applyMatrix4(meshes[0].matrixWorld);
    const clipped = new THREE.Vector3(5, 5, 1).applyMatrix3(clipMatrixOf(meshes[0]));
    assert.deepEqual([round(corner.x), round(corner.y)], [round(clipped.x), round(clipped.y)]);

    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    disconnect();
    root.remove();
  });

  /**
   * The matrix a nested `<svg>`'s group carries, inside a root drawn 100 by
   * 50 px.
   *
   * @param {Record<string, string>} attributes The nested `<svg>`'s.
   * @param {string} [rootViewBox]
   */
  function nestedSvgMatrix(attributes, rootViewBox) {
    const root = document.createElementNS(SVG_NS, "svg");
    if (rootViewBox) {
      root.setAttribute("viewBox", rootViewBox);
    }
    root.getBoundingClientRect = () => clientRect(0, 0, 100, 50);
    const inner = document.createElementNS(SVG_NS, "svg");
    for (const [name, value] of Object.entries(attributes)) {
      inner.setAttribute(name, value);
    }
    root.appendChild(inner);
    document.body.appendChild(root);
    const mirror = createMirror();
    mirror.adopt(root);
    mirror.adopt(inner);
    /** @type {Object3D | undefined} */
    let object;
    const subscription = group({}, inner).subscribe((value) => {
      object = value;
    });
    assert.ok(object);
    const matrix = matrix2d(object);
    subscription.unsubscribe();
    root.remove();
    return matrix;
  }

  test("a nested svg is a group whose matrix is its viewport", () => {
    assert.deepEqual(
      nestedSvgMatrix({ x: "10", y: "20", width: "40", height: "20", viewBox: "0 0 4 2" }),
      [10, 0, 0, 10, 10, 20],
    );
  });

  test("a nested svg of auto or percentage size fits its viewBox to the viewport around it", () => {
    // No size: the whole 10 by 5 of the root's viewBox, which a 4 by 2
    // viewBox fills at 2.5 times.
    assert.deepEqual(nestedSvgMatrix({ viewBox: "0 0 4 2" }, "0 0 10 5"), [2.5, 0, 0, 2.5, 0, 0]);
    // Half the width, all the height: 5 by 5, met at 1.25 and centred on y.
    assert.deepEqual(
      nestedSvgMatrix({ width: "50%", viewBox: "0 0 4 2" }, "0 0 10 5"),
      [1.25, 0, 0, 1.25, 0, 1.25],
    );
  });

  test("a nested svg's size attributes hold when the browser computes them as auto", () => {
    // Chromium 152 does, and draws the attributes' size all the same.
    const restore = leaveSizesUnmapped();
    try {
      assert.deepEqual(
        nestedSvgMatrix({ x: "10", y: "20", width: "40", height: "20", viewBox: "0 0 4 2" }),
        [10, 0, 0, 10, 10, 20],
      );
      // With no attribute, `auto` is still the whole viewport around it.
      assert.deepEqual(nestedSvgMatrix({ viewBox: "0 0 4 2" }, "0 0 10 5"), [2.5, 0, 0, 2.5, 0, 0]);
    } finally {
      restore();
    }
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

describe("svg shape as a ray target", () => {
  /**
   * An interaction manager that records what it is handed, as the div
   * tests use one. The test is about which object the shape registers and
   * when, not what the manager does with it.
   */
  function recordingManager() {
    /** @type {string[]} */
    const registrations = [];
    /** @type {Object3D[]} */
    const registered = [];
    const manager = /** @type {InteractionManager} */ (
      /** @type {unknown} */ ({
        /** @param {Object3D} object */
        add: (object) => {
          registrations.push("add");
          registered.push(object);
        },
        /** @param {Object3D} object */
        remove: (object) => {
          registrations.push("remove");
          registered.splice(registered.indexOf(object), 1);
        },
        stopPropagation: () => {},
      })
    );
    return { manager, registrations, registered };
  }

  /**
   * A shape's meshes in the order they are drawn, fill before stroke. The
   * object's children can be in another order, because a fill that arrives
   * later is added after the stroke, and the draw order is what counts.
   *
   * @param {{ meshes: Mesh[] }} s
   * @returns {Mesh[]}
   */
  function drawn(s) {
    return [...s.meshes].sort((a, b) => a.renderOrder - b.renderOrder);
  }

  /** A 20px square at (10, 10), filled and with a 2px stroke. */
  const SQUARE = {
    x: "10",
    y: "10",
    width: "20",
    height: "20",
    fill: "red",
    stroke: "blue",
    "stroke-width": "2",
  };

  /**
   * The meshes a ray from in front of the point (x, y) meets, each once,
   * found by the interaction manager's own walk.
   *
   * @param {Object3D} object
   * @param {number} x
   * @param {number} y
   * @returns {Object3D[]}
   */
  function hitsAt(object, x, y) {
    object.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1));
    /** @type {THREE.Intersection<Object3D<XREventMap>>[]} */
    const intersections = [];
    intersectVisible(raycaster, /** @type {Object3D<XREventMap>} */ (object), intersections);
    // A mesh is met once per triangle, and a ray down a diagonal meets two.
    return [...new Set(intersections.map((intersection) => intersection.object))];
  }

  test("a shape is a ray target only under cursor: pointer, and follows it", () => {
    const { manager, registrations, registered } = recordingManager();
    const s = setup("rect", SQUARE, { manager });
    assert.deepEqual(registrations, []);

    s.setAttribute("style", "cursor: pointer");
    assert.deepEqual(registrations, ["add"]);
    assert.deepEqual(registered, [s.object]);

    // A restyle that leaves the answer alone does not churn it.
    s.setAttribute("style", "cursor: pointer; opacity: 0.5");
    assert.deepEqual(registrations, ["add"]);

    s.setAttribute("style", null);
    assert.deepEqual(registrations, ["add", "remove"]);
    s.teardown();
  });

  test("a shape no ray can hit is not registered, cursor or not", () => {
    const { manager, registrations } = recordingManager();
    const s = setup(
      "rect",
      { ...SQUARE, style: "cursor: pointer; pointer-events: none" },
      { manager },
    );
    assert.deepEqual(registrations, []);

    s.setAttribute("style", "cursor: pointer");
    assert.deepEqual(registrations, ["add"]);

    // Hidden, under the default `visiblePainted`, is out of reach too.
    s.setAttribute("style", "cursor: pointer; visibility: hidden");
    assert.deepEqual(registrations, ["add", "remove"]);
    s.teardown();
  });

  test("a shape's control is found through a <g>, which has no content group", () => {
    // What decides whether a ray moving onto the shape arrives on a new
    // control: the unbroken run of clickable elements above it, as objects.
    // jsdom inherits no `cursor`, so each element says it for itself.
    const root = document.createElementNS(SVG_NS, "svg");
    const g = document.createElementNS(SVG_NS, "g");
    const rect = document.createElementNS(SVG_NS, "rect");
    for (const element of [root, g, rect]) {
      element.setAttribute("style", "cursor: pointer");
    }
    root.appendChild(g);
    g.appendChild(rect);
    document.body.appendChild(root);

    // The `<svg>` is a box with a content group; the `<g>` is an object the
    // `<rect>` hangs straight off.
    const rootObject = new THREE.Object3D();
    const content = new THREE.Object3D();
    rootObject.add(content);
    setContentGroup(rootObject, content);
    const gObject = new THREE.Object3D();
    content.add(gObject);
    const rectObject = new THREE.Object3D();
    gObject.add(rectObject);

    assert.equal(
      getControlRoot(/** @type {HTMLElement} */ (/** @type {Element} */ (rect)), rectObject),
      rootObject,
    );
    root.remove();
  });

  test("a ray through two overlapping shapes on a panel in paint order lands on the later", () => {
    // Both are level with each other, and the later one in paint order is
    // drawn over the earlier. Goes red with the shapes left out of the hit
    // test's draw order (`registerDrawOrder`), which takes the first found.
    const manager = new InteractionManager();
    // A panel in paint order, as far as a shape asks: whether it has a
    // layer order at all.
    const inPaintOrder = LayerOrderContext.set(
      InteractionContext.set({}, manager),
      /** @type {never} */ ({}),
    );
    const { ctx, container: panel } = forwardedPanel(inPaintOrder);
    const root = document.createElementNS(SVG_NS, "svg");
    root.getBoundingClientRect = () => clientRect(0, 0, 20, 20);
    const [under, over] = [0, 1].map(() => {
      const rect = document.createElementNS(SVG_NS, "rect");
      const square = { x: "-5", y: "-5", width: "10", height: "10", fill: "red" };
      for (const [name, value] of Object.entries(square)) {
        rect.setAttribute(name, value);
      }
      rect.setAttribute("style", "cursor: pointer");
      root.appendChild(rect);
      return rect;
    });
    document.body.appendChild(root);
    const { mirror, disconnect } = observedMirror(root);
    for (const node of [root, under, over]) {
      mirror.adopt(node);
    }
    /** @type {Map<Element, Object3D>} */
    const objects = new Map();
    const subscriptions = [under, over].map((rect) =>
      shape(ctx, rect).subscribe((value) => {
        objects.set(rect, value);
        panel.add(value);
      }),
    );
    panel.position.z = -5;
    panel.updateMatrixWorld(true);

    const controller = /** @type {THREE.XRTargetRaySpace} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    const hit = manager.getIntersection(controller);
    assert.ok(hit, "the ray meets the shapes");
    assert.strictEqual(manager.getTarget(hit.object), objects.get(over));

    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    disconnect();
    root.remove();
  });

  test("a clickable <g> is hovered and pressed with the shape the ray is on", () => {
    // `.node:hover rect` on a page: the ray is on the `<rect>`, and the
    // `<g>` around it is hovered too, as every clickable box around a
    // hovered one is. jsdom inherits no `cursor`, so each says it itself.
    const { manager, registered } = recordingManager();
    const { ctx, container: panel } = forwardedPanel(InteractionContext.set({}, manager));
    const root = document.createElementNS(SVG_NS, "svg");
    const g = document.createElementNS(SVG_NS, "g");
    const rect = document.createElementNS(SVG_NS, "rect");
    g.setAttribute("style", "cursor: pointer");
    for (const [name, value] of Object.entries({ ...SQUARE, style: "cursor: pointer" })) {
      rect.setAttribute(name, value);
    }
    g.appendChild(rect);
    root.appendChild(g);
    document.body.appendChild(root);
    const { mirror, disconnect } = observedMirror(root);
    for (const node of [root, g, rect]) {
      mirror.adopt(node);
    }
    /** @type {Object3D | undefined} */
    let gObject;
    /** @type {Object3D | undefined} */
    let rectObject;
    const subscriptions = [
      group(ctx, g).subscribe((value) => {
        gObject = value;
      }),
      shape(ctx, rect).subscribe((value) => {
        rectObject = value;
      }),
    ];
    assert.ok(gObject && rectObject);
    gObject.add(rectObject);
    panel.add(gObject);

    const controller = new THREE.Object3D();
    /** @param {string} type */
    const dispatch = (type) => {
      bubble(/** @type {Object3D} */ (rectObject), { type, controller });
    };
    const gData = /** @type {SVGElement} */ (g).dataset;
    const rectData = /** @type {SVGElement} */ (rect).dataset;

    dispatch("pointerenter");
    assert.equal(rectData.xrHover, "true");
    assert.equal(gData.xrHover, "true", "the <g> is hovered too");
    dispatch("selectstart");
    assert.equal(gData.xrActive, "true");
    dispatch("selectend");
    assert.equal(gData.xrActive, undefined);
    dispatch("pointerleave");
    assert.equal(gData.xrHover, undefined);
    assert.ok(registered.includes(gObject), "the <g> is a ray target");

    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    disconnect();
    root.remove();
  });

  test("a hit through a clickable <g> is a hit on a shape a ray can hit", () => {
    // A clickable `<g>` is registered, so the manager walks its subtree. What
    // that walk meets is still decided by each shape: its own
    // `pointer-events`, and a shape that is not clickable itself (a
    // `cursor: default` label) is reached through the group, as on a page.
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const root = document.createElementNS(SVG_NS, "svg");
    const g = document.createElementNS(SVG_NS, "g");
    const rect = document.createElementNS(SVG_NS, "rect");
    g.setAttribute("style", "cursor: pointer");
    for (const [name, value] of Object.entries(SQUARE)) {
      rect.setAttribute(name, value);
    }
    g.appendChild(rect);
    root.appendChild(g);
    document.body.appendChild(root);
    const { mirror, flush, disconnect } = observedMirror(root);
    for (const node of [root, g, rect]) {
      mirror.adopt(node);
    }
    /** @type {Object3D | undefined} */
    let gObject;
    /** @type {Object3D | undefined} */
    let rectObject;
    const subscriptions = [
      group(ctx, g).subscribe((value) => {
        gObject = value;
      }),
      shape(ctx, rect).subscribe((value) => {
        rectObject = value;
      }),
    ];
    assert.ok(gObject && rectObject);
    gObject.add(rectObject);
    const g3 = /** @type {Object3D<XREventMap>} */ (gObject);
    const rect3 = /** @type {Object3D<XREventMap>} */ (rectObject);

    // The label is not clickable itself: the hit belongs to the group.
    const [fill] = hitsAt(g3, 20, 20);
    assert.ok(fill && fill.parent === rect3, "the walk from the group meets the rect");
    assert.equal(manager.getTarget(/** @type {Object3D<XREventMap>} */ (fill)), g3);

    // Clickable itself, the rect is the innermost registered object.
    rect.setAttribute("style", "cursor: pointer");
    flush();
    assert.equal(manager.getTarget(/** @type {Object3D<XREventMap>} */ (fill)), rect3);

    // And it still decides whether it can be hit at all.
    rect.setAttribute("style", "cursor: pointer; pointer-events: none");
    flush();
    assert.deepEqual(hitsAt(g3, 20, 20), [], "pointer-events: none under a clickable <g>");

    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    disconnect();
    root.remove();
  });

  test("a press on a shape reaches its element as a box's does", () => {
    const { manager } = recordingManager();
    const s = setup("rect", { ...SQUARE, style: "cursor: pointer" }, { manager });
    /** @type {string[]} */
    const events = [];
    for (const type of ["mousedown", "mouseup", "click", "mousemove"]) {
      s.element.addEventListener(type, (event) => {
        events.push(`${event.type} on ${/** @type {Element} */ (event.target).localName}`);
      });
    }
    const controller = new THREE.Object3D();
    /** @param {string} type */
    const dispatch = (type) => {
      bubble(s.object, { type, controller });
    };
    const dataset = /** @type {SVGElement} */ (s.element).dataset;

    dispatch("pointerenter");
    assert.equal(dataset.xrHover, "true");
    dispatch("pointermove");
    dispatch("selectstart");
    assert.equal(dataset.xrActive, "true");
    dispatch("selectend");
    assert.equal(dataset.xrActive, undefined);
    dispatch("select");
    assert.deepEqual(events, [
      "mousemove on rect",
      "mousedown on rect",
      "mouseup on rect",
      "click on rect",
    ]);

    // Held and hovered when it stops being clickable. The handler that
    // would have cleared the flags is gone, so the teardown clears them.
    dispatch("selectstart");
    s.setAttribute("style", null);
    assert.equal(dataset.xrHover, undefined);
    assert.equal(dataset.xrActive, undefined);
    s.teardown();
  });

  // These tests set `pointer-events` through `style`. jsdom computes it as
  // `auto` whatever the attribute says, where a browser folds the
  // presentation attribute into the computed value.
  test("a ray meets the fill and the stroke, and nothing under pointer-events: none", () => {
    const s = setup("rect", SQUARE);
    const [fill, stroke] = s.meshes;
    assert.deepEqual(hitsAt(s.object, 20, 20), [fill]);
    // On the edge, where the stroke covers the fill's border.
    assert.deepEqual(new Set(hitsAt(s.object, 10.5, 20)), new Set([fill, stroke]));
    assert.deepEqual(hitsAt(s.object, 9.5, 20), [stroke]);
    assert.deepEqual(hitsAt(s.object, 50, 20), []);

    s.setAttribute("style", "pointer-events: none");
    assert.deepEqual(hitsAt(s.object, 20, 20), []);
    assert.deepEqual(hitsAt(s.object, 9.5, 20), []);
    // Still drawn, since pointer-events decides hits and not paint.
    assert.equal(fill.visible && material(fill).visible, true);
    s.teardown();
  });

  test("pointer-events: stroke leaves the inside to what is behind, and fill the edge", () => {
    const s = setup("rect", { ...SQUARE, style: "pointer-events: stroke" });
    const [, stroke] = s.meshes;
    assert.deepEqual(hitsAt(s.object, 20, 20), []);
    assert.deepEqual(hitsAt(s.object, 9.5, 20), [stroke]);

    s.setAttribute("style", "pointer-events: fill");
    const [fill] = s.meshes;
    assert.deepEqual(hitsAt(s.object, 20, 20), [fill]);
    assert.deepEqual(hitsAt(s.object, 9.5, 20), []);
    s.teardown();
  });

  test("an unpainted fill is hit under pointer-events: all, and still not drawn", () => {
    const s = setup("rect", { ...SQUARE, fill: "none" });
    assert.equal(s.meshes.length, 1, "only the stroke, by default");
    assert.deepEqual(hitsAt(s.object, 20, 20), []);

    s.setAttribute("style", "pointer-events: all");
    assert.equal(s.meshes.length, 2);
    const [fill] = drawn(s);
    assert.deepEqual(hitsAt(s.object, 20, 20), [fill]);
    assert.equal(material(fill).visible, false);

    // `transparent` is a paint, so the default hits it. That is how a page
    // makes an invisible shape clickable.
    s.setAttribute("style", null);
    s.setAttribute("fill", "transparent");
    assert.deepEqual(hitsAt(s.object, 20, 20), [drawn(s)[0]]);
    s.teardown();
  });

  test("a hidden shape is out of the rays by default, and in them under painted", () => {
    const s = setup("rect", { ...SQUARE, style: "visibility: hidden" });
    assert.deepEqual(hitsAt(s.object, 20, 20), []);

    s.setAttribute("style", "visibility: hidden; pointer-events: painted");
    const [fill] = s.meshes;
    assert.deepEqual(hitsAt(s.object, 20, 20), [fill]);
    assert.equal(material(fill).visible, false, "hit, and still hidden");
    s.teardown();
  });

  test("a ray is trimmed where the clip patch trims the drawing, through the viewBox", () => {
    // Twice the size under the `viewBox`, so the square covers (20, 20) to
    // (60, 60) of a root 50px tall, so its lower part is outside the root.
    const s = setup("rect", SQUARE, { viewBox: "0 0 50 25", width: 100, height: 50 });
    s.root.style.overflow = "hidden";
    s.flush();
    const [fill] = s.meshes;
    // The shape's object carries none of the viewport; place it as the
    // root's content group would.
    const content = new THREE.Object3D();
    content.scale.set(2, 2, 1);
    content.add(s.object);
    content.updateMatrixWorld(true);

    assert.deepEqual(hitsAt(content, 40, 30), [fill]);
    assert.deepEqual(hitsAt(content, 40, 55), [], "below the root's bottom edge");
    s.teardown();
  });

  test("a ray is trimmed where a clip-path trims the drawing", () => {
    const s = setup("rect", SQUARE);
    // The left half of the square.
    const edge = document.createElementNS(SVG_NS, "rect");
    edge.setAttribute("x", "10");
    edge.setAttribute("y", "10");
    edge.setAttribute("width", "10");
    edge.setAttribute("height", "20");
    const clipPath = document.createElementNS(SVG_NS, "clipPath");
    clipPath.id = "ray-clip-path";
    clipPath.appendChild(edge);
    s.root.appendChild(clipPath);
    s.setAttribute("clip-path", "url(#ray-clip-path)");
    const [fill] = s.meshes;

    assert.deepEqual(hitsAt(s.object, 15, 20), [fill]);
    assert.deepEqual(hitsAt(s.object, 25, 20), [], "right of the clip");
    s.teardown();
  });

  test("a hover that switches the fill on puts it under the stroke", () => {
    const { manager } = recordingManager();
    const s = setup("rect", { ...SQUARE, fill: "none", style: "cursor: pointer" }, { manager });
    // From a hand, as every ray event is.
    bubble(s.object, { type: "pointerenter", controller: new THREE.Object3D() });
    assert.equal(/** @type {SVGElement} */ (s.element).dataset.xrHover, "true");

    // What a `[data-xr-hover] { fill: … }` rule does to the computed style.
    s.setAttribute("fill", "red");
    const [fill, stroke] = drawn(s);
    assert.equal(material(fill).visible, true);
    assert.ok(fill.renderOrder < stroke.renderOrder, "the new fill under the old stroke");
    assert.equal(Math.floor(fill.renderOrder), Math.floor(stroke.renderOrder));
    assert.equal(/** @type {SVGElement} */ (s.element).dataset.xrHover, "true", "still hovered");
    s.teardown();
  });
});

describe("a shape's outline", () => {
  /**
   * What a path's outline is made of: per subpath, its kinds of curve, its
   * closing and the points it samples to, which is all the fill and the
   * stroke read of it.
   *
   * @param {THREE.ShapePath | null} path
   */
  const outline = (path) =>
    path?.subPaths.map((subPath) => ({
      curves: subPath.curves.map((curve) => curve.type),
      autoClose: subPath.autoClose,
      points: subPath.getPoints(8).map(({ x, y }) => [x, y]),
    }));

  /** @param {string} markup */
  const loaded = (markup) =>
    new SVGLoader().parse(`<svg xmlns="${SVG_NS}">${markup}</svg>`).paths[0];

  test("each kind of shape is built as three's loader builds it", () => {
    /** @type {[import("./style.js").ShapeGeometry, string][]} */
    const cases = [
      [
        { kind: "rect", x: 1, y: 2, width: 10, height: 5, rx: 0, ry: 0 },
        '<rect x="1" y="2" width="10" height="5" rx="0" ry="0"/>',
      ],
      [
        { kind: "rect", x: 1, y: 2, width: 10, height: 5, rx: 2, ry: 1.5 },
        '<rect x="1" y="2" width="10" height="5" rx="2" ry="1.5"/>',
      ],
      [{ kind: "circle", cx: 5, cy: -3, r: 4.25 }, '<circle cx="5" cy="-3" r="4.25"/>'],
      [{ kind: "ellipse", cx: 0, cy: 1, rx: 4, ry: 2 }, '<ellipse cx="0" cy="1" rx="4" ry="2"/>'],
      [{ kind: "line", x1: 1, y1: 2, x2: 3.5, y2: -4 }, '<line x1="1" y1="2" x2="3.5" y2="-4"/>'],
      [{ kind: "polyline", points: [0, 0, 10, 0, 5, 0.5] }, '<polyline points="0,0 10,0 5,5e-1"/>'],
      [{ kind: "polygon", points: [0, 0, 10, 0, 5, 5] }, '<polygon points="0 0 10 0 5 5"/>'],
      [{ kind: "path", d: "M0 0 A5 5 0 0 1 10 0 Z" }, '<path d="M0 0 A5 5 0 0 1 10 0 Z"/>'],
      // A quote in a `d` is escaped on its way into the document the loader
      // parses, and the loader reads the path up to it.
      [{ kind: "path", d: 'M0 0 L10 0 L10 10 Z "' }, '<path d="M0 0 L10 0 L10 10 Z"/>'],
    ];
    for (const [geometry, markup] of cases) {
      const built = buildShapePath(geometry);
      assert.ok(built, markup);
      assert.deepEqual(outline(built), outline(loaded(markup)), markup);
    }
  });

  test("a points list is read as a browser reads it, where the loader shifts its pairs", () => {
    // A comma and then a space between the numbers of a pair: the loader
    // takes one separator only, and pairs `0, 0 10, 0 5, 5` as (0,10),(0,5).
    const geometry = /** @type {const} */ ({
      kind: "polygon",
      points: parsePoints("0, 0 10, 0 5, 5") ?? [],
    });
    assert.deepEqual(
      outline(buildShapePath(geometry)),
      outline(loaded('<polygon points="0,0 10,0 5,5"/>')),
    );
  });

  test("a shape that moves is rebuilt without the loader; a path is parsed once per d", (t) => {
    const parse = t.mock.method(SVGLoader.prototype, "parse");
    for (const [tag, attributes, name] of /** @type {const} */ ([
      ["circle", { cx: "5", cy: "5", r: "4", fill: "red" }, "cx"],
      ["ellipse", { cx: "5", cy: "5", rx: "4", ry: "2", fill: "red" }, "cy"],
      ["rect", { x: "0", y: "0", width: "10", height: "10", fill: "red" }, "x"],
      ["line", { x1: "0", y1: "0", x2: "10", y2: "10", stroke: "red" }, "x2"],
      ["polygon", { points: "0,0 10,0 5,5", fill: "red" }, "points"],
    ])) {
      const s = setup(tag, attributes);
      for (const value of ["1", "2", "3"]) {
        s.setAttribute(name, name === "points" ? `${value},0 10,0 5,5` : value);
      }
      s.teardown();
    }
    assert.equal(parse.mock.callCount(), 0, "no simple shape was written out and parsed");

    // The parsed paths are cached for the whole process, so these two `d`s
    // are this test's own: no other test may draw them, or the count below
    // would find one already parsed.
    const first = "M0 0 H21.0625 V11.0625 Z";
    const second = "M0 0 H41.0625 V11.0625 Z";
    const s = setup("path", { d: first, fill: "red" });
    s.setAttribute("d", second);
    s.setAttribute("d", first);
    assert.equal(parse.mock.callCount(), 2, "each d is parsed once, and found again after");
    s.teardown();
  });
});

describe("how finely a curve is sampled", () => {
  // three's loader draws a circle as two arcs, so a circle has twice as
  // many points on its edge as each arc has segments, and a fill one more
  // for its centre.
  const circle = new SVGLoader().parse(
    `<svg xmlns="${SVG_NS}"><circle cx="0" cy="0" r="10"/></svg>`,
  ).paths[0];
  /** @param {number} scale */
  const edge = (scale) => {
    const geometry = /** @type {THREE.BufferGeometry} */ (
      buildFillGeometry(circle, "nonzero", scale)
    );
    return geometry.getAttribute("position").count - 1;
  };

  test("a circle drawn at a user unit a px has 48 points on its edge", () => {
    assert.equal(edge(1), 48);
  });

  test("never fewer than 32, however small it is drawn", () => {
    assert.equal(edge(0.01), 32);
  });

  test("and never more than 256, however large", () => {
    assert.equal(edge(1000), 256);
  });
});
