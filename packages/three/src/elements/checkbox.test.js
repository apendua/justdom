import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { InteractionContext } from "../interactions.js";
import { createMirror, PORTAL_ATTRIBUTE } from "./mirror.js";
import { checkbox } from "./checkbox.js";

/**
 * @import { Mesh, MeshBasicMaterial, Object3D } from "three";
 * @import { InteractionManager } from "../interactions.js";
 * @import { XREventMap } from "../core.js";
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
 * A checkbox wired the way the portal wires one: a mirror standing in for the
 * portal's own, and a recording manager in place of the real one.
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
  // jsdom lays nothing out, so the CSS above reaches the computed style but
  // never the rect — and a box measured at zero, less its borders, comes out
  // negative and takes the tick's geometry with it. Say what a browser would
  // have said.
  element.getBoundingClientRect = () =>
    /** @type {DOMRect} */ ({ left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20 });
  document.body.appendChild(element);

  const mirror = createMirror();
  mirror.adopt(element);

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
      mirror.attributeChanged(element);
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
    assert.ok(mark);

    // The tick is authored in the element's own coordinates — the frame its
    // clip box is given in — so the border offset is in the vertices rather
    // than in the mesh's position.
    assert.equal(mark.position.x, 0);
    assert.equal(mark.position.y, 0);
    // In front of the background, which `div` draws at +1.
    assert.equal(mark.position.z, 0);

    mark.geometry.computeBoundingBox();
    const bounds = mark.geometry.boundingBox;
    assert.ok(bounds);
    // Inside the content box: past the 4px border on each side, and short of
    // the far edge 12px later.
    assert.ok(bounds.min.x >= 4, `left edge ${bounds.min.x} clears the border`);
    assert.ok(bounds.min.y >= 4, `top edge ${bounds.min.y} clears the border`);
    assert.ok(bounds.max.x <= 16, `right edge ${bounds.max.x} stays inside`);
    assert.ok(bounds.max.y <= 16, `bottom edge ${bounds.max.y} stays inside`);

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

/**
 * A ticked checkbox 20px square, sitting 10px into a 100px `overflow: hidden`
 * scroller — the same arrangement `div.test.js` uses for a row, because a
 * checkbox in a scrolling list is exactly where the tick meets the clip.
 */
function setupScrolledCheckbox() {
  let scrollTop = 0;

  const container = document.createElement("div");
  container.setAttribute(PORTAL_ATTRIBUTE, "");
  const scroller = document.createElement("div");
  const element = document.createElement("input");

  scroller.style.overflow = "hidden";
  element.type = "checkbox";
  element.checked = true;
  scroller.appendChild(element);
  container.appendChild(scroller);
  document.body.appendChild(container);

  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop });

  const mirror = createMirror();
  for (const node of [container, scroller, element]) {
    mirror.adopt(node);
  }

  /**
   * @param {Element} target
   * @param {() => [number, number, number, number]} rect
   */
  const layout = (target, rect) => {
    target.getBoundingClientRect = () => {
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
  layout(element, () => [0, 10 - scrollTop, 20, 30 - scrollTop]);

  const manager = /** @type {InteractionManager} */ (
    /** @type {unknown} */ ({ add: () => {}, remove: () => {}, stopPropagation: () => {} })
  );

  /** @type {Object3D<XREventMap>} */
  let object;
  const subscription = checkbox(InteractionContext.set({}, manager), element).subscribe((value) => {
    object = /** @type {Object3D<XREventMap>} */ (value);
  });

  return {
    container,
    subscription,
    get mark() {
      return /** @type {Mesh} */ (
        object.children.find(
          (child) =>
            child instanceof THREE.Mesh && !(child.material instanceof THREE.ShaderMaterial),
        )
      );
    },
    /** @param {number} value */
    scrollTo: (value) => {
      scrollTop = value;
      mirror.scrolled(scroller);
    },
  };
}

describe("checkbox clipping", () => {
  test("the tick is told what the scroller leaves of it, in the element's own px", () => {
    const { container, mark, scrollTo, subscription } = setupScrolledCheckbox();
    try {
      // `applyClip` hands the uniform to the compiled program rather than
      // keeping it on the material, so the patch is the only way to reach it
      // without a GL context — which is also proof the patch is installed.
      const material = /** @type {MeshBasicMaterial} */ (mark.material);
      assert.equal(material.customProgramCacheKey?.(), "justdom-three-clip", "the tick is clipped");
      /** @type {{uniforms: Record<string, {value: THREE.Vector4}>, vertexShader: string, fragmentShader: string}} */
      const shader = {
        uniforms: {},
        vertexShader: "void main() {\n#include <begin_vertex>\n}",
        fragmentShader: "void main() {\n#include <alphatest_fragment>\n}",
      };
      material.onBeforeCompile(/** @type {any} */ (shader), /** @type {any} */ (null));
      const clip = shader.uniforms.clipBox;
      assert.ok(clip, "the clip box reaches the shader");

      // The window is the scroller's whole padding box; the checkbox starts
      // 10px down it, so it may draw from its own -10 to its own 90.
      assert.deepEqual(clip.value.toArray(), [0, -10, 200, 90]);

      scrollTo(30);
      assert.deepEqual(
        clip.value.toArray(),
        [0, 20, 200, 120],
        "the window has not moved, so in the checkbox's coordinates it slides the other way",
      );

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });

  test("the tick's hit region is trimmed too, not just its drawing", () => {
    const { container, mark, subscription } = setupScrolledCheckbox();
    try {
      // A raycast consults neither a discarded fragment nor `visible`, so a
      // tick that was only clipped in the shader would still answer rays
      // aimed at the part of it that has scrolled out of the list — the thing
      // that makes a scrolling list feel broken rather than unfinished.
      // `clipRaycast` wraps the mesh's own `raycast`; inheriting the
      // prototype's means it never did.
      assert.ok(
        Object.prototype.hasOwnProperty.call(mark, "raycast"),
        "the mark carries a raycast filter of its own",
      );

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });
});
