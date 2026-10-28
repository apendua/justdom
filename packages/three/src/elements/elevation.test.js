import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "@apendua/signal";
import {
  bandBase,
  drawInPaintOrder,
  ELEVATION_BAND,
  getContentRenderOrder,
  getDrawLevel,
  getElevation,
  getLayer,
  getLayerBase,
  getRenderBand,
  isOverlay,
  isPaintOrdered,
  PIECE_BAND,
  setLayerBase,
} from "./elevation.js";
import { createMirror } from "./mirror.js";
import { PORTAL_ATTRIBUTE } from "./portalRoot.js";
import { clientRect } from "../test/clientRect.js";

/**
 * @param {string} cssText
 * @param {HTMLElement} [parent]
 * @returns {HTMLElement}
 */
function element(cssText, parent = document.body) {
  const el = document.createElement("div");
  el.style.cssText = cssText;
  parent.appendChild(el);
  return el;
}

describe("isOverlay", () => {
  test("an ordinary box is not one", () => {
    assert.equal(isOverlay(element("")), false);
  });

  test("being positioned is not enough on its own", () => {
    // A badge pinned to a corner overlaps nothing and wants no layer.
    assert.equal(isOverlay(element("position: absolute; top: 0")), false);
  });

  test("a stacking order is not enough on its own either", () => {
    // `z-index` on a static element does nothing on the web, and nothing here.
    assert.equal(isOverlay(element("z-index: 1")), false);
  });

  test("positioned and stacked above is an overlay", () => {
    assert.equal(isOverlay(element("position: absolute; z-index: 1")), true);
    assert.equal(isOverlay(element("position: fixed; z-index: 2")), true);
    assert.equal(isOverlay(element("position: relative; z-index: 1000")), true);
  });

  test("stacked below is not, whatever the position", () => {
    assert.equal(isOverlay(element("position: absolute; z-index: -1")), false);
    assert.equal(isOverlay(element("position: absolute; z-index: 0")), false);
  });
});

describe("getElevation", () => {
  test("nothing in a plain tree is elevated", () => {
    const panel = element("");
    const button = element("", panel);
    assert.equal(getElevation(panel), 0);
    assert.equal(getElevation(button), 0);
  });

  test("an overlay counts itself, and everything inside it inherits", () => {
    const panel = element("");
    const menu = element("position: absolute; z-index: 1", panel);
    const option = element("cursor: pointer", menu);

    assert.equal(getElevation(panel), 0);
    assert.equal(getElevation(menu), 1);
    assert.equal(getElevation(option), 1);
  });

  test("layers stack by nesting rather than by how big the number is", () => {
    const modal = element("position: fixed; z-index: 10");
    const body = element("", modal);
    const menu = element("position: absolute; z-index: 1", body);

    assert.equal(getElevation(modal), 1);
    assert.equal(getElevation(body), 1);
    assert.equal(getElevation(menu), 2);
  });

  test("a restyle above reaches a reader only when the count changes", () => {
    // A box reads its count every time it is styled. A list restyled when
    // its rows change, as a list is, used to run every row's again, and a
    // row that had left the panel was then styled from a node out of the
    // document.
    const panel = element("");
    const menu = element("", panel);
    const option = element("", menu);
    const mirror = createMirror();
    for (const node of [panel, menu, option]) {
      mirror.adopt(node);
    }
    let runs = 0;
    const reader = new Effect(() => {
      runs += 1;
      getElevation(option);
    });

    menu.style.color = "rgb(1, 2, 3)";
    mirror.attributeChanged(menu);
    assert.equal(runs, 1, "a restyle that leaves the count as it was");

    menu.style.cssText = "position: absolute; z-index: 1";
    mirror.attributeChanged(menu);
    assert.equal(runs, 2, "and one that makes it an overlay");
    assert.equal(getElevation(option), 1);

    reader.dispose();
    panel.remove();
  });
});

describe("getContentRenderOrder", () => {
  test("an element's content draws after its own box, before its child's content", () => {
    const panel = element("");
    const button = element("", panel);

    // The box's own figure is elevation·ELEVATION_BAND + draw level, which
    // is the ancestor count here. Content is one deeper, counted from the
    // element itself.
    assert.equal(getContentRenderOrder(button), getContentRenderOrder(panel) + 1);
    assert.ok(getContentRenderOrder(panel) > 0);
  });

  test("an overlay's content draws in the overlay's band", () => {
    const panel = element("");
    const menu = element("position: absolute; z-index: 1", panel);

    assert.ok(getContentRenderOrder(menu) >= ELEVATION_BAND);
    assert.ok(getContentRenderOrder(menu) - getContentRenderOrder(panel) >= ELEVATION_BAND);
  });
});

/**
 * An element of a panel's page, laid out where `at` says: left, top, width
 * and height. jsdom lays nothing out.
 *
 * @typedef {object} Spec
 * @property {string} id
 * @property {string} [style]
 * @property {[number, number, number, number]} at
 * @property {string} [text]
 * @property {Spec[]} [children]
 */

/**
 * A panel's page under a 400 by 300 root, mirrored, and drawn in paint
 * order unless `lifted`.
 *
 * @param {Spec[]} children
 * @param {object} [options]
 * @param {boolean} [options.lifted] Leave the panel to the step.
 */
function page(children, { lifted = false } = {}) {
  const root = document.createElement("div");
  root.setAttribute(PORTAL_ATTRIBUTE, "");
  root.getBoundingClientRect = () => clientRect(0, 0, 400, 300);
  /** @type {Map<string, HTMLElement>} */
  const elements = new Map();
  /**
   * @param {HTMLElement} parent
   * @param {Spec} spec
   */
  const build = (parent, spec) => {
    const el = document.createElement("div");
    el.style.cssText = spec.style ?? "";
    if (spec.text) {
      el.textContent = spec.text;
    }
    el.getBoundingClientRect = () => clientRect(...spec.at);
    elements.set(spec.id, el);
    parent.appendChild(el);
    for (const child of spec.children ?? []) {
      build(el, child);
    }
  };
  for (const child of children) {
    build(root, child);
  }
  document.body.appendChild(root);
  if (!lifted) {
    drawInPaintOrder(root);
  }
  const mirror = createMirror();
  mirror.adopt(root);
  for (const el of elements.values()) {
    mirror.adopt(el);
  }
  return {
    root,
    mirror,
    /** @param {string} id */
    get: (id) => /** @type {HTMLElement} */ (elements.get(id)),
    remove: () => root.remove(),
  };
}

/** A transform that takes a box out of its parent's plane. */
const SWUNG = "matrix3d(0.866, 0, -0.5, 0, 0, 1, 0, 0, 0.5, 0, 0.866, 0, 0, 0, 0, 1)";
const OPAQUE_CARD = "position: absolute; background-color: rgb(255, 255, 255)";

describe("a panel drawn in paint order", () => {
  test("is the one whose root asked, and every element in it", () => {
    const ordered = page([{ id: "card", at: [0, 0, 100, 100] }]);
    const lifted = page([{ id: "card", at: [0, 0, 100, 100] }], { lifted: true });
    try {
      assert.equal(isPaintOrdered(ordered.root), true);
      assert.equal(isPaintOrdered(ordered.get("card")), true);
      assert.equal(isPaintOrdered(lifted.root), false);
      assert.equal(isPaintOrdered(lifted.get("card")), false);
    } finally {
      ordered.remove();
      lifted.remove();
    }
  });

  test("makes a layer of its root, an overlay and a box swung out of its plane", () => {
    const { root, get, remove } = page([
      {
        id: "menu",
        style: "position: absolute; z-index: 1",
        at: [0, 0, 100, 100],
        children: [{ id: "option", at: [0, 0, 100, 20] }],
      },
      {
        id: "door",
        style: `transform: ${SWUNG}`,
        at: [100, 0, 100, 100],
        children: [{ id: "handle", at: [110, 10, 10, 10] }],
      },
      { id: "spun", style: "transform: matrix(0, 1, -1, 0, 0, 0)", at: [200, 0, 50, 50] },
    ]);
    try {
      assert.equal(getLayer(root), root);
      assert.equal(getLayer(get("menu")), get("menu"));
      assert.equal(getLayer(get("option")), get("menu"));
      assert.equal(getLayer(get("door")), get("door"));
      assert.equal(getLayer(get("handle")), get("door"));
      assert.equal(getLayer(get("spun")), root, "a rotation in the plane is no layer");
    } finally {
      remove();
    }
  });

  test("leaves an SVG element in the layer of the <svg> it is in", () => {
    const { root, remove } = page([]);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    shape.setAttribute("style", `transform: ${SWUNG}`);
    svg.appendChild(shape);
    root.appendChild(svg);
    try {
      assert.equal(getLayer(shape), root);
    } finally {
      remove();
    }
  });

  test("counts layers for the elevation, a swung box included", () => {
    const { root, get, remove } = page([
      {
        id: "door",
        style: `transform: ${SWUNG}`,
        at: [0, 0, 100, 100],
        children: [
          {
            id: "menu",
            style: "position: absolute; z-index: 1",
            at: [0, 0, 50, 50],
            children: [{ id: "option", at: [0, 0, 50, 10] }],
          },
        ],
      },
    ]);
    try {
      assert.equal(getElevation(root), 0);
      assert.equal(getElevation(get("door")), 1);
      assert.equal(getElevation(get("menu")), 2);
      assert.equal(getElevation(get("option")), 2);
    } finally {
      remove();
    }
  });

  test("draws a later opaque card after everything an earlier one draws", () => {
    /** @param {boolean} lifted */
    const pile = (lifted) =>
      page(
        [
          {
            id: "under",
            style: OPAQUE_CARD,
            at: [0, 0, 100, 100],
            children: [{ id: "label", at: [10, 10, 80, 20] }],
          },
          { id: "over", style: OPAQUE_CARD, at: [50, 50, 100, 100] },
        ],
        { lifted },
      );
    const ordered = pile(false);
    const lifted = pile(true);
    try {
      // The step hides the card under by the opaque card's depth, so the
      // card keeps its tree depth. Paint order writes no depth: the card
      // over has to draw after the label it covers.
      assert.equal(getDrawLevel(lifted.get("over")), getDrawLevel(lifted.get("under")));
      assert.equal(getDrawLevel(ordered.root), 0);
      assert.equal(getDrawLevel(ordered.get("under")), 1);
      assert.equal(getDrawLevel(ordered.get("label")), 2);
      assert.equal(getDrawLevel(ordered.get("over")), 4);
    } finally {
      ordered.remove();
      lifted.remove();
    }
  });

  test("starts a layer's levels at 0, and leaves it out of what its parent reaches", () => {
    const { get, remove } = page([
      {
        id: "frame",
        style: "position: absolute",
        at: [0, 0, 100, 100],
        children: [
          {
            id: "door",
            style: `transform: ${SWUNG}`,
            at: [0, 0, 100, 100],
            children: [
              {
                id: "handle",
                at: [10, 10, 10, 10],
                children: [
                  {
                    id: "knob",
                    at: [12, 12, 6, 6],
                    children: [{ id: "grip", at: [13, 13, 4, 4] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      { id: "over", style: "position: absolute", at: [50, 50, 100, 100] },
    ]);
    try {
      assert.equal(getDrawLevel(get("door")), 0);
      assert.equal(getDrawLevel(get("handle")), 1);
      // The frame's own content alone: the door is placed by the walk.
      assert.equal(getDrawLevel(get("over")), getDrawLevel(get("frame")) + 2);
    } finally {
      remove();
    }
  });

  test("counts the shadow of an element's own text in what it covers", () => {
    const shadow = "text-shadow: 30px 30px 0px rgb(0, 0, 0)";
    /**
     * @param {string} text
     * @param {boolean} lifted
     */
    const shadowed = (text, lifted) =>
      page(
        [
          { id: "label", style: `position: absolute; ${shadow}`, text, at: [0, 0, 100, 20] },
          { id: "card", style: "position: absolute", at: [0, 40, 100, 40] },
        ],
        { lifted },
      );
    const ordered = shadowed("Score", false);
    const blank = shadowed("", false);
    const lifted = shadowed("Score", true);
    try {
      assert.equal(getDrawLevel(ordered.get("card")), getDrawLevel(ordered.get("label")) + 2);
      assert.equal(getDrawLevel(blank.get("card")), 1, "no text of its own, no shadow to cover");
      assert.equal(getDrawLevel(lifted.get("card")), getDrawLevel(lifted.get("label")));
    } finally {
      ordered.remove();
      blank.remove();
      lifted.remove();
    }
  });

  test("draws a layer from the base its walk writes, or from its depth before any", () => {
    const { root, get, remove } = page([
      {
        id: "menu",
        style: "position: absolute; z-index: 1",
        at: [0, 0, 100, 100],
        children: [{ id: "option", at: [0, 0, 100, 20] }],
      },
    ]);
    let runs = 0;
    const reader = new Effect(() => {
      runs += 1;
      getRenderBand(get("option"));
    });
    try {
      assert.equal(getRenderBand(root), 0);
      assert.equal(getLayerBase(get("menu")), PIECE_BAND, "one layer deep");
      assert.equal(getRenderBand(get("option")), PIECE_BAND);
      assert.equal(
        getContentRenderOrder(get("option")),
        PIECE_BAND + getDrawLevel(get("option")) + 1,
      );

      setLayerBase(get("menu"), 3 * PIECE_BAND);
      assert.equal(runs, 2, "a walk that moves the layer moves what is in it");
      assert.equal(getRenderBand(get("option")), 3 * PIECE_BAND);
      setLayerBase(get("menu"), 3 * PIECE_BAND);
      assert.equal(runs, 2, "and one that leaves it where it was does not");
    } finally {
      reader.dispose();
      remove();
    }
  });

  test("tells the band an order is in", () => {
    assert.equal(bandBase(0), 0);
    assert.equal(bandBase(PIECE_BAND - 1), 0);
    assert.equal(bandBase(PIECE_BAND), PIECE_BAND);
    assert.equal(bandBase(2 * PIECE_BAND + 7.5), 2 * PIECE_BAND);
  });
});
