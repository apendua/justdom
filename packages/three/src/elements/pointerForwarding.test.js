import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { shape } from "../svg/shape.js";
import { getContentGroup } from "./contentGroup.js";
import { box } from "./div.js";
import { registerPanel } from "./dragAndDrop.js";
import { createMirror } from "./mirror.js";
import { PORTAL_ATTRIBUTE } from "./portalRoot.js";
import { movesList } from "./scroll.js";
import { createHaptics, HapticsContext } from "./haptics.js";
import { recordingSource } from "../test/rumble.js";
import { clientRect } from "../test/clientRect.js";
import { describeScroller } from "../test/scroller.js";
import { countingManager, flushFrame, settle } from "../test/portalHarness.js";
import { forwardedPanel } from "../test/rays.js";
import { rayHand } from "../test/rayHand.js";
import { createPortal } from "./portal.js";
import { PointerForwarderContext } from "./pointerForwarding.js";

/**
 * @import { XREventMap } from "../core.js";
 */

// three's SVGLoader parses with DOMParser, which jsdom-env does not install.
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = window.DOMParser;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The capture method a browser has, before any panel wraps it. */
const { setPointerCapture } = Element.prototype;

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
 * outer under the panel's container, which carries the panel's forwarder,
 * in a scene. The container stands for a root element around the outer,
 * laid out where the outer is, as a portal's container stands for its
 * root, and is registered as the panel, so that a press can ask where on
 * the page it landed. The manager is a real one, because what is under
 * test is where its dispatch stops.
 *
 * @param {object} options
 * @param {Element} options.outer
 * @param {Element} options.inner
 * @param {(ctx: WeakKey, element: Element) => import("@apendua/signal").Source<THREE.Object3D>} options.build
 * @param {import("./haptics.js").Haptics | null} [options.haptics] What the
 *   panel lets the hand feel, if anything.
 */
function nest({ outer, inner, build, haptics = null }) {
  const root = document.createElement("div");
  root.setAttribute(PORTAL_ATTRIBUTE, "");
  root.getBoundingClientRect = () => outer.getBoundingClientRect();
  root.appendChild(outer);
  document.body.appendChild(root);
  const mirror = createMirror();
  mirror.adopt(root);
  mirror.adopt(outer);
  mirror.adopt(inner);

  const manager = new InteractionManager();
  const scene = new THREE.Object3D();
  const { ctx, container: panel } = forwardedPanel(
    HapticsContext.set(InteractionContext.set({}, manager), haptics),
  );
  scene.add(panel);

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
  const { unregister } = registerPanel(panel, root, (node) =>
    node === root ? panel : node === outer ? outerObject : node === inner ? innerObject : undefined,
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
    scene.addEventListener(/** @type {never} */ (type), () => escaped.push(type));
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
    innerObject,
    scene,
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
      if (type.endsWith("start") || type.endsWith("end")) {
        // The controller's own button event, which the manager's listener
        // passed on as the above, and which a scroll drag and the hand's
        // record of its buttons hear directly.
        hand.dispatchEvent(/** @type {never} */ ({ type, data: inputSource }));
      }
    },
    teardown() {
      for (const type of types) {
        document.removeEventListener(type, record, true);
      }
      PointerForwarderContext.get(ctx)?.dispose();
      unregister();
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      root.remove();
    },
  };
}

/**
 * A page mirrored into a real panel, in a scene with a real interaction
 * manager, for a test that hands drive frame by frame. The root is 400 by
 * 300 at the page's corner, and `place` lays each element out where it
 * says, on the page and so in the panel.
 *
 * @param {(place: (tag: string, id: string, at: [number, number, number, number], parent?: HTMLElement) => HTMLElement) => void} fill
 * @param {object} [options]
 * @param {string} [options.name] The root's id.
 * @param {InteractionManager} [options.manager] Another page's, to share
 *   its scene.
 * @param {THREE.Object3D} [options.scene]
 * @param {number} [options.x] How far along x to put the panel, in m, so
 *   that a ray aimed at one panel misses another.
 */
async function mirrored(
  fill,
  { name = "root", manager = new InteractionManager(), scene = new THREE.Group(), x = 0 } = {},
) {
  const root = document.createElement("div");
  root.id = name;
  root.getBoundingClientRect = () => clientRect(0, 0, 400, 300);
  fill((tag, id, at, parent = root) => {
    const element = document.createElement(tag);
    element.id = id;
    element.getBoundingClientRect = () => clientRect(...at);
    parent.appendChild(element);
    return element;
  });
  document.body.appendChild(root);
  const portal = createPortal(InteractionContext.set({}, manager), { root, budget: 0 });
  const group = new THREE.Group();
  group.position.x = x;
  scene.add(group);
  portal.addTo(group);
  await settle(portal);
  return {
    root,
    manager,
    scene,
    /** The panel's object, whose frame is the page's px. */
    panel: group.children[0],
    teardown() {
      portal.disconnect();
      root.remove();
      group.removeFromParent();
    },
  };
}

/**
 * What the page hears of the given events, as `type #id`, from the moment
 * this is called until `stop`; with `at`, followed by the event's point
 * and the buttons it says are held.
 *
 * @param {string[]} types
 * @param {{ at?: boolean }} [options]
 */
function hearing(types, { at = false } = {}) {
  /** @type {string[]} */
  const heard = [];
  /** @param {Event} event */
  const record = (event) => {
    const { clientX, clientY, buttons } = /** @type {MouseEvent} */ (event);
    const where = at ? ` at ${Math.round(clientX)},${Math.round(clientY)} buttons ${buttons}` : "";
    heard.push(`${event.type} #${/** @type {Element} */ (event.target).id}${where}`);
  };
  for (const type of types) {
    document.addEventListener(type, record, true);
  }
  return {
    heard,
    stop() {
      for (const type of types) {
        document.removeEventListener(type, record, true);
      }
    },
  };
}

/**
 * A row a hand's length tall in a list that scrolls, for `mirrored`.
 *
 * @param {Parameters<Parameters<typeof mirrored>[0]>[0]} place
 * @param {boolean} draggable Whether the row is `draggable="true"`.
 */
function scrollingRow(place, draggable) {
  const list = place("div", "list", [20, 20, 150, 120]);
  list.style.overflow = "hidden";
  describeScroller(list, { client: 120, scroll: 400 });
  const row = place("div", "row", [20, 20, 150, 100], list);
  row.style.cursor = "pointer";
  if (draggable) {
    row.setAttribute("draggable", "true");
  }
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
    s.scene.addEventListener(/** @type {never} */ ("squeezestart"), (event) =>
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

  test("carry the buttons the hand holds, the grip as 2", () => {
    const { s, point, inner, teardown } = label();
    /** @type {string[]} */
    const held = [];
    const types = [...TYPES, "contextmenu"];
    /** @param {Event} event */
    const record = (event) => {
      held.push(`${event.type} ${/** @type {MouseEvent} */ (event).buttons}`);
    };
    for (const type of types) {
      inner.addEventListener(type, record);
    }
    s.press("pointermove", null, point);
    s.press("selectstart", null, point);
    s.press("pointermove", null, point);
    s.press("squeezestart", null, point);
    s.press("pointermove", null, point);
    s.press("selectend", null, point);
    s.press("select", null, point);
    s.press("pointermove", null, point);
    s.press("squeezeend", null, point);
    s.press("squeeze", null, point);
    s.press("pointermove", null, point);
    assert.deepEqual(held, [
      "pointermove 0",
      "mousemove 0",
      // A press says the button it closed, and a release no longer does,
      // as a browser's do.
      "pointerdown 1",
      "mousedown 1",
      "pointermove 1",
      "mousemove 1",
      "pointermove 3",
      "mousemove 3",
      "pointerup 2",
      "mouseup 2",
      "click 2",
      "pointermove 2",
      "mousemove 2",
      "contextmenu 0",
      "pointermove 0",
      "mousemove 0",
    ]);
    teardown();
  });

  test("count a button closed while the ray was off the panels", () => {
    const { s, point, inner, teardown } = label();
    /** @type {number[]} */
    const held = [];
    inner.addEventListener("pointermove", (event) => held.push(event.buttons));
    s.press("pointermove", null, point);
    // The trigger closes with the ray on nothing the panel has: the
    // manager sends the scene nothing, and the controller its own event.
    s.controller.dispatchEvent(/** @type {never} */ ({ type: "selectstart", data: null }));
    s.press("pointermove", null, point);
    s.controller.dispatchEvent(/** @type {never} */ ({ type: "selectend", data: null }));
    s.press("pointermove", null, point);
    assert.deepEqual(held, [0, 1, 0]);
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

  test("are the mouse's from the primary hand alone, as a second touch's are not", () => {
    const { s, point, inner, teardown } = label();
    const other = /** @type {THREE.XRTargetRaySpace} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );
    /** @type {string[]} */
    const heard = [];
    /** @param {Event} event */
    const record = (event) => {
      heard.push(
        event instanceof PointerEvent
          ? `${event.type}${event.isPrimary ? " primary" : ""}`
          : event.type,
      );
    };
    for (const type of TYPES) {
      inner.addEventListener(type, record);
    }
    /**
     * @param {RayEventType} type
     * @param {THREE.XRTargetRaySpace} [hand]
     */
    const send = (type, hand) => {
      heard.push(`> ${hand === other ? "other" : "first"} ${type}`);
      s.press(type, null, point, undefined, null, undefined, hand);
    };
    send("pointermove");
    send("pointermove", other);
    // A press of a hand while the primary one holds nothing makes it the
    // primary one.
    send("selectstart", other);
    send("selectend", other);
    send("select", other);
    send("pointermove");
    // While the primary one holds a press, the other's does not take over,
    // and its click still goes.
    send("selectstart", other);
    send("selectstart");
    send("selectend");
    send("select");
    send("selectend", other);
    // Once the primary hand holds nothing and its ray is on no panel, the
    // next hand to send anything is the primary one.
    send("pointerleave", other);
    send("pointermove");
    assert.deepEqual(heard, [
      "> first pointermove",
      "pointermove primary",
      "mousemove",
      "> other pointermove",
      "pointermove",
      "> other selectstart",
      "pointerdown primary",
      "mousedown",
      "> other selectend",
      "pointerup primary",
      "mouseup",
      "> other select",
      "click",
      "> first pointermove",
      "pointermove",
      "> other selectstart",
      "pointerdown primary",
      "mousedown",
      "> first selectstart",
      "pointerdown",
      "> first selectend",
      "pointerup",
      "> first select",
      "click",
      "> other selectend",
      "pointerup primary",
      "mouseup",
      "> other pointerleave",
      "> first pointermove",
      "pointermove primary",
      "mousemove",
    ]);
    teardown();
  });

  test("say where the ray crosses from element to element, as a mouse's do", () => {
    const { s, point, inner, outer, teardown } = label();
    const crossings = [
      "pointerover",
      "pointerenter",
      "pointerout",
      "pointerleave",
      "mouseover",
      "mouseenter",
      "mouseout",
      "mouseleave",
      "pointermove",
      "mousemove",
    ];
    /** @type {string[]} */
    const heard = [];
    /** @param {Event} event */
    const record = (event) => {
      const { relatedTarget, bubbles } = /** @type {MouseEvent} */ (event);
      const target = /** @type {Element} */ (event.target).localName;
      const related = /** @type {Element | null} */ (relatedTarget)?.localName ?? "nothing";
      heard.push(
        event.type.endsWith("move")
          ? `${event.type} ${target}`
          : `${event.type} ${target} from ${related}${bubbles ? " bubbles" : ""}`,
      );
    };
    for (const type of crossings) {
      document.addEventListener(type, record, true);
    }
    /** @param {string} label */
    const step = (label) => heard.push(`> ${label}`);
    step("onto the label");
    s.press("pointerenter", null, point);
    s.press("pointermove", null, point);
    step("onto the button around it");
    s.press("pointerleave", null, undefined, undefined, s.outerObject);
    s.press("pointerenter", null, point, undefined, s.innerObject, s.outerObject);
    step("off the panel");
    s.press("pointerleave", null, undefined, undefined, null, s.outerObject);
    for (const type of crossings) {
      document.removeEventListener(type, record, true);
    }
    const root = /** @type {HTMLElement} */ (outer.parentElement).localName;
    assert.equal(root, "div");
    assert.equal(inner.localName, "span");
    assert.deepEqual(heard, [
      "> onto the label",
      // Over and out bubble from the element itself, and enter and leave
      // go to each element crossed, the panel's root included, from the
      // outermost in as the ray enters and the innermost out as it leaves.
      "pointerover span from nothing bubbles",
      "pointerenter div from nothing",
      "pointerenter button from nothing",
      "pointerenter span from nothing",
      "mouseover span from nothing bubbles",
      "mouseenter div from nothing",
      "mouseenter button from nothing",
      "mouseenter span from nothing",
      "pointermove span",
      "mousemove span",
      "> onto the button around it",
      "pointerout span from button bubbles",
      "pointerleave span from button",
      "pointerover button from span bubbles",
      "mouseout span from button bubbles",
      "mouseleave span from button",
      "mouseover button from span bubbles",
      "> off the panel",
      "pointerout button from nothing bubbles",
      "pointerleave button from nothing",
      "pointerleave div from nothing",
      "mouseout button from nothing bubbles",
      "mouseleave button from nothing",
      "mouseleave div from nothing",
    ]);
    teardown();
  });

  const MOVED = ["pointermove #row", "mousemove #row"];
  for (const [gesture, draggable, held, first] of /** @type {const} */ ([
    // The hand's frame comes before the page's in `rayHand`, so the move
    // that crosses the threshold is sent before the scroll hears of it.
    ["a scroll", false, MOVED, MOVED],
    // A press on something draggable sends no moves while it is held, as
    // a page's `:hover` holds still under a drag.
    ["a drag and drop", true, [], ["dragstart #row"]],
  ])) {
    test(`are cancelled when a press becomes ${gesture}, and go quiet until the release`, async () => {
      // A row a hand's length tall in a list that scrolls, so the ray stays
      // on it whether the list follows the hand or the row is carried.
      const page = await mirrored((place) => scrollingRow(place, draggable));
      const { panel } = page;
      const hand = rayHand(page.manager);
      hand.aim(panel, 95, 100);
      const { heard, stop } = hearing([
        "pointerdown",
        "pointermove",
        "pointercancel",
        "pointerout",
        "pointerleave",
        "pointerup",
        "mousedown",
        "mousemove",
        "mouseup",
        "click",
        "dragstart",
      ]);
      /** @param {string} label */
      const step = (label) => heard.push(`> ${label}`);

      step("press");
      hand.trigger("selectstart");
      hand.aim(panel, 95, 97);
      step("past the threshold");
      hand.aim(panel, 95, 60);
      step("on");
      hand.aim(panel, 95, 55);
      step("release");
      hand.trigger("selectend");
      await null;
      step("after");
      hand.aim(panel, 95, 50);
      hand.aim(panel, 95, 45);
      stop();
      assert.deepEqual(heard, [
        "> press",
        "pointerdown #row",
        "mousedown #row",
        ...held,
        "> past the threshold",
        ...first,
        // The pointer is taken away from the page, and leaves.
        "pointercancel #row",
        "pointerout #row",
        "pointerleave #row",
        "pointerleave #list",
        "pointerleave #root",
        "> on",
        "> release",
        "> after",
        ...MOVED,
        ...MOVED,
      ]);
      hand.remove();
      page.teardown();
    });
  }

  test("are cancelled on every panel the ray is over when the press becomes a gesture", async () => {
    // A press on a row whose ray is on another panel's button by the frame
    // the press becomes a scroll: that button is left as well.
    const page = await mirrored((place) => scrollingRow(place, false));
    const other = await mirrored(
      (place) => {
        place("div", "far", [20, 20, 100, 40]).style.cursor = "pointer";
      },
      { name: "other", manager: page.manager, scene: page.scene, x: 4 },
    );
    const hand = rayHand(page.manager);
    hand.aim(page.panel, 95, 100);
    hand.trigger("selectstart");
    const { heard, stop } = hearing(["pointercancel", "pointerout", "pointerleave"]);
    hand.aim(other.panel, 70, 40);
    stop();
    assert.deepEqual(heard, [
      "pointerout #row",
      "pointerleave #row",
      "pointerleave #list",
      "pointerleave #root",
      "pointercancel #row",
      "pointerout #far",
      "pointerleave #far",
      "pointerleave #other",
    ]);
    hand.trigger("selectend");
    hand.remove();
    other.teardown();
    page.teardown();
  });

  test("cancelled, catch up on another panel at the release where the ray is, holding nothing", async () => {
    // The press became a scroll on its own panel, and the ray went on to
    // another panel's button while the press was the scroll's.
    const page = await mirrored((place) => scrollingRow(place, false));
    const other = await mirrored(
      (place) => {
        place("div", "far", [20, 20, 100, 40]).style.cursor = "pointer";
      },
      { name: "other", manager: page.manager, scene: page.scene, x: 4 },
    );
    const hand = rayHand(page.manager);
    hand.aim(page.panel, 95, 100);
    hand.trigger("selectstart");
    hand.aim(page.panel, 95, 60);
    hand.aim(other.panel, 70, 40);
    const { heard, stop } = hearing(["mouseover", "pointerover"], { at: true });
    hand.trigger("selectend");
    stop();
    assert.deepEqual(
      heard.filter((entry) => entry.includes("#far")),
      ["pointerover #far at 70,40 buttons 0", "mouseover #far at 70,40 buttons 0"],
    );
    hand.remove();
    other.teardown();
    page.teardown();
  });

  test("cancelled, catch the mouse up on every panel at the release", async () => {
    // The mouse crossed onto another panel's button on the frame the press
    // became a scroll, and held still there while the press was the
    // scroll's. The ray turns away before the release.
    const page = await mirrored((place) => scrollingRow(place, false));
    const other = await mirrored(
      (place) => {
        place("div", "far", [20, 20, 100, 40]).style.cursor = "pointer";
      },
      { name: "other", manager: page.manager, scene: page.scene, x: 4 },
    );
    const hand = rayHand(page.manager);
    hand.aim(page.panel, 95, 100);
    hand.trigger("selectstart");
    hand.aim(other.panel, 70, 40);
    const { heard, stop } = hearing(["mouseout", "mouseleave"]);
    hand.turnAway();
    hand.trigger("selectend");
    hand.frame();
    hand.frame();
    stop();
    assert.deepEqual(heard, ["mouseout #far", "mouseleave #far", "mouseleave #other"]);
    hand.remove();
    other.teardown();
    page.teardown();
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

  /**
   * A drawing that drags by capture, as Euclid's does, in the corner of a
   * panel with room around it.
   *
   * @param {Parameters<Parameters<typeof mirrored>[0]>[0]} place
   * @param {[number, number, number, number]} [at]
   */
  const drawing = (
    place,
    at = /** @type {[number, number, number, number]} */ ([20, 20, 100, 100]),
  ) => {
    const element = place("div", "drawing", at);
    element.style.cursor = "pointer";
    element.addEventListener("pointerdown", (event) => {
      element.setPointerCapture(/** @type {PointerEvent} */ (event).pointerId);
    });
  };

  test("captured, follow the ray off the controls and off the panel", async () => {
    const page = await mirrored(drawing);
    const { panel } = page;
    const hand = rayHand(page.manager);
    /** @type {string[]} */
    const heard = [];
    /** @param {Event} event */
    const record = (event) => {
      const { clientX, clientY } = /** @type {MouseEvent} */ (event);
      const target = /** @type {Element} */ (event.target).id;
      heard.push(`${event.type} #${target} at ${Math.round(clientX)},${Math.round(clientY)}`);
    };
    const types = ["pointermove", "pointerup"];
    for (const type of types) {
      document.addEventListener(type, record, true);
    }
    hand.aim(panel, 50, 50);
    hand.trigger("selectstart");
    hand.aim(panel, 60, 50);
    // Onto the panel's background, where no control is.
    hand.aim(panel, 200, 150);
    // Past the panel's edge, onto nothing at all.
    hand.aim(panel, 500, 350);
    // A frame with the hand still sends nothing new.
    hand.frame();
    hand.aim(panel, 80, 80);
    hand.trigger("selectend");
    for (const type of types) {
      document.removeEventListener(type, record, true);
    }
    assert.deepEqual(heard, [
      "pointermove #drawing at 60,50",
      "pointermove #drawing at 200,150",
      "pointermove #drawing at 500,350",
      "pointermove #drawing at 80,80",
      "pointerup #drawing at 80,80",
    ]);
    hand.remove();
    page.teardown();
  });

  test("captured, are released where the ray crosses the captor's panel", async () => {
    const page = await mirrored(drawing);
    const other = await mirrored(
      (place) => {
        place("div", "far", [20, 20, 100, 40]).style.cursor = "pointer";
      },
      { name: "other", manager: page.manager, scene: page.scene, x: 4 },
    );
    const hand = rayHand(page.manager);
    /** @type {string[]} */
    const heard = [];
    /** @param {Event} event */
    const record = (event) => {
      const { clientX, clientY } = /** @type {MouseEvent} */ (event);
      const target = /** @type {Element} */ (event.target).id;
      heard.push(`${event.type} #${target} at ${Math.round(clientX)},${Math.round(clientY)}`);
    };
    const types = ["pointerup", "mouseup"];
    for (const type of types) {
      document.addEventListener(type, record, true);
    }
    // Released past the panel's edge, onto nothing at all.
    hand.aim(page.panel, 50, 50);
    hand.trigger("selectstart");
    hand.aim(page.panel, 500, 350);
    hand.trigger("selectend");
    // Released on another panel, which is still off the captor's.
    hand.aim(page.panel, 50, 50);
    hand.trigger("selectstart");
    hand.aim(other.panel, 70, 40);
    hand.trigger("selectend");
    for (const type of types) {
      document.removeEventListener(type, record, true);
    }
    // The other panel lies 4 units to the right in the captor's plane,
    // which is 400 of the captor's px at a portal's 0.01 units a px.
    assert.deepEqual(heard, [
      "pointerup #drawing at 500,350",
      "mouseup #drawing at 500,350",
      "pointerup #drawing at 470,40",
      "mouseup #drawing at 470,40",
    ]);
    hand.remove();
    other.teardown();
    page.teardown();
  });

  test("captured, are released where the pointer last was when the ray turns from the plane", async () => {
    const page = await mirrored(drawing);
    const hand = rayHand(page.manager);
    hand.aim(page.panel, 50, 50);
    hand.trigger("selectstart");
    hand.aim(page.panel, 500, 350);
    // Turned round, the ray crosses the captor's plane nowhere.
    hand.turnAway();
    const { heard, stop } = hearing(["pointerup", "mouseup"], { at: true });
    hand.trigger("selectend");
    stop();
    assert.deepEqual(heard, [
      "pointerup #drawing at 500,350 buttons 0",
      "mouseup #drawing at 500,350 buttons 0",
    ]);
    hand.remove();
    page.teardown();
  });

  test("captured, say where the pointer is as the capture comes and goes", async () => {
    const page = await mirrored(drawing);
    const hand = rayHand(page.manager);
    const { heard, stop } = hearing(
      ["gotpointercapture", "pointerup", "lostpointercapture", "pointerout", "pointerleave"],
      { at: true },
    );
    hand.aim(page.panel, 50, 50);
    hand.trigger("selectstart");
    // The capture takes hold at this move, before the move goes out.
    hand.aim(page.panel, 60, 50);
    // Released past the panel's edge, where its moves had taken it.
    hand.aim(page.panel, 500, 350);
    hand.trigger("selectend");
    stop();
    assert.deepEqual(heard, [
      "gotpointercapture #drawing at 50,50 buttons 1",
      "pointerup #drawing at 500,350 buttons 0",
      "lostpointercapture #drawing at 500,350 buttons 0",
      "pointerout #drawing at 500,350 buttons 0",
      "pointerleave #drawing at 500,350 buttons 0",
      "pointerleave #root at 500,350 buttons 0",
    ]);
    hand.remove();
    page.teardown();
  });

  test("captured, released with the ray turned from the plane, leave where the release says", async () => {
    const page = await mirrored(drawing);
    const hand = rayHand(page.manager);
    hand.aim(page.panel, 50, 50);
    hand.trigger("selectstart");
    hand.aim(page.panel, 500, 350);
    hand.turnAway();
    const { heard, stop } = hearing(["lostpointercapture", "pointerout", "mouseout"], {
      at: true,
    });
    hand.trigger("selectend");
    stop();
    assert.deepEqual(heard, [
      "lostpointercapture #drawing at 500,350 buttons 0",
      "pointerout #drawing at 500,350 buttons 0",
      "mouseout #drawing at 500,350 buttons 0",
    ]);
    hand.remove();
    page.teardown();
  });

  test("captured, leave the captor where the release says, not where the last move did", async () => {
    const page = await mirrored(drawing);
    const hand = rayHand(page.manager);
    hand.aim(page.panel, 50, 50);
    hand.trigger("selectstart");
    hand.aim(page.panel, 500, 350);
    // The ray moves on with no frame between, so the release is the first
    // the page hears of where it went.
    page.panel.updateWorldMatrix(true, true);
    const point = page.panel.localToWorld(new THREE.Vector3(450, 320, 0));
    hand.controller.position.set(point.x, point.y, point.z + 1);
    hand.controller.updateMatrixWorld(true);
    const { heard, stop } = hearing(["pointerup", "lostpointercapture", "pointerout"], {
      at: true,
    });
    hand.trigger("selectend");
    stop();
    assert.deepEqual(heard, [
      "pointerup #drawing at 450,320 buttons 0",
      "lostpointercapture #drawing at 450,320 buttons 0",
      "pointerout #drawing at 450,320 buttons 0",
    ]);
    hand.remove();
    page.teardown();
  });

  for (const [gesture, draggable] of /** @type {const} */ ([
    ["a scroll", false],
    ["a drag and drop", true],
  ])) {
    test(`taken by ${gesture} and released off the panel, leave nowhere, as no release says where`, async () => {
      const page = await mirrored((place) => scrollingRow(place, draggable));
      const hand = rayHand(page.manager);
      hand.aim(page.panel, 95, 100);
      hand.trigger("selectstart");
      hand.aim(page.panel, 95, 97);
      hand.aim(page.panel, 95, 60);
      hand.aim(page.panel, 95, 55);
      hand.turnAway();
      const { heard, stop } = hearing(["pointerup", "mouseout"], { at: true });
      hand.trigger("selectend");
      await null;
      stop();
      assert.deepEqual(heard, ["mouseout #row at 0,0 buttons 0"]);
      hand.remove();
      page.teardown();
    });
  }

  test("uncaptured, released off the panel, leave the pointer where it last was on the page", async () => {
    const page = await mirrored((place) => {
      place("div", "btn", [20, 20, 100, 40]).style.cursor = "pointer";
    });
    const button = /** @type {HTMLElement} */ (page.root.querySelector("#btn"));
    let pointerId = 0;
    button.addEventListener("pointerdown", (event) => {
      pointerId = /** @type {PointerEvent} */ (event).pointerId;
    });
    const hand = rayHand(page.manager);
    hand.aim(page.panel, 70, 40);
    hand.trigger("selectstart");
    hand.aim(page.panel, 500, 350);
    // A release off the panel, uncaptured, is nowhere on the page.
    hand.trigger("selectend");
    // A capture taken with no button held, before the next press.
    button.setPointerCapture(pointerId);
    const { heard, stop } = hearing(["gotpointercapture"], { at: true });
    hand.aim(page.panel, 60, 30);
    stop();
    button.releasePointerCapture(pointerId);
    assert.deepEqual(heard, ["gotpointercapture #btn at 70,40 buttons 0"]);
    hand.remove();
    page.teardown();
  });

  test("after a swallowed press, leave nowhere, whatever the hand's last release said", async () => {
    const page = await mirrored((place) => {
      drawing(place, [20, 20, 100, 40]);
      place("div", "gone", [300, 200, 60, 60]).style.cursor = "pointer";
    });
    const captor = /** @type {HTMLElement} */ (page.root.querySelector("#drawing"));
    let pointerId = 0;
    captor.addEventListener("pointerdown", (event) => {
      pointerId = /** @type {PointerEvent} */ (event).pointerId;
    });
    const hand = rayHand(page.manager);
    // A captured release, placed on the captor's plane.
    hand.aim(page.panel, 50, 30);
    hand.trigger("selectstart");
    hand.trigger("selectend");
    // A capture taken with no button held, which the next press keeps.
    captor.setPointerCapture(pointerId);
    hand.aim(page.panel, 330, 230);
    // A press on an element that has left the page is swallowed: it sends
    // no `pointerdown`, and its end no `pointerup`.
    /** @type {HTMLElement} */ (page.root.querySelector("#gone")).remove();
    hand.trigger("selectstart");
    hand.turnAway();
    const { heard, stop } = hearing(["pointerup", "pointerout", "mouseout"], { at: true });
    hand.trigger("selectend");
    stop();
    assert.deepEqual(heard, [
      "pointerout #drawing at 0,0 buttons 0",
      "mouseout #drawing at 0,0 buttons 0",
    ]);
    hand.remove();
    page.teardown();
  });

  test("uncaptured, released on the panel, leave the pointer where the release says", async () => {
    const page = await mirrored((place) => {
      place("div", "btn", [20, 20, 200, 100]).style.cursor = "pointer";
    });
    const button = /** @type {HTMLElement} */ (page.root.querySelector("#btn"));
    let pointerId = 0;
    button.addEventListener("pointerdown", (event) => {
      pointerId = /** @type {PointerEvent} */ (event).pointerId;
    });
    const hand = rayHand(page.manager);
    hand.aim(page.panel, 70, 40);
    hand.trigger("selectstart");
    // The ray moves on with no frame between, so the release is the first
    // the page hears of where it went.
    page.panel.updateWorldMatrix(true, true);
    const point = page.panel.localToWorld(new THREE.Vector3(150, 90, 0));
    hand.controller.position.set(point.x, point.y, point.z + 1);
    hand.controller.updateMatrixWorld(true);
    const { heard, stop } = hearing(["pointerup", "gotpointercapture"], { at: true });
    hand.trigger("selectend");
    button.setPointerCapture(pointerId);
    hand.aim(page.panel, 160, 95);
    stop();
    button.releasePointerCapture(pointerId);
    assert.deepEqual(heard, [
      "pointerup #btn at 150,90 buttons 0",
      "gotpointercapture #btn at 150,90 buttons 0",
    ]);
    hand.remove();
    page.teardown();
  });

  // Pins where the release reads its capture: after `settleCapture`, from
  // the captor it is then sent to, and not before.
  test("let go of before the release, are released as an uncaptured press is", async () => {
    const page = await mirrored(drawing);
    const element = /** @type {HTMLElement} */ (page.root.querySelector("#drawing"));
    element.addEventListener("pointermove", (event) => {
      element.releasePointerCapture(/** @type {PointerEvent} */ (event).pointerId);
    });
    const hand = rayHand(page.manager);
    hand.aim(page.panel, 50, 50);
    hand.trigger("selectstart");
    // The capture takes hold at this move, which lets go of it; the
    // release that follows is the next event, which ends it.
    hand.aim(page.panel, 500, 350);
    const { heard, stop } = hearing(["pointerup", "mouseup"], { at: true });
    hand.trigger("selectend");
    stop();
    // Off the panel, uncaptured, the release is nowhere on the page.
    assert.deepEqual(heard, [
      "pointerup #drawing at 0,0 buttons 0",
      "mouseup #drawing at 0,0 buttons 0",
    ]);
    hand.remove();
    page.teardown();
  });

  test("leave as a browser's do, the pointer first, when a hand that holds nothing goes", async () => {
    const page = await mirrored((place) => {
      place("div", "btn", [20, 20, 100, 40]).style.cursor = "pointer";
    });
    const hand = rayHand(page.manager);
    hand.aim(page.panel, 70, 40);
    const { heard, stop } = hearing(["pointerout", "pointerleave", "mouseout", "mouseleave"]);
    hand.disconnect();
    hand.frame();
    stop();
    assert.deepEqual(heard, [
      "pointerout #btn",
      "pointerleave #btn",
      "pointerleave #root",
      "mouseout #btn",
      "mouseleave #btn",
      "mouseleave #root",
    ]);
    hand.remove();
    page.teardown();
  });

  test("captured on one panel, take the mouse off the captor when the hand goes", async () => {
    const page = await mirrored(drawing);
    const other = await mirrored(
      (place) => {
        place("div", "far", [20, 20, 100, 40]).style.cursor = "pointer";
      },
      { name: "other", manager: page.manager, scene: page.scene, x: 4 },
    );
    const hand = rayHand(page.manager);
    hand.aim(page.panel, 50, 50);
    hand.trigger("selectstart");
    hand.aim(other.panel, 70, 40);
    const { heard, stop } = hearing(["mouseover", "mouseout", "mouseleave"]);
    hand.disconnect();
    hand.frame();
    stop();
    assert.deepEqual(heard, ["mouseout #drawing", "mouseleave #drawing", "mouseleave #root"]);
    hand.remove();
    other.teardown();
    page.teardown();
  });

  test("captured, are cancelled when the hand goes, and followed no further", async () => {
    const page = await mirrored(drawing);
    const hand = rayHand(page.manager);
    hand.aim(page.panel, 50, 50);
    hand.trigger("selectstart");
    const { heard, stop } = hearing([
      "gotpointercapture",
      "pointermove",
      "pointercancel",
      "lostpointercapture",
    ]);
    hand.aim(page.panel, 60, 50);
    // At the end of a session, say: no release will come.
    hand.disconnect();
    hand.aim(page.panel, 80, 80);
    stop();
    assert.deepEqual(heard, [
      "gotpointercapture #drawing",
      "pointermove #drawing",
      "pointercancel #drawing",
      "lostpointercapture #drawing",
    ]);
    hand.remove();
    page.teardown();
  });

  test("move the mouse to the hand that takes over, on every panel", async () => {
    // One hand on a button of one panel is the primary one; the other,
    // on another panel's button, presses it and takes over.
    const page = await mirrored((place) => {
      place("div", "first", [20, 20, 100, 40]).style.cursor = "pointer";
    });
    const other = await mirrored(
      (place) => {
        place("div", "second", [20, 20, 100, 40]).style.cursor = "pointer";
      },
      { name: "other", manager: page.manager, scene: page.scene, x: 4 },
    );
    const firstHand = rayHand(page.manager);
    const secondHand = rayHand(page.manager);
    firstHand.aim(page.panel, 70, 40);
    secondHand.aim(other.panel, 70, 40);
    const { heard, stop } = hearing([
      "mouseover",
      "mouseenter",
      "mouseout",
      "mouseleave",
      "pointerdown",
      "mousedown",
    ]);
    secondHand.trigger("selectstart");
    stop();
    assert.deepEqual(heard, [
      // The mouse leaves where the first hand left it,
      "mouseout #first",
      "mouseleave #first",
      "mouseleave #root",
      // and is over the second hand's button before it is pressed there.
      "mouseover #second",
      "mouseenter #other",
      "mouseenter #second",
      "pointerdown #second",
      "mousedown #second",
    ]);
    secondHand.trigger("selectend");
    firstHand.remove();
    secondHand.remove();
    other.teardown();
    page.teardown();
  });

  test("move the mouse to a captured hand that takes over on a move", async () => {
    // The first hand holds a button; the second captures a drawing and
    // takes its ray to another panel. The first lets go and turns away, and
    // the second's next captured move makes it the primary one.
    const page = await mirrored((place) => {
      place("div", "hold", [20, 20, 100, 40]).style.cursor = "pointer";
      drawing(place, [20, 100, 100, 100]);
    });
    const other = await mirrored(
      (place) => {
        place("div", "far", [20, 20, 100, 40]).style.cursor = "pointer";
      },
      { name: "other", manager: page.manager, scene: page.scene, x: 4 },
    );
    const firstHand = rayHand(page.manager);
    const secondHand = rayHand(page.manager);
    firstHand.aim(page.panel, 70, 40);
    firstHand.trigger("selectstart");
    secondHand.aim(page.panel, 70, 150);
    secondHand.trigger("selectstart");
    secondHand.aim(other.panel, 70, 40);
    firstHand.trigger("selectend");
    firstHand.turnAway();
    const { heard, stop } = hearing([
      "mouseover",
      "mouseenter",
      "mouseout",
      "mouseleave",
      "mousemove",
      "mouseup",
    ]);
    secondHand.aim(other.panel, 75, 40);
    secondHand.trigger("selectend");
    stop();
    assert.deepEqual(heard, [
      // The mouse is over the captor before its first move there,
      "mouseover #drawing",
      "mouseenter #root",
      "mouseenter #drawing",
      "mousemove #drawing",
      "mouseup #drawing",
      // and goes where the ray is once the release ends the capture.
      "mouseout #drawing",
      "mouseleave #drawing",
      "mouseleave #root",
      "mouseover #far",
      "mouseenter #other",
      "mouseenter #far",
    ]);
    firstHand.remove();
    secondHand.remove();
    other.teardown();
    page.teardown();
  });

  test("let the page release a hand's capture in its own pointerup", () => {
    /** @type {string[]} */
    const handled = [];
    const { s, point, outer, teardown } = label((event) => {
      if (event.type === "pointerdown") {
        outer.setPointerCapture(/** @type {PointerEvent} */ (event).pointerId);
      }
    });
    outer.addEventListener("pointerup", (event) => {
      // What a page that drags by capture writes on its captor, which by
      // now finds the capture gone with the release, as a browser's is.
      outer.releasePointerCapture(/** @type {PointerEvent} */ (event).pointerId);
      handled.push("released");
    });
    s.press("selectstart", null, point);
    s.press("selectend", null, point);
    s.press("select", null, point);
    const span = /** @type {HTMLElement} */ (outer.firstElementChild);
    span.releasePointerCapture(2);
    handled.push("released one never captured");
    assert.deepEqual(handled, ["released", "released one never captured"]);
    teardown();
  });

  test("tell the captor it has the pointer, and that it has lost it", () => {
    let id = 0;
    const { s, point, outer, teardown } = label((event) => {
      if (event.type === "pointerdown") {
        id = /** @type {PointerEvent} */ (event).pointerId;
        outer.setPointerCapture(id);
      }
    });
    const types = [
      "gotpointercapture",
      "lostpointercapture",
      "pointerdown",
      "pointermove",
      "pointerup",
      "mouseup",
      "click",
    ];
    /** @type {string[]} */
    const heard = [];
    /** @param {Event} event */
    const record = (event) => {
      heard.push(`${event.type} on ${/** @type {Element} */ (event.target).localName}`);
    };
    for (const type of types) {
      document.addEventListener(type, record, true);
    }
    s.press("selectstart", null, point);
    s.press("pointermove", null, point);
    s.press("selectend", null, point);
    s.press("select", null, point);
    // A page that lets go of it before the release.
    s.press("selectstart", null, point);
    s.press("pointermove", null, point);
    outer.releasePointerCapture(id);
    s.press("pointermove", null, point);
    s.press("selectend", null, point);
    for (const type of types) {
      document.removeEventListener(type, record, true);
    }
    assert.deepEqual(heard, [
      "pointerdown on span",
      // Before the hand's next event, as a browser processes a capture.
      "gotpointercapture on button",
      "pointermove on button",
      "pointerup on button",
      "mouseup on button",
      // The release ends it.
      "lostpointercapture on button",
      "click on span",
      "pointerdown on span",
      "gotpointercapture on button",
      "pointermove on button",
      "lostpointercapture on button",
      "pointermove on span",
      "pointerup on span",
      "mouseup on span",
    ]);
    teardown();
  });

  test("wrap the capture methods while a panel is up, and no longer", () => {
    const proto = Element.prototype;
    const first = label();
    const second = label();
    assert.equal(proto.setPointerCapture, setPointerCapture, "not before a hand sends anything");
    first.s.press("pointermove", null, first.point);
    assert.notEqual(proto.setPointerCapture, setPointerCapture, "wrapped while panels are up");
    first.teardown();
    assert.notEqual(proto.setPointerCapture, setPointerCapture, "and while one is");
    second.teardown();
    assert.equal(proto.setPointerCapture, setPointerCapture, "given back after the last");
  });

  test("leave the mouse's own capture to the browser", () => {
    const { s, point, teardown } = label();
    // A hand sends something, so the wrap is on and the mouse's capture
    // goes through it.
    s.press("pointermove", null, point);
    assert.notEqual(Element.prototype.setPointerCapture, setPointerCapture);
    const element = document.createElement("div");
    document.body.appendChild(element);
    element.setPointerCapture(1);
    assert.equal(element.hasPointerCapture(1), true);
    element.releasePointerCapture(1);
    assert.equal(element.hasPointerCapture(1), false);
    assert.throws(() => element.setPointerCapture(99), { name: "NotFoundError" });
    assert.throws(() => element.releasePointerCapture(99), { name: "NotFoundError" });
    element.remove();
    teardown();
  });
});

describe("a press on mirrored content that is no ray target", () => {
  test("is named once per element in development", async () => {
    // A board that listens for clicks but says no `cursor: pointer`, as
    // Knights' did, and a label beside it, with room around both.
    /** @type {HTMLElement[]} */
    const pressed = [];
    /** @type {string[]} */
    const clicks = [];
    const page = await mirrored((place) => {
      pressed.push(place("div", "board", [20, 20, 200, 200]));
      const label = place("p", "", [250, 20, 100, 40]);
      label.removeAttribute("id");
      label.className = "caption";
      pressed.push(label);
      // A menu in a layer of its own, whose padding a press reaches through
      // its own blocker, as a click on the menu.
      const menu = place("div", "menu", [250, 100, 100, 60]);
      menu.style.cssText = "position: absolute; z-index: 10";
      menu.addEventListener("click", () => clicks.push("menu"));
      pressed.push(menu);
    });
    const [board, label, menu] = pressed;
    // Something of the scene's own hung in the panel, as a plugin hangs
    // its objects, which takes presses of its own.
    const prop = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
    prop.position.set(300, 200, -5);
    page.panel.add(prop);
    page.manager.add(/** @type {never} */ (prop));
    /** @type {string[]} */
    const taken = [];
    prop.addEventListener(/** @type {never} */ ("selectstart"), () => taken.push("prop"));
    const hand = rayHand(page.manager);
    /** @type {string[]} */
    const notes = [];
    const { warn } = console;
    const { NODE_ENV } = process.env;
    /** @param {[number, number]} at */
    const pressAt = ([x, y]) => {
      hand.aim(page.panel, x, y);
      hand.trigger("selectstart");
      hand.trigger("selectend");
    };
    /** @param {Element} element */
    const middle = (element) => {
      const { left, top, width, height } = element.getBoundingClientRect();
      return /** @type {[number, number]} */ ([left + width / 2, top + height / 2]);
    };
    try {
      console.warn = (message) => notes.push(String(message));
      process.env.NODE_ENV = "production";
      pressAt(middle(board));
      assert.deepEqual(notes, [], "nothing outside development");
      process.env.NODE_ENV = "development";
      pressAt(middle(board));
      pressAt(middle(board));
      pressAt(middle(label));
      // The panel's own background, the scene's object in the panel, and
      // the menu's padding.
      pressAt([380, 250]);
      pressAt([300, 200]);
      pressAt(middle(menu));
      assert.deepEqual(taken, ["prop"], "the press reached the scene's object");
      assert.deepEqual(clicks, ["menu"], "and the menu heard its click");
      assert.equal(notes.length, 2, "once for each element of the page, and for nothing else");
      assert.match(notes[0], /div#board/);
      assert.match(notes[1], /p\.caption/);
    } finally {
      console.warn = warn;
      process.env.NODE_ENV = NODE_ENV;
      hand.remove();
      page.teardown();
    }
  });
});

describe("a panel's ray events", () => {
  test("are heard by its container, and by nothing in it but the background", async () => {
    // Which ray events each object listens for, recorded as listeners are
    // added and removed rather than read from three's private store.
    /** @type {Map<object, Map<string, number>>} */
    const listening = new Map();
    /**
     * @param {object} object
     * @param {string} type
     * @param {number} by
     */
    const count = (object, type, by) => {
      const types = listening.get(object) ?? new Map();
      types.set(type, (types.get(type) ?? 0) + by);
      listening.set(object, types);
    };
    /** @type {any} */
    const proto = THREE.EventDispatcher.prototype;
    const { addEventListener, removeEventListener } = proto;
    /** @this {THREE.EventDispatcher} @param {string} type @param {any} listener */
    proto.addEventListener = function (type, listener) {
      if (!this.hasEventListener(type, listener)) {
        count(this, type, 1);
      }
      addEventListener.call(this, type, listener);
    };
    /** @this {THREE.EventDispatcher} @param {string} type @param {any} listener */
    proto.removeEventListener = function (type, listener) {
      if (this.hasEventListener(type, listener)) {
        count(this, type, -1);
      }
      removeEventListener.call(this, type, listener);
    };

    // A clickable card with a clickable icon in it, and a list that scrolls,
    // of clickable rows: every kind of element a ray acts on in a panel
    // that has no field and no overlay, which listen for their own reasons.
    const root = document.createElement("div");
    const card = html("div", "cursor: pointer");
    card.appendChild(html("span", "cursor: pointer"));
    const list = html("div", "overflow: hidden");
    describeScroller(list, { client: 50, scroll: 400 });
    list.appendChild(html("div", "cursor: pointer"));
    list.appendChild(html("div", "cursor: pointer"));
    root.append(card, list);
    document.body.appendChild(root);
    const { ctx, targets } = countingManager();
    const portal = createPortal(ctx, { root, budget: 0 });
    const scene = new THREE.Group();
    try {
      portal.addTo(scene);
      await settle(portal);
    } finally {
      proto.addEventListener = addEventListener;
      proto.removeEventListener = removeEventListener;
    }
    const container = scene.children[0];
    assert.equal(targets.size, 6, "the background, the card, the icon, the list and its rows");

    const types = [
      "selectstart",
      "selectend",
      "select",
      "selectmissed",
      "squeezestart",
      "squeezeend",
      "squeeze",
      "squeezemissed",
      "pointermove",
      "pointerenter",
      "pointerleave",
    ];
    /**
     * The ray events an object listens for.
     *
     * @param {THREE.Object3D} object
     */
    const heard = (object) => types.filter((type) => (listening.get(object)?.get(type) ?? 0) > 0);
    // Every event the container listens for, ray event or not, so that a
    // listener added beside these is seen too.
    const containerHears = [...(listening.get(container) ?? [])]
      .filter(([, count]) => count > 0)
      .map(([type]) => type)
      .sort();
    assert.deepEqual(
      containerHears,
      [...types].sort(),
      "the container hears every ray event, and no more",
    );
    /** @type {string[][]} */
    const inside = [];
    container.traverse((object) => {
      if (object !== container && heard(object).length > 0) {
        inside.push(heard(object));
      }
    });
    assert.deepEqual(inside, [["select"]], "and in it only the background's click");

    portal.disconnect();
    root.remove();
  });
});
