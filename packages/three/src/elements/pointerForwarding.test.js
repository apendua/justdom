import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { shape } from "../svg/shape.js";
import { getContentGroup } from "./contentGroup.js";
import { box } from "./div.js";
import { registerPanel } from "./dragAndDrop.js";
import { createMirror } from "./mirror.js";
import { movesList } from "./scroll.js";
import { createHaptics, HapticsContext } from "./haptics.js";
import { recordingSource } from "../test/rumble.js";
import { clientRect } from "../test/clientRect.js";
import { describeScroller } from "../test/scroller.js";
import { flushFrame } from "../test/portalHarness.js";

/**
 * @import { XREventMap } from "../core.js";
 */

// three's SVGLoader parses with DOMParser, which jsdom-env does not install.
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = window.DOMParser;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The ray events `nest` can dispatch.
 *
 * @typedef {"selectstart" | "selectend" | "select" | "selectmissed"
 *   | "squeezestart" | "squeezeend" | "squeeze" | "squeezemissed"
 *   | "pointermove" | "pointerenter" | "pointerleave"} RayEventType
 */

/**
 * An outer element with an inner one in it, projected the way the portal
 * projects them: the inner object in the outer's content group, and the
 * outer under an object standing for the panel. The manager is a real one,
 * because what is under test is where its dispatch stops. The outer is
 * registered as the panel's top, as the portal registers its container, so
 * that a press can ask where on the page it landed.
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
  const { unregister } = registerPanel(outerObject, /** @type {HTMLElement} */ (outer), (node) =>
    node === outer ? outerObject : node === inner ? innerObject : undefined,
  );

  /** @type {string[]} */
  const events = [];
  /** @type {string[]} */
  const points = [];
  // Heard on the way down, so that an event sent to an element that is
  // not the innermost one is heard too.
  const types = ["mousedown", "mouseup", "click", "contextmenu", "mousemove"];
  for (const type of types) {
    document.addEventListener(type, record, true);
  }
  /** @param {Event} event */
  function record(event) {
    const target = /** @type {Element} */ (event.target);
    events.push(`${event.type} on ${target.localName}`);
    const { clientX, clientY, button } = /** @type {MouseEvent} */ (event);
    points.push(`${event.type} at ${clientX},${clientY} button ${button}`);
  }

  /** @type {string[]} */
  const escaped = [];
  for (const type of [
    "selectstart",
    "selectend",
    "select",
    "selectmissed",
    "squeezestart",
    "squeezeend",
    "squeeze",
    "squeezemissed",
  ]) {
    panel.addEventListener(/** @type {never} */ (type), () => escaped.push(type));
  }

  const controller = /** @type {THREE.XRTargetRaySpace} */ (
    /** @type {unknown} */ (new THREE.Object3D())
  );

  /** The last start of each button, for the events that end its press. */
  const starts = new Map();

  return {
    events,
    /** Where each of `events` happened on the page, and with which button. */
    points,
    /** The outer element's object, whose frame is the panel's px. */
    outerObject,
    panel,
    manager,
    escaped,
    controller,
    /**
     * A ray event, dispatched the way the manager dispatches one: to the
     * mesh the ray met, and up from there.
     *
     * @param {RayEventType} type
     * @param {XRInputSource | null} [inputSource] The hand it came from.
     * @param {THREE.Vector3} [point] Where the ray is, in world space, if
     *   the event says.
     * @param {THREE.Object3D} [on] What the ray is on at `point`: the mesh
     *   it was dispatched to unless said otherwise.
     * @param {THREE.Object3D | null} [from] On a `pointerenter`, the
     *   registered object the ray was on before, if any.
     * @param {THREE.Object3D} [of] The registered object whose mesh the
     *   ray met: the inner's unless said otherwise, the outer's for the
     *   part of it the inner does not cover. The events that end a press
     *   carry the start it began with, as the manager's do.
     * @param {THREE.XRTargetRaySpace} [hand] The controller it came from:
     *   the one hand unless said otherwise.
     */
    press(type, inputSource = null, point, on, from = null, of = innerObject, hand = controller) {
      const mesh = of.children.find((child) => child instanceof THREE.Mesh) ?? of;
      const button = type.startsWith("squeeze") ? "squeeze" : "select";
      const event = {
        type,
        controller: hand,
        inputSource,
        target: mesh,
        originalTarget: mesh,
        registeredTarget: of,
        relatedTarget: from,
        ...(point && { intersection: { point, object: on ?? mesh } }),
        ...(!type.endsWith("start") &&
          !type.startsWith("pointer") && { start: starts.get(button) }),
      };
      if (type.endsWith("start")) {
        starts.set(button, event);
      }
      manager.dispatch(
        /** @type {THREE.Object3D<XREventMap>} */ (mesh),
        /** @type {never} */ (event),
      );
      if (type === "selectend") {
        // The controller's own release, which the manager's listener
        // passed on as the above and which a scroll drag hears directly.
        hand.dispatchEvent(/** @type {never} */ ({ type, data: inputSource }));
      }
    },
    teardown() {
      for (const type of types) {
        document.removeEventListener(type, record, true);
      }
      unregister();
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

  test("released after the pressed element has gone, ends on the next one up", () => {
    // A live list dropping a row's control while the hand still holds it:
    // the case `isGone` is for.
    const outer = html("button", "cursor: pointer");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });

    s.press("selectstart");
    inner.remove();
    s.press("selectend");
    assert.equal(outer.dataset.xrActive, undefined, "the button is not left held");
    assert.equal(inner.dataset.xrActive, undefined);
    // Where a page sends a release whose target has gone: to what is left.
    assert.deepEqual(s.events, ["mousedown on span", "mouseup on button"]);
    assert.deepEqual(s.escaped, []);
    s.teardown();
  });

  test("released after a lone pressed element has gone, keeps the release", () => {
    const outer = html("div", "");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });

    s.press("selectstart");
    inner.remove();
    s.press("selectend");
    assert.equal(inner.dataset.xrActive, undefined);
    assert.deepEqual(s.events, ["mousedown on span"], "nothing is left to take the release");
    assert.deepEqual(s.escaped, [], "and it goes no further");
    s.teardown();
  });

  test("on an icon under pointer-events: none, is the button's", () => {
    // What a browser computes for the icon: the button's `cursor: pointer`
    // inherited, with `pointer-events: none` set on it. jsdom inherits
    // neither, so both are spelled out.
    const outer = html("button", "cursor: pointer");
    const inner = document.createElementNS(SVG_NS, "svg");
    inner.setAttribute("style", "cursor: pointer; pointer-events: none");
    outer.appendChild(inner);
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });

    s.press("selectstart");
    assert.equal(outer.dataset.xrActive, "true");
    assert.equal(/** @type {SVGElement} */ (inner).dataset.xrActive, undefined);
    s.press("selectend");
    s.press("select");
    assert.deepEqual(s.events, ["mousedown on button", "mouseup on button", "click on button"]);
    assert.deepEqual(s.escaped, []);
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

  test("of the grip is felt as it closes and as it opens, once each", async () => {
    const outer = html("button", "cursor: pointer");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    const { source, played } = recordingSource();
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
      haptics: createHaptics({ flavor: "key" }),
    });

    s.press("squeezestart", source);
    // Once the dispatch has run, which is when the panel knows the grip is
    // its own.
    await Promise.resolve();
    assert.equal(played.length, 1, "one pulse as the grip closes");
    s.press("squeezeend", source);
    assert.equal(played.length, 2, "and one as it opens");
    s.press("squeezemissed", source);
    assert.equal(played.length, 2, "whether or not the right-click lands");
    assert.deepEqual(
      s.escaped,
      ["squeezestart"],
      "and the miss stays in the panel, as the end does",
    );

    // Opened in the same task as it closed, as a runtime driven from script
    // may send them: the closing is still felt first, and once.
    s.press("squeezestart", source);
    s.press("squeezeend", source);
    s.press("squeezemissed", source);
    await Promise.resolve();
    assert.deepEqual(played.slice(2), played.slice(0, 2), "closing, then opening");
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
    root.getBoundingClientRect = () => clientRect(0, 0, 100, 50);
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

  test("carries the point the ray met, on the page", () => {
    const outer = html("button", "cursor: pointer");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    outer.getBoundingClientRect = () => clientRect(100, 40, 80, 30);
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });
    // Wherever the scene hangs the panel: what counts is where the point is
    // in the frame of the panel's top element, here 12 px in and 7 down.
    s.outerObject.updateMatrixWorld(true);
    const point = s.outerObject.localToWorld(new THREE.Vector3(12, 7, 0));

    // As the manager sends them: an arrival, then a move a frame.
    s.press("pointerenter", null, point);
    s.press("pointermove", null, point);
    s.press("selectstart", null, point);
    s.press("selectend", null, point);
    s.press("select", null, point);
    assert.deepEqual(s.points, [
      // One, from the innermost of the two, though the ray is over both.
      "mousemove at 112,47 button 0",
      "mousedown at 112,47 button 0",
      "mouseup at 112,47 button 0",
      "click at 112,47 button 0",
    ]);
    s.teardown();
  });

  test("released with the ray off its panel, says nowhere on the page", () => {
    const outer = html("button", "cursor: pointer");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    outer.getBoundingClientRect = () => clientRect(100, 40, 80, 30);
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });
    s.outerObject.updateMatrixWorld(true);
    const point = s.outerObject.localToWorld(new THREE.Vector3(12, 7, 0));
    // Another panel, or anything else in the scene: what the ray is on as
    // the trigger opens. Its point means nothing on this panel's page.
    const elsewhere = new THREE.Object3D();

    s.press("selectstart", null, point);
    s.press("selectend", null, point, elsewhere);
    assert.deepEqual(s.points, ["mousedown at 112,47 button 0", "mouseup at 0,0 button 0"]);
    s.teardown();
  });

  test("of the grip on a shape is the page's contextmenu, at the point", () => {
    // A board drawn as one shape, which is how a page with its own hit test
    // draws one: what was pressed is told by where, not by the target.
    const root = document.createElementNS(SVG_NS, "svg");
    root.setAttribute("style", "cursor: pointer");
    root.getBoundingClientRect = () => clientRect(20, 30, 100, 50);
    const board = document.createElementNS(SVG_NS, "rect");
    for (const [name, value] of Object.entries({
      width: "100",
      height: "50",
      fill: "green",
      style: "cursor: pointer",
    })) {
      board.setAttribute(name, value);
    }
    root.appendChild(board);
    const s = nest({
      outer: root,
      inner: board,
      build: (ctx, element) =>
        element === root
          ? box(ctx, /** @type {HTMLElement} */ (/** @type {Element} */ (root)))
          : shape(ctx, element),
    });
    /** @type {boolean[]} */
    const cancelable = [];
    const listen = (/** @type {Event} */ event) => cancelable.push(event.cancelable);
    document.addEventListener("contextmenu", listen);
    s.outerObject.updateMatrixWorld(true);

    const point = s.outerObject.localToWorld(new THREE.Vector3(60, 25, 0));
    s.press("squeezestart", null, point);
    s.press("squeezeend", null, point);
    s.press("squeeze", null, point);
    assert.deepEqual(s.events, ["contextmenu on rect"], "sent once, from the innermost");
    assert.deepEqual(s.points, ["contextmenu at 80,55 button 2"]);
    assert.deepEqual(cancelable, [true], "and a page can cancel it, as it can a real one");
    assert.deepEqual(
      s.escaped,
      ["squeezestart"],
      "only the start goes on past the panel, for a scene that grabs with the grip",
    );
    document.removeEventListener("contextmenu", listen);
    s.teardown();
  });

  test("of the grip on an element that has gone, is nobody's", async () => {
    const outer = html("ul", "cursor: pointer");
    const inner = html("li", "cursor: pointer");
    outer.appendChild(inner);
    const { source, played } = recordingSource();
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
      haptics: createHaptics({ flavor: "key" }),
    });

    // Gone while the grip is held: the list behind the row feels the grip
    // open and sends nothing, as it does for the trigger.
    s.press("squeezestart", source);
    await Promise.resolve();
    inner.remove();
    s.press("squeezeend", source);
    s.press("squeeze", source);
    assert.deepEqual(s.events, [], "not the list's behind the row either");
    assert.deepEqual(played.length, 2, "felt closing on the row and opening on the list");
    assert.deepEqual(s.escaped, ["squeezestart"]);

    // Or let go off the row: the miss is the panel's too.
    outer.appendChild(inner);
    s.press("squeezestart", source);
    await Promise.resolve();
    inner.remove();
    s.press("squeezeend", source);
    s.press("squeezemissed", source);
    assert.deepEqual(played.length, 4, "felt the same way");
    assert.deepEqual(s.escaped, ["squeezestart", "squeezestart"], "nothing of it leaves the panel");

    // Gone before the grip closes: swallowed, so that nothing behind the
    // row, the scene included, takes a grip on a row the page let go of,
    // and its end stops at the panel as its start did.
    outer.appendChild(inner);
    inner.remove();
    s.press("squeezestart", source);
    await Promise.resolve();
    s.press("squeezeend", source);
    s.press("squeezemissed", source);
    assert.deepEqual(s.events, []);
    assert.deepEqual(played.length, 4, "felt neither closing nor opening");
    assert.deepEqual(s.escaped, ["squeezestart", "squeezestart"], "nothing of it leaves the panel");
    s.teardown();
  });

  test("of the grip that something above took, is that carry's", async () => {
    const outer = html("button", "cursor: pointer");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    const { source, played } = recordingSource();
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
      haptics: createHaptics({ flavor: "key" }),
    });
    // What `drag()` with the grip among its buttons does with the press.
    s.panel.addEventListener(/** @type {never} */ ("squeezestart"), (event) =>
      s.manager.stopPropagation(/** @type {never} */ (event)),
    );

    s.press("squeezestart", source);
    await Promise.resolve();
    // The button is taken out while the hand carries the panel by it: the
    // carry still gets its end.
    inner.remove();
    s.press("squeezeend", source);
    s.press("squeezemissed", source);
    assert.deepEqual(s.events, [], "no contextmenu for a grab");
    assert.equal(played.length, 0, "and nothing felt for one, closing or opening");
    assert.deepEqual(
      s.escaped,
      ["squeezestart", "squeezeend", "squeezemissed"],
      "and the grab's end reaches whatever took its start, its miss let past with it",
    );
    s.teardown();
  });

  test("of the grip under the trigger is a right-click until the trigger moves a list", async () => {
    // A mouse sends `contextmenu` for its other button while the main one is
    // held still. Once the main one drags a list, a page hears no other
    // button, and the row passing under the ray is not being pressed.
    const outer = html("div", "overflow: hidden");
    describeScroller(outer, { client: 100, scroll: 400 });
    const inner = html("button", "cursor: pointer");
    outer.appendChild(inner);
    const { source, played } = recordingSource();
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
      haptics: createHaptics({ flavor: "key" }),
    });
    s.outerObject.updateMatrixWorld(true);
    /**
     * Point the hand's ray at a spot on the list, in its px.
     *
     * @param {number} x
     * @param {number} y
     */
    const aim = (x, y) => {
      const point = s.outerObject.localToWorld(new THREE.Vector3(x, y, 0));
      s.controller.position.set(point.x, point.y, point.z + 1);
      s.controller.updateMatrixWorld(true);
      return point;
    };
    /** @param {THREE.Vector3} at */
    const grip = async (at) => {
      s.press("squeezestart", source, at);
      await Promise.resolve();
      s.press("squeezeend", source, at);
      s.press("squeeze", source, at);
    };

    // The trigger rests on the list's padding: a press that may yet be a
    // click, and nothing has moved.
    let point = aim(12, 40);
    s.press("selectstart", source, point, undefined, null, s.outerObject);
    await grip(point);
    assert.deepEqual(s.events, ["contextmenu on button"], "a right-click on the row");
    assert.equal(played.length, 2, "felt closing and opening");

    // The grip closes on the row, and then the trigger drags the list.
    s.press("squeezestart", source, point);
    await Promise.resolve();
    point = aim(12, 7);
    flushFrame();
    assert.ok(outer.scrollTop > 0, "the list moved");
    s.press("squeezeend", source, point);
    s.press("squeeze", source, point);
    assert.deepEqual(s.events, ["contextmenu on button"], "no right-click mid-scroll");
    assert.equal(played.length, 4, "but the opening is felt, as its closing was");

    // A grip while the list moves is no press at all.
    await grip(point);
    assert.deepEqual(s.events, ["contextmenu on button"]);
    assert.equal(played.length, 4, "and is felt neither way");
    assert.deepEqual(s.escaped, ["squeezestart", "squeezestart", "squeezestart"]);

    // Nor is one that closed while the list moved and opens once it has
    // stopped: the trigger lets go and the glide retires in between.
    s.press("squeezestart", source, point);
    await Promise.resolve();
    s.press("selectend", source, point, undefined, null, s.outerObject);
    const ctx = InteractionContext.set({}, s.manager);
    for (let frame = 0; frame < 300 && movesList(ctx, s.controller); frame += 1) {
      flushFrame();
    }
    assert.equal(movesList(ctx, s.controller), false, "the list has stopped");
    s.press("squeezeend", source, point);
    s.press("squeeze", source, point);
    assert.deepEqual(s.events, ["contextmenu on button"], "no right-click for it");
    assert.equal(played.length, 4, "and nothing felt");
    s.teardown();
  });

  test("of the trigger dragging a list the page takes down lets the hand go", () => {
    const outer = html("div", "overflow: hidden");
    describeScroller(outer, { client: 100, scroll: 400 });
    const inner = html("button", "cursor: pointer");
    outer.appendChild(inner);
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });
    s.outerObject.updateMatrixWorld(true);
    const ctx = InteractionContext.set({}, s.manager);
    /**
     * @param {number} x
     * @param {number} y
     */
    const aim = (x, y) => {
      const point = s.outerObject.localToWorld(new THREE.Vector3(x, y, 0));
      s.controller.position.set(point.x, point.y, point.z + 1);
      s.controller.updateMatrixWorld(true);
      return point;
    };

    let point = aim(12, 40);
    s.press("selectstart", null, point, undefined, null, s.outerObject);
    point = aim(12, 7);
    flushFrame();
    assert.equal(movesList(ctx, s.controller), true, "the list moves");

    // Taken down mid-drag, and the trigger let go on what is left of it.
    outer.remove();
    s.press("selectend", null, point, undefined, null, s.outerObject);
    flushFrame();
    assert.equal(movesList(ctx, s.controller), false, "the hand moves nothing any more");
    document.body.appendChild(outer);
    s.teardown();
  });

  test("of the trigger on a list's own padding, let go off the panel, keeps its miss", () => {
    const outer = html("div", "overflow: hidden");
    describeScroller(outer, { client: 100, scroll: 400 });
    const inner = html("button", "cursor: pointer");
    outer.appendChild(inner);
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });

    s.press("selectstart", null, undefined, undefined, null, s.outerObject);
    s.press("selectend", null, undefined, undefined, null, s.outerObject);
    s.press("selectmissed", null, undefined, undefined, null, s.outerObject);
    assert.deepEqual(s.escaped, [], "the list's press, its end and its miss are the list's");
    s.teardown();
  });

  test("of a move is taken where the panel was last probed, and a press probes again", () => {
    // A move is sent every frame and reads no layout; a press is one event
    // and reads it, so it is exact however the page has moved since.
    const outer = html("button", "cursor: pointer");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    let left = 100;
    let reads = 0;
    outer.getBoundingClientRect = () => {
      reads += 1;
      return clientRect(left, 40, 80, 30);
    };
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });
    s.outerObject.updateMatrixWorld(true);
    const point = s.outerObject.localToWorld(new THREE.Vector3(12, 7, 0));

    s.press("selectstart", null, point);
    // The page scrolls the panel's element 100 px along while the trigger
    // is held, which no move hears of.
    left = 200;
    const before = reads;
    s.press("pointermove", null, point);
    assert.equal(reads, before, "a move reads no layout");
    s.press("selectend", null, point);
    assert.deepEqual(s.points, [
      "mousedown at 112,47 button 0",
      "mousemove at 112,47 button 0",
      "mouseup at 212,47 button 0",
    ]);
    s.teardown();
  });

  test("of an arrival is where the panel is now, and the moves after it read no layout", () => {
    // A hover that a page answers from the point, the way it finds what was
    // pressed, is exact as the ray arrives, and drifts only by what the page
    // moves while the ray stays; the next arrival is exact again.
    const outer = html("button", "cursor: pointer");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    let left = 100;
    let reads = 0;
    outer.getBoundingClientRect = () => {
      reads += 1;
      return clientRect(left, 40, 80, 30);
    };
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });
    s.outerObject.updateMatrixWorld(true);
    const point = s.outerObject.localToWorld(new THREE.Vector3(12, 7, 0));

    let before = reads;
    s.press("pointerenter", null, point);
    assert.equal(reads, before + 1, "an arrival reads where the panel is, once");
    before = reads;
    s.press("pointermove", null, point);
    left = 200;
    s.press("pointermove", null, point);
    assert.equal(reads, before, "a move reads no layout");
    s.press("pointerleave", null, point);
    s.press("pointerenter", null, point);
    s.press("pointermove", null, point);
    assert.deepEqual(s.points, [
      "mousemove at 112,47 button 0",
      "mousemove at 112,47 button 0",
      "mousemove at 212,47 button 0",
    ]);
    s.teardown();
  });

  test("an arrival from within the same control reads no layout", () => {
    // A ray resting on a button and trembling across its label's edge
    // leaves and enters the label each time, and has arrived on nothing.
    const outer = html("button", "cursor: pointer");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    let left = 100;
    let reads = 0;
    outer.getBoundingClientRect = () => {
      reads += 1;
      return clientRect(left, 40, 80, 30);
    };
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });
    s.outerObject.updateMatrixWorld(true);
    const point = s.outerObject.localToWorld(new THREE.Vector3(12, 7, 0));

    s.press("pointerenter", null, point);
    const before = reads;
    s.press("pointerleave", null, point);
    s.press("pointerenter", null, point, undefined, s.outerObject);
    assert.equal(reads, before, "from the button onto its label is no arrival");
    left = 200;
    s.press("pointermove", null, point);
    assert.deepEqual(s.points, ["mousemove at 112,47 button 0"]);
    s.teardown();
  });

  test("an arrival on a scrolling list inside a control reads the panel's layout", () => {
    // The list is a ray target of its own, for the scroll, and forwards
    // nothing; the clickable element around it sends the moves, from the
    // corner this arrival reads.
    const outer = html("button", "cursor: pointer");
    const inner = html("div", "overflow: hidden");
    describeScroller(inner, { client: 100, scroll: 400 });
    outer.appendChild(inner);
    let reads = 0;
    outer.getBoundingClientRect = () => {
      reads += 1;
      return clientRect(100, 40, 80, 30);
    };
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });
    s.outerObject.updateMatrixWorld(true);
    const point = s.outerObject.localToWorld(new THREE.Vector3(12, 7, 0));

    const before = reads;
    s.press("pointerenter", null, point);
    assert.equal(reads, before + 1, "the arrival reads where the panel is, once");
    s.press("pointermove", null, point);
    assert.deepEqual(s.points, ["mousemove at 112,47 button 0"]);
    s.teardown();
  });

  test("a control reached while a list scrolls takes the point the scroll's press read", () => {
    // A press on the list's own padding is `drags.begin` alone, no
    // `mousedown`, and a control the ray reaches while the hand scrolls
    // reads nothing on arrival: the press is what reads the panel.
    const outer = html("div", "overflow: hidden");
    describeScroller(outer, { client: 100, scroll: 400 });
    const inner = html("button", "cursor: pointer");
    outer.appendChild(inner);
    let reads = 0;
    outer.getBoundingClientRect = () => {
      reads += 1;
      return clientRect(100, 40, 80, 30);
    };
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });
    s.outerObject.updateMatrixWorld(true);
    const point = s.outerObject.localToWorld(new THREE.Vector3(12, 7, 0));

    let before = reads;
    s.press("selectstart", null, point, undefined, null, s.outerObject);
    assert.equal(reads, before + 1, "the press on the list reads where the panel is");
    before = reads;
    s.press("pointerenter", null, point, undefined, s.outerObject);
    assert.equal(reads, before, "the control reached under the scroll reads nothing");
    s.press("pointermove", null, point);
    assert.deepEqual(s.points, ["mousemove at 112,47 button 0"]);
    s.press("selectend", null, point, undefined, null, s.outerObject);
    s.teardown();
  });
});

describe("a ray's pointer events", () => {
  const TYPES = [
    "pointerdown",
    "pointermove",
    "pointerup",
    "mousedown",
    "mousemove",
    "mouseup",
    "click",
  ];

  /**
   * A button with a label in it, and what the page hears of the ray on the
   * label, as `type on element #pointerId button` for a pointer event and
   * `type on element` for the rest.
   *
   * @param {(event: Event) => void} [listen] A page's own handler, run
   *   for each of `TYPES` on the label as it is heard there.
   */
  function label(listen) {
    const outer = html("button", "cursor: pointer");
    const inner = html("span", "cursor: pointer");
    outer.appendChild(inner);
    outer.getBoundingClientRect = () => clientRect(100, 40, 80, 30);
    const s = nest({
      outer,
      inner,
      build: (ctx, element) => box(ctx, /** @type {HTMLElement} */ (element)),
    });
    s.outerObject.updateMatrixWorld(true);
    const point = s.outerObject.localToWorld(new THREE.Vector3(12, 7, 0));
    /** @type {string[]} */
    const heard = [];
    /** @param {Event} event */
    const record = (event) => {
      const target = /** @type {Element} */ (event.target).localName;
      heard.push(
        event instanceof PointerEvent
          ? `${event.type} on ${target} #${event.pointerId} ${event.button}`
          : `${event.type} on ${target}`,
      );
    };
    for (const type of TYPES) {
      document.addEventListener(type, record, true);
      if (listen) {
        inner.addEventListener(type, listen);
      }
    }
    return {
      s,
      point,
      inner,
      outer,
      heard,
      teardown() {
        for (const type of TYPES) {
          document.removeEventListener(type, record, true);
        }
        s.teardown();
      },
    };
  }

  test("come ahead of each mouse event, as a browser sends them", () => {
    const { s, point, heard, teardown } = label();
    s.press("pointerenter", null, point);
    s.press("pointermove", null, point);
    s.press("selectstart", null, point);
    s.press("selectend", null, point);
    s.press("select", null, point);
    const id = heard[0].split("#")[1].split(" ")[0];
    assert.ok(Number(id) >= 2, "a hand's pointer is not the mouse's");
    assert.deepEqual(heard, [
      // A move changes no button, which a pointer event says as -1.
      `pointermove on span #${id} -1`,
      "mousemove on span",
      `pointerdown on span #${id} 0`,
      "mousedown on span",
      `pointerup on span #${id} 0`,
      "mouseup on span",
      "click on span",
    ]);
    teardown();
  });

  test("say which hand each is from", () => {
    const { s, point, heard, teardown } = label();
    const other = /** @type {THREE.XRTargetRaySpace} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    s.press("pointermove", null, point);
    s.press("pointermove", null, point, undefined, null, undefined, other);
    s.press("pointermove", null, point);
    const ids = heard
      .filter((entry) => entry.startsWith("pointermove"))
      .map((entry) => entry.split("#")[1]);
    assert.equal(ids.length, 3);
    assert.notEqual(ids[0], ids[1], "the other hand is another pointer");
    assert.equal(ids[0], ids[2], "and the first hand keeps its own");
    teardown();
  });

  test("cancelled at the press, leave out the mouse events until the release", () => {
    const { s, point, heard, teardown } = label((event) => {
      if (event.type === "pointerdown") {
        event.preventDefault();
      }
    });
    s.press("selectstart", null, point);
    s.press("pointermove", null, point);
    s.press("selectend", null, point);
    s.press("select", null, point);
    s.press("pointermove", null, point);
    assert.deepEqual(
      heard.map((entry) => entry.split(" #")[0]),
      [
        "pointerdown on span",
        "pointermove on span",
        "pointerup on span",
        // The click still goes, as a browser's does.
        "click on span",
        // And a move after the release is a mouse's again.
        "pointermove on span",
        "mousemove on span",
      ],
    );
    teardown();
  });

  test("can be captured, and the hand's moves and release go to the captor", () => {
    /** @type {string[]} */
    const captured = [];
    const { s, point, outer, heard, teardown } = label((event) => {
      if (event.type === "pointerdown") {
        const { pointerId } = /** @type {PointerEvent} */ (event);
        // A page that drags by capture, which a browser refuses for a
        // pointer it does not know.
        outer.setPointerCapture(pointerId);
        captured.push(`has capture: ${outer.hasPointerCapture(pointerId)}`);
      }
    });
    s.press("selectstart", null, point);
    s.press("pointermove", null, point);
    s.press("selectend", null, point);
    s.press("select", null, point);
    const id = Number(heard[0].split("#")[1].split(" ")[0]);
    captured.push(`after the release: ${outer.hasPointerCapture(id)}`);
    s.press("pointermove", null, point);
    assert.deepEqual(captured, ["has capture: true", "after the release: false"]);
    assert.deepEqual(
      heard.map((entry) => entry.split(" #")[0]),
      [
        "pointerdown on span",
        "mousedown on span",
        "pointermove on button",
        "mousemove on button",
        "pointerup on button",
        "mouseup on button",
        "click on span",
        "pointermove on span",
        "mousemove on span",
      ],
    );
    teardown();
  });

  test("leave the mouse's own capture to the browser", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    // Wrapped by now: an earlier test gave a hand a pointer.
    element.setPointerCapture(1);
    assert.equal(element.hasPointerCapture(1), true);
    element.releasePointerCapture(1);
    assert.equal(element.hasPointerCapture(1), false);
    assert.throws(() => element.setPointerCapture(99), { name: "NotFoundError" });
    element.remove();
  });
});
