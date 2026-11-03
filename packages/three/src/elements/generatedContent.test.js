import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { clientRect } from "../test/clientRect.js";
import { stubCanvas } from "../test/stubCanvas.js";
import { isRunMesh } from "../test/runMesh.js";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal as createHeldPortal } from "./portal.js";
import { resetMeasuringRangeForTests } from "./mirror.js";
import { batchedBoxMaterial, rectGeometry } from "./sdfRect.js";
import { parseGeneratedContent } from "./generatedContent.js";
import { getGeneratedSelectors } from "./documentStyles.js";
import { generatedHost, splitSelectorList } from "./styleRules.js";
import { HOVER_ATTRIBUTE } from "./portalRoot.js";

/**
 * `createPortal` with the loading frame's timing off, so a mount loads the
 * moment it is built.
 *
 * @type {typeof createHeldPortal}
 */
const createPortal = (ctx, options = {}) =>
  createHeldPortal(ctx, {
    loadingFrame: { delay: 0, minimumTime: 0 },
    ...options,
  });

if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = window.MutationObserver;
}

// Rasterizing resolves colours through a bare `getComputedStyle`, which a
// browser has and the jsdom setup does not install. Through `window`, so
// that it answers as the stub below does.
if (typeof globalThis.getComputedStyle === "undefined") {
  globalThis.getComputedStyle = (element, pseudo) => window.getComputedStyle(element, pseudo);
}

if (!document.fonts) {
  Object.defineProperty(document, "fonts", {
    value: {
      status: "loaded",
      ready: Promise.resolve(),
      addEventListener() {},
      removeEventListener() {},
    },
  });
}

/** @type {Array<FrameRequestCallback>} */
const frameCallbacks = [];
globalThis.requestAnimationFrame = (callback) => frameCallbacks.push(callback);
globalThis.cancelAnimationFrame = () => {};

function flushFrame() {
  for (const callback of frameCallbacks.splice(0, frameCallbacks.length)) {
    callback(0);
  }
}

function nextMacrotask() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * @param {{ isLoading: () => boolean }} portal
 */
async function settle(portal) {
  await nextMacrotask();
  for (let index = 0; index < 500 && portal.isLoading(); index++) {
    flushFrame();
    await nextMacrotask();
  }
  await pump();
}

async function pump() {
  await nextMacrotask();
  for (let index = 0; index < 20 && frameCallbacks.length > 0; index++) {
    flushFrame();
    await nextMacrotask();
  }
}

describe("parseGeneratedContent", () => {
  test("none and normal generate no box, and an empty string an empty one", () => {
    assert.equal(parseGeneratedContent("none"), null);
    assert.equal(parseGeneratedContent("normal"), null);
    assert.deepEqual(parseGeneratedContent('""'), { text: "", url: null });
  });

  test("strings are joined, with their escapes undone", () => {
    assert.deepEqual(parseGeneratedContent('"a" "b\\"c"'), { text: 'ab"c', url: null });
    assert.deepEqual(parseGeneratedContent('"\\2192 next"'), { text: "→next", url: null });
    assert.deepEqual(parseGeneratedContent('"\\2192  next"'), { text: "→ next", url: null });
  });

  test("a url() alone is a picture, quoted or not", () => {
    assert.deepEqual(parseGeneratedContent('url("a.svg")'), { text: "", url: "a.svg" });
    assert.deepEqual(parseGeneratedContent("url(b.png)"), { text: "", url: "b.png" });
  });

  test("text beside a picture is drawn, and the picture is not", () => {
    assert.deepEqual(parseGeneratedContent('url("a.svg") " more"'), { text: " more", url: null });
  });

  test("a counter or a quote leaves the text empty, and the box drawn", () => {
    assert.deepEqual(parseGeneratedContent('counter(step) "."'), { text: "", url: null });
    assert.deepEqual(parseGeneratedContent("open-quote"), { text: "", url: null });
  });

  test("the alternative text after a slash is not drawn", () => {
    assert.deepEqual(parseGeneratedContent('"★" / "starred"'), { text: "★", url: null });
  });
});

describe("selectors for generated content", () => {
  test("a list splits at its top-level commas only", () => {
    assert.deepEqual(splitSelectorList('a, :is(b, c), [title="d, e"], f\\,g'), [
      "a",
      " :is(b, c)",
      ' [title="d, e"]',
      " f\\,g",
    ]);
  });

  test("a selector ending in ::before or ::after gives the element it styles", () => {
    assert.deepEqual(generatedHost(".chip::before"), { kind: "before", host: ".chip" });
    assert.deepEqual(generatedHost(" .chip:hover:AFTER "), { kind: "after", host: ".chip:hover" });
    assert.deepEqual(generatedHost("::before"), { kind: "before", host: "*" });
    assert.deepEqual(generatedHost(".list > ::after"), { kind: "after", host: ".list > *" });
    assert.equal(generatedHost(".chip::marker"), null);
    assert.equal(generatedHost(".chip\\:before"), null);
  });

  test("the document's rules give one list for each pseudo-element", () => {
    const style = document.createElement("style");
    style.textContent = `
      .a::before { color: red }
      .b:before, .c > ::after { color: blue }
      @media screen { .d::after { color: red } }
      .e { color: red }
    `;
    document.head.append(style);
    try {
      assert.deepEqual(getGeneratedSelectors(), { before: ".a, .b", after: ".c > *, .d" });
    } finally {
      style.remove();
    }
    assert.deepEqual(getGeneratedSelectors(), { before: null, after: null });
  });
});

/**
 * The page's rules for a test's pseudo-elements, and what jsdom cannot say
 * about them: it implements no pseudo-element styles, and answers for one
 * with an error on the console. Each rule is put in the document, so that
 * the gate finds it, and answered here: the style of a probe span that
 * wears the rule's declarations, with the rule's `content`.
 *
 * @type {{ host: string, kind: string, css: string, content: string }[]}
 */
const pseudoRules = [];
/** @type {Element[]} */
const pseudoReads = [];
const realGetComputedStyle = window.getComputedStyle;

/**
 * @param {string} host
 * @param {"before" | "after"} kind
 * @param {string} content
 * @param {string} [css]
 */
function pseudoRule(host, kind, content, css = "") {
  pseudoRules.push({ host, kind, css, content });
  const style = document.createElement("style");
  style.textContent = `${host}::${kind} { color: inherit }`;
  document.head.append(style);
}

/**
 * What jsdom cannot say about layout: an element's rect is its `data-rect`,
 * and the stand-in a pseudo-element is measured as, the first or last child
 * of a copy, is at the `data-before` or `data-after` its element carries,
 * from the copy's corner. Every number is `left,top,width,height`.
 */
const realGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

/**
 * @param {string | null} value
 * @returns {number[] | null}
 */
function numbers(value) {
  return value === null ? null : value.split(",").map(Number);
}

/**
 * A range that lays text out at ten px a character, on one sixteen px line,
 * from the top left of the element the text is in.
 *
 * @returns {() => void}
 */
function installRange() {
  const original = document.createRange;
  resetMeasuringRangeForTests();
  document.createRange = () => {
    /** @type {Node | null} */
    let node = null;
    let start = 0;
    let end = 0;
    const rect = () => {
      const parent = /** @type {HTMLElement | null} */ (node?.parentElement ?? null);
      const at = parent ? parent.getBoundingClientRect() : clientRect(0, 0, 0, 0);
      return clientRect(at.left + start * 10, at.top, (end - start) * 10, 16);
    };
    return /** @type {Range} */ (
      /** @type {unknown} */ ({
        selectNodeContents: (/** @type {Node} */ target) => {
          node = target;
          start = 0;
          end = (target.textContent || "").length;
        },
        setStart: (/** @type {Node} */ target, /** @type {number} */ offset) => {
          node = target;
          start = offset;
        },
        setEnd: (/** @type {Node} */ _target, /** @type {number} */ offset) => {
          end = offset;
        },
        getBoundingClientRect: rect,
        getClientRects: () => /** @type {DOMRectList} */ (/** @type {unknown} */ ([rect()])),
      })
    );
  };
  return () => {
    document.createRange = original;
    resetMeasuringRangeForTests();
  };
}

/**
 * A page-owned root with `markup` in it, and a portal over it.
 *
 * @param {string} markup
 */
function generatedPanel(markup) {
  const ctx = InteractionContext.set({}, new InteractionManager());
  const root = document.createElement("div");
  root.innerHTML = markup;
  document.body.appendChild(root);
  const portal = createPortal(ctx, { root });
  const parent = new THREE.Group();
  portal.addTo(parent);
  return {
    portal,
    root,
    /**
     * The quads of the generated boxes, which carry their pseudo-element's
     * name.
     *
     * @returns {THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[]}
     */
    quads: () => {
      /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[]} */
      const found = [];
      parent.traverse((object) => {
        if (
          object instanceof THREE.Mesh &&
          object.geometry === rectGeometry &&
          (object.name === "::before" || object.name === "::after")
        ) {
          found.push(
            /** @type {THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>} */ (object),
          );
        }
      });
      return found;
    },
    /** @returns {THREE.Mesh[]} */
    runs: () => {
      /** @type {THREE.Mesh[]} */
      const found = [];
      parent.traverse((object) => {
        if (isRunMesh(object)) {
          found.push(object);
        }
      });
      return found;
    },
    cleanup: () => {
      portal.disconnect();
      root.remove();
    },
  };
}

describe("an element's ::before and ::after in a panel", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  /** @type {() => void} */
  let restoreRange;
  before(() => {
    canvas = stubCanvas();
    restoreRange = installRange();
    window.getComputedStyle = (element, pseudo) => {
      if (pseudo !== "::before" && pseudo !== "::after") {
        return realGetComputedStyle.call(window, element);
      }
      pseudoReads.push(element);
      const kind = pseudo.slice(2);
      const rule = [...pseudoRules]
        .reverse()
        .find((r) => r.kind === kind && element.matches(r.host));
      const probe = document.createElement("span");
      probe.style.cssText = rule?.css ?? "";
      document.body.append(probe);
      const style = realGetComputedStyle.call(window, probe);
      probe.remove();
      const content = rule?.content ?? "none";
      return new Proxy(style, {
        get: (target, key) => {
          if (key === "content") {
            return content;
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    HTMLElement.prototype.getBoundingClientRect = function boundingClientRect() {
      const own = numbers(this.getAttribute("data-rect"));
      if (own) {
        return clientRect(own[0], own[1], own[2], own[3]);
      }
      const copy = this.parentElement;
      if (
        copy?.hasAttribute("data-xr-generated-copy") &&
        this.localName === "span" &&
        (this === copy.firstChild || this === copy.lastChild)
      ) {
        const at =
          (this === copy.firstChild ? numbers(copy.getAttribute("data-before")) : null) ??
          (this === copy.lastChild ? numbers(copy.getAttribute("data-after")) : null);
        const corner = copy.getBoundingClientRect();
        if (at) {
          return clientRect(corner.left + at[0], corner.top + at[1], at[2], at[3]);
        }
      }
      return realGetBoundingClientRect.call(this);
    };
  });
  after(() => {
    canvas.restore();
    restoreRange();
    window.getComputedStyle = realGetComputedStyle;
    HTMLElement.prototype.getBoundingClientRect = realGetBoundingClientRect;
  });
  beforeEach(() => {
    canvas.drawn.length = 0;
    pseudoReads.length = 0;
  });
  afterEach(() => {
    pseudoRules.length = 0;
    for (const style of document.head.querySelectorAll("style")) {
      style.remove();
    }
  });

  test("draws a ::before's box and text where the copy lays it out", async () => {
    pseudoRule(".chip", "before", '"★"', "background-color: rgb(255, 0, 0)");
    const panel = generatedPanel(
      `<div class="chip" style="position: relative" data-rect="0,0,200,40" data-before="4,2,20,16"></div>`,
    );
    await settle(panel.portal);

    const [quad] = panel.quads();
    assert.ok(quad, "the ::before's box is drawn");
    assert.deepEqual(
      [quad.position.x, quad.position.y, quad.scale.x, quad.scale.y],
      [4, 2, 20, 16],
    );
    assert.deepEqual(canvas.drawn, ["★"]);
    const [run] = panel.runs();
    assert.deepEqual([run.position.x, run.position.y], [4, 2]);
    // Drawn by the panel's batch at its element's order, after the
    // element's own box, and under the text drawn at the next.
    assert.equal(quad.material, batchedBoxMaterial());
    assert.equal(quad.renderOrder, run.renderOrder - 1);

    panel.cleanup();
  });

  test("reads no pseudo-element style of an element no rule gives one", async () => {
    pseudoRule(".chip", "before", '"★"');
    const panel = generatedPanel(
      `<div class="other" data-rect="0,0,200,40" data-before="0,0,10,16"></div>`,
    );
    await settle(panel.portal);

    assert.deepEqual(pseudoReads, []);
    assert.equal(panel.quads().length, 0);
    assert.deepEqual(canvas.drawn, []);

    panel.cleanup();
  });

  test("text alone builds no quad, and content none or display none draws nothing", async () => {
    pseudoRule(".text", "before", '"a"');
    pseudoRule(".none", "before", "none", "background-color: red");
    pseudoRule(".hidden", "before", '"b"', "display: none; background-color: red");
    const panel = generatedPanel(`
      <div class="text" data-rect="0,0,200,40" data-before="0,0,10,16"></div>
      <div class="none" data-rect="0,40,200,40" data-before="0,0,10,16"></div>
      <div class="hidden" data-rect="0,80,200,40" data-before="0,0,10,16"></div>
    `);
    await settle(panel.portal);

    assert.equal(panel.quads().length, 0);
    assert.deepEqual(canvas.drawn, ["a"]);

    panel.cleanup();
  });

  test("an ::after is drawn after the element's children", async () => {
    pseudoRule(".card", "after", '"!"', "background-color: rgb(0, 0, 255)");
    const panel = generatedPanel(`
      <div class="card" data-rect="0,0,200,40" data-after="150,0,20,16">
        <div data-rect="0,0,100,40" style="background-color: green"></div>
      </div>
    `);
    await settle(panel.portal);

    const [quad] = panel.quads();
    assert.ok(quad);
    // Every batched box draws half a level past its order. The child's text,
    // had it any, would draw at the order after the child's box, so the
    // ::after's box, a level further on, draws over both, and its text over
    // its box.
    const run = panel.runs().find((mesh) => mesh.renderOrder === quad.renderOrder + 1);
    assert.ok(run, "the ::after's text is drawn over its box");
    const childOrder = Math.max(
      ...collectBatched(panel)
        .filter((box) => box !== quad)
        .map((box) => box.renderOrder),
    );
    assert.ok(quad.renderOrder >= childOrder + 1, `${quad.renderOrder} after ${childOrder}`);

    panel.cleanup();
  });

  test("a positioned one is drawn only when its element is its containing block", async () => {
    pseudoRule(".bar", "after", '""', "position: absolute; background-color: red");
    const panel = generatedPanel(`
      <div class="bar" style="position: relative" data-rect="0,0,200,40" data-after="0,38,200,2"></div>
      <div class="bar" data-rect="0,40,200,40" data-after="0,38,200,2"></div>
    `);
    await settle(panel.portal);

    const quads = panel.quads();
    assert.equal(quads.length, 1);
    assert.deepEqual([quads[0].position.y, quads[0].scale.y], [38, 2]);

    panel.cleanup();
  });

  test("a rule that arrives after the panel is up gives the element its ::before", async () => {
    const panel = generatedPanel(
      `<div class="late" data-rect="0,0,200,40" data-before="0,0,10,16"></div>`,
    );
    await settle(panel.portal);
    assert.deepEqual(canvas.drawn, []);

    pseudoRule(".late", "before", '"✓"');
    await pump();
    assert.deepEqual(canvas.drawn, ["✓"]);

    panel.cleanup();
  });

  test("a content: url() draws its picture at its own size, in the content box", async () => {
    // Pictures land at once, at 12 by 14.
    const load = THREE.TextureLoader.prototype.load;
    THREE.TextureLoader.prototype.load = function (_url, onLoad) {
      const texture = new THREE.Texture(
        /** @type {HTMLImageElement} */ ({ width: 12, height: 14 }),
      );
      onLoad?.(/** @type {THREE.Texture<HTMLImageElement>} */ (texture));
      return /** @type {THREE.Texture<HTMLImageElement>} */ (texture);
    };
    try {
      pseudoRule(".pic", "before", 'url("/icon.png")', "padding: 2px");
      const panel = generatedPanel(
        `<div class="pic" data-rect="0,0,200,40" data-before="10,4,16,18"></div>`,
      );
      await settle(panel.portal);

      const [quad] = panel.quads();
      assert.ok(quad, "a picture is drawn on a quad of its own");
      assert.notEqual(quad.material, batchedBoxMaterial(), "a picture draws itself");
      const { uImage, uImageRect } = quad.material.uniforms;
      assert.ok(uImage.value, "the picture is bound");
      assert.deepEqual(uImageRect.value.toArray(), [2, 2, 14, 16]);
      assert.deepEqual(canvas.drawn, []);

      panel.cleanup();
    } finally {
      THREE.TextureLoader.prototype.load = load;
    }
  });

  test("a :hover rule gives the element an ::after while the ray is on it", async () => {
    // What the browser would answer while the ray is on it, which is not a
    // rule of the page's: the gate is to find the page's `:hover` alone.
    pseudoRules.push({ host: `.link[${HOVER_ATTRIBUTE}]`, kind: "after", css: "", content: '"→"' });
    const style = document.createElement("style");
    style.textContent = ".link:hover::after { content: '→' }";
    document.head.append(style);
    const panel = generatedPanel(
      `<div class="link" data-rect="0,0,100,20" data-after="80,0,10,16"></div>`,
    );
    await settle(panel.portal);
    assert.deepEqual(canvas.drawn, []);

    const link = /** @type {HTMLElement} */ (panel.root.querySelector(".link"));
    link.setAttribute(HOVER_ATTRIBUTE, "true");
    await pump();
    assert.deepEqual(canvas.drawn, ["→"]);
    const [run] = panel.runs();
    assert.equal(run.position.x, 80);

    link.removeAttribute(HOVER_ATTRIBUTE);
    await pump();
    assert.equal(panel.runs().length, 0);

    panel.cleanup();
  });
});

/**
 * The boxes the panel's batch draws.
 *
 * @param {ReturnType<typeof generatedPanel>} panel
 * @returns {THREE.Mesh[]}
 */
function collectBatched(panel) {
  /** @type {THREE.Mesh[]} */
  const found = [];
  /** @type {THREE.Object3D | null} */
  let top = panel.quads()[0] ?? null;
  while (top?.parent) {
    top = top.parent;
  }
  top?.traverse((object) => {
    if (
      object instanceof THREE.Mesh &&
      object.geometry === rectGeometry &&
      object.material === batchedBoxMaterial()
    ) {
      found.push(object);
    }
  });
  return found;
}
