import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createMirror } from "../elements/mirror.js";
import { PortalTemplatesContext } from "../elements/plugins.js";
import { svgElements } from "./index.js";
import { drawUse } from "./template.js";
import { drawnRange, drawText } from "./text.js";

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
 * jsdom lays nothing out, so text is laid out here: each run starts at its
 * parent's `x` and sits on its `y` as a baseline, every character 2 units
 * wide and the line 4 tall, and a percentage `x` is of the measuring
 * `<svg>`'s width. The measuring `<svg>` reports itself at
 * (1000, 500), as an off-screen one would, so a run is read relative to it.
 * Every range read also records the `transform` of the `<text>` it measured
 * in.
 *
 * @returns {{ transforms: string[], restore: () => void }}
 */
function installLayout() {
  /** @type {string[]} */
  const transforms = [];
  const originalRange = document.createRange;
  const originalRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    const element = /** @type {Element} */ (this);
    const host =
      element.localName === "svg" &&
      /** @type {SVGElement} */ (element).style.getPropertyValue("left") === "-99999px";
    return /** @type {DOMRect} */ (
      host
        ? { left: 1000, top: 500, right: 1000, bottom: 500, width: 0, height: 0 }
        : originalRect.call(element)
    );
  };
  document.createRange = () => {
    /** @type {Node | null} */
    let container = null;
    let start = 0;
    let end = 0;
    return /** @type {Range} */ (
      /** @type {unknown} */ ({
        setStart: (/** @type {Node} */ node, /** @type {number} */ offset) => {
          container = node;
          start = offset;
        },
        setEnd: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
          end = offset;
        },
        getBoundingClientRect: () => {
          const parent = /** @type {Element} */ (container?.parentNode);
          const text = /** @type {SVGElement} */ (parent.closest("text"));
          transforms.push(text.style.getPropertyValue("transform"));
          const host = /** @type {Element} */ (text.parentNode);
          const raw = parent.getAttribute("x") ?? text.getAttribute("x") ?? "0";
          // A percentage of the measuring <svg>'s width, as a browser would.
          const x = raw.endsWith("%")
            ? (Number.parseFloat(raw) / 100) * Number(host.getAttribute("width"))
            : Number(raw);
          const y = Number(parent.getAttribute("y") ?? text.getAttribute("y") ?? 0);
          return {
            left: 1000 + x + start * 2,
            top: 500 + y - 3,
            right: 1000 + x + end * 2,
            bottom: 500 + y + 1,
            width: (end - start) * 2,
            height: 4,
          };
        },
      })
    );
  };
  return {
    transforms,
    restore() {
      document.createRange = originalRange;
      window.Element.prototype.getBoundingClientRect = originalRect;
    },
  };
}

/**
 * A root twice the size of its `viewBox` holding `content`, every node
 * adopted, and `draw` drawn through the entry point for it.
 *
 * With `portalOrder`, only the root and `draw` are adopted up front, and the
 * rest only when the drawing asks the portal's `PortalTemplatesContext` to
 * adopt it, which is the order a portal builds a `<text>` in: the element
 * first, its children after it.
 *
 * @param {Element[]} content
 * @param {Element} draw
 * @param {{ portalOrder?: boolean }} [options]
 */
function scene(content, draw, { portalOrder = false } = {}) {
  const layout = installLayout();
  const root = svg("svg", { viewBox: "0 0 50 25" }, content);
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
  const ctx = PortalTemplatesContext.set({}, adopt);
  /** @type {Object3D | undefined} */
  let object;
  const subscription = (
    draw.localName === "use" ? drawUse(ctx, draw) : drawText(ctx, draw)
  ).subscribe((value) => {
    object = value;
  });
  assert.ok(object);
  const drawn = object;
  return {
    root,
    mirror,
    object: drawn,
    /** One entry per range read: the `transform` the `<text>` had then. */
    transforms: layout.transforms,
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

  test("an edit to the characters redraws that run, in the order a portal builds", () => {
    const text = svg("text", { x: "0", y: "10", fill: "red" }, [
      "A",
      svg("tspan", { x: "20" }, ["B"]),
    ]);
    const s = scene([text], text, { portalOrder: true });
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
});
