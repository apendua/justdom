import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { PORTAL_ATTRIBUTE } from "./mirror.js";
import { createScrollDrags, findScroller, isScrollable } from "./scroll.js";

/**
 * jsdom lays nothing out and never scrolls, so a scroller has to be
 * described: how much fits, how much there is, and where it currently sits.
 *
 * @param {HTMLElement} element
 * @param {{ client: number, scroll: number }} size
 */
function describeScroller(element, { client, scroll }) {
  let top = 0;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, get: () => client },
    scrollHeight: { configurable: true, get: () => scroll },
    clientWidth: { configurable: true, get: () => client },
    scrollWidth: { configurable: true, get: () => client },
    scrollTop: {
      configurable: true,
      get: () => top,
      // Browsers clamp, and so does the list at the ends of its travel.
      set: (value) => {
        top = Math.max(0, Math.min(value, scroll - client));
      },
    },
  });
}

/**
 * @param {string} style
 * @param {HTMLElement} [parent]
 * @returns {HTMLElement}
 */
function el(style, parent) {
  const element = document.createElement("div");
  element.style.cssText = style;
  (parent ?? document.body).appendChild(element);
  return element;
}

/**
 * A controller whose ray points straight down -z from a movable origin, and
 * the scene furniture a drag needs around it.
 */
function setup() {
  const root = el("");
  root.setAttribute(PORTAL_ATTRIBUTE, "");
  const list = el("overflow: hidden", root);
  describeScroller(list, { client: 100, scroll: 400 });
  const row = el("cursor: pointer", list);

  // The list's object: local px, sitting at the world origin facing +z, so a
  // ray from (x, y, 5) pointing at -z lands on the list at exactly (x, y).
  const space = new THREE.Object3D();
  // The gesture walks two objects per element: a box's DOM children ride in
  // a content group under its object, the way div.js builds one.
  const contentGroup = new THREE.Object3D();
  space.add(contentGroup);
  const rowObject = new THREE.Object3D();
  contentGroup.add(rowObject);
  space.updateMatrixWorld(true);

  const controller = /** @type {THREE.XRTargetRaySpace} */ (
    /** @type {unknown} */ (new THREE.Object3D())
  );
  /**
   * @param {number} x
   * @param {number} y
   */
  const aimAt = (x, y) => {
    controller.position.set(x, y, 5);
    controller.updateMatrixWorld(true);
  };
  aimAt(0, 0);

  /** @type {(() => void)[]} */
  const ticks = [];
  const drags = createScrollDrags((tick) => {
    ticks.push(tick);
    return () => {
      const index = ticks.indexOf(tick);
      if (index >= 0) {
        ticks.splice(index, 1);
      }
    };
  });

  return {
    list,
    row,
    rowObject,
    controller,
    drags,
    aimAt,
    frame: () => ticks.forEach((tick) => tick()),
    running: () => ticks.length > 0,
  };
}

// `setFromXRController` reads the controller's world matrix, which a plain
// Object3D provides — but three's raycaster asks for the camera-less variant
// only on XRTargetRaySpace, so the stand-in above is enough.

describe("isScrollable", () => {
  test("a list that clips and overflows is something to take hold of", () => {
    const list = el("overflow: hidden");
    describeScroller(list, { client: 100, scroll: 400 });
    assert.equal(isScrollable(list), true);
  });

  test("a list that clips but fits is not", () => {
    // Grabbing it should still press the row under the ray.
    const list = el("overflow: hidden");
    describeScroller(list, { client: 100, scroll: 100 });
    assert.equal(isScrollable(list), false);
  });

  test("content that overflows without clipping is not", () => {
    const list = el("");
    describeScroller(list, { client: 100, scroll: 400 });
    assert.equal(isScrollable(list), false);
  });
});

describe("findScroller", () => {
  test("finds the nearest scrolling ancestor of the element grabbed", () => {
    const root = el("");
    root.setAttribute(PORTAL_ATTRIBUTE, "");
    const list = el("overflow: hidden", root);
    describeScroller(list, { client: 100, scroll: 400 });
    const row = el("", list);
    assert.equal(findScroller(row), list);
    assert.equal(findScroller(list), list);
  });

  test("stops at the portal container rather than escaping into the page", () => {
    const page = el("overflow: hidden");
    describeScroller(page, { client: 100, scroll: 400 });
    const root = el("", page);
    root.setAttribute(PORTAL_ATTRIBUTE, "");
    const row = el("", root);
    assert.equal(findScroller(row), null);
  });
});

describe("dragging a list", () => {
  test("the list follows the hand, and the viewport goes the other way", () => {
    const { list, row, rowObject, controller, drags, aimAt, frame } = setup();

    drags.begin(controller, row, rowObject);
    frame();
    assert.equal(list.scrollTop, 0);

    // Pull upwards: the content comes with the hand, so the list scrolls down.
    aimAt(0, -40);
    frame();
    assert.equal(list.scrollTop, 40);

    // And back again.
    aimAt(0, -10);
    frame();
    assert.equal(list.scrollTop, 10);

    drags.end(controller);
  });

  test("a small wobble is a press, not a drag", () => {
    const { list, row, rowObject, controller, drags, aimAt, frame } = setup();

    drags.begin(controller, row, rowObject);
    frame();
    aimAt(0, -2);
    frame();

    assert.equal(list.scrollTop, 0, "nothing scrolled");
    assert.equal(drags.didScroll(controller), false, "so the press is still a click");

    drags.end(controller);
  });

  test("a real drag suppresses the click on what it started from", () => {
    const { row, rowObject, controller, drags, aimAt, frame } = setup();

    drags.begin(controller, row, rowObject);
    frame();
    aimAt(0, -40);
    frame();

    assert.equal(drags.didScroll(controller), true);
    drags.end(controller);
  });

  test("the list keeps up with a hand that has left it behind", () => {
    // Hit events only reach what the ray is touching, so a drag driven by
    // them would stall exactly when the list is being pulled hardest.
    const { list, row, rowObject, controller, drags, aimAt, frame } = setup();

    drags.begin(controller, row, rowObject);
    frame();
    aimAt(0, -40);
    frame();
    // Now well past the panel's edge, pointing at nothing at all.
    aimAt(500, -90);
    frame();

    assert.equal(list.scrollTop, 90);
    drags.end(controller);
  });

  test("scrolling stops where the browser clamps it", () => {
    const { list, row, rowObject, controller, drags, aimAt, frame } = setup();

    drags.begin(controller, row, rowObject);
    frame();
    aimAt(0, -10000);
    frame();

    assert.equal(list.scrollTop, 300, "the bottom of a 400px list showing 100px");
    drags.end(controller);
  });

  test("grabbing something with no scrolling ancestor does nothing", () => {
    const { rowObject, controller, drags, aimAt, frame, running } = setup();
    const loose = el("");

    drags.begin(controller, loose, rowObject);
    aimAt(0, -40);
    frame();

    assert.equal(drags.didScroll(controller), false);
    assert.equal(running(), false, "and asks for no frames");
  });

  test("a flick glides on after release, and settles", () => {
    const { list, row, rowObject, controller, drags, aimAt, frame, running } = setup();

    drags.begin(controller, row, rowObject);
    frame();
    aimAt(0, -40);
    frame();
    const atRelease = list.scrollTop;
    drags.end(controller);

    frame();
    assert.ok(list.scrollTop > atRelease, "the list carries on");

    // And arrives, releasing the frame loop behind it.
    for (let i = 0; i < 500 && running(); i++) {
      frame();
    }
    assert.equal(running(), false, "the loop retires once the glide has settled");
  });

  test("letting go without dragging starts no glide", () => {
    const { row, rowObject, controller, drags, frame, running } = setup();

    drags.begin(controller, row, rowObject);
    frame();
    drags.end(controller);
    frame();

    assert.equal(running(), false);
  });
});
