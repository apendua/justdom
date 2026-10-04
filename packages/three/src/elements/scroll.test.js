import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { PORTAL_ATTRIBUTE } from "./portalRoot.js";
import { setContentGroup } from "./contentGroup.js";
import {
  createPanelScrollDrags,
  createScrollDrags,
  findScroller,
  isScrollable,
  movesList,
  scrollDrags,
  ScrollDragsContext,
} from "./scroll.js";
import { describeScroller } from "../test/scroller.js";
import { flushFrame } from "../test/portalHarness.js";

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
  // A box's DOM children ride in a content group under its object, the way
  // div.js builds one.
  const contentGroup = new THREE.Object3D();
  space.add(contentGroup);
  setContentGroup(space, contentGroup);
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
    contentGroup,
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

describe("a hand moving a list", () => {
  test("is a fact about the scene, once the list has moved, until its glide retires", () => {
    const { row, rowObject, controller, aimAt } = setup();
    // Two panels of one scene, each with a gesture of its own, as a portal
    // sets one.
    const manager = new InteractionManager();
    const scene = InteractionContext.set({}, manager);
    const here = ScrollDragsContext.set(scene, createPanelScrollDrags(scene));
    const there = ScrollDragsContext.set(scene, createPanelScrollDrags(scene));
    const drags = scrollDrags(here);

    drags.begin(controller, row, rowObject);
    assert.equal(drags.scrolling(controller), true, "the panel's gesture holds the press");
    assert.equal(movesList(there, controller), false, "but a resting press moves nothing");

    aimAt(0, -40);
    flushFrame();
    assert.equal(movesList(there, controller), true, "seen from the other panel");
    assert.equal(scrollDrags(there).scrolling(controller), false, "whose gesture has no say");

    drags.end(controller);
    flushFrame();
    assert.equal(movesList(there, controller), true, "gliding");
    for (let frame = 0; frame < 300 && drags.scrolling(controller); frame += 1) {
      flushFrame();
    }
    assert.equal(drags.scrolling(controller), false, "the glide retired");
    assert.equal(movesList(there, controller), false, "and the hand moves nothing");
  });

  test("ends however the press does, with no element left to hear it", () => {
    const { list, row, rowObject, controller, aimAt } = setup();
    const manager = new InteractionManager();
    const ctx = InteractionContext.set({}, manager);
    const drags = scrollDrags(ctx);
    const hold = () => {
      aimAt(0, 0);
      drags.begin(controller, row, rowObject);
      aimAt(0, -40);
      flushFrame();
      assert.equal(movesList(ctx, controller), true);
    };

    // The controller's own release, which the pressed element would have
    // passed on: the glide it starts retires.
    hold();
    controller.dispatchEvent(/** @type {never} */ ({ type: "selectend" }));
    for (let frame = 0; frame < 300 && drags.scrolling(controller); frame += 1) {
      flushFrame();
    }
    assert.equal(movesList(ctx, controller), false, "released by the controller");

    // The controller lost, at the end of a session: no glide.
    hold();
    controller.dispatchEvent(/** @type {never} */ ({ type: "disconnected" }));
    assert.equal(movesList(ctx, controller), false, "lost with the controller");

    // The list taken out of the document while held.
    hold();
    const parent = /** @type {HTMLElement} */ (list.parentElement);
    list.remove();
    flushFrame();
    assert.equal(movesList(ctx, controller), false, "gone with the list");
    parent.appendChild(list);

    // The panel taken down while held.
    hold();
    drags.dispose();
    assert.equal(movesList(ctx, controller), false, "gone with the panel");
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

  test("a shape inside an <svg> in the list drags it in the list's own px", () => {
    const { list, contentGroup, controller, drags, aimAt, frame } = setup();
    const SVG_NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVG_NS, "svg");
    const g = document.createElementNS(SVG_NS, "g");
    const rect = document.createElementNS(SVG_NS, "rect");
    list.appendChild(svg);
    svg.appendChild(g);
    g.appendChild(rect);

    // The `<svg>` is a box, with a content group scaled by its `viewBox`.
    // The `<g>` below it has none, so the `<rect>` is its direct child.
    const svgObject = new THREE.Object3D();
    const svgContent = new THREE.Object3D();
    svgContent.scale.set(2, 2, 1);
    svgObject.add(svgContent);
    setContentGroup(svgObject, svgContent);
    const gObject = new THREE.Object3D();
    gObject.position.set(5, 5, 0);
    svgContent.add(gObject);
    const rectObject = new THREE.Object3D();
    gObject.add(rectObject);
    contentGroup.add(svgObject);
    svgObject.updateMatrixWorld(true);

    drags.begin(controller, /** @type {HTMLElement} */ (/** @type {Element} */ (rect)), rectObject);
    frame();
    aimAt(0, -40);
    frame();
    // Measured in any frame under the `viewBox`, the same hand would have
    // travelled 20 units rather than 40.
    assert.equal(list.scrollTop, 40);

    drags.end(controller);
    svg.remove();
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
