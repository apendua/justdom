import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Subject } from "rxjs";
import { InteractionContext } from "../interactions.js";
import { setSubject } from "./cache.js";
import { checkbox } from "./checkbox.js";

/**
 * @import { Mesh, MeshBasicMaterial, Object3D } from "three";
 * @import { InteractionManager } from "../interactions.js";
 * @import { XREventMap } from "../core.js";
 * @import { MutationBatch } from "./cache.js";
 */

// Same reason as in div.test.js: jsdom implements no Font Loading API, and
// `VisualProperties` refuses to measure anything until the fonts are in.
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
 * A checkbox wired the way the portal wires one: a subject standing in for the
 * MutationObserver, and a recording manager in place of the real one.
 *
 * @param {object} [options]
 * @param {boolean} [options.checked] What the box starts out as.
 * @param {boolean} [options.disabled]
 */
function setup({ checked = false, disabled = false } = {}) {
  const element = document.createElement("input");
  element.type = "checkbox";
  element.checked = checked;
  element.disabled = disabled;
  element.style.cssText = "width: 20px; height: 20px";
  document.body.appendChild(element);

  /** @type {Subject<MutationBatch>} */
  const mutations = new Subject();
  setSubject(element, mutations);

  /** @type {Object3D[]} */
  const registered = [];
  const manager = /** @type {InteractionManager} */ (
    /** @type {unknown} */ ({
      /** @param {Object3D} object */
      add: (object) => {
        registered.push(object);
      },
      /** @param {Object3D} object */
      remove: (object) => {
        const index = registered.indexOf(object);
        if (index >= 0) {
          registered.splice(index, 1);
        }
      },
      stopPropagation: () => {},
    })
  );

  const ctx = InteractionContext.set({}, manager);

  /** @type {Object3D<XREventMap>} */
  let object;
  const subscription = checkbox(ctx, element).subscribe((value) => {
    object = /** @type {Object3D<XREventMap>} */ (value);
  });

  return {
    element,
    registered,
    subscription,
    get object() {
      return object;
    },
    /**
     * What the control draws over its own box. The box itself is one quad and
     * a distance-field shader; anything drawn inside it carries an ordinary
     * material, which is what tells the two apart.
     *
     * @returns {Mesh[]}
     */
    get marks() {
      return /** @type {Mesh[]} */ (
        object.children.filter(
          (child) =>
            child instanceof THREE.Mesh && !(child.material instanceof THREE.ShaderMaterial),
        )
      );
    },
    /** Announce an attribute change the way the portal's observer would. */
    restyle: (/** @type {string} */ cssText) => {
      element.style.cssText = cssText;
      mutations.next({ types: new Set(["attributes"]), targets: new Set([element]) });
    },
  };
}

describe("checkbox", () => {
  test("an unticked box is drawn as a box and nothing else", () => {
    const { marks, subscription } = setup();
    assert.deepEqual(marks, []);
    subscription.unsubscribe();
  });

  test("a ticked box has a mark in it", () => {
    const { marks, subscription } = setup({ checked: true });
    assert.equal(marks.length, 1);

    // A strip of quads along the polyline, indexed by hand: two vertices per
    // point of the tick, two triangles per segment between them. Asserted
    // rather than merely non-empty because the alternative — handing the
    // outline to `ShapeGeometry` — is a general polygon triangulator, and
    // importing one pulls three's whole shape subtree into every bundle that
    // has a portal in it.
    const { geometry } = marks[0];
    assert.equal(geometry.getAttribute("position").count, 6, "two vertices per point of the tick");
    assert.equal(geometry.getIndex()?.count, 12, "two triangles per segment");

    subscription.unsubscribe();
  });

  test("the mark follows the state, whichever way the state moved", () => {
    const target = setup();
    assert.deepEqual(target.marks, []);

    // The way the player does it: the ray's click is a click, and a click on a
    // checkbox toggles it. Nothing about that is an attribute mutation, so the
    // `change` it fires is the only news of it.
    target.element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    assert.equal(target.element.checked, true);
    assert.equal(target.marks.length, 1);

    // The way the application does it: a property assignment, which mutates
    // nothing at all and fires nothing either.
    target.element.checked = false;
    assert.deepEqual(target.marks, []);

    target.element.checked = true;
    assert.equal(target.marks.length, 1);

    target.subscription.unsubscribe();
  });

  test("the state is written back as an attribute, so styles can follow it", () => {
    const target = setup();
    assert.equal(target.element.dataset.xrChecked, undefined);

    target.element.checked = true;
    // `:checked` changes no attribute, so without this nothing would tell the
    // portal to re-read a style that follows it — and the attribute is what
    // the panel's own stylesheet can hang a rule on in the first place.
    assert.equal(target.element.dataset.xrChecked, "true");

    target.element.checked = false;
    assert.equal(target.element.dataset.xrChecked, undefined);

    target.element.checked = true;
    target.subscription.unsubscribe();
    assert.equal(target.element.dataset.xrChecked, undefined, "and it leaves nothing behind");
  });

  test("a checkbox is a ray target without being asked, and a disabled one is not", () => {
    // No `cursor: pointer` anywhere: a control is there to be operated, which
    // is the one thing an ordinary box cannot be assumed to be.
    const plain = setup();
    assert.equal(plain.registered.length, 1);
    plain.subscription.unsubscribe();
    assert.equal(plain.registered.length, 0);

    const off = setup({ disabled: true });
    assert.deepEqual(off.registered, []);
    off.subscription.unsubscribe();
  });

  test("the mark is drawn inside the border, in the colour the element is written in", () => {
    const { marks, restyle, subscription } = setup({ checked: true });

    restyle("width: 20px; height: 20px; border: 4px solid rgb(0, 0, 0); color: rgb(255, 0, 0)");

    const [mark] = marks;
    assert.ok(mark, "the mark is offset by the border it sits inside");
    assert.equal(mark.position.x, 4);
    assert.equal(mark.position.y, 4);
    // In front of the background, which `div` draws at +1.
    assert.equal(mark.position.z, 0);

    const material = /** @type {MeshBasicMaterial} */ (mark.material);
    assert.equal(material.color.getHexString(), "ff0000");

    subscription.unsubscribe();
  });

  test("the mark is drawn after the box it sits on", () => {
    const { object, marks, subscription } = setup({ checked: true });

    const [surface] = /** @type {Mesh[]} */ (
      object.children.filter(
        (child) => child instanceof THREE.Mesh && child.material instanceof THREE.ShaderMaterial,
      )
    );
    // Transparency is sorted, not depth-tested: a mark drawn before its own
    // surface blends with whatever is behind the panel instead.
    assert.ok(marks[0].renderOrder > surface.renderOrder);

    subscription.unsubscribe();
  });

  test("clicking one reports it the way the DOM would", () => {
    const { element, registered, subscription } = setup();

    /** @type {string[]} */
    const seen = [];
    element.addEventListener("change", () => seen.push(`change:${element.checked}`));

    registered[0].dispatchEvent(/** @type {any} */ ({ type: "select", target: registered[0] }));
    registered[0].dispatchEvent(/** @type {any} */ ({ type: "select", target: registered[0] }));

    // Which is the whole point of mirroring a real input rather than drawing
    // one: the application listens for `change` and reads `checked`, exactly
    // as it does on the page.
    assert.deepEqual(seen, ["change:true", "change:false"]);

    subscription.unsubscribe();
  });
});
