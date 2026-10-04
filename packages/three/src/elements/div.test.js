import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext } from "../interactions.js";
import { createMirror } from "./mirror.js";
import { PORTAL_ATTRIBUTE } from "./portalRoot.js";
import { div } from "./div.js";
import { getContentRenderOrder } from "./elevation.js";
import { GRADIENT_LINEAR, rampAtlas } from "./gradient.js";
import { createHaptics, HapticsContext } from "./haptics.js";
import { getContentGroup } from "./contentGroup.js";
import { scrollDrags } from "./scroll.js";
import { describeScroller } from "../test/scroller.js";
import { recordingSource } from "../test/rumble.js";
import { clientRect } from "../test/clientRect.js";
import { registerPanel } from "./dragAndDrop.js";
import { createPanelForwarder, PointerForwarderContext } from "./pointerForwarding.js";
import { rectGeometry } from "./sdfRect.js";

/**
 * @import { InteractionManager } from "../interactions.js";
 * @import { XREventMap } from "../core.js";
 */

// jsdom implements no Font Loading API, and `VisualProperties` refuses to
// measure text until `document.fonts` says the fonts are in — which, left
// undefined, throws from a recompute well after the test that started it. The
// x-height it goes on to measure is zero in a browserless layout either way,
// and none of that is what this file is about.
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: {
    status: "loaded",
    ready: Promise.resolve(),
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

/**
 * A ray event sent the way the manager sends one: to the object the ray
 * met, and up through its parents, each told what it went through.
 *
 * @param {THREE.Object3D} object
 * @param {object} event
 */
function bubble(object, event) {
  const sent = /** @type {any} */ ({ ...event, originalTarget: object });
  for (let node = /** @type {THREE.Object3D | null} */ (object); node; node = node.parent) {
    node.dispatchEvent(sent);
  }
}

/**
 * An element wired the way the portal wires one: a mirror standing in for the
 * portal's own, so a style change can be announced the way a real one is.
 *
 * The manager is recorded rather than real — what is being tested is which
 * objects `div` hands it and when, not what it then does with them.
 *
 * @param {string} cursor
 * @param {string} [cssText] Anything else the element should be styled with.
 * @param {import('./haptics.js').Haptics | null} [haptics] What the panel
 *   the element is in feels like; none, as outside a panel, unless given.
 * @param {HTMLElement} [parent] Where the element goes. Unless given, a
 *   fresh container of its own, so that what earlier tests left behind is
 *   never a sibling it could be stacked against.
 * @param {{ ctx: WeakKey, panel: THREE.Object3D }} [within] An element set
 *   up earlier whose panel this one is in, sharing its forwarder; the test
 *   puts this one's object under that one's. Unless given, the element's
 *   object is put under a panel of its own, whose container carries a
 *   forwarder as the portal's does.
 */
function setup(
  cursor,
  cssText = "",
  haptics = null,
  parent = document.body.appendChild(document.createElement("div")),
  within,
) {
  const element = document.createElement("div");
  element.style.cssText = cssText;
  element.style.cursor = cursor;
  parent.appendChild(element);

  const mirror = createMirror();
  mirror.adopt(element);

  /** @type {string[]} */
  const registrations = [];
  /** @type {THREE.Object3D[]} */
  const registered = [];
  const manager = /** @type {InteractionManager} */ (
    /** @type {unknown} */ ({
      /** @param {THREE.Object3D} object */
      add: (object) => {
        registrations.push("add");
        registered.push(object);
      },
      /** @param {THREE.Object3D} object */
      remove: (object) => {
        registrations.push("remove");
        const index = registered.indexOf(object);
        if (index >= 0) {
          registered.splice(index, 1);
        }
      },
      stopPropagation: () => {},
    })
  );

  const panel = within?.panel ?? new THREE.Object3D();
  const base = HapticsContext.set(InteractionContext.set({}, manager), haptics);
  const ctx = within?.ctx ?? PointerForwarderContext.set(base, createPanelForwarder(base, panel));

  /** @type {THREE.Object3D<XREventMap>} */
  let object;
  const subscription = div(ctx, element).subscribe((value) => {
    object = /** @type {THREE.Object3D<XREventMap>} */ (value);
    if (!within) {
      panel.add(value);
    }
  });

  return {
    ctx,
    panel,
    element,
    mirror,
    registrations,
    registered,
    subscription,
    get object() {
      return object;
    },
    /** Announce a style change the way the portal's observer would. */
    restyle: (/** @type {string} */ value) => {
      element.style.cursor = value;
      mirror.attributeChanged(element);
    },
    /** The same, for anything that is not the cursor. */
    restyleWith: (/** @type {string} */ cssText) => {
      element.style.cssText = cssText;
      mirror.attributeChanged(element);
    },
    /**
     * A restyle announced the way a *hover* is: presentational, so the
     * mirror re-reads styles and measures nothing. What a rule following
     * `[data-xr-hover]` is allowed to do goes through here.
     */
    hoverWith: (/** @type {string} */ cssText) => {
      element.style.cssText = cssText;
      mirror.attributeChanged(element, { presentational: true, selfScoped: true });
    },
    /**
     * A ray event on this element's object, sent up through its parents as
     * the manager sends one.
     *
     * @param {"pointerenter" | "pointerleave" | "selectstart" | "selectend"} type
     * @param {XRInputSource | null} [inputSource] The hand it came from.
     * @param {THREE.Object3D | null} [relatedTarget] Where the ray was before.
     * @param {THREE.Object3D} [registeredTarget] What the hit belongs to,
     *   when not this object.
     * @param {THREE.Object3D} [controller] The hand, for what it is doing.
     */
    dispatch: (
      type,
      inputSource = null,
      relatedTarget = null,
      registeredTarget = object,
      controller = new THREE.Object3D(),
    ) => {
      bubble(object, { type, registeredTarget, inputSource, relatedTarget, controller });
    },
  };
}

describe("div interactivity", () => {
  test("an element that is not clickable is never registered", () => {
    const { registrations, subscription } = setup("default");
    assert.deepEqual(registrations, []);
    subscription.unsubscribe();
  });

  test("a clickable element is registered, and unregistered on teardown", () => {
    const { registrations, subscription } = setup("pointer");
    assert.deepEqual(registrations, ["add"]);
    subscription.unsubscribe();
    assert.deepEqual(registrations, ["add", "remove"]);
  });

  test("interactivity follows cursor: pointer as the stylesheet changes it", () => {
    const { registrations, restyle, subscription } = setup("default");

    restyle("pointer");
    assert.deepEqual(registrations, ["add"]);

    restyle("default");
    assert.deepEqual(registrations, ["add", "remove"]);

    restyle("pointer");
    assert.deepEqual(registrations, ["add", "remove", "add"]);

    subscription.unsubscribe();
  });

  test("a restyle that leaves the answer alone does not churn the registration", () => {
    const { registrations, restyle, subscription } = setup("pointer");
    assert.deepEqual(registrations, ["add"]);

    // Any attribute mutation invalidates the computed style on purpose, and the
    // hover handler writes one back onto this very element. Detaching on each
    // of those would pull the listeners out from under the events they handle.
    restyle("pointer");
    restyle("pointer");
    assert.deepEqual(registrations, ["add"]);

    subscription.unsubscribe();
  });

  test("pointer-events: none takes an element out of the rays, cursor or not", () => {
    // What a browser computes for an icon's `<svg>` in a button: the
    // button's `cursor: pointer` inherited, and `pointer-events: none` set
    // so that the button, and not the icon, is what a press lands on.
    const { registrations, restyleWith, subscription } = setup("pointer", "pointer-events: none");
    assert.deepEqual(registrations, []);

    restyleWith("cursor: pointer");
    assert.deepEqual(registrations, ["add"]);

    subscription.unsubscribe();
  });

  test("the handlers go with the registration, and leave no hover state behind", () => {
    const { element, dispatch, restyle, subscription } = setup("pointer");

    dispatch("pointerenter");
    assert.equal(element.dataset.xrHover, "true");

    // Turning clickability off while the ray is on the element: the handler
    // that would have cleared the flag is gone, so the teardown clears it.
    restyle("default");
    assert.equal(element.dataset.xrHover, undefined);

    // And with the listeners detached, a stray event changes nothing.
    dispatch("pointerenter");
    assert.equal(element.dataset.xrHover, undefined);

    subscription.unsubscribe();
  });
});

describe("div visibility", () => {
  /**
   * The element's own quad, as opposed to the content group beside it.
   *
   * @param {THREE.Object3D} object
   * @returns {THREE.Mesh}
   */
  function quadOf(object) {
    const [mesh] = object.children.filter((child) => child instanceof THREE.Mesh);
    assert.ok(mesh instanceof THREE.Mesh);
    return mesh;
  }

  test("a hidden element draws no quad and is no ray target", () => {
    const { object, registrations, subscription } = setup("pointer", "visibility: hidden");
    assert.equal(quadOf(object).visible, false);
    assert.deepEqual(registrations, []);
    subscription.unsubscribe();
  });

  test("hiding keeps the object and its content group, which children answer for", () => {
    const { object, subscription } = setup("default", "visibility: hidden");
    // `visibility` is overridable by a descendant, so nothing that would prune
    // the subtree — the object's own flag, the content group's — is touched.
    assert.equal(object.visible, true);
    for (const child of object.children) {
      if (!(child instanceof THREE.Mesh)) {
        assert.equal(child.visible, true);
      }
    }
    subscription.unsubscribe();
  });

  test("visibility follows the stylesheet both ways", () => {
    const { object, registrations, restyleWith, subscription } = setup("pointer");
    assert.equal(quadOf(object).visible, true);
    assert.deepEqual(registrations, ["add"]);

    restyleWith("cursor: pointer; visibility: hidden");
    assert.equal(quadOf(object).visible, false);
    assert.deepEqual(registrations, ["add", "remove"]);

    restyleWith("cursor: pointer; visibility: collapse");
    assert.equal(quadOf(object).visible, false);
    assert.deepEqual(registrations, ["add", "remove"]);

    restyleWith("cursor: pointer; visibility: visible");
    assert.equal(quadOf(object).visible, true);
    assert.deepEqual(registrations, ["add", "remove", "add"]);

    subscription.unsubscribe();
  });

  test("a hidden overlay covers nothing", () => {
    const { registered, restyleWith, subscription } = setup(
      "default",
      "position: absolute; z-index: 1",
    );
    const [blocker] = registered;
    assert.ok(blocker);
    assert.equal(blocker.visible, true);

    restyleWith("position: absolute; z-index: 1; visibility: hidden");
    // Out of the raycast by its flag, which the manager's walk consults —
    // and which an ancestor raycast as a subtree would consult too.
    assert.equal(blocker.visible, false);

    subscription.unsubscribe();
  });
});

describe("div rendering", () => {
  test("the whole box is one quad: background and border ring share a mesh", () => {
    const { object, subscription } = setup(
      "default",
      "background-color: rgb(255, 0, 0); border: 2px solid rgb(0, 0, 255)",
    );

    const meshes = object.children.filter((child) => child instanceof THREE.Mesh);
    assert.equal(meshes.length, 1);
    const [mesh] = meshes;
    assert.ok(mesh.material instanceof THREE.ShaderMaterial);

    const { uFillColor, uBorderColor, uBorder } = mesh.material.uniforms;
    const fill = uFillColor.value;
    assert.deepEqual([fill.x, fill.y, fill.z, fill.w], [1, 0, 0, 1]);
    const border = uBorderColor.value;
    assert.deepEqual([border.x, border.y, border.z, border.w], [0, 0, 1, 1]);
    const widths = uBorder.value;
    assert.deepEqual([widths.x, widths.y, widths.z, widths.w], [2, 2, 2, 2]);

    subscription.unsubscribe();
  });

  test("a restyle is a uniform write on the same material", () => {
    const { object, restyleWith, subscription } = setup(
      "default",
      "background-color: rgb(255, 0, 0)",
    );
    const [mesh] = object.children.filter((child) => child instanceof THREE.Mesh);
    assert.ok(mesh.material instanceof THREE.ShaderMaterial);
    const material = mesh.material;
    const fill = material.uniforms.uFillColor.value;

    restyleWith("background-color: rgb(0, 0, 255)");
    assert.equal(mesh.material, material);
    assert.equal(material.uniforms.uFillColor.value, fill);
    assert.deepEqual([fill.x, fill.y, fill.z, fill.w], [0, 0, 1, 1]);

    subscription.unsubscribe();
  });
});

/**
 * That the object carries no CSS transform: its matrix moves every point by
 * the content step alone, leaving x and y where they were. Read off the
 * committed matrix rather than off `matrixAutoUpdate`, which is false for
 * every box a portal draws — transformed or not, they all write their own.
 *
 * Layout offsets are all zero under jsdom, so the step in z is the whole of
 * what an untransformed box does.
 *
 * @param {THREE.Object3D} object
 * @param {string} message
 */
function assertPlainTranslation(object, message) {
  const point = new THREE.Vector3(1, 1, 0).applyMatrix4(object.matrix);
  assert.deepEqual([point.x, point.y, point.z], [1, 1, -2], message);
}

describe("div transforms", () => {
  test("a CSS transform lands on the object's matrix, about its origin", () => {
    const { object, subscription } = setup(
      "default",
      "transform: matrix(2, 0, 0, 2, 10, 20); transform-origin: 0px 0px",
    );

    // Writing the matrix directly: three.js must not recompose it from the
    // untouched position/quaternion/scale on the next frame.
    assert.equal(object.matrixAutoUpdate, false);

    // Layout offsets are all zero under jsdom, so the matrix is the CSS one
    // plus the content step in z.
    const point = new THREE.Vector3(1, 1, 0).applyMatrix4(object.matrix);
    assert.equal(point.x, 2 * 1 + 10);
    assert.equal(point.y, 2 * 1 + 20);
    assert.equal(point.z, -2);

    subscription.unsubscribe();
  });

  test("a transform put on by hover still reaches the matrix, unmeasured", () => {
    // The boundary of the presentational contract, and the reason it is
    // worth having rather than simply banning everything: `transform` is
    // the cheap tier the flat web recommends for hover, and it goes on
    // working with no re-measurement at all. A transformed element carries
    // the matrix on its object and takes its size and position from layout
    // offsets, and *whether* it is transformed is derived from the computed
    // style — so the whole thing arrives through the restyle path.
    const { object, hoverWith, subscription } = setup("pointer");
    // Every box commits its own matrix, transformed or not, so the flag no
    // longer distinguishes the two. What does is the matrix: an untransformed
    // box translates by the content step and nothing else.
    assertPlainTranslation(object, "untransformed to begin with");

    hoverWith("cursor: pointer; transform: matrix(1, 0, 0, 1, 4, 6)");

    const point = new THREE.Vector3(0, 0, 0).applyMatrix4(object.matrix);
    assert.equal(point.x, 4, "the hover transform took effect");
    assert.equal(point.y, 6);

    // And leaving hands it back, the same way.
    hoverWith("cursor: pointer");
    assertPlainTranslation(object, "the transform is gone from the matrix again");

    subscription.unsubscribe();
  });

  test("removing the transform hands the object back to ordinary positioning", () => {
    const { object, restyleWith, subscription } = setup(
      "default",
      "transform: matrix(1, 0, 0, 1, 10, 20)",
    );
    assert.equal(object.matrixAutoUpdate, false);

    restyleWith("");
    assertPlainTranslation(object, "back to ordinary positioning");
    assert.equal(object.position.z, -2);

    subscription.unsubscribe();
  });
});

describe("div elevation", () => {
  test("an ordinary box sits one content step in front of its parent", () => {
    const { object, subscription } = setup("default");
    assert.equal(object.position.z, -2);
    subscription.unsubscribe();
  });

  test("an overlay pushes itself clear of the surface it covers", () => {
    const { object, subscription } = setup("default", "position: absolute; z-index: 1");
    assert.equal(object.position.z, -10);
    subscription.unsubscribe();
  });

  test("an overlay is opaque to rays, and stops being so when it stops floating", () => {
    const { registered, restyleWith, subscription } = setup(
      "default",
      "position: absolute; z-index: 1",
    );

    // Not clickable, so the only thing registered is the blocker the layer
    // brought with it: without it a ray through the gap between two menu rows
    // carries on into the panel underneath.
    assert.equal(registered.length, 1);
    const [blocker] = registered;
    assert.ok(blocker instanceof THREE.Mesh);
    assert.ok(blocker.geometry instanceof THREE.PlaneGeometry);
    // A portal flips its container half a turn about x to put the CSS y axis
    // the right way round, which leaves every plane in it facing away from the
    // viewer. A one-sided mesh is not raycast from behind, so a blocker that
    // is not two-sided blocks nothing whatsoever.
    assert.equal(blocker.material.side, THREE.DoubleSide);

    restyleWith("");
    assert.deepEqual(registered, []);

    restyleWith("position: absolute; z-index: 1");
    assert.equal(registered.length, 1);

    subscription.unsubscribe();
    assert.deepEqual(registered, []);
  });

  test("a box that floats over nothing carries no blocker", () => {
    const { registered, subscription } = setup("default", "position: absolute; top: 0");
    assert.deepEqual(registered, []);
    subscription.unsubscribe();
  });

  test("clicking an overlay's own background is reported to the element", () => {
    const { element, object, registered, subscription } = setup(
      "default",
      "position: absolute; z-index: 1",
    );
    // The overlay as the panel's top, laid out by the page at 100,40, so
    // that the click can say where on the page it landed.
    element.getBoundingClientRect = () => clientRect(100, 40, 200, 100);
    const { unregister } = registerPanel(object, element, (node) =>
      node === element ? object : undefined,
    );
    object.updateMatrixWorld(true);
    const point = object.localToWorld(new THREE.Vector3(12, 7, 0));

    /** @type {string[]} */
    const clicked = [];
    /** @param {Event} event */
    const listener = (event) => {
      const { target, clientX, clientY } = /** @type {MouseEvent} */ (event);
      clicked.push(`${/** @type {Element} */ (target).localName} at ${clientX},${clientY}`);
    };
    document.addEventListener("click", listener);

    const [blocker] = registered;
    blocker.dispatchEvent(
      /** @type {any} */ ({ type: "select", intersection: { point, object: blocker } }),
    );

    // The menu's own padding is not a miss to be passed through to whatever is
    // behind it; it is a click on the menu, and "did the click land inside the
    // menu" is exactly the question a dismiss-on-outside-click handler asks.
    // With the point the ray met, as a click on a button carries it.
    assert.deepEqual(clicked, ["div at 112,47"]);

    document.removeEventListener("click", listener);
    unregister();
    subscription.unsubscribe();
  });
});

/**
 * Siblings under one positioned parent, each drawn by `div` under one
 * mirror, the way a portal draws a panel. The parent is 400 px square at the
 * page origin, so a child's rect in page px is also its rect in the parent.
 */
function setupSiblings() {
  const parent = document.createElement("div");
  parent.style.position = "relative";
  document.body.appendChild(parent);
  layout(parent, () => [0, 0, 400, 400]);

  const mirror = createMirror();
  mirror.adopt(parent);
  const manager = /** @type {InteractionManager} */ (
    /** @type {unknown} */ ({ add: () => {}, remove: () => {}, stopPropagation: () => {} })
  );
  const ctx = InteractionContext.set({}, manager);

  /** @type {Map<Element, THREE.Object3D>} */
  const objects = new Map();
  /** @type {{ unsubscribe(): void }[]} */
  const subscriptions = [];

  return {
    parent,
    mirror,
    /**
     * An element laid out and mirrored, but not drawn: what `add` does
     * before `draw`. Nothing reads it until something drawn does.
     *
     * @param {string} cssText
     * @param {[number, number, number, number]} rect
     * @param {HTMLElement} [into]
     */
    place(cssText, rect, into = parent) {
      const element = document.createElement("div");
      element.style.cssText = cssText;
      into.appendChild(element);
      layout(element, () => rect);
      mirror.adopt(element);
      // As the portal's observer would, or every sibling read after the
      // first goes on seeing the child list from before it.
      mirror.childListChanged(into);
      return element;
    },
    /** @param {HTMLElement} element */
    draw(element) {
      subscriptions.push(
        div(ctx, element).subscribe((value) => {
          objects.set(element, value);
        }),
      );
      return element;
    },
    /**
     * @param {string} cssText
     * @param {[number, number, number, number]} rect
     * @param {HTMLElement} [into]
     */
    add(cssText, rect, into = parent) {
      return this.draw(this.place(cssText, rect, into));
    },
    /**
     * How far the element's origin sits from its parent's content along
     * local z, read off the committed matrix. Negative is toward the viewer.
     *
     * @param {Element} element
     */
    z(element) {
      const object = objects.get(element);
      assert.ok(object);
      return new THREE.Vector3().setFromMatrixPosition(object.matrix).z;
    },
    /**
     * Where the element's own quad is in the draw order, read off the mesh
     * `div` built for it. Its text draws at `getContentRenderOrder`.
     *
     * @param {Element} element
     */
    boxOrder(element) {
      const box = objects
        .get(element)
        ?.children.find((child) => /** @type {THREE.Mesh} */ (child).geometry === rectGeometry);
      assert.ok(box, "expected a box mesh");
      return box.renderOrder;
    },
    teardown() {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
      parent.remove();
    },
  };
}

describe("div sibling stacking", () => {
  test("a rotated hand over a positioned dial is drawn in front of the dial", () => {
    const clock = setupSiblings();
    const dial = clock.add("position: absolute; border-radius: 50%", [0, 0, 100, 100]);
    // Half a radian past twelve, turning about its foot.
    const [cos, sin] = [Math.cos(0.5), Math.sin(0.5)];
    const hand = clock.add(
      "position: absolute; transform-origin: 50% 100%; " +
        `transform: matrix(${cos}, ${sin}, ${-sin}, ${cos}, 0, 0)`,
      [0, 0, 0, 0],
    );
    // A transformed box is measured off the layout, which jsdom leaves at
    // zero: a 4 by 40 hand standing on the dial's centre.
    for (const [name, value] of /** @type {const} */ ([
      ["offsetLeft", 48],
      ["offsetTop", 10],
      ["offsetWidth", 4],
      ["offsetHeight", 40],
    ])) {
      Object.defineProperty(hand, name, { configurable: true, value });
    }
    clock.mirror.reflowed([hand]);

    // The hand's quad is 1 px behind its origin, and has to be in front of
    // the dial's own content, which sits at the dial's origin.
    assert.ok(
      clock.z(hand) + 1 < clock.z(dial),
      `hand at ${clock.z(hand)} is not in front of the dial at ${clock.z(dial)}`,
    );
    clock.teardown();
  });

  test("a later card covers the pin an earlier card floats over itself", () => {
    const board = setupSiblings();
    // `z-index: 0` makes the card a stacking context, as the desk's tilted
    // cards are, so a page paints the pin with the card, under the next one.
    const first = board.add("position: absolute; z-index: 0", [0, 0, 100, 100]);
    const pin = board.add("position: absolute; z-index: 1", [45, -5, 55, 5], first);
    const second = board.add("position: absolute", [50, 50, 150, 150]);

    // The pin's origin, where its text is drawn, against the second card's
    // quad, both in the board's frame.
    const pinZ = board.z(first) + board.z(pin);
    assert.ok(
      board.z(second) + 1 < pinZ,
      `the second card's quad at ${board.z(second) + 1} is behind the pin at ${pinZ}`,
    );
    board.teardown();
  });

  test("a pin escapes a card that is no stacking context and stays over the next", () => {
    const board = setupSiblings();
    // No `z-index` and no transform: the pin's `z-index: 1` is compared with
    // the second card's, and a page paints it over the second card.
    const first = board.add("position: absolute", [0, 0, 100, 100]);
    const pin = board.add("position: absolute; z-index: 1", [45, -5, 55, 5], first);
    const second = board.add("position: absolute", [50, 50, 150, 150]);

    const pinZ = board.z(first) + board.z(pin);
    assert.ok(
      pinZ + 1 < board.z(second),
      `the pin's quad at ${pinZ + 1} is behind the second card at ${board.z(second)}`,
    );
    board.teardown();
  });

  test("a box held still while its siblings scroll past keeps every lift", () => {
    const panel = setupSiblings();
    let scrollTop = 0;
    const scroller = panel.add("overflow: auto", [0, 0, 400, 200]);
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop });
    // Anchored to the panel, not to the scroller, so the scroll does not
    // move it while the row slides under it.
    panel.add("position: absolute", [0, 0, 100, 50], scroller);
    const row = panel.add("position: relative", [0, 0, 0, 0], scroller);
    row.getBoundingClientRect = () => clientRect(0, 100 - scrollTop, 400, 40);
    panel.mirror.reflowed([row]);
    const before = panel.z(row);

    scrollTop = 80;
    panel.mirror.scrolled(scroller);

    assert.equal(panel.z(row), before, "the row's lift followed the scroll");
    panel.teardown();
  });

  test("cards anchored to a scroller above their wrapper stay level", () => {
    const panel = setupSiblings();
    // The scroller is the cards' anchor, so its scroll moves them and the
    // wrapper's other children together, never one against another.
    const scroller = panel.add("position: relative; overflow: auto", [0, 0, 400, 400]);
    const wrapper = panel.add("", [0, 0, 400, 100], scroller);
    const first = panel.add("position: absolute", [0, 0, 100, 100], wrapper);
    const second = panel.add("position: absolute", [300, 0, 400, 100], wrapper);

    assert.deepEqual([panel.z(first), panel.z(second)], [-2, -2]);
    panel.teardown();
  });

  test("a translucent card stepped over a label is drawn after it", () => {
    // The card's quad writes depth in front of the label. Drawn first, it
    // would keep the label out where it covers it; drawn after, it blends
    // over the label as a page tints it.
    const board = setupSiblings();
    const first = board.add("position: absolute", [0, 0, 100, 100]);
    const label = board.add("", [10, 10, 90, 30], first);
    const second = board.add(
      "position: absolute; background: rgba(255, 255, 255, 0.3)",
      [50, 0, 150, 100],
    );

    const labelZ = board.z(first) + board.z(label);
    assert.ok(board.z(second) + 1 < labelZ, "the translucent card is stepped over the label");
    assert.ok(
      board.boxOrder(second) > board.boxOrder(label),
      "the label's box is drawn after the card that covers it",
    );
    assert.ok(
      board.boxOrder(second) > getContentRenderOrder(label),
      "the label's text is drawn after the card that covers it",
    );
    board.teardown();
  });

  test("a card faded by its opacity is drawn after the label it covers", () => {
    const board = setupSiblings();
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100]);
    const label = board.add("", [10, 10, 90, 30], first);
    const second = board.add(
      "position: absolute; background: white; opacity: 0.8",
      [50, 0, 150, 100],
    );

    assert.ok(board.boxOrder(second) > getContentRenderOrder(label));
    board.teardown();
  });

  test("a card in a faded parent is drawn after the label it covers", () => {
    const board = setupSiblings();
    // The opacity is the wrapper's, not the card's: the card's quad is
    // drawn with the product, so it blends all the same.
    const wrapper = board.add("position: relative; opacity: 0.5", [0, 0, 400, 400]);
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100], wrapper);
    const label = board.add("", [10, 10, 90, 30], first);
    const second = board.add("position: absolute; background: white", [50, 0, 150, 100], wrapper);

    assert.ok(board.boxOrder(second) > getContentRenderOrder(label));
    board.teardown();
  });

  test("a translucent card brings its own content with it", () => {
    const board = setupSiblings();
    const first = board.add("position: absolute", [0, 0, 100, 100]);
    const label = board.add("", [10, 10, 90, 30], first);
    const second = board.add(
      "position: absolute; background: rgba(255, 255, 255, 0.3)",
      [50, 0, 150, 100],
    );
    const inner = board.add("background: white", [60, 10, 140, 30], second);

    assert.ok(
      board.boxOrder(inner) > board.boxOrder(second),
      "the card's child is drawn after the card",
    );
    assert.ok(
      getContentRenderOrder(second) > getContentRenderOrder(label),
      "the card's text is drawn after the label's",
    );
    board.teardown();
  });

  test("an opaque card stepped over a label keeps the order of its siblings", () => {
    // An opaque card hides the label wherever it is drawn, so it needs no
    // later order, and a pile of them shares one bucket.
    const board = setupSiblings();
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100]);
    board.add("", [10, 10, 90, 30], first);
    const second = board.add("position: absolute; background: white", [50, 0, 150, 100]);
    // A border is drawn in the same quad; an opaque one changes nothing.
    const third = board.add(
      "position: absolute; background: white; border: 1px solid black",
      [60, 0, 160, 100],
    );

    assert.equal(board.boxOrder(second), board.boxOrder(first));
    assert.equal(board.boxOrder(third), board.boxOrder(first));
    board.teardown();
  });

  test("an empty positioned wrapper keeps the order of its siblings", () => {
    // A fragment with nothing to paint is discarded, writing no depth, so a
    // wrapper with no background or border hides nothing it is stepped over.
    const board = setupSiblings();
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100]);
    board.add("", [10, 10, 90, 30], first);
    const wrapper = board.add("position: absolute; background: transparent", [50, 0, 150, 100]);

    assert.equal(board.boxOrder(wrapper), board.boxOrder(first));
    board.teardown();
  });

  test("a translucent border is drawn after the label it covers", () => {
    const board = setupSiblings();
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100]);
    const label = board.add("", [10, 10, 90, 30], first);
    const second = board.add(
      "position: absolute; background: white; border: 4px solid rgba(0, 0, 0, 0.5)",
      [50, 0, 150, 100],
    );

    assert.ok(board.boxOrder(second) > getContentRenderOrder(label));
    board.teardown();
  });

  test("a label with no background stepped over a card that climbed draws after it", () => {
    // `second` climbs past the label under it. `label` paints nothing of
    // its own, but its text is stepped in front of `second` and has to
    // draw after it, or `second` blends behind the glyphs it should tint.
    const board = setupSiblings();
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100]);
    board.add("", [10, 10, 90, 30], first);
    const second = board.add(
      "position: absolute; background: rgba(255, 255, 255, 0.5)",
      [50, 0, 150, 100],
    );
    const label = board.add("position: absolute", [100, 10, 140, 30]);

    assert.ok(board.z(label) < board.z(second), "the label is stepped over the card");
    assert.ok(
      getContentRenderOrder(label) > board.boxOrder(second),
      `the label's text at ${getContentRenderOrder(label)} draws before the card at ` +
        `${board.boxOrder(second)}`,
    );
    board.teardown();
  });

  test("a translucent child of an empty card over a card that climbed draws after it", () => {
    const board = setupSiblings();
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100]);
    board.add("", [10, 10, 90, 30], first);
    const second = board.add(
      "position: absolute; background: rgba(255, 255, 255, 0.5)",
      [50, 0, 150, 100],
    );
    const tip = board.add("position: absolute", [100, 40, 140, 60]);
    const tipCard = board.add("background: rgba(0, 0, 255, 0.5)", [100, 40, 140, 60], tip);

    assert.ok(
      board.boxOrder(tipCard) > board.boxOrder(second),
      `the half-blue card at ${board.boxOrder(tipCard)} draws before the card behind it ` +
        `at ${board.boxOrder(second)}`,
    );
    board.teardown();
  });

  test("an empty card over one whose content climbed draws after that content", () => {
    // Nothing on `holder` itself climbs, but the translucent card inside it
    // does, so what is stepped in front of `holder` has to wait for it.
    const board = setupSiblings();
    const holder = board.add("position: absolute", [0, 0, 150, 100]);
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100], holder);
    board.add("", [10, 10, 90, 30], first);
    const climbed = board.add(
      "position: absolute; background: rgba(255, 255, 255, 0.5)",
      [50, 0, 150, 100],
      holder,
    );
    const tip = board.add("position: absolute", [100, 40, 140, 60]);
    const tipCard = board.add("background: rgba(0, 0, 255, 0.5)", [100, 40, 140, 60], tip);

    assert.ok(board.boxOrder(tipCard) > board.boxOrder(climbed));
    board.teardown();
  });

  test("an opaque card over a card that climbed keeps the order of its siblings", () => {
    // Its own quad hides the climbed card wherever it covers it, so it can
    // draw first, and a pile of opaque cards on a translucent one adds no
    // bucket.
    const board = setupSiblings();
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100]);
    board.add("", [10, 10, 90, 30], first);
    board.add("position: absolute; background: rgba(255, 255, 255, 0.5)", [50, 0, 150, 100]);
    const third = board.add("position: absolute; background: white", [60, 0, 160, 100]);

    assert.equal(board.boxOrder(third), board.boxOrder(first));
    board.teardown();
  });

  test("a pile of translucent cards stays under an overlay drawn before it", () => {
    // Every translucent card draws after the one under it, so a pile climbs
    // the order by a few levels a card. An overlay is a band of its own, and
    // the pile has to stay below it however high it climbs.
    const board = setupSiblings();
    const menu = board.place("position: absolute; z-index: 1", [300, 300, 400, 400]);
    /** @type {HTMLElement[]} */
    const cards = [];
    // Placed first and drawn once the pile is complete, as a portal commits
    // a panel: drawn as they arrive, every card drawn so far would re-scan
    // the board on each one.
    for (let i = 0; i < 400; i += 1) {
      const card = board.place("position: absolute; background: rgba(255, 255, 255, 0.5)", [
        i % 10,
        i % 10,
        100 + (i % 10),
        100 + (i % 10),
      ]);
      board.place("", [10, 10, 90, 30], card);
      cards.push(card);
    }
    board.draw(menu);
    const bottom = board.draw(cards[0]);
    const top = board.draw(cards[cards.length - 1]);

    assert.ok(board.boxOrder(top) > board.boxOrder(bottom), "the pile climbs the order");
    assert.ok(
      board.boxOrder(menu) > getContentRenderOrder(top),
      `the overlay at ${board.boxOrder(menu)} is drawn under the pile at ` +
        `${getContentRenderOrder(top)}`,
    );
    board.teardown();
  });

  test("overlapping backdrops with a negative z-index stay under the flow", () => {
    const page = setupSiblings();
    page.add("position: absolute; z-index: -1", [0, 0, 200, 200]);
    const backdrop = page.add("position: absolute; z-index: -1", [100, 0, 300, 200]);
    // A paragraph in the flow, over the second backdrop. A page paints the
    // flow over every negative `z-index`.
    const paragraph = page.add("", [150, 50, 250, 100]);

    // The paragraph's text sits level with its origin; the backdrop's quad
    // is 1 px behind the backdrop's.
    assert.ok(
      page.z(paragraph) < page.z(backdrop) + 1,
      `the text at ${page.z(paragraph)} is behind the backdrop at ${page.z(backdrop) + 1}`,
    );
    page.teardown();
  });

  test("cards that do not overlap stay level, however many there are", () => {
    const board = setupSiblings();
    const cards = [
      // Edge to edge with the next one, which is touching, not overlapping.
      board.add("position: absolute", [0, 0, 100, 100]),
      board.add("position: absolute", [100, 0, 200, 100]),
      board.add("position: absolute; transform: matrix(1, 0, 0, 1, 0, 0)", [0, 0, 0, 0]),
      board.add("position: absolute", [300, 300, 400, 400]),
    ];
    // Layout offsets for the transformed one, below the first two.
    Object.defineProperty(cards[2], "offsetTop", { configurable: true, value: 150 });
    Object.defineProperty(cards[2], "offsetWidth", { configurable: true, value: 100 });
    Object.defineProperty(cards[2], "offsetHeight", { configurable: true, value: 100 });
    board.add("position: absolute; z-index: 1", [45, -5, 55, 5], cards[0]);
    board.mirror.reflowed([cards[2]]);

    assert.deepEqual(
      cards.map((card) => board.z(card)),
      [-2, -2, -2, -2],
    );
    board.teardown();
  });

  test("re-appending a card brings it in front of the card it overlaps", () => {
    const board = setupSiblings();
    const first = board.add("position: absolute", [0, 0, 100, 100]);
    const second = board.add("position: absolute", [50, 50, 150, 150]);
    assert.ok(board.z(second) < board.z(first), "the later card starts in front");

    // The records a portal's observer would hand the mirror. jsdom-env does
    // not expose `MutationObserver` as a global.
    const observer = new window.MutationObserver(() => {});
    observer.observe(board.parent, { childList: true });
    board.parent.appendChild(first);
    board.mirror.ingest(observer.takeRecords());
    observer.disconnect();

    assert.ok(
      board.z(first) + 1 < board.z(second),
      `the re-appended card at ${board.z(first)} is not in front of ${board.z(second)}`,
    );
    board.teardown();
  });

  test("an earlier overlay stays in front of a later sibling that covers it", () => {
    const page = setupSiblings();
    const modal = page.add("position: fixed; z-index: 10", [100, 100, 300, 300]);
    const main = page.add("position: relative", [0, 0, 400, 400]);
    // A pile inside `main` that reaches farther out than the modal's own
    // lift, so leaving `main` where it is would not be enough.
    let card = page.add("position: absolute", [150, 150, 250, 250], main);
    for (let i = 1; i < 5; i += 1) {
      card = page.add("position: absolute", [150 + i, 150, 250 + i, 250], main);
    }

    // The modal's quad, 1 px behind its origin, against the farthest thing
    // `main` draws: its top card's origin, in the page's frame.
    const cardZ = page.z(main) + page.z(card);
    assert.ok(
      page.z(modal) + 1 < cardZ,
      `the modal's quad at ${page.z(modal) + 1} is behind main's card at ${cardZ}`,
    );
    page.teardown();
  });

  test("a transformed card that moves onto another without resizing is stepped", () => {
    const column = setupSiblings();
    /**
     * A card on layout offsets, which is how a transformed box is placed.
     *
     * @param {number} top
     */
    const card = (top) => {
      const element = column.add(
        "position: relative; transform: matrix(1, 0, 0, 1, 0, 0)",
        [0, 0, 0, 0],
      );
      for (const [name, value] of /** @type {const} */ ([
        ["offsetTop", top],
        ["offsetWidth", 100],
        ["offsetHeight", 100],
      ])) {
        Object.defineProperty(element, name, { configurable: true, value });
      }
      return element;
    };
    const first = card(0);
    const second = card(200);
    column.mirror.reflowed([first, second]);
    assert.equal(column.z(second), column.z(first), "the cards start apart");

    // Text above wraps onto one more line and the second card slides up
    // onto the first, the same size as before.
    Object.defineProperty(second, "offsetTop", { configurable: true, value: 50 });
    column.mirror.reflowed([second]);

    assert.ok(
      column.z(second) + 1 < column.z(first),
      `the moved card at ${column.z(second)} is not in front of ${column.z(first)}`,
    );
    column.teardown();
  });

  test("a card whose perspective sends a corner behind the eye covers everything", () => {
    const board = setupSiblings();
    // w = 1 - 0.02 x about the card's centre: the right edge, 100 px out,
    // is at w = -1, behind the eye.
    const card = board.add(
      "position: absolute; transform: matrix3d(1, 0, 0, -0.02, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)",
      [0, 0, 0, 0],
    );
    for (const [name, value] of /** @type {const} */ ([
      ["offsetWidth", 200],
      ["offsetHeight", 100],
    ])) {
      Object.defineProperty(card, name, { configurable: true, value });
    }
    board.mirror.reflowed([card]);
    // Over the right half of the card's layout box, which dividing the
    // corners behind the eye by w would mirror away from it.
    const later = board.add("position: absolute", [150, 0, 250, 100]);

    // The card's own matrix scales its origin by w, so it is the later
    // card's lift that says whether it was stepped: past the plain step.
    assert.ok(board.z(later) < -2, `the later card at ${board.z(later)} was not stepped`);
    board.teardown();
  });

  test("a later backdrop with a negative z-index stays behind what it covers", () => {
    const page = setupSiblings();
    const card = page.add("position: absolute", [100, 100, 300, 300]);
    // The card is already built, so it hears of the backdrop through the
    // records a portal's observer would hand the mirror.
    const observer = new window.MutationObserver(() => {});
    observer.observe(page.parent, { childList: true });
    const backdrop = page.add("position: absolute; z-index: -1", [0, 0, 400, 400]);
    page.mirror.ingest(observer.takeRecords());
    observer.disconnect();

    assert.ok(
      page.z(card) + 1 < page.z(backdrop),
      `the card's quad at ${page.z(card) + 1} is behind the backdrop at ${page.z(backdrop)}`,
    );
    page.teardown();
  });
});

/**
 * Give an element the client rect jsdom does not compute: left, top, right
 * and bottom in page px, read each time the rect is asked for.
 *
 * @param {Element} element
 * @param {() => [number, number, number, number]} rect
 */
function layout(element, rect) {
  element.getBoundingClientRect = () => {
    const [left, top, right, bottom] = rect();
    return clientRect(left, top, right - left, bottom - top);
  };
}

/**
 * A clickable row inside something that hides its overflow, with the layout
 * jsdom does not have: a window that stays put and a 40px row that slides
 * through it, starting 10px into a 100px scroller.
 */
function setupScrolledRow() {
  let scrollTop = 0;

  const container = document.createElement("div");
  container.setAttribute(PORTAL_ATTRIBUTE, "");
  const scroller = document.createElement("div");
  const row = document.createElement("div");

  scroller.style.overflow = "hidden";
  row.style.cursor = "pointer";
  scroller.appendChild(row);
  container.appendChild(scroller);
  document.body.appendChild(container);

  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop });

  const mirror = createMirror();
  for (const node of [container, scroller, row]) {
    mirror.adopt(node);
  }

  layout(container, () => [0, 0, 200, 100]);
  layout(scroller, () => [0, 0, 200, 100]);
  layout(row, () => [0, 10 - scrollTop, 200, 50 - scrollTop]);

  /** @type {string[]} */
  const registrations = [];
  const manager = /** @type {InteractionManager} */ (
    /** @type {unknown} */ ({
      add: () => registrations.push("add"),
      remove: () => registrations.push("remove"),
      stopPropagation: () => {},
    })
  );

  /** @type {THREE.Object3D<XREventMap>} */
  let object;
  const subscription = div(InteractionContext.set({}, manager), row).subscribe((value) => {
    object = /** @type {THREE.Object3D<XREventMap>} */ (value);
  });

  return {
    container,
    registrations,
    subscription,
    get object() {
      return object;
    },
    /** @param {number} value */
    scrollTo: (value) => {
      scrollTop = value;
      mirror.scrolled(scroller);
    },
  };
}

describe("div clipping", () => {
  test("the box is told what its ancestors leave of it, in its own px", () => {
    const { container, object, scrollTo, subscription } = setupScrolledRow();
    try {
      const material = /** @type {THREE.ShaderMaterial} */ (
        /** @type {THREE.Mesh} */ (object.children.find((child) => child instanceof THREE.Mesh))
          .material
      );
      // `overflow: hidden` hides it on both axes, so the window is the
      // scroller's whole padding box: the row starts 10px down it and may
      // draw from its own -10 to its own 90.
      assert.deepEqual(material.uniforms.uClip.value.toArray(), [0, -10, 200, 90]);

      scrollTo(30);
      assert.deepEqual(
        material.uniforms.uClip.value.toArray(),
        [0, 20, 200, 120],
        "the window has not moved, so in the row's coordinates it slides the other way",
      );

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });

  test("a row scrolled out of its window stops being drawn and stops being a target", () => {
    const { container, object, registrations, scrollTo, subscription } = setupScrolledRow();
    try {
      assert.deepEqual(registrations, ["add"]);
      assert.equal(object.visible, true);

      // Straddling the top edge: still shown, still a target. What is left of
      // it is trimmed by the raycast filter rather than by the registration.
      scrollTo(30);
      assert.deepEqual(registrations, ["add"]);
      assert.equal(object.visible, true);

      // Past the top edge entirely, taking its whole subtree out of the
      // raycast set with it.
      scrollTo(60);
      assert.deepEqual(registrations, ["add", "remove"]);
      assert.equal(object.visible, false);

      // And back.
      scrollTo(0);
      assert.deepEqual(registrations, ["add", "remove", "add"]);
      assert.equal(object.visible, true);

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });
});

describe("div drag-to-scroll", () => {
  test("a list with more in it than fits becomes something the ray can take hold of", () => {
    const { element, mirror, registrations, registered, subscription } = setup(
      "default",
      "overflow: hidden",
    );
    // Not yet: it clips, but everything in it fits, so grabbing it should
    // still press whatever is under the ray.
    assert.deepEqual(registrations, []);

    describeScroller(element, { client: 100, scroll: 400 });
    // A row arriving is a childList mutation, which is what a growing list
    // announces; nothing has to tell the projection that it now scrolls.
    mirror.childListChanged(element);
    assert.deepEqual(registrations, ["add"]);

    subscription.unsubscribe();
    assert.deepEqual(registrations, ["add", "remove"]);
    assert.equal(registered.length, 0);
  });

  test("a list that already overflows is registered from the start", () => {
    const element = document.createElement("div");
    element.style.cssText = "overflow: hidden";
    document.body.appendChild(element);
    describeScroller(element, { client: 100, scroll: 400 });

    createMirror().adopt(element);

    /** @type {THREE.Object3D[]} */
    const registered = [];
    const manager = /** @type {InteractionManager} */ (
      /** @type {unknown} */ ({
        /** @param {THREE.Object3D} object */
        add: (object) => registered.push(object),
        remove: () => {},
        stopPropagation: () => {},
      })
    );
    const base = InteractionContext.set({}, manager);
    const panel = new THREE.Object3D();
    const ctx = PointerForwarderContext.set(base, createPanelForwarder(base, panel));

    /** @type {THREE.Object3D<XREventMap> | undefined} */
    let object;
    const subscription = div(ctx, element).subscribe((value) => {
      object = /** @type {THREE.Object3D<XREventMap>} */ (value);
    });

    assert.ok(object);
    panel.add(object);
    // A plain list is not clickable and carries no hover styling, but it is
    // draggable — otherwise a list of text could not be scrolled at all.
    assert.ok(registered.includes(object), "the list itself is a ray target");
    assert.equal(element.dataset.xrHover, undefined);

    // A press that never became a drag still reports a click, which is what
    // the panel background would have reported had the list not been there,
    // with the point the ray met, as that click carries it. The list as the
    // panel's top, laid out by the page at 100,40.
    element.getBoundingClientRect = () => clientRect(100, 40, 300, 100);
    const { unregister } = registerPanel(object, element, (node) =>
      node === element ? object : undefined,
    );
    object.updateMatrixWorld(true);
    const point = object.localToWorld(new THREE.Vector3(12, 7, 0));
    /** @type {string[]} */
    const clicked = [];
    const listener = (/** @type {Event} */ event) => {
      const { target, clientX, clientY } = /** @type {MouseEvent} */ (event);
      clicked.push(`${/** @type {Element} */ (target).localName} at ${clientX},${clientY}`);
    };
    document.addEventListener("click", listener);
    const controller = new THREE.Object3D();
    const intersection = { point, object };
    bubble(object, { type: "selectstart", controller, intersection });
    bubble(object, { type: "selectend", controller, intersection });
    bubble(object, { type: "select", controller, intersection });
    assert.deepEqual(clicked, ["div at 112,47"]);

    document.removeEventListener("click", listener);
    unregister();
    subscription.unsubscribe();
  });
});

describe("div haptics", () => {
  test("a control is felt on hover, press and release, by the hand that did it", () => {
    const { source, played } = recordingSource();
    const { dispatch, subscription } = setup(
      "pointer",
      "",
      createHaptics({ hover: true, flavor: "key" }),
    );

    dispatch("pointerenter", source);
    dispatch("selectstart", source);
    dispatch("selectend", source);
    dispatch("pointerleave", source);
    assert.deepEqual(
      played.map((effect) => effect.duration),
      [30, 45, 30],
      "the key's hover, press and release, and nothing for leaving",
    );

    // A hand with no motors, or a test's event with no hand, is not an error.
    dispatch("pointerenter");
    assert.equal(played.length, 3);
    subscription.unsubscribe();
  });

  test("a hover is one pulse per arrival, whatever is clickable inside the control", () => {
    const { source, played } = recordingSource();
    const haptics = createHaptics({ hover: true });
    const button = setup("pointer", "", haptics);
    // The label inside the button inherits its cursor, and so is a target
    // of its own, under the button's object as the portal would put it.
    const label = setup("pointer", "", haptics, button.element, button);
    getContentGroup(button.object).add(label.object);
    const other = new THREE.Object3D();

    label.dispatch("pointerenter", source);
    assert.equal(
      played.length,
      1,
      "the ray arrives on the label from nothing, and the button it is in adds nothing",
    );

    button.dispatch("pointerenter", source, label.object);
    assert.equal(played.length, 1, "drifting from the label onto the button is not an arrival");
    label.dispatch("pointerenter", source, button.object);
    assert.equal(played.length, 1, "nor is drifting back");

    button.dispatch("pointerenter", source, other);
    assert.equal(played.length, 2, "coming from another control is");

    label.subscription.unsubscribe();
    button.subscription.unsubscribe();
  });

  test("a button entered from the list it is in is entered, but not while the list scrolls", () => {
    const { source, played } = recordingSource();
    const haptics = createHaptics({ hover: true });
    // A list with more in it than fits, inside a panel: a ray target to be
    // dragged by, and the ancestor of every button in it, but no control.
    const root = document.createElement("div");
    root.setAttribute(PORTAL_ATTRIBUTE, "");
    const list = document.createElement("div");
    list.style.overflow = "hidden";
    describeScroller(list, { client: 100, scroll: 400 });
    root.appendChild(list);
    document.body.appendChild(root);
    const listObject = new THREE.Object3D();
    const listContent = new THREE.Object3D();
    listObject.add(listContent);

    const button = setup("pointer", "", haptics, list);
    button.panel.add(listObject);
    listContent.add(button.object);
    const controller = /** @type {THREE.XRTargetRaySpace} */ (
      /** @type {unknown} */ (new THREE.Object3D())
    );

    button.dispatch("pointerenter", source, listObject, button.object, controller);
    assert.equal(played.length, 1, "from the gap between the rows is an arrival");

    // The ray crossing the gap may meet the button's label first, which is
    // a target of its own by the button's cursor: still the button, still
    // an arrival.
    const label = setup("pointer", "", haptics, button.element, button);
    getContentGroup(button.object).add(label.object);
    label.dispatch("pointerenter", source, listObject, label.object, controller);
    assert.equal(played.length, 2, "onto the label from the list is an arrival");
    button.dispatch("pointerenter", source, label.object, button.object, controller);
    assert.equal(played.length, 2, "and from the label onto the button is not");
    label.subscription.unsubscribe();

    // The hand takes hold of the list: rows now pass under a ray that is
    // aimed at none of them.
    const drags = scrollDrags(button.ctx);
    drags.begin(controller, button.element, button.object);
    button.dispatch("pointerenter", source, listObject, button.object, controller);
    assert.equal(played.length, 2, "silent while the list is being scrolled");
    drags.end(controller);
    button.dispatch("pointerenter", source, listObject, button.object, controller);
    assert.equal(played.length, 3, "and felt again once it is let go");

    button.subscription.unsubscribe();
    root.remove();
  });

  test("a control in a panel without haptics feels like nothing", () => {
    const { source, played } = recordingSource();
    const silent = setup("pointer");
    silent.dispatch("pointerenter", source);
    silent.dispatch("selectstart", source);
    assert.deepEqual(played, []);
    silent.subscription.unsubscribe();
  });
});

describe("div gradients", () => {
  /**
   * A box the size of a real one — jsdom lays nothing out, and a gradient in
   * a box with no area draws nothing — wearing `cssText`.
   *
   * @param {string} cssText
   */
  function sized(cssText) {
    const element = document.createElement("div");
    element.style.cssText = cssText;
    element.getBoundingClientRect = () => clientRect(0, 0, 200, 100);
    document.body.appendChild(element);
    const mirror = createMirror();
    mirror.adopt(element);
    const manager = /** @type {InteractionManager} */ (
      /** @type {unknown} */ ({ add: () => {}, remove: () => {}, stopPropagation: () => {} })
    );
    /** @type {THREE.Object3D | undefined} */
    let object;
    const subscription = div(InteractionContext.set({}, manager), element).subscribe((value) => {
      object = value;
    });
    const uniforms = () => {
      const mesh = /** @type {THREE.Mesh} */ (
        object?.children.find((child) => child instanceof THREE.Mesh)
      );
      return /** @type {THREE.ShaderMaterial} */ (mesh.material).uniforms;
    };
    return {
      subscription,
      uniforms,
      restyleWith: (/** @type {string} */ text) => {
        element.style.cssText = text;
        mirror.attributeChanged(element);
      },
    };
  }

  test("a gradient is drawn from a ramp row the box holds until it goes", () => {
    const before = rampAtlas.size;
    const box = sized("background-image: linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255))");
    assert.equal(box.uniforms().uGradient.value.x, GRADIENT_LINEAR);
    assert.equal(rampAtlas.size, before + 1);

    // The same gradient again takes nothing new...
    box.restyleWith("background-image: linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255))");
    assert.equal(rampAtlas.size, before + 1);
    // ...another swaps its row for a new one...
    box.restyleWith("background-image: linear-gradient(90deg, rgb(0, 255, 0), rgb(0, 0, 255))");
    assert.equal(rampAtlas.size, before + 1);
    // ...and none gives it back.
    box.restyleWith("background-color: rgb(255, 0, 0)");
    assert.equal(box.uniforms().uGradient.value.x, 0);
    assert.equal(rampAtlas.size, before);

    box.restyleWith("background-image: linear-gradient(rgb(1, 1, 1), rgb(2, 2, 2))");
    assert.equal(rampAtlas.size, before + 1);
    box.subscription.unsubscribe();
    assert.equal(rampAtlas.size, before, "teardown releases the row");
  });
});
