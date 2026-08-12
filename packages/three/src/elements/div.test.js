import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext } from "../interactions.js";
import { createMirror, PORTAL_ATTRIBUTE } from "./mirror.js";
import { div } from "./div.js";

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
 */
function setup(cursor, cssText = "") {
  const element = document.createElement("div");
  element.style.cssText = cssText;
  element.style.cursor = cursor;
  document.body.appendChild(element);

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

  const ctx = InteractionContext.set({}, manager);

  /** @type {THREE.Object3D<XREventMap>} */
  let object;
  const subscription = div(ctx, element).subscribe((value) => {
    object = /** @type {THREE.Object3D<XREventMap>} */ (value);
  });

  return {
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
      mirror.attributeChanged(element, { movesGeometry: false });
    },
    /** @param {"pointerenter" | "pointerleave"} type */
    dispatch: (type) => {
      object.dispatchEvent(/** @type {any} */ ({ type, target: object, originalTarget: object }));
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
    assert.equal(object.matrixAutoUpdate, true, "untransformed to begin with");

    hoverWith("cursor: pointer; transform: matrix(1, 0, 0, 1, 4, 6)");

    assert.equal(object.matrixAutoUpdate, false, "the hover transform took effect");
    const point = new THREE.Vector3(0, 0, 0).applyMatrix4(object.matrix);
    assert.equal(point.x, 4);
    assert.equal(point.y, 6);

    // And leaving hands it back, the same way.
    hoverWith("cursor: pointer");
    assert.equal(object.matrixAutoUpdate, true);

    subscription.unsubscribe();
  });

  test("removing the transform hands the object back to ordinary positioning", () => {
    const { object, restyleWith, subscription } = setup(
      "default",
      "transform: matrix(1, 0, 0, 1, 10, 20)",
    );
    assert.equal(object.matrixAutoUpdate, false);

    restyleWith("");
    assert.equal(object.matrixAutoUpdate, true);
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
    const { element, registered, subscription } = setup(
      "default",
      "position: absolute; z-index: 1",
    );

    /** @type {EventTarget[]} */
    const clicked = [];
    /** @param {Event} event */
    const listener = (event) => {
      if (event.target) {
        clicked.push(event.target);
      }
    };
    document.addEventListener("click", listener);

    registered[0].dispatchEvent(/** @type {any} */ ({ type: "select" }));

    // The menu's own padding is not a miss to be passed through to whatever is
    // behind it; it is a click on the menu, and "did the click land inside the
    // menu" is exactly the question a dismiss-on-outside-click handler asks.
    assert.deepEqual(clicked, [element]);

    document.removeEventListener("click", listener);
    subscription.unsubscribe();
  });
});

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

  /**
   * @param {Element} element
   * @param {() => [number, number, number, number]} rect
   */
  const layout = (element, rect) => {
    element.getBoundingClientRect = () => {
      const [left, top, right, bottom] = rect();
      return /** @type {DOMRect} */ ({
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
      });
    };
  };
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

/**
 * Describe an element as a list with more inside it than fits, the way a real
 * one would report itself — jsdom lays nothing out, so every one of these is
 * zero otherwise.
 *
 * @param {HTMLElement} element
 * @param {{ client: number, scroll: number }} size
 */
function describeScroller(element, { client, scroll }) {
  for (const [name, value] of [
    ["clientHeight", client],
    ["scrollHeight", scroll],
    ["clientWidth", client],
    ["scrollWidth", client],
  ]) {
    Object.defineProperty(element, name, { configurable: true, get: () => value });
  }
}

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
    const ctx = InteractionContext.set({}, manager);

    /** @type {THREE.Object3D<XREventMap> | undefined} */
    let object;
    const subscription = div(ctx, element).subscribe((value) => {
      object = /** @type {THREE.Object3D<XREventMap>} */ (value);
    });

    assert.ok(object);
    // A plain list is not clickable and carries no hover styling, but it is
    // draggable — otherwise a list of text could not be scrolled at all.
    assert.ok(registered.includes(object), "the list itself is a ray target");
    assert.equal(element.dataset.xrHover, undefined);

    // A press that never became a drag still reports a click, which is what
    // the panel background would have reported had the list not been there.
    /** @type {EventTarget[]} */
    const clicked = [];
    const listener = (/** @type {Event} */ event) => {
      if (event.target) {
        clicked.push(event.target);
      }
    };
    document.addEventListener("click", listener);
    const controller = new THREE.Object3D();
    object.dispatchEvent(/** @type {any} */ ({ type: "selectstart", controller }));
    object.dispatchEvent(/** @type {any} */ ({ type: "selectend", controller }));
    object.dispatchEvent(/** @type {any} */ ({ type: "select", controller }));
    assert.deepEqual(clicked, [element]);

    document.removeEventListener("click", listener);
    subscription.unsubscribe();
  });
});
