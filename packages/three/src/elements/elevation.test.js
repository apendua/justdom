import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "@apendua/signal";
import { ELEVATION_BAND, getContentRenderOrder, getElevation, isOverlay } from "./elevation.js";
import { createMirror } from "./mirror.js";

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
