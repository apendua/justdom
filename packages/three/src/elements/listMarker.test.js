import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { clientRect } from "../test/clientRect.js";
import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal as createHeldPortal } from "./portal.js";
import { getListItemOrdinal, listMarkerText } from "./listMarker.js";
import { resetMeasuringRangeForTests } from "./mirror.js";
import { stubCanvas, STUB_GLYPH_WIDTH } from "../test/stubCanvas.js";
import { isRunMesh } from "../test/runMesh.js";

/**
 * `createPortal` with the loading frame's timing off, as the portal suite
 * has it, so a mount loads the moment it is built.
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

// Rasterizing reads the document's root font size and resolves colours
// through `getComputedStyle` as a bare global, which a browser has and the
// jsdom setup does not install.
if (typeof globalThis.getComputedStyle === "undefined") {
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
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

/**
 * What jsdom cannot say about `::marker`. It implements no pseudo-element
 * styles and answers for one with an error on the console; a browser
 * answers with the item's own style, inherited, plus whatever the page's
 * `::marker` rules say. This answers the same way, with `markerColor`
 * standing in for such a rule.
 *
 * @type {string | null}
 */
let markerColor = null;
const realGetComputedStyle = window.getComputedStyle;
before(() => {
  window.getComputedStyle = (element, pseudo) => {
    const style = realGetComputedStyle.call(window, element);
    if (pseudo !== "::marker" || markerColor === null) {
      return style;
    }
    const color = markerColor;
    return new Proxy(style, {
      get: (target, key) => (key === "color" ? color : Reflect.get(target, key)),
    });
  };
});
after(() => {
  window.getComputedStyle = realGetComputedStyle;
});

/**
 * What jsdom cannot say about layout. It measures every box at nothing,
 * and a marker is drawn only for an item that has a box, so a list item
 * measures 100 by 20 here, as a browser lays an empty one out, unless an
 * element around it is `display: none` and nothing inside is laid out at
 * all. A test that gives an element a rect of its own still wins.
 */
const realGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
before(() => {
  HTMLElement.prototype.getBoundingClientRect = function boundingClientRect() {
    const real = realGetBoundingClientRect.call(this);
    if (window.getComputedStyle(this).display !== "list-item") {
      return real;
    }
    for (let at = /** @type {Element | null} */ (this); at; at = at.parentElement) {
      if (window.getComputedStyle(at).display === "none") {
        return real;
      }
    }
    return clientRect(0, 0, 100, 20);
  };
});
after(() => {
  HTMLElement.prototype.getBoundingClientRect = realGetBoundingClientRect;
});

/**
 * A page-owned root with a list in it, and a portal over it. The items are
 * empty: jsdom lays out no text, and a marker is drawn for an empty item as
 * for any other.
 *
 * @param {string} markup
 */
function listPanel(markup) {
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
    /** @returns {HTMLElement} */
    list: () => /** @type {HTMLElement} */ (root.firstElementChild),
    /** The meshes carrying a run of text, in document order. */
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

/**
 * The clip a run was drawn with, in the run's own frame: what `applyClip`
 * hands the shader, read by compiling a stand-in for one.
 *
 * @param {THREE.Mesh} run
 * @returns {THREE.Vector4}
 */
function clipOf(run) {
  const material = /** @type {THREE.Material} */ (run.material);
  const shader = /** @type {any} */ ({
    uniforms: {},
    vertexShader: "void main() {\n#include <begin_vertex>\n}",
    fragmentShader: "void main() {\n}",
  });
  material.onBeforeCompile(shader, /** @type {any} */ (null));
  return shader.uniforms.clipBox.value;
}

/**
 * A range that lays text out the way the stand-in canvas measures it: one
 * line, ten px a character and sixteen tall, at `top` on the page. jsdom
 * has no layout to measure a range against.
 *
 * @param {number} top
 * @returns {() => void} Put the real range back.
 */
function installRange(top) {
  const original = document.createRange;
  resetMeasuringRangeForTests();
  document.createRange = () => {
    let start = 0;
    let end = 0;
    const rect = () => clientRect(start * 10, top, (end - start) * 10, 16);
    return /** @type {Range} */ (
      /** @type {unknown} */ ({
        selectNodeContents: (/** @type {Node} */ node) => {
          start = 0;
          end = (node.textContent || "").length;
        },
        setStart: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
          start = offset;
        },
        setEnd: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
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

describe("listMarkerText", () => {
  const never = () => {
    throw new Error("a bullet asked for its number");
  };

  /**
   * The marker's glyphs and its space, run together, so a table of them
   * reads as the marker would.
   *
   * @param {Parameters<typeof listMarkerText>} args
   */
  const say = (...args) => {
    const marker = listMarkerText(...args);
    return marker && `${marker.text}${marker.space}`;
  };

  test("a bullet is its glyph and a space, and never counts", () => {
    assert.equal(say("disc", never), "• ");
    assert.equal(say("circle", never), "◦ ");
    assert.equal(say("square", never), "▪ ");
    assert.equal(say("disclosure-open", never), "▾ ");
    assert.equal(say("disclosure-closed", never), "▸ ");
  });

  test("a number is written in its style, with a full stop", () => {
    for (const [type, n, text] of /** @type {[string, number, string][]} */ ([
      ["decimal", 3, "3. "],
      ["decimal-leading-zero", 7, "07. "],
      ["lower-alpha", 1, "a. "],
      ["lower-alpha", 27, "aa. "],
      ["upper-latin", 52, "AZ. "],
      ["lower-roman", 4, "iv. "],
      ["upper-roman", 1994, "MCMXCIV. "],
      ["lower-greek", 2, "β. "],
    ])) {
      assert.equal(
        say(type, () => n),
        text,
        `${type} ${n}`,
      );
    }
  });

  test("out of a style's range, or in a style it does not know, it is decimal", () => {
    for (const [type, n, text] of /** @type {[string, number, string][]} */ ([
      ["lower-alpha", 0, "0. "],
      ["upper-roman", 4000, "4000. "],
      ["my-own-counter-style", 5, "5. "],
    ])) {
      assert.equal(
        say(type, () => n),
        text,
        `${type} ${n}`,
      );
    }
  });

  test("a string is the marker as written, and none is no marker", () => {
    assert.deepEqual(listMarkerText('"→ "', never), { text: "→", space: " " });
    assert.deepEqual(listMarkerText('"\\"q\\""', never), { text: '"q"', space: "" });
    assert.equal(listMarkerText('""', never), null);
    assert.equal(listMarkerText('"  "', never), null);
    assert.equal(listMarkerText("none", never), null);
  });

  test("right to left, a number's full stop and a closed triangle face the text", () => {
    assert.deepEqual(
      listMarkerText("decimal", () => 3, "rtl"),
      { text: ".3", space: " " },
    );
    assert.deepEqual(
      listMarkerText("upper-roman", () => 4, "rtl"),
      { text: ".IV", space: " " },
    );
    assert.equal(say("disclosure-closed", never, "rtl"), "◂ ");
    assert.equal(say("disclosure-open", never, "rtl"), "▾ ");
    assert.equal(say("disc", never, "rtl"), "• ");
  });
});

describe("a list in a panel", () => {
  /** @type {ReturnType<typeof stubCanvas>} */
  let canvas;
  before(() => {
    canvas = stubCanvas();
  });
  after(() => {
    canvas.restore();
  });

  const BULLET = 'style="list-style-type: disc"';
  const NUMBER = 'style="list-style-type: decimal"';

  test("draws a bullet in front of each item", async () => {
    const panel = listPanel(`<ul><li ${BULLET}></li><li ${BULLET}></li></ul>`);
    canvas.drawn.length = 0;
    await settle(panel.portal);

    assert.deepEqual(canvas.drawn, ["•", "•"]);
    assert.equal(panel.runs().length, 2);

    panel.cleanup();
  });

  test("hangs the marker outside the content box, its space included", async () => {
    const panel = listPanel(
      `<ul><li style="list-style-type: decimal; padding-left: 4px; padding-top: 3px"></li></ul>`,
    );
    await settle(panel.portal);

    const [run] = panel.runs();
    // "1. " is three glyphs, all of which stand between where the glyphs
    // start and the content box, four px in.
    assert.equal(run.position.x, 4 - 3 * STUB_GLYPH_WIDTH);
    assert.equal(run.position.y, 3);

    panel.cleanup();
  });

  test("puts an inside marker at the start of the line", async () => {
    const panel = listPanel(
      `<ul><li style="list-style-position: inside; list-style-type: decimal; padding-left: 4px"></li></ul>`,
    );
    await settle(panel.portal);

    assert.equal(panel.runs()[0].position.x, 4);

    panel.cleanup();
  });

  test("hangs a right-to-left marker off the right of the content box", async () => {
    const panel = listPanel(
      `<ul><li style="list-style-type: decimal; direction: rtl; padding-right: 4px"></li></ul>`,
    );
    const item = /** @type {HTMLElement} */ (panel.list().firstElementChild);
    item.getBoundingClientRect = () => clientRect(0, 0, 100, 20);
    await settle(panel.portal);

    // The content box ends at 96, and the space is on its side of the
    // number, so the glyphs start one space further out.
    assert.equal(panel.runs()[0].position.x, 96 + STUB_GLYPH_WIDTH);

    panel.cleanup();
  });

  test("numbers the items of an ordered list", async () => {
    const panel = listPanel(`<ol><li ${NUMBER}></li><li ${NUMBER}></li><li ${NUMBER}></li></ol>`);
    canvas.drawn.length = 0;
    await settle(panel.portal);

    assert.deepEqual(canvas.drawn, ["1.", "2.", "3."]);

    panel.cleanup();
  });

  test("counts from start, from an item's value, and down in a reversed list", async () => {
    const panel = listPanel(
      `<ol start="5"><li ${NUMBER}></li><li ${NUMBER} value="10"></li><li ${NUMBER}></li></ol>`,
    );
    canvas.drawn.length = 0;
    await settle(panel.portal);
    assert.deepEqual(canvas.drawn, ["5.", "10.", "11."]);
    panel.cleanup();

    const reversed = listPanel(
      `<ol reversed><li ${NUMBER}></li><li ${NUMBER}></li><li ${NUMBER}></li></ol>`,
    );
    canvas.drawn.length = 0;
    await settle(reversed.portal);
    assert.deepEqual(canvas.drawn, ["3.", "2.", "1."]);
    reversed.cleanup();
  });

  test("skips an item that is not laid out as one", async () => {
    const panel = listPanel(
      `<ol><li ${NUMBER}></li><li style="display: block"></li><li ${NUMBER}></li></ol>`,
    );
    canvas.drawn.length = 0;
    await settle(panel.portal);

    assert.deepEqual(canvas.drawn, ["1.", "2."]);

    panel.cleanup();
  });

  test("an appended item is numbered, and the items before it are not re-drawn", async () => {
    const panel = listPanel(`<ol><li ${NUMBER}></li><li ${NUMBER}></li></ol>`);
    await settle(panel.portal);

    canvas.drawn.length = 0;
    const item = document.createElement("li");
    item.style.listStyleType = "decimal";
    panel.list().appendChild(item);
    await pump();

    assert.deepEqual(canvas.drawn, ["3."]);
    assert.equal(panel.runs().length, 3);

    panel.cleanup();
  });

  test("an item inserted at the top renumbers the items after it", async () => {
    const panel = listPanel(`<ol><li ${NUMBER}></li><li ${NUMBER}></li></ol>`);
    await settle(panel.portal);

    canvas.drawn.length = 0;
    const item = document.createElement("li");
    item.style.listStyleType = "decimal";
    panel.list().prepend(item);
    await pump();

    // The new first item draws "1.", and the two after it move up by one:
    // the old "1." becomes "2." and the old "2." becomes "3.".
    assert.deepEqual([...canvas.drawn].sort(), ["1.", "2.", "3."]);

    panel.list().firstElementChild?.remove();
    canvas.drawn.length = 0;
    await pump();
    assert.deepEqual([...canvas.drawn].sort(), ["1.", "2."]);

    panel.cleanup();
  });

  test("an item inserted or removed in the middle renumbers the items after it", async () => {
    const panel = listPanel(`<ol><li ${NUMBER}></li><li ${NUMBER}></li></ol>`);
    await settle(panel.portal);

    canvas.drawn.length = 0;
    const item = document.createElement("li");
    item.style.listStyleType = "decimal";
    panel.list().insertBefore(item, panel.list().children[1]);
    await pump();
    // The new second item, and the old second, now third. The first is
    // before the change and is not drawn again.
    assert.deepEqual([...canvas.drawn].sort(), ["2.", "3."]);

    canvas.drawn.length = 0;
    item.remove();
    await pump();
    // The old third item is second again. The item that left can be drawn
    // once more as the first of no list before its object goes, which is
    // why this does not ask for exactly one redraw.
    assert.ok(canvas.drawn.includes("2."), `drawn: ${canvas.drawn}`);
    assert.ok(!canvas.drawn.includes("3."), `drawn: ${canvas.drawn}`);
    assert.equal(panel.runs().length, 2);

    panel.cleanup();
  });

  test("draws the marker of any element laid out as a list item", async () => {
    const panel = listPanel(
      `<details><summary style="display: list-item; list-style-type: disclosure-closed; list-style-position: inside"></summary></details>`,
    );
    canvas.drawn.length = 0;
    await settle(panel.portal);
    assert.deepEqual(canvas.drawn, ["▸"]);
    panel.cleanup();

    const block = listPanel(
      `<div><div style="display: list-item; list-style-type: square"></div></div>`,
    );
    canvas.drawn.length = 0;
    await settle(block.portal);
    assert.deepEqual(canvas.drawn, ["▪"]);
    block.cleanup();
  });

  test("an item that clips its overflow cuts its outside marker off", async () => {
    const panel = listPanel(
      `<ul><li style="list-style-type: decimal; overflow: hidden"></li></ul>`,
    );
    const item = /** @type {HTMLElement} */ (panel.list().firstElementChild);
    item.getBoundingClientRect = () => clientRect(0, 0, 100, 20);
    await settle(panel.portal);

    const [run] = panel.runs();
    // The marker hangs off the item's left edge, so in the run's frame the
    // item's own window starts at or past the glyphs' right edge.
    assert.ok(
      clipOf(run).x >= 2 * STUB_GLYPH_WIDTH,
      `the clip starts at ${clipOf(run).x}, inside the marker`,
    );

    panel.cleanup();
  });

  test("sits on the item's first line, below a block's margin", async () => {
    const restore = installRange(12);
    const panel = listPanel(`<ul><li style="list-style-type: disc"><p>Point</p></li></ul>`);
    const paragraph = /** @type {HTMLElement} */ (panel.root.querySelector("p"));
    paragraph.getBoundingClientRect = () => clientRect(0, 12, 100, 16);
    try {
      await settle(panel.portal);
      const marker = panel.runs().find((run) => run.position.x < 0);
      assert.ok(marker, "the marker is drawn, off the item's left edge");
      assert.equal(marker.position.y, 12);
    } finally {
      panel.cleanup();
      restore();
    }
  });

  test("numbers a long list read from the end without nesting an item per frame", () => {
    const list = document.createElement("ol");
    for (let index = 0; index < 20000; index++) {
      list.appendChild(document.createElement("li"));
    }
    document.body.appendChild(list);
    try {
      assert.equal(getListItemOrdinal(/** @type {Element} */ (list.lastElementChild)), 20000);
    } finally {
      list.remove();
    }
  });

  test("an item with no text that scrolls carries its marker with the scroll", async () => {
    const panel = listPanel(`<ul><li style="list-style-type: disc; overflow: auto"></li></ul>`);
    const item = /** @type {HTMLElement} */ (panel.list().firstElementChild);
    item.scrollTop = 5;
    await settle(panel.portal);

    // The marker is on the box's object, not in the scrolled content, so it
    // is drawn where the content box's top has scrolled to.
    assert.equal(panel.runs()[0].position.y, -5);

    panel.cleanup();
  });

  test("an item that is not laid out has no marker", async () => {
    const hidden = listPanel(`<ul style="display: none"><li ${BULLET}></li></ul>`);
    canvas.drawn.length = 0;
    await settle(hidden.portal);
    assert.deepEqual(canvas.drawn, []);
    assert.equal(hidden.runs().length, 0);

    // Shown, it is laid out and draws its bullet; hidden again, it goes.
    hidden.list().style.display = "";
    await pump();
    assert.deepEqual(canvas.drawn, ["•"]);
    assert.equal(hidden.runs().length, 1);

    hidden.list().style.display = "none";
    await pump();
    assert.equal(hidden.runs().length, 0);
    hidden.cleanup();
  });

  test("a reversed list renumbers every item when one is appended", async () => {
    const panel = listPanel(`<ol reversed><li ${NUMBER}></li><li ${NUMBER}></li></ol>`);
    await settle(panel.portal);

    canvas.drawn.length = 0;
    const item = document.createElement("li");
    item.style.listStyleType = "decimal";
    panel.list().appendChild(item);
    await pump();

    assert.deepEqual([...canvas.drawn].sort(), ["1.", "2.", "3."]);

    panel.cleanup();
  });

  test("follows start and value written after the list is up", async () => {
    const panel = listPanel(`<ol><li ${NUMBER}></li><li ${NUMBER}></li></ol>`);
    await settle(panel.portal);

    canvas.drawn.length = 0;
    panel.list().setAttribute("start", "4");
    await pump();
    assert.deepEqual([...canvas.drawn].sort(), ["4.", "5."]);

    canvas.drawn.length = 0;
    panel.list().firstElementChild?.setAttribute("value", "8");
    await pump();
    assert.deepEqual([...canvas.drawn].sort(), ["8.", "9."]);

    panel.cleanup();
  });

  test("a list styled none draws no marker, and one restyled to none loses it", async () => {
    const plain = listPanel(`<ul><li style="list-style-type: none"></li></ul>`);
    canvas.drawn.length = 0;
    await settle(plain.portal);
    assert.deepEqual(canvas.drawn, []);
    assert.equal(plain.runs().length, 0);
    plain.cleanup();

    const panel = listPanel(`<ul><li ${BULLET}></li></ul>`);
    await settle(panel.portal);
    assert.equal(panel.runs().length, 1);

    const item = /** @type {HTMLElement} */ (panel.list().firstElementChild);
    item.style.listStyleType = "none";
    await pump();
    assert.equal(panel.runs().length, 0);

    item.style.listStyleType = "square";
    canvas.drawn.length = 0;
    await pump();
    assert.deepEqual(canvas.drawn, ["▪"]);
    assert.equal(panel.runs().length, 1);

    panel.cleanup();
  });

  test("is tinted in the ::marker colour, and hidden with its item", async () => {
    markerColor = "rgb(255, 0, 0)";
    const panel = listPanel(`<ul><li ${BULLET}></li></ul>`);
    await settle(panel.portal);

    const [run] = panel.runs();
    const material = /** @type {THREE.MeshBasicMaterial} */ (run.material);
    assert.ok(material.alphaMap, "a mask, tinted by the material");
    assert.equal(material.color.getHexString(), new THREE.Color("rgb(255, 0, 0)").getHexString());
    markerColor = null;

    const item = /** @type {HTMLElement} */ (panel.list().firstElementChild);
    item.style.visibility = "hidden";
    await pump();
    assert.equal(run.visible, false);

    panel.cleanup();
  });
});
