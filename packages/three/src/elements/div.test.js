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
 */
function setup(cursor) {
  const element = document.createElement("div");
  element.style.cursor = cursor;
  document.body.appendChild(element);

  /** @type {Subject<Set<import('./cache.js').MutationType>>} */
  const mutations = new Subject();
  setSubject(element, mutations);

  /** @type {string[]} */
  const registrations = [];
  const manager = /** @type {InteractionManager} */ (
    /** @type {unknown} */ ({
      add: () => registrations.push("add"),
      remove: () => registrations.push("remove"),
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
    subscription,
    /** Announce a style change the way the portal's MutationObserver would. */
    restyle: (/** @type {string} */ value) => {
      element.style.cursor = value;
      mutations.next(new Set(["attributes"]));
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
