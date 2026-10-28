/**
 * The scenes phase 1 of `docs/freedom-paint-order-plan.md` counts in
 * jsdom, and the one way they are mounted and counted. Phase 3's tests
 * mount the same scenes in paint order (`mountScene`). The bench's scenes
 * come from `benchLayout.js`; the rest are layers out of the plane, which
 * the bench has none of, and what a page holds that freedom draws nothing
 * of. `bench/paintOrderCount.jsdom.mjs` prints their counts and
 * `paintOrderCount.test.js` holds them.
 *
 * Importing this installs `benchLayout.js`'s stand-ins, and offsets that
 * agree with its layout (`layoutOffsets.js`).
 */

import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal } from "../elements/portal.js";
import { PORTAL_ATTRIBUTE } from "../elements/portalRoot.js";
import { makeCard, makeRow, relayout } from "./benchLayout.js";
import { countPanel } from "./paintOrderCount.js";
import { matrix3d } from "./matrix3d.js";
import "./layoutOffsets.js";

/**
 * @typedef {import("./paintOrderCount.js").PanelCount} PanelCount
 *
 * @typedef {object} Scene
 * @property {string} name
 * @property {(root: HTMLElement) => void} build Fill the panel's root.
 */

// jsdom computes no pseudo-element. A list item's `::marker` takes the
// item's font and colour on a page unless a rule says otherwise, and none
// of these scenes says otherwise.
const computeStyle = window.getComputedStyle;
window.getComputedStyle = (element, pseudo) =>
  computeStyle(element, pseudo === "::marker" ? null : pseudo);
globalThis.getComputedStyle = window.getComputedStyle;

function nextMacrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Mount a portal and let `build` fill its root.
 *
 * @param {(root: HTMLElement) => void} build
 * @returns {Promise<{ root: HTMLElement, dispose: () => void }>}
 */
export async function mountScene(build) {
  const manager = new InteractionManager();
  const portal = createPortal(InteractionContext.set({}, manager));
  portal.addTo(new THREE.Group());
  const roots = document.querySelectorAll(`[${PORTAL_ATTRIBUTE}]`);
  const root = /** @type {HTMLElement} */ (roots[roots.length - 1]);
  build(root);
  relayout(root);
  await nextMacrotask();
  return {
    root,
    dispose() {
      portal.disconnect();
      root.remove();
    },
  };
}

/**
 * Mount a portal, let `build` fill its root, and count it.
 *
 * @param {(root: HTMLElement) => void} build
 * @returns {Promise<PanelCount>}
 */
export async function countScene(build) {
  const { root, dispose } = await mountScene(build);
  const result = countPanel(root);
  dispose();
  return result;
}

/**
 * @param {HTMLElement} root
 * @returns {HTMLElement}
 */
export function addBoard(root) {
  const board = document.createElement("div");
  board.style.position = "relative";
  board.style.width = "1000px";
  board.style.height = "1000px";
  board.style.background = "rgb(240, 240, 240)";
  root.appendChild(board);
  return board;
}

/**
 * A 100 px card at a place on a board, with a label and a transform about
 * its centre.
 *
 * @param {HTMLElement} parent
 * @param {number} left
 * @param {number} top
 * @param {string} transform
 * @returns {HTMLElement}
 */
export function addCard(parent, left, top, transform) {
  const card = document.createElement("div");
  card.style.position = "absolute";
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  card.style.width = "100px";
  card.style.height = "100px";
  card.style.background = "rgb(255, 255, 255)";
  card.style.transform = transform;
  // The browser's computed default; jsdom computes none.
  card.style.transformOrigin = "50px 50px 0px";
  const label = document.createElement("span");
  label.textContent = "card";
  card.appendChild(label);
  parent.appendChild(card);
  return card;
}

const SVG = "http://www.w3.org/2000/svg";

/**
 * An SVG element with its attributes.
 *
 * @param {string} tag
 * @param {Record<string, string>} attributes
 * @param {Element[]} [children]
 * @returns {Element}
 */
export function svg(tag, attributes, children = []) {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.append(...children);
  return element;
}

/**
 * A box with a background and a label.
 *
 * @param {string} text
 * @returns {HTMLElement}
 */
export function labelled(text) {
  const box = document.createElement("div");
  box.style.background = "rgb(255, 255, 255)";
  box.textContent = text;
  return box;
}

/**
 * The bench's scenes: `mirror.bench.js`'s list and its three boards.
 *
 * @type {Scene[]}
 */
export const BENCH_SCENES = [
  {
    name: "800-row list",
    build(root) {
      const list = document.createElement("div");
      for (let i = 0; i < 800; i += 1) {
        list.appendChild(makeRow(i));
      }
      root.appendChild(list);
    },
  },
  .../** @type {const} */ ([
    ["100 cards, apart", { piled: false }],
    ["100 cards, piled", { piled: true }],
    ["100 cards, translucent", { piled: true, translucent: true }],
  ]).map(([name, options]) => ({
    name,
    /** @param {HTMLElement} root */
    build(root) {
      const board = addBoard(root);
      for (let i = 0; i < 100; i += 1) {
        board.appendChild(makeCard(i, options));
      }
    },
  })),
];

/**
 * Layers out of the plane, to show what the tree does with them.
 *
 * @type {Scene[]}
 */
export const LAYER_SCENES = [
  {
    name: "lifted by translateZ",
    build(root) {
      const board = addBoard(root);
      addCard(board, 0, 0, matrix3d(["translateZ", 10]));
      addCard(board, 50, 50, "none");
    },
  },
  {
    name: "swung about its centre",
    build(root) {
      addCard(addBoard(root), 0, 0, matrix3d(["rotateY", 30]));
    },
  },
  {
    name: "swung about its edge",
    build(root) {
      const card = addCard(addBoard(root), 0, 0, matrix3d(["rotateY", 30]));
      card.style.transformOrigin = "0px 50px 0px";
    },
  },
  {
    name: "a swing in a swing",
    build(root) {
      const outer = addCard(addBoard(root), 0, 0, matrix3d(["rotateY", 30]));
      addCard(outer, 25, 0, matrix3d(["rotateX", 60]));
    },
  },
  {
    name: "two crossing in an X",
    build(root) {
      const board = addBoard(root);
      addCard(board, 0, 0, matrix3d(["translateZ", 20], ["rotateY", 30]));
      addCard(board, 0, 0, matrix3d(["translateZ", 20], ["rotateY", -30]));
    },
  },
  {
    name: "three lifted side by side",
    build(root) {
      const board = addBoard(root);
      for (let i = 0; i < 3; i += 1) {
        addCard(board, i * 120, 0, matrix3d(["translateZ", 4]));
      }
    },
  },
  {
    name: "three tilted about one centre",
    build(root) {
      const board = addBoard(root);
      addCard(board, 0, 0, matrix3d(["translateZ", 30], ["rotateX", 20]));
      addCard(board, 0, 0, matrix3d(["translateZ", 30], ["rotateZ", 120], ["rotateX", 20]));
      addCard(board, 0, 0, matrix3d(["translateZ", 30], ["rotateZ", 240], ["rotateX", 20]));
    },
  },
];

/**
 * What a page holds and freedom draws nothing of, each beside what it does
 * draw.
 *
 * @type {Scene[]}
 */
export const HIDDEN_SCENES = [
  {
    name: "a closed overlay",
    build(root) {
      root.appendChild(labelled("open"));
      const menu = labelled("menu");
      menu.style.position = "absolute";
      menu.style.zIndex = "5";
      menu.style.display = "none";
      root.appendChild(menu);
    },
  },
  {
    name: "a hidden group, one child shown",
    build(root) {
      const group = labelled("group");
      group.style.visibility = "hidden";
      const shown = labelled("shown");
      shown.style.visibility = "visible";
      group.appendChild(shown);
      root.appendChild(group);
    },
  },
  {
    name: "a select of ten options",
    build(root) {
      const select = document.createElement("select");
      for (let i = 0; i < 10; i += 1) {
        const option = document.createElement("option");
        option.textContent = `option ${i}`;
        select.appendChild(option);
      }
      root.appendChild(select);
    },
  },
  {
    name: "a menu faded to opacity 0",
    build(root) {
      root.appendChild(labelled("open"));
      const menu = labelled("menu");
      menu.style.opacity = "0";
      menu.appendChild(document.createElement("img"));
      root.appendChild(menu);
    },
  },
  {
    name: "an svg with a clip, a symbol and a use",
    build(root) {
      root.appendChild(
        svg("svg", { width: "100", height: "100" }, [
          svg("defs", {}, [svg("clipPath", { id: "clip" }, [svg("rect", { width: "50" })])]),
          svg("symbol", { id: "dot" }, [svg("circle", { r: "5", fill: "red", stroke: "black" })]),
          svg("use", { href: "#dot" }),
          svg("path", { d: "M0 0L10 10", fill: "blue", stroke: "none" }),
        ]),
      );
    },
  },
];
