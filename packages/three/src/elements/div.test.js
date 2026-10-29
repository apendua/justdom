import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { UpdateChannel, withChannel } from "@apendua/signal";
import { InteractionContext } from "../interactions.js";
import { createMirror } from "./mirror.js";
import { PORTAL_ATTRIBUTE } from "./portalRoot.js";
import { div } from "./div.js";
import { getClearedSiblings, getContentRenderOrder } from "./elevation.js";
import { GRADIENT_LINEAR, rampAtlas } from "./gradient.js";
import { createHaptics, HapticsContext } from "./haptics.js";
import { getContentGroup } from "./contentGroup.js";
import { ScrollDragsContext } from "./scroll.js";
import { bubble, forwardedPanel } from "../test/rays.js";
import { describeScroller } from "../test/scroller.js";
import { recordingSource } from "../test/rumble.js";
import { clientRect } from "../test/clientRect.js";
import { registerPanel } from "./dragAndDrop.js";
import { rectGeometry } from "./sdfRect.js";
import { text } from "./text.js";
import { InputFocusContext, textInput } from "./textInput.js";
import { markedBox } from "./listMarker.js";
import { installRange } from "../test/textRange.js";
import { stubCanvas } from "../test/stubCanvas.js";
import { isRunMesh } from "../test/runMesh.js";
import { BOX_BUCKET_BIAS, BoxBatchContext } from "./boxBatch.js";
import { paintBatch } from "../test/textRuns.js";
import { shape } from "../svg/shape.js";
import { drawText } from "../svg/text.js";
import { installSvgTextLayout } from "../test/svgTextLayout.js";

// three's SVGLoader parses with DOMParser, which jsdom-env does not install.
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = window.DOMParser;
}

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

  const { ctx, container: panel } = within
    ? { ctx: within.ctx, container: within.panel }
    : forwardedPanel(HapticsContext.set(InteractionContext.set({}, manager), haptics));

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
 * That the object carries no CSS transform: its matrix leaves every point
 * where it was. Read off the committed matrix rather than off
 * `matrixAutoUpdate`, which is false for every box a portal draws —
 * transformed or not, they all write their own.
 *
 * Layout offsets are all zero under jsdom, and a box sits in its parent's
 * plane, so an untransformed box moves nothing.
 *
 * @param {THREE.Object3D} object
 * @param {string} message
 */
function assertPlainTranslation(object, message) {
  const point = new THREE.Vector3(1, 1, 0).applyMatrix4(object.matrix);
  assert.deepEqual([point.x, point.y, point.z], [1, 1, 0], message);
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

    // Layout offsets are all zero under jsdom, so the matrix is the CSS one,
    // in the parent's plane.
    const point = new THREE.Vector3(1, 1, 0).applyMatrix4(object.matrix);
    assert.equal(point.x, 2 * 1 + 10);
    assert.equal(point.y, 2 * 1 + 20);
    assert.equal(point.z, 0);

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
    // box here moves nothing.
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
    assert.equal(object.position.z, 0);

    subscription.unsubscribe();
  });
});

describe("div elevation", () => {
  test("an ordinary box sits in its parent's plane", () => {
    const { object, subscription } = setup("default");
    assert.equal(object.position.z, 0);
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
    // Drawn by nothing, as it changes no pixel, and still a ray target.
    assert.equal(blocker.material.visible, false);
    assert.equal(blocker.visible, true);

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
      this.adopt(element, rect, into);
      return element;
    },
    /**
     * Put any element in `into`, laid out at `rect` and mirrored, but not
     * drawn: a field, a list item or an `<svg>` as much as a `div`.
     *
     * @param {Element} element
     * @param {[number, number, number, number]} rect
     * @param {HTMLElement} [into]
     */
    adopt(element, rect, into = parent) {
      into.appendChild(element);
      layout(element, () => rect);
      mirror.adopt(element);
      // As the portal's observer would, or every sibling read after the
      // first goes on seeing the child list from before it.
      mirror.childListChanged(into);
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
     * Draw an element with a component other than `div`, handed the
     * harness's context: a field, a list item or an SVG element, as the
     * portal draws them.
     *
     * @param {Element} element
     * @param {(ctx: object) => import("@apendua/signal").Source<THREE.Object3D>} component
     * @returns {THREE.Object3D} What the component built.
     */
    drawWith(element, component) {
      subscriptions.push(
        component(ctx).subscribe((value) => {
          objects.set(element, value);
        }),
      );
      const object = objects.get(element);
      assert.ok(object, "expected the component to build an object");
      return object;
    },
    /**
     * A text node appended to the element and drawn as the portal draws one,
     * by `text`, with no batch, so the run draws itself. Needs
     * `installRange`.
     *
     * @param {HTMLElement} element
     * @param {string} data
     * @returns {THREE.Mesh} The run's mesh.
     */
    write(element, data) {
      const node = document.createTextNode(data);
      element.appendChild(node);
      mirror.adopt(node);
      mirror.childListChanged(element);
      /** @type {THREE.Mesh | undefined} */
      let run;
      subscriptions.push(
        text(ctx, node).subscribe((object) => {
          run = /** @type {THREE.Mesh} */ (object.children[0]);
        }),
      );
      assert.ok(run, "expected a run");
      return run;
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

    // The hand's box has to draw after the dial's own content.
    assert.ok(
      clock.boxOrder(hand) > getContentRenderOrder(dial),
      `hand at ${clock.boxOrder(hand)} draws before the dial's content at ` +
        `${getContentRenderOrder(dial)}`,
    );
    clock.teardown();
  });

  test("a box held still while its siblings scroll past keeps its order", () => {
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
    const before = panel.boxOrder(row);

    scrollTop = 80;
    panel.mirror.scrolled(scroller);

    assert.equal(panel.boxOrder(row), before, "the row's order followed the scroll");
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

    assert.equal(panel.boxOrder(second), panel.boxOrder(first));
    panel.teardown();
  });

  test("a translucent card stepped over a label is drawn after it", () => {
    // Drawn after the label, the card blends over it as a page tints it.
    const board = setupSiblings();
    const first = board.add("position: absolute", [0, 0, 100, 100]);
    const label = board.add("", [10, 10, 90, 30], first);
    const second = board.add(
      "position: absolute; background: rgba(255, 255, 255, 0.3)",
      [50, 0, 150, 100],
    );

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

  test("an opaque card stepped over a label draws after it all the same", () => {
    // Nothing on a panel but its depth quad writes depth, so an opaque card
    // hides the label only by drawing after it.
    const board = setupSiblings();
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100]);
    const label = board.add("", [10, 10, 90, 30], first);
    const second = board.add("position: absolute; background: white", [50, 0, 150, 100]);
    // A border is drawn in the same quad; an opaque one changes nothing.
    const third = board.add(
      "position: absolute; background: white; border: 1px solid black",
      [60, 0, 160, 100],
    );

    assert.ok(board.boxOrder(second) > getContentRenderOrder(label));
    assert.ok(board.boxOrder(third) > getContentRenderOrder(second));
    board.teardown();
  });

  test("an empty positioned wrapper draws after what it is stepped over", () => {
    // A wrapper with no background or border hides nothing it is stepped
    // over, and what that holds would draw over the wrapper's text if it
    // drew later.
    const board = setupSiblings();
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100]);
    const label = board.add("", [10, 10, 90, 30], first);
    const wrapper = board.add("position: absolute; background: transparent", [50, 0, 150, 100]);

    assert.ok(board.boxOrder(wrapper) > getContentRenderOrder(label));
    board.teardown();
  });

  test("a translucent card in an empty wrapper is drawn after the label it covers", () => {
    // The wrapper is what clears the sibling, and has nothing to paint. It
    // still waits for the sibling, so the card inside it blends over the
    // label.
    const board = setupSiblings();
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100]);
    const label = board.add("", [10, 10, 90, 30], first);
    const wrapper = board.add("position: absolute", [50, 0, 150, 100]);
    const card = board.add("background: rgba(255, 255, 255, 0.3)", [50, 0, 150, 100], wrapper);

    assert.ok(board.boxOrder(card) > getContentRenderOrder(label));
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

  test("an opaque card over a card that climbed draws after it", () => {
    const board = setupSiblings();
    const first = board.add("position: absolute; background: white", [0, 0, 100, 100]);
    board.add("", [10, 10, 90, 30], first);
    const second = board.add(
      "position: absolute; background: rgba(255, 255, 255, 0.5)",
      [50, 0, 150, 100],
    );
    const third = board.add("position: absolute; background: white", [60, 0, 160, 100]);

    assert.ok(board.boxOrder(third) > getContentRenderOrder(second));
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

    assert.ok(
      getContentRenderOrder(paragraph) > page.boxOrder(backdrop),
      `the text at ${getContentRenderOrder(paragraph)} draws before the backdrop at ` +
        `${page.boxOrder(backdrop)}`,
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
      cards.map((card) => board.boxOrder(card)),
      cards.map(() => board.boxOrder(cards[0])),
    );
    board.teardown();
  });

  test("re-appending a card brings it in front of the card it overlaps", () => {
    const board = setupSiblings();
    const first = board.add("position: absolute", [0, 0, 100, 100]);
    const second = board.add("position: absolute", [50, 50, 150, 150]);
    assert.ok(
      board.boxOrder(second) > getContentRenderOrder(first),
      "the later card starts in front",
    );

    // The records a portal's observer would hand the mirror. jsdom-env does
    // not expose `MutationObserver` as a global.
    const observer = new window.MutationObserver(() => {});
    observer.observe(board.parent, { childList: true });
    board.parent.appendChild(first);
    board.mirror.ingest(observer.takeRecords());
    observer.disconnect();

    assert.ok(
      board.boxOrder(first) > getContentRenderOrder(second),
      `the re-appended card at ${board.boxOrder(first)} draws before ` +
        `${getContentRenderOrder(second)}`,
    );
    board.teardown();
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
    assert.equal(column.boxOrder(second), column.boxOrder(first), "the cards start apart");

    // Text above wraps onto one more line and the second card slides up
    // onto the first, the same size as before.
    Object.defineProperty(second, "offsetTop", { configurable: true, value: 50 });
    column.mirror.reflowed([second]);

    assert.ok(
      column.boxOrder(second) > getContentRenderOrder(first),
      `the moved card at ${column.boxOrder(second)} draws before ${getContentRenderOrder(first)}`,
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

    // The card is a layer of its own, which the panel's walk places, so it
    // is what the later card clears that says it covers everything.
    assert.deepEqual(getClearedSiblings(later), [card]);
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
      page.boxOrder(card) > getContentRenderOrder(backdrop),
      `the card at ${page.boxOrder(card)} draws before the backdrop's content at ` +
        `${getContentRenderOrder(backdrop)}`,
    );
    page.teardown();
  });
});

// Night Ops' gauges: a caption is a positioned box with no background laid
// over the dial, and the dial's face is a box inside the dial. The caption
// is stepped in front of the face, so the face has to draw before its marks
// or it paints over them.

/**
 * A dial with a face inside it, as Night Ops' gauges have, a tick on the
 * face, and a positioned caption with no background laid over both. The
 * tick is a level deeper than the face, so a mark nested a level inside the
 * caption meets a box at its own tree depth too.
 *
 * @param {ReturnType<typeof setupSiblings>} gauge
 * @param {string} [captionCss]
 * @param {HTMLElement} [into]
 */
function dialWithCaption(gauge, captionCss = "", into = gauge.parent) {
  const dial = gauge.add("position: absolute; background: white", [0, 0, 100, 100], into);
  const face = gauge.add("background: black", [20, 20, 80, 80], dial);
  const tick = gauge.add("background: red", [25, 55, 75, 85], face);
  const caption = gauge.add(`position: absolute; ${captionCss}`, [30, 60, 70, 80], into);
  return { dial, face, tick, caption };
}

/**
 * Assert that a mark laid over `dialWithCaption`'s dial draws after every
 * box of the dial.
 *
 * @param {ReturnType<typeof setupSiblings>} gauge
 * @param {THREE.Object3D} mark
 * @param {ReturnType<typeof dialWithCaption>} dial
 */
function assertDrawsAfterDial(gauge, mark, { dial, face, tick }) {
  for (const box of [dial, face, tick]) {
    assertDrawsAfter(gauge, mark, box);
  }
}

/**
 * Assert that a mark draws after a box: after the box's own mesh, and after
 * the half level later a portal's box batch draws it at.
 *
 * @param {ReturnType<typeof setupSiblings>} gauge
 * @param {THREE.Object3D} mark
 * @param {Element} box
 */
function assertDrawsAfter(gauge, mark, box) {
  assert.ok(
    gauge.boxOrder(box) + 0.5 < mark.renderOrder,
    `the box at ${gauge.boxOrder(box)} draws after the mark at ${mark.renderOrder}`,
  );
}

describe("marks stepped over a box", () => {
  test("a caption laid over a dial draws after the dial's face", () => {
    const restore = installRange();
    const gauge = setupSiblings();
    try {
      const parts = dialWithCaption(gauge);
      const { dial, caption } = parts;
      const run = gauge.write(caption, "LOAD");

      assert.deepEqual(getClearedSiblings(caption), [dial], "the caption is stepped over the dial");
      assertDrawsAfterDial(gauge, run, parts);
    } finally {
      gauge.teardown();
      restore();
    }
  });

  test("a rotated caption laid over a dial draws after the dial's face", () => {
    const restore = installRange();
    const gauge = setupSiblings();
    try {
      const dial = gauge.add("position: absolute; background: white", [0, 0, 100, 100]);
      const face = gauge.add("background: black", [20, 20, 80, 80], dial);
      // A transform alone puts the caption in a painting layer; it is placed
      // by its layout offsets, as a transformed box is.
      const [cos, sin] = [Math.cos(0.3), Math.sin(0.3)];
      const caption = gauge.add(
        `transform: matrix(${cos}, ${sin}, ${-sin}, ${cos}, 0, 0)`,
        [0, 0, 0, 0],
      );
      for (const [name, value] of /** @type {const} */ ([
        ["offsetLeft", 30],
        ["offsetTop", 60],
        ["offsetWidth", 40],
        ["offsetHeight", 20],
      ])) {
        Object.defineProperty(caption, name, { configurable: true, value });
      }
      gauge.mirror.reflowed([caption]);
      const run = gauge.write(caption, "LOAD");

      assert.deepEqual(getClearedSiblings(caption), [dial], "the caption is stepped over the dial");
      assertDrawsAfter(gauge, run, face);
    } finally {
      gauge.teardown();
      restore();
    }
  });

  test("a caption moved off the dial goes back to its tree order", () => {
    const restore = installRange();
    const gauge = setupSiblings();
    try {
      const dial = gauge.add("position: absolute; background: white", [0, 0, 100, 100]);
      const face = gauge.add("background: black", [20, 20, 80, 80], dial);
      /** @type {[number, number, number, number]} */
      const rect = [30, 60, 70, 80];
      const caption = gauge.add("position: absolute", rect);
      const run = gauge.write(caption, "LOAD");
      assertDrawsAfter(gauge, run, face);

      // Read through `layout`, which reads the same array every time.
      rect.splice(0, 4, 200, 60, 240, 80);
      gauge.mirror.reflowed([caption]);

      assert.equal(gauge.boxOrder(caption), gauge.boxOrder(dial), "the caption's box");
      assert.equal(run.renderOrder, getContentRenderOrder(dial), "the caption's text");
    } finally {
      gauge.teardown();
      restore();
    }
  });

  test("a caption in a clipping window draws after the dial's face", () => {
    const restore = installRange();
    const gauge = setupSiblings();
    try {
      const clip = gauge.add("position: relative; overflow: hidden", [0, 50, 400, 150]);
      const parts = dialWithCaption(gauge, "", clip);
      const run = gauge.write(parts.caption, "LOAD");

      assertDrawsAfterDial(gauge, run, parts);
    } finally {
      gauge.teardown();
      restore();
    }
  });

  test("a faint caption, its colour at 30% alpha, draws after the dial's face", () => {
    // The alpha is the text's, not the caption box's, so the box has nothing
    // to paint and is no more translucent than a clear caption.
    const restore = installRange();
    const gauge = setupSiblings();
    try {
      const parts = dialWithCaption(gauge, "color: rgba(255, 255, 255, 0.3)");
      const run = gauge.write(parts.caption, "LOAD");
      const material = /** @type {THREE.MeshBasicMaterial} */ (run.material);
      assert.ok(material.opacity < 0.5, `the caption is drawn at ${material.opacity}`);

      assertDrawsAfterDial(gauge, run, parts);
    } finally {
      gauge.teardown();
      restore();
    }
  });

  test("a caption fading in draws after the dial's face all through the fade", () => {
    // The fade is on a child of the caption, so the caption's own box stays
    // empty and only the text it holds is faint.
    const restore = installRange();
    const gauge = setupSiblings();
    try {
      const parts = dialWithCaption(gauge);
      const value = gauge.add("opacity: 0.3", [30, 60, 70, 80], parts.caption);
      const run = gauge.write(value, "LOAD");
      const opacity = () => /** @type {THREE.MeshBasicMaterial} */ (run.material).opacity;
      assert.ok(opacity() < 0.5, `the caption is drawn at ${opacity()}`);
      assertDrawsAfterDial(gauge, run, parts);

      for (const step of ["0.45", "0.6", "1"]) {
        value.style.opacity = step;
        gauge.mirror.attributeChanged(value);
        assert.equal(opacity(), Number(step), "the run follows the fade");
        assertDrawsAfterDial(gauge, run, parts);
      }
    } finally {
      gauge.teardown();
      restore();
    }
  });

  test("a field's value laid over a dial draws after the dial's face", () => {
    const canvas = stubCanvas();
    const gauge = setupSiblings();
    try {
      const { parts, object } = fieldOverDial(gauge);

      const value = findMesh(object, isRunMesh);
      assert.ok(value, "the value is drawn");
      assertDrawsAfterDial(gauge, value, parts);
    } finally {
      gauge.teardown();
      canvas.restore();
    }
  });

  test("a field's caret laid over a dial draws after the dial's face", () => {
    const canvas = stubCanvas();
    const gauge = setupSiblings();
    try {
      // The field being typed into, which is the one that draws a caret.
      const { parts, object } = fieldOverDial(gauge, { isFocused: () => true, press: () => {} });

      // The caret is a quad of its own in the field's content, not the
      // field's box.
      const box = object.children.find(
        (child) => /** @type {THREE.Mesh} */ (child).geometry === rectGeometry,
      );
      const caret = findMesh(object, (mesh) => mesh !== box && mesh.geometry === rectGeometry);
      assert.ok(caret, "the caret is drawn");
      assertDrawsAfterDial(gauge, caret, parts);
    } finally {
      gauge.teardown();
      canvas.restore();
    }
  });

  test("a list marker laid over a dial draws after the dial's face", () => {
    const canvas = stubCanvas();
    const gauge = setupSiblings();
    try {
      const parts = dialWithCaption(gauge);
      const item = document.createElement("li");
      item.style.cssText = "display: list-item; list-style-type: disc";
      gauge.adopt(item, [50, 60, 70, 80], parts.caption);
      const object = gauge.drawWith(item, (ctx) => markedBox(ctx, item));

      const marker = findMesh(object, isRunMesh);
      assert.ok(marker, "the marker is drawn");
      assert.ok(canvas.drawn.includes("•"), "the marker is a bullet");
      assertDrawsAfterDial(gauge, marker, parts);
    } finally {
      gauge.teardown();
      canvas.restore();
    }
  });

  test("an <svg> laid over a dial paints all of itself after the dial's face", () => {
    // An `<svg>` paints its shapes in a slot that starts at its content
    // order and ends short of the boxes drawn at that level, half a level up
    // (`paintSlot`), so no shape in it draws before that order.
    const gauge = setupSiblings();
    try {
      const parts = dialWithCaption(gauge);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      gauge.adopt(svg, [30, 60, 70, 80], parts.caption);

      const slot = new THREE.Object3D();
      slot.renderOrder = getContentRenderOrder(
        /** @type {HTMLElement} */ (/** @type {unknown} */ (svg)),
      );
      assertDrawsAfterDial(gauge, slot, parts);
    } finally {
      gauge.teardown();
    }
  });
});

describe("an <svg> and a translucent stepped card", () => {
  /**
   * Two positioned cards on a board, the second translucent and stepped over
   * the first, each drawn by the panel's one batch, and an `<svg>` holding a
   * shape and then a text, in `holder`'s choice of card.
   *
   * @param {"first" | "second"} holder
   */
  function cardsWithSvg(holder) {
    const svgText = installSvgTextLayout();
    const board = setupSiblings();
    const container = new THREE.Group();
    const draws = paintBatch(container);
    const batch = draws.boxes;
    const teardown = () => {
      board.teardown();
      draws.dispose();
      batch.dispose();
      svgText.restore();
    };
    // Torn down here if an assertion below fails, since the caller is not
    // handed `teardown` then, and the stubs would outlive the test.
    try {
      /** @param {HTMLElement} card */
      const drawCard = (card) =>
        container.add(board.drawWith(card, (ctx) => div(BoxBatchContext.set(ctx, batch), card)));
      const first = board.place("position: absolute; background: white", [0, 0, 100, 100]);
      const second = board.place(
        "position: absolute; background: rgba(255, 255, 255, 0.3)",
        [50, 0, 150, 100],
      );
      drawCard(first);
      drawCard(second);

      const ns = "http://www.w3.org/2000/svg";
      const icon = document.createElementNS(ns, "svg");
      icon.setAttribute("viewBox", "0 0 40 20");
      const card = holder === "first" ? first : second;
      board.adopt(icon, holder === "first" ? [55, 10, 95, 30] : [60, 10, 100, 30], card);
      const dot = document.createElementNS(ns, "rect");
      dot.setAttribute("width", "10");
      dot.setAttribute("height", "10");
      dot.setAttribute("fill", "red");
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", "12");
      label.setAttribute("y", "10");
      label.setAttribute("fill", "red");
      label.append("on");
      icon.append(dot, label);
      for (const node of [dot, label, ...label.childNodes]) {
        board.mirror.adopt(node);
      }
      board.mirror.childListChanged(icon);

      /** @type {THREE.Mesh[]} */
      const meshes = [];
      for (const object of [
        board.drawWith(dot, (ctx) => shape(ctx, dot)),
        board.drawWith(label, (ctx) => drawText(ctx, label)),
      ]) {
        object.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            meshes.push(child);
          }
        });
      }
      assert.equal(meshes.length, 2, "the dot's fill and the label's run");

      draws.flush();
      return {
        meshes,
        /**
         * Where the one batch lays the opaque card's box and the translucent
         * card's, half a level past each box's own order.
         */
        boxes: [first, second].map((each) => board.boxOrder(each) + BOX_BUCKET_BIAS),
        teardown,
      };
    } catch (error) {
      teardown();
      throw error;
    }
  }

  test("an <svg> in the translucent card draws over the card, after what it covers", () => {
    // The card blends over the first card, so it draws after it, and the
    // `<svg>` on it is in front of both: drawn before the card's box, it
    // would be tinted by the card it sits on.
    const drawn = cardsWithSvg("second");
    try {
      const [under, card] = drawn.boxes;
      assert.ok(card > under, "the translucent card draws after the card it covers");
      for (const mesh of drawn.meshes) {
        assert.ok(
          mesh.renderOrder > card,
          `drawn at ${mesh.renderOrder}, before the card it is on at ${card}`,
        );
      }
    } finally {
      drawn.teardown();
    }
  });

  test("an <svg> under the translucent card draws before it, so the card tints it", () => {
    // The translucent card is painted over the `<svg>`, which a page shows
    // tinted by it.
    const drawn = cardsWithSvg("first");
    try {
      const [under, card] = drawn.boxes;
      for (const mesh of drawn.meshes) {
        assert.ok(mesh.renderOrder > under, `drawn at ${mesh.renderOrder}, under its own card`);
        assert.ok(
          mesh.renderOrder < card,
          `drawn at ${mesh.renderOrder}, after the card over it at ${card}`,
        );
      }
    } finally {
      drawn.teardown();
    }
  });
});

/**
 * A text field holding "42", with nothing of its own to paint, in the
 * caption `dialWithCaption` lays over a dial, drawn as the portal draws one.
 *
 * @param {ReturnType<typeof setupSiblings>} gauge
 * @param {import("./textInput.js").InputFocus} [focus] For a field being
 *   typed into, which draws a caret.
 */
function fieldOverDial(gauge, focus) {
  const parts = dialWithCaption(gauge);
  const input = document.createElement("input");
  input.type = "text";
  input.value = "42";
  input.style.cssText = "background: transparent; border: 0";
  gauge.adopt(input, [30, 60, 70, 80], parts.caption);
  const object = gauge.drawWith(input, (ctx) =>
    textInput(focus ? InputFocusContext.set(ctx, focus) : ctx, input),
  );
  return { parts, object };
}

/**
 * The first mesh under an object that a predicate accepts.
 *
 * @param {THREE.Object3D} object
 * @param {(mesh: THREE.Mesh) => boolean} accept
 * @returns {THREE.Mesh | undefined}
 */
function findMesh(object, accept) {
  /** @type {THREE.Mesh | undefined} */
  let found;
  object.traverse((child) => {
    if (!found && child instanceof THREE.Mesh && accept(child)) {
      found = child;
    }
  });
  return found;
}

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
 * through it, starting 10px into a 100px scroller. `moveTo` moves the row by
 * layout, as a change of its `top` would.
 *
 * @param {object} [options]
 * @param {string} [options.transform] A CSS transform on the row, which puts
 *   it on a transformed chain: placed by a matrix rather than a position.
 */
function setupScrolledRow({ transform } = {}) {
  let scrollTop = 0;
  let rowTop = 10;

  const container = document.createElement("div");
  container.setAttribute(PORTAL_ATTRIBUTE, "");
  const scroller = document.createElement("div");
  const row = document.createElement("div");

  scroller.style.overflow = "hidden";
  row.style.cursor = "pointer";
  if (transform) {
    row.style.transform = transform;
  }
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
  layout(row, () => [0, rowTop - scrollTop, 200, rowTop + 40 - scrollTop]);

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
    /** @param {number} value */
    moveTo: (value) => {
      rowTop = value;
      mirror.reflowed([row]);
    },
  };
}

/**
 * The clip the box's quad is drawn with, as `[left, top, right, bottom]` in
 * the box's own px.
 *
 * @param {THREE.Object3D} object
 */
function quadClipOf(object) {
  const quad = /** @type {THREE.Mesh} */ (
    object.children.find((child) => child instanceof THREE.Mesh)
  );
  const material = /** @type {THREE.ShaderMaterial} */ (quad.material);
  return material.uniforms.uClip.value.toArray();
}

describe("div clipping", () => {
  test("a move reaches the place and the clip together, under a budget of one effect", () => {
    // A panel that is not atomic runs its effects under a budget, and a
    // clock that moves a whole budget per effect stops every pass after one
    // of them. No pass is let off the budget for having been cut short.
    let time = 0;
    const channel = new UpdateChannel({
      manual: true,
      now: () => time++,
      maxStalePasses: Infinity,
    });
    const row = withChannel(channel, () => setupScrolledRow());
    try {
      channel.flush({ budget: Infinity });
      // The window's top edge is the scroller's, so in the row's own px it
      // is wherever the row is not: the row's place and the clip's top sum
      // to nothing.
      assert.equal(row.object.position.y + quadClipOf(row.object)[1], 0);

      row.moveTo(30);
      let passes = 0;
      while (channel.hasPendingUpdates) {
        channel.flush({ budget: 1 });
        passes += 1;
        assert.equal(
          row.object.position.y + quadClipOf(row.object)[1],
          0,
          `after pass ${passes}, the clip is where the window is`,
        );
      }
      assert.ok(passes > 1, "the budget split the move across passes");
      assert.equal(row.object.position.y, 30);
      row.subscription.unsubscribe();
    } finally {
      row.container.remove();
    }
  });

  // A box placed by a matrix only: a plain box's offset comes through
  // `getContentPosition`, already gated on equality, so a reflow that leaves
  // it in place never reaches `placement`. On a transformed chain the offset
  // is read fresh from the reflow context, and `placementEqual` decides.
  // Outside a portal the place effect runs the motion step itself, so this
  // is also the step's own check, that a matrix it composes the same as the
  // one drawn is not written.
  test("a re-read layout that leaves a transformed box in place writes no matrix", () => {
    const { container, object, moveTo, subscription } = setupScrolledRow({
      transform: "matrix(1, 0, 0, 1, 5, 0)",
    });
    try {
      object.matrixWorldNeedsUpdate = false;
      // Reflowed where it already was: the placement is read again and
      // comes out the same.
      moveTo(10);
      assert.equal(
        object.matrixWorldNeedsUpdate,
        false,
        "three is not asked to recompute the world matrices under the box",
      );
      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });

  for (const [name, transform] of [
    ["placed by its position", undefined],
    ["placed by a matrix", "matrix(1, 0, 0, 1, 5, 0)"],
  ]) {
    test(`a scroll moves the clip and leaves the box's matrix alone, ${name}`, () => {
      const { container, object, scrollTo, subscription } = setupScrolledRow({ transform });
      try {
        // jsdom lays nothing out, so the only x a box gets is its transform's.
        assert.equal(object.matrix.elements[12], transform ? 5 : 0, `the box is ${name}`);
        const matrix = object.matrix.clone();
        const clip = quadClipOf(object);
        object.matrixWorldNeedsUpdate = false;
        scrollTo(30);
        assert.notDeepEqual(quadClipOf(object), clip, "the scroll reached the clip");
        assert.ok(object.matrix.equals(matrix), "the matrix is where it was");
        assert.equal(
          object.matrixWorldNeedsUpdate,
          false,
          "three is not asked to recompute the world matrices under the box",
        );
        subscription.unsubscribe();
      } finally {
        container.remove();
      }
    });
  }

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
    const { ctx, container: panel } = forwardedPanel(InteractionContext.set({}, manager));

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
    // panel's top, laid out by the page at 100,40, and registered under the
    // container, as the portal registers its panel.
    element.getBoundingClientRect = () => clientRect(100, 40, 300, 100);
    const { unregister } = registerPanel(panel, element, (node) =>
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
    const drags = ScrollDragsContext.get(button.ctx);
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
