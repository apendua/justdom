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
import { getGenerated, parseGeneratedContent } from "./pseudoElements.js";
import {
  getDrawLevel,
  getElevation,
  getLayer,
  getLayerBase,
  getRenderBand,
  OVERLAY_LIFT,
  PIECE_BAND,
} from "./elevation.js";
import { isBlocker } from "./blocker.js";
import { getLayerOrder } from "./layerOrder.js";
import { comparePaintOrder } from "./layerTree.js";
import { fakeClock } from "../test/clock.js";
import { countEvaluations } from "../test/evaluations.js";
import { flicker, reportTransform, shifted, transformTransition } from "../test/motion.js";
import { getPanel } from "./dragAndDrop.js";
import { layerDepth, listPaintOrder } from "../test/paintOrderCount.js";
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

  test("a nested rule's element is resolved against the rule it is nested in", () => {
    // jsdom parses no nesting, so the sheet is one as Chromium reads it.
    const sheet = {
      cssRules: [
        {
          selectorText: ".chip, .tag",
          cssRules: [
            { selectorText: "&:hover::before" },
            { selectorText: ".icon::after, > ::after" },
            { selectorText: "&.open", cssRules: [{ selectorText: "&::after" }] },
          ],
        },
      ],
    };
    const adopted = Object.getOwnPropertyDescriptor(document, "adoptedStyleSheets");
    Object.defineProperty(document, "adoptedStyleSheets", { configurable: true, value: [sheet] });
    try {
      assert.deepEqual(getGeneratedSelectors(), {
        before: ":is(.chip, .tag):hover",
        after: ":is(.chip, .tag) .icon, :is(.chip, .tag) > *, :is(:is(.chip, .tag).open)",
      });
    } finally {
      if (adopted) {
        Object.defineProperty(document, "adoptedStyleSheets", adopted);
      } else {
        delete (/** @type {any} */ (document).adoptedStyleSheets);
      }
    }
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
 * from the copy's corner, and a picture in it at the element's
 * `data-picture`, from the stand-in's. Every number is
 * `left,top,width,height`.
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
 * Stand in for the browser where jsdom cannot: a pseudo-element's style is
 * the one `pseudoRules` gives it, and a rect is the one `data-rect`,
 * `data-before` or `data-after` names.
 *
 * @returns {void}
 */
function installPseudoStubs() {
  window.getComputedStyle = (element, pseudo) => {
    if (pseudo !== "::before" && pseudo !== "::after") {
      return realGetComputedStyle.call(window, element);
    }
    pseudoReads.push(element);
    const kind = pseudo.slice(2);
    const rule = [...pseudoRules].reverse().find((r) => r.kind === kind && element.matches(r.host));
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
      // An inline element parked on its own is made a block, and its line
      // laid out anew, lower than on the page.
      const blockified =
        copy.parentElement === document.body &&
        realGetComputedStyle.call(window, copy).display === "inline"
          ? 3
          : 0;
      if (at) {
        return clientRect(corner.left + at[0], corner.top + at[1] + blockified, at[2], at[3]);
      }
    }
    const stand = this.parentElement;
    const at = numbers(stand?.parentElement?.getAttribute("data-picture") ?? null);
    if (this.localName === "img" && stand && at) {
      const corner = stand.getBoundingClientRect();
      return clientRect(corner.left + at[0], corner.top + at[1], at[2], at[3]);
    }
    return realGetBoundingClientRect.call(this);
  };
}

/** @returns {void} */
function removePseudoStubs() {
  window.getComputedStyle = realGetComputedStyle;
  HTMLElement.prototype.getBoundingClientRect = realGetBoundingClientRect;
}

/**
 * A page-owned root with `markup` in it, and a portal over it.
 *
 * @param {string} markup
 * @param {Parameters<typeof createPortal>[1]} [options]
 */
function generatedPanel(markup, options = {}) {
  const ctx = InteractionContext.set({}, new InteractionManager());
  const root = document.createElement("div");
  root.innerHTML = markup;
  document.body.appendChild(root);
  const portal = createPortal(ctx, { ...options, root });
  const parent = new THREE.Group();
  portal.addTo(parent);
  return {
    portal,
    root,
    parent,
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
    installPseudoStubs();
  });
  after(() => {
    canvas.restore();
    restoreRange();
    removePseudoStubs();
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

  test("a box pays for pseudo-elements only once some rule of the page styles one", async () => {
    // Every reactive evaluation while a panel mounts, as `mirror.bench.js`
    // counts them.
    const evaluations = countEvaluations();
    /** @param {number} rows */
    const mount = async (rows) => {
      const panel = generatedPanel(
        Array.from({ length: rows }, (_, i) => `<div data-rect="0,${i * 20},200,20"></div>`).join(
          "",
        ),
      );
      evaluations.count = 0;
      await settle(panel.portal);
      const counted = evaluations.count;
      panel.cleanup();
      return counted;
    };
    /** What one more row costs a panel. */
    const perRow = async () => ((await mount(11)) - (await mount(1))) / 10;
    try {
      const none = await perRow();
      pseudoRule(".elsewhere", "before", '""');
      const some = await perRow();
      assert.ok(none < some, `${none} per row with no rule, ${some} with one`);
    } finally {
      evaluations.restore();
    }
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

  test("a ::before with only an outline or a box-shadow builds its quad", async () => {
    pseudoRule(".ringed", "before", '""', "outline-style: solid; outline-width: 2px");
    pseudoRule(".shadowed", "before", '""', "box-shadow: red 0px 2px 4px");
    pseudoRule(".bare", "before", '""', "outline-style: none; outline-width: 2px");
    const panel = generatedPanel(`
      <div class="ringed" data-rect="0,0,200,40" data-before="0,0,10,16"></div>
      <div class="shadowed" data-rect="0,40,200,40" data-before="0,0,10,16"></div>
      <div class="bare" data-rect="0,80,200,40" data-before="0,0,10,16"></div>
    `);
    await settle(panel.portal);

    assert.equal(panel.quads().length, 2);

    panel.cleanup();
  });

  test("a positioned ::after is drawn after the children it covers", async () => {
    pseudoRule(".card", "after", '"!"', "position: absolute; background-color: rgb(0, 0, 255)");
    const panel = generatedPanel(`
      <div class="card" style="position: relative" data-rect="0,0,200,40" data-after="50,0,20,16">
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
    const card = /** @type {HTMLElement} */ (panel.root.querySelector(".card"));
    const generated = getGenerated(card, "after");
    assert.equal(quad.renderOrder, getRenderBand(generated) + getDrawLevel(generated));

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

  test("a content: url() draws its picture at its own size, where the copy lays it out", async () => {
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
      pseudoRule(".pic", "before", 'url("/icon.png")', "padding: 2px; background-color: red");
      pseudoRule(".tall", "before", 'url("/icon.png")');
      const panel = generatedPanel(`
        <div class="pic" data-rect="0,0,200,40" data-before="10,4,16,20" data-picture="2,1,12,14"></div>
        <div class="tall" data-rect="0,40,200,40" data-before="0,10,12,8" data-picture="0,-4,12,14"></div>
      `);
      await settle(panel.portal);

      const [quad, tall] = panel.quads();
      assert.ok(quad, "a picture is drawn on a quad of its own");
      assert.notEqual(quad.material, batchedBoxMaterial(), "a picture draws itself");
      const { uImage, uImageRect } = quad.material.uniforms;
      assert.ok(uImage.value, "the picture is bound");
      // On the baseline, a pixel down here, not at the content box's corner,
      // which the padding puts at 2, 2.
      assert.deepEqual(uImageRect.value.toArray(), [2, 1, 14, 15]);
      // Taller than its line, it reaches above its box, and with no box of
      // its own to paint, its quad is the picture.
      assert.deepEqual(
        [tall.position.x, tall.position.y, tall.scale.x, tall.scale.y],
        [0, 6, 12, 14],
      );
      assert.deepEqual(tall.material.uniforms.uImageRect.value.toArray(), [0, 0, 12, 14]);
      assert.deepEqual(canvas.drawn, []);

      panel.cleanup();
    } finally {
      THREE.TextureLoader.prototype.load = load;
    }
  });

  test("an inline element's ::before is measured in the line its element is on", async () => {
    pseudoRule(".link", "before", '"→"', "background-color: red");
    const panel = generatedPanel(`
      <p data-rect="0,0,200,40">
        Read <a class="link" style="display: inline" data-rect="40,0,60,20" data-before="0,2,10,16">more</a>
      </p>
    `);
    await settle(panel.portal);

    const [quad] = panel.quads();
    assert.ok(quad);
    assert.deepEqual([quad.position.x, quad.position.y], [0, 2]);

    panel.cleanup();
  });

  test("a transparent border paints no box", async () => {
    pseudoRule(".clear", "before", '"a"', "border: 2px solid rgba(0, 0, 0, 0)");
    const panel = generatedPanel(
      `<div class="clear" data-rect="0,0,200,40" data-before="0,0,14,20"></div>`,
    );
    await settle(panel.portal);

    assert.equal(panel.quads().length, 0);
    assert.deepEqual(canvas.drawn, ["a"]);

    panel.cleanup();
  });

  test("a pseudo-element is hidden by its own visibility, not its element's", async () => {
    pseudoRule(".shown", "before", '""', "visibility: visible; background-color: red");
    pseudoRule(".gone", "before", '""', "visibility: hidden; background-color: red");
    const panel = generatedPanel(`
      <div class="shown" style="visibility: hidden" data-rect="0,0,200,40" data-before="0,0,10,10"></div>
      <div class="gone" data-rect="0,40,200,40" data-before="0,0,10,10"></div>
    `);
    await settle(panel.portal);

    const quads = panel.quads();
    assert.equal(quads.length, 2);
    assert.deepEqual(
      quads.map((quad) => quad.visible),
      [true, false],
    );

    panel.cleanup();
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

describe("an element's ::before and ::after in the paint order", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  /** @type {() => void} */
  let restoreRange;
  before(() => {
    canvas = stubCanvas();
    restoreRange = installRange();
    installPseudoStubs();
  });
  after(() => {
    canvas.restore();
    restoreRange();
    removePseudoStubs();
  });
  afterEach(() => {
    pseudoRules.length = 0;
    for (const style of document.head.querySelectorAll("style")) {
      style.remove();
    }
  });

  /**
   * The draw level of the element `selector` finds, or of its `kind` of
   * pseudo-element.
   *
   * @param {ReturnType<typeof generatedPanel>} panel
   * @param {string} selector
   * @param {"before" | "after"} [kind]
   * @returns {number}
   */
  const level = (panel, selector, kind) => {
    const element = /** @type {HTMLElement} */ (panel.root.querySelector(selector));
    return getDrawLevel(kind ? getGenerated(element, kind) : element);
  };

  test("a positioned ::before draws over the flow child it covers, and an in-flow one does not", async () => {
    pseudoRule(".over", "before", '""', "position: absolute; background-color: red");
    pseudoRule(".flow", "before", '""', "display: block; background-color: red");
    const panel = generatedPanel(`
      <div class="over" style="position: relative" data-rect="0,0,200,40" data-before="0,0,50,40">
        <div class="child" data-rect="0,0,200,40" style="background-color: green"></div>
      </div>
      <div class="flow" data-rect="0,40,200,40" data-before="0,0,200,10">
        <div class="child" data-rect="0,50,200,30" style="background-color: green"></div>
      </div>
    `);
    await settle(panel.portal);

    assert.ok(level(panel, ".over", "before") > level(panel, ".over > .child"));
    assert.equal(level(panel, ".flow", "before"), level(panel, ".flow > .child"));

    panel.cleanup();
  });

  test("a later positioned child draws over a positioned ::before it covers", async () => {
    pseudoRule(".card", "before", '""', "position: absolute; background-color: red");
    const panel = generatedPanel(`
      <div class="card" style="position: relative" data-rect="0,0,200,40" data-before="0,0,50,40">
        <div class="tip" style="position: absolute; background-color: green" data-rect="20,0,50,20"></div>
        <div class="far" style="position: absolute; background-color: green" data-rect="150,0,50,20"></div>
      </div>
    `);
    await settle(panel.portal);

    assert.ok(level(panel, ".tip") > level(panel, ".card", "before"));
    assert.equal(level(panel, ".far"), level(panel, ".card", "before"));

    panel.cleanup();
  });

  test("a pseudo-element with a negative z-index does not climb past the flow it covers", async () => {
    pseudoRule(".card", "before", '""', "position: absolute; z-index: -1; background-color: red");
    pseudoRule(".card", "after", '""', "position: absolute; z-index: -1; background-color: red");
    const panel = generatedPanel(`
      <div class="card" style="position: relative; z-index: 0" data-rect="0,0,200,40" data-before="0,0,200,40" data-after="0,0,200,40">
        <div class="child" data-rect="0,0,200,40" style="background-color: green"></div>
      </div>
    `);
    await settle(panel.portal);

    assert.equal(level(panel, ".card", "before"), level(panel, ".child"));
    assert.equal(level(panel, ".card", "after"), level(panel, ".child"));

    panel.cleanup();
  });

  test("an element's ::after draws after a descendant's, and a sibling over it after both", async () => {
    pseudoRule(".box", "after", '""', "position: absolute; background-color: red");
    const panel = generatedPanel(`
      <div class="box outer" style="position: relative" data-rect="0,0,200,100" data-after="0,0,200,100">
        <div class="box inner" style="position: relative" data-rect="0,0,100,50" data-after="0,0,100,50"></div>
      </div>
      <div class="cover" style="position: absolute; background-color: green" data-rect="0,0,200,100"></div>
    `);
    await settle(panel.portal);

    const outer = level(panel, ".outer", "after");
    assert.ok(outer > level(panel, ".inner", "after"), "the element's ::after is its last");
    assert.ok(level(panel, ".cover") > outer, "a sibling over the element draws over its ::after");

    panel.cleanup();
  });

  test("the paint-order count counts each as its element's first or last child", async () => {
    pseudoRule(".card", "before", '"★"', "position: absolute; background-color: red");
    pseudoRule(".card", "after", 'url("/badge.png")', "position: absolute");
    const panel = generatedPanel(`
      <div class="card" style="position: relative" data-rect="0,0,200,40" data-before="0,0,20,16" data-after="180,0,20,20">
        <div class="child" data-rect="0,0,200,40" style="background-color: green"></div>
      </div>
    `);
    await settle(panel.portal);

    const card = /** @type {HTMLElement} */ (panel.root.querySelector(".card"));
    const before = getGenerated(card, "before");
    const after = getGenerated(card, "after");
    const { entries } = listPaintOrder(panel.root);
    const of = (/** @type {unknown} */ node) =>
      entries.filter((entry) => entry.element === node).map((entry) => [entry.kind, entry.level]);
    assert.deepEqual(of(before), [
      ["box", getDrawLevel(before)],
      ["run", getDrawLevel(before) + 1],
    ]);
    assert.deepEqual(of(after), [["picture", getDrawLevel(after)]]);
    const order = entries.map((entry) => entry.element);
    assert.ok(order.indexOf(before) < order.indexOf(card.firstElementChild ?? card));
    assert.ok(order.indexOf(after) > order.indexOf(card.firstElementChild ?? card));

    panel.cleanup();
  });

  test("a pseudo-element appearing on hover reorders the siblings it covers, and back", async () => {
    pseudoRules.push({
      host: `.row[${HOVER_ATTRIBUTE}]`,
      kind: "after",
      css: "position: absolute; background-color: red",
      content: '""',
    });
    const style = document.createElement("style");
    style.textContent = ".row:hover::after { content: '' }";
    document.head.append(style);
    const panel = generatedPanel(`
      <div class="row" style="position: relative" data-rect="0,0,200,40" data-after="0,0,60,40">
        <div class="tip" style="position: absolute; background-color: green" data-rect="20,0,20,20"></div>
        <div class="far" style="position: absolute; background-color: green" data-rect="150,0,20,20"></div>
      </div>
    `);
    await settle(panel.portal);
    const tip = level(panel, ".tip");
    const far = level(panel, ".far");

    const row = /** @type {HTMLElement} */ (panel.root.querySelector(".row"));
    row.setAttribute(HOVER_ATTRIBUTE, "true");
    await pump();
    // The ::after is the row's last paint child, after the tip in tree
    // order, so it covers the tip, and the far one it does not touch keeps
    // its level.
    assert.ok(level(panel, ".row", "after") > tip);
    assert.equal(level(panel, ".tip"), tip);
    assert.equal(level(panel, ".far"), far);
    const [quad] = panel.quads();
    assert.equal(
      quad.renderOrder,
      getRenderBand(getGenerated(row, "after")) + level(panel, ".row", "after"),
    );

    row.removeAttribute(HOVER_ATTRIBUTE);
    await pump();
    assert.equal(panel.quads().length, 0);
    assert.equal(level(panel, ".tip"), tip);

    panel.cleanup();
  });

  /**
   * One frame's walk of the panel's layers, from a point in front of it.
   *
   * @param {ReturnType<typeof generatedPanel>} panel
   */
  const walk = async (panel) => {
    const order = /** @type {import("./layerOrder.js").LayerOrder} */ (getLayerOrder(panel.root));
    panel.parent.updateWorldMatrix(true, true);
    order.walk(new THREE.Vector3(100, -50, 2000));
    await pump();
    order.cut();
    return order;
  };

  test("a positioned pseudo-element with a positive z-index is a layer, lifted, and back", async () => {
    pseudoRule(".card", "after", '""', "position: absolute; background-color: red");
    pseudoRule(".card.up", "after", '""', "position: absolute; z-index: 1; background-color: red");
    const panel = generatedPanel(`
      <div class="card up" style="position: relative" data-rect="0,0,200,100" data-after="150,0,50,50">
        <div class="child" style="position: relative; background-color: green" data-rect="0,0,200,100"></div>
      </div>
    `);
    // A root with an area, which the walk takes as a plane.
    panel.root.setAttribute("data-rect", "0,0,400,300");
    await settle(panel.portal);
    const card = /** @type {HTMLElement} */ (panel.root.querySelector(".card"));
    const child = /** @type {HTMLElement} */ (panel.root.querySelector(".child"));
    const after = getGenerated(card, "after");

    assert.equal(getLayer(after), after, "a layer of its own");
    assert.equal(getDrawLevel(after), 0, "the root of its layer");
    assert.equal(getElevation(after), getElevation(card) + 1);
    // The paint-order count nests it as deep, for the walk it reproduces.
    assert.equal(layerDepth(after), getElevation(after));
    assert.equal(layerDepth(panel.root), getElevation(panel.root));
    let order = await walk(panel);
    const layers = order.pieces().map((piece) => piece.layer);
    assert.deepEqual(layers, [panel.root, after], "walked after the layer it floats over");
    assert.ok(getLayerBase(after) >= getLayerBase(getLayer(card)) + PIECE_BAND);
    const [quad] = panel.quads();
    assert.equal(quad.renderOrder, getLayerBase(after), "drawn from its own layer's base");
    // Lifted off its element's plane, as an overlay element is, and still
    // drawn where the copy lays it out.
    const lifted = quad.parent;
    assert.ok(lifted);
    assert.equal(lifted.position.z, -OVERLAY_LIFT);
    quad.updateWorldMatrix(true, false);
    const corner = new THREE.Vector3().setFromMatrixPosition(quad.matrixWorld);
    // The group its element's ::before and ::after hang in, level with the
    // element's own frame.
    const frame = /** @type {THREE.Object3D} */ (lifted.parent);
    assert.deepEqual(
      frame
        .worldToLocal(corner)
        .toArray()
        .map((n) => Math.round(n) + 0),
      [150, 0, -OVERLAY_LIFT],
    );

    // A plain positioned ::after again: level with its element, in its layer.
    card.classList.remove("up");
    await pump();
    assert.equal(getLayer(after), getLayer(card));
    assert.ok(getDrawLevel(after) > getDrawLevel(child));
    order = await walk(panel);
    assert.ok(order.pieces().every((piece) => piece.layer !== after));
    const [level] = panel.quads();
    assert.equal(level.parent?.position.z, 0);

    panel.cleanup();
  });

  test("a press on a lifted pseudo-element's blocker clicks its element", async () => {
    pseudoRule(".card", "after", '""', "position: absolute; z-index: 1; background-color: red");
    const panel = generatedPanel(`
      <div class="card" style="position: relative" data-rect="0,0,200,100" data-after="150,0,50,50">
        <div class="child" style="cursor: pointer" data-rect="0,0,200,100"></div>
      </div>
    `);
    await settle(panel.portal);
    const card = /** @type {HTMLElement} */ (panel.root.querySelector(".card"));
    /** @type {THREE.Mesh[]} */
    const blockers = [];
    panel.parent.traverse((object) => {
      if (object instanceof THREE.Mesh && isBlocker(object)) {
        blockers.push(object);
      }
    });
    const [quad] = panel.quads();
    const blocker = blockers.find((mesh) => mesh.parent === quad.parent);
    assert.ok(blocker, "the lifted ::after brings a blocker");

    /** @type {string[]} */
    const clicked = [];
    /** @param {Event} event */
    const hear = (event) => clicked.push(/** @type {Element} */ (event.target).className);
    document.addEventListener("click", hear);
    /** @type {any} */ (blocker).dispatchEvent({
      type: "select",
      intersection: { point: blocker.getWorldPosition(new THREE.Vector3()), object: blocker },
    });
    document.removeEventListener("click", hear);
    assert.deepEqual(clicked, [card.className]);

    panel.cleanup();
  });

  /**
   * Where a child 20 wide is drawn while it steps from 0 to `to`, near the
   * card's `::after` at 150 to 200, as the panel's channel waits to commit:
   * the motion step holds a step that changes what the child overlaps
   * until the commit (`keepsOverlaps` in `div.js`).
   *
   * @param {string} css The `::after`'s style.
   * @param {number} to
   * @returns {Promise<number>} The child's x a few frames into the step.
   */
  const stepAcross = async (css, to) => {
    pseudoRule(".card", "after", '""', css);
    const clock = fakeClock();
    const panel = generatedPanel(
      `
      <div class="card" style="position: relative" data-rect="0,0,200,100" data-after="150,0,50,50">
        <div class="mover" style="position: relative; transform: ${shifted(0)}" data-rect="0,0,20,20"></div>
      </div>
    `,
      { budget: 0 },
    );
    const card = /** @type {HTMLElement} */ (panel.root.querySelector(".card"));
    const mover = /** @type {HTMLElement} */ (panel.root.querySelector(".mover"));
    // A transformed box is measured by its layout offsets.
    for (const [name, value] of [
      ["offsetLeft", 0],
      ["offsetTop", 0],
      ["offsetWidth", 20],
      ["offsetHeight", 20],
    ]) {
      Object.defineProperty(mover, name, { configurable: true, get: () => value });
    }
    const reported = reportTransform(mover, shifted(0));
    /** @type {(() => void) | undefined} */
    let stop;
    try {
      await settle(panel.portal);
      const object = getPanel(panel.parent.children[0])?.objectOf(mover);
      assert.ok(object);
      assert.equal(object.matrix.elements[12], 0);
      stop = flicker(card);
      card.appendChild(document.createElement("div"));
      transformTransition(mover, "transitionrun");
      reported.value = shifted(to);
      for (let frame = 0; frame < 3; frame++) {
        flushFrame();
        await nextMacrotask();
      }
      return object.matrix.elements[12];
    } finally {
      transformTransition(mover, "transitionend");
      stop?.();
      reported.restore();
      clock.restore();
      panel.cleanup();
    }
  };

  test("a child stepping onto a positioned ::after holds until the commit", async () => {
    const css = "position: absolute; background-color: red";
    assert.equal(await stepAcross(css, 100), 100, "a step short of it is drawn");
    assert.equal(await stepAcross(css, 140), 0, "and one onto it holds");
  });

  test("a child stepping onto a lifted ::after is drawn at once", async () => {
    // The lifted one is a layer, ordered by the walk, and the child's draw
    // level skips it, as it skips a sibling that is a layer.
    const css = "position: absolute; z-index: 1; background-color: red";
    assert.equal(await stepAcross(css, 140), 140);
  });

  test("a stand-in sorts among its element's children, by paint layer first", async () => {
    pseudoRule(".card", "before", '""', "position: absolute; z-index: 1");
    pseudoRule(".card", "after", '""', "position: absolute");
    const panel = generatedPanel(`
      <div class="card" style="position: relative" data-rect="0,0,200,100" data-before="0,0,10,10" data-after="0,0,10,10">
        <div class="child" data-rect="0,0,200,100"><span class="leaf">x</span></div>
      </div>
      <div class="next" data-rect="0,100,200,100"></div>
    `);
    await settle(panel.portal);
    const card = /** @type {HTMLElement} */ (panel.root.querySelector(".card"));
    const child = /** @type {HTMLElement} */ (panel.root.querySelector(".child"));
    const leaf = /** @type {HTMLElement} */ (panel.root.querySelector(".leaf"));
    const next = /** @type {HTMLElement} */ (panel.root.querySelector(".next"));
    const before = getGenerated(card, "before");
    const after = getGenerated(card, "after");

    assert.equal(comparePaintOrder(card, after), -1, "an element paints before what is in it");
    assert.equal(comparePaintOrder(after, card), 1);
    assert.equal(comparePaintOrder(child, after), -1, "an ::after after the children");
    assert.equal(comparePaintOrder(after, leaf), 1, "and after what is in them");
    assert.equal(comparePaintOrder(child, before), -1, "a ::before over the flow by its z-index");
    assert.equal(comparePaintOrder(after, before), -1, "the higher paint layer last");
    assert.equal(comparePaintOrder(before, next), -1, "the next sibling after all of it");

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
