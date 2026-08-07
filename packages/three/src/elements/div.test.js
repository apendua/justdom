import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Subject } from "rxjs";
import { InteractionContext } from "../interactions.js";
import { setSubject } from "./cache.js";
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
 * An element wired the way the portal wires one: a subject standing in for the
 * MutationObserver, so a style change can be announced the way a real one is.
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

  /** @type {Subject<import('./cache.js').MutationBatch>} */
  const mutations = new Subject();
  setSubject(element, mutations);

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
    registrations,
    registered,
    subscription,
    get object() {
      return object;
    },
    /** Announce a style change the way the portal's MutationObserver would. */
    restyle: (/** @type {string} */ value) => {
      element.style.cursor = value;
      mutations.next({ types: new Set(["attributes"]), targets: new Set([element]) });
    },
    /** The same, for anything that is not the cursor. */
    restyleWith: (/** @type {string} */ cssText) => {
      element.style.cssText = cssText;
      mutations.next({ types: new Set(["attributes"]), targets: new Set([element]) });
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
