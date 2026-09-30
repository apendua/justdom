import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { shape } from "../svg/shape.js";
import { getContentGroup } from "./contentGroup.js";
import { box } from "./div.js";
import { createMirror } from "./mirror.js";
import { createHaptics, HapticsContext } from "./haptics.js";
import { recordingSource } from "../test/rumble.js";

/**
 * @import { XREventMap } from "../core.js";
 */

// jsdom implements no Font Loading API, and `VisualProperties` refuses to
// measure text until `document.fonts` says the fonts are in. The div tests
// say why at length; nothing here measures text.
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: {
    status: "loaded",
    ready: Promise.resolve(),
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

// three's SVGLoader parses with DOMParser, which jsdom-env does not install.
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = window.DOMParser;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * An outer element with an inner one in it, projected the way the portal
 * projects them: the inner object in the outer's content group, and the
 * outer under an object standing for the panel. The manager is a real one,
 * because what is under test is where its dispatch stops.
 *
 * @param {object} options
 * @param {Element} options.outer
 * @param {Element} options.inner
 * @param {(ctx: WeakKey, element: Element) => import("@apendua/signal").Source<THREE.Object3D>} options.build
 * @param {import("./haptics.js").Haptics | null} [options.haptics] What the
 *   panel lets the hand feel, if anything.
 */
function nest({ outer, inner, build, haptics = null }) {
  document.body.appendChild(outer);
  const mirror = createMirror();
  mirror.adopt(outer);
  mirror.adopt(inner);

  const manager = new InteractionManager();
  const ctx = HapticsContext.set(InteractionContext.set({}, manager), haptics);
  const panel = new THREE.Object3D();

  /** @type {THREE.Object3D<XREventMap>[]} */
  const objects = [];
  const subscriptions = [outer, inner].map((element) =>
    build(ctx, element).subscribe((value) => {
      objects.push(/** @type {THREE.Object3D<XREventMap>} */ (value));
    }),
  );
  const [outerObject, innerObject] = objects;
  panel.add(outerObject);
  getContentGroup(outerObject).add(innerObject);

  /** @type {string[]} */
  const events = [];
  for (const type of ["mousedown", "mouseup", "click"]) {
    document.addEventListener(type, record);
  }
  /** @param {Event} event */
  function record(event) {
    const target = /** @type {Element} */ (event.target);
    events.push(`${event.type} on ${target.localName}`);
  }

  /** @type {string[]} */
  const escaped = [];
  for (const type of ["selectstart", "selectend", "select"]) {
    panel.addEventListener(/** @type {never} */ (type), () => escaped.push(type));
  }

  const controller = new THREE.Object3D();
  return {
    events,
    escaped,
    /**
     * A ray event, dispatched the way the manager dispatches one: to the
     * mesh the ray met, and up from there.
     *
     * @param {"selectstart" | "selectend" | "select"} type
     * @param {XRInputSource | null} [inputSource] The hand it came from.
     */
    press(type, inputSource = null) {
      const mesh = innerObject.children.find((child) => child instanceof THREE.Mesh) ?? innerObject;
      manager.dispatch(
        /** @type {THREE.Object3D<XREventMap>} */ (mesh),
        /** @type {never} */ ({
          type,
          controller,
          inputSource,
          target: mesh,
          originalTarget: mesh,
        }),
      );
    },
    teardown() {
      for (const type of ["mousedown", "mouseup", "click"]) {
        document.removeEventListener(type, record);
      }
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      outer.remove();
    },
  };
}

/**
 * @param {string} tag
 * @param {string} cssText
 */
function html(tag, cssText) {
  const element = document.createElement(tag);
  element.style.cssText = cssText;
  return element;
}

describe("a press on nested clickable elements", () => {
  test("is sent to the DOM once, from the innermost, and presses both", () => {
    const outer = html("button", "cursor: pointer");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    /** @type {string[]} */
    const pressed = [];
    const s = nest({
      outer,
      inner,
      build: (ctx, element) =>
        box(ctx, /** @type {HTMLElement} */ (element), {
          onPress: () => pressed.push(element.localName),
        }),
    });

    s.press("selectstart");
    assert.equal(outer.dataset.xrActive, "true", "the button is held, as :active");
    assert.equal(inner.dataset.xrActive, "true");
    s.press("selectend");
    assert.equal(outer.dataset.xrActive, undefined);
    assert.equal(inner.dataset.xrActive, undefined);
    s.press("select");

    assert.deepEqual(s.events, ["mousedown on span", "mouseup on span", "click on span"]);
    assert.deepEqual(pressed, ["span", "button"], "each hears its own press");
    assert.deepEqual(s.escaped, [], "and nothing outside the panel hears it");
    s.teardown();
  });

  test("is felt once, however many elements it holds", () => {
    const outer = html("button", "cursor: pointer");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    const { source, played } = recordingSource();
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
      // The key flavour, which has a release as well as a press.
      haptics: createHaptics({ flavor: "key" }),
    });

    s.press("selectstart", source);
    assert.equal(played.length, 1, "one pulse for the press");
    s.press("selectend", source);
    assert.equal(played.length, 2, "and one for the release");
    s.teardown();
  });

  test("inside an element that is not clickable, stops where it did", () => {
    const outer = html("div", "");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });

    s.press("selectstart");
    s.press("selectend");
    s.press("select");
    assert.equal(outer.dataset.xrActive, undefined);
    assert.deepEqual(s.events, ["mousedown on span", "mouseup on span", "click on span"]);
    assert.deepEqual(s.escaped, []);
    s.teardown();
  });

  test("on a shape inside a clickable <svg>, is the shape's and presses the <svg>", () => {
    const root = document.createElementNS(SVG_NS, "svg");
    root.setAttribute("style", "cursor: pointer");
    root.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({
        left: 0,
        top: 0,
        right: 100,
        bottom: 50,
        width: 100,
        height: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    const rect = document.createElementNS(SVG_NS, "rect");
    for (const [name, value] of Object.entries({
      x: "10",
      y: "10",
      width: "20",
      height: "20",
      fill: "red",
      style: "cursor: pointer",
    })) {
      rect.setAttribute(name, value);
    }
    root.appendChild(rect);
    const s = nest({
      outer: root,
      inner: rect,
      build: (ctx, element) =>
        element === root
          ? box(ctx, /** @type {HTMLElement} */ (/** @type {Element} */ (root)))
          : shape(ctx, element),
    });
    const dataset = (/** @type {Element} */ element) => /** @type {SVGElement} */ (element).dataset;

    s.press("selectstart");
    assert.equal(dataset(root).xrActive, "true");
    assert.equal(dataset(rect).xrActive, "true");
    s.press("selectend");
    s.press("select");
    assert.deepEqual(s.events, ["mousedown on rect", "mouseup on rect", "click on rect"]);
    assert.deepEqual(s.escaped, []);
    s.teardown();
  });
});
