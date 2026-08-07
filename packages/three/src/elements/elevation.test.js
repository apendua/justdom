import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getContentRenderOrder, getElevation, isOverlay } from "./elevation.js";

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
});

describe("getContentRenderOrder", () => {
  test("an element's content draws after its own box, before its child's content", () => {
    const panel = element("");
    const button = element("", panel);

    // The box's own figure is elevation·1000 + ancestor count; content is one
    // deeper — counted from the element itself.
    assert.equal(getContentRenderOrder(button), getContentRenderOrder(panel) + 1);
    assert.ok(getContentRenderOrder(panel) > 0);
  });

  test("an overlay's content draws in the overlay's band", () => {
    const panel = element("");
    const menu = element("position: absolute; z-index: 1", panel);

    assert.ok(getContentRenderOrder(menu) >= 1000);
    assert.ok(getContentRenderOrder(menu) - getContentRenderOrder(panel) >= 1000);
  });
});
