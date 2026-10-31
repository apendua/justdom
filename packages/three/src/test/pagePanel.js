import * as THREE from "three";
import { InteractionContext, InteractionManager } from "../interactions.js";
import { createPortal } from "../elements/portal.js";
import { clientRect } from "./clientRect.js";
import { settle } from "./portalHarness.js";

/**
 * @import { PortalOptions } from "../elements/portal.js";
 */

/** @typedef {readonly [number, number, number, number]} Rect */

/**
 * An element of a page, laid out where `at` says: its left, top, width and
 * height on the page. jsdom lays nothing out, so every element says.
 *
 * @typedef {object} PageSpec
 * @property {string} id
 * @property {string} [style]
 * @property {Rect} at
 * @property {string} [text] What it says.
 * @property {string} [tag] `div` unless given.
 * @property {PageSpec[]} [children]
 */

/**
 * Build a page under a 400 by 300 root at the page's corner, mirror it into
 * a panel through a real interaction manager, and let the panel settle.
 *
 * @template {PageSpec} S
 * @param {S[]} children
 * @param {object} [options]
 * @param {Omit<PortalOptions, "root">} [options.portal] The panel's own
 *   options, beside `root` and a `budget` of 0.
 * @param {string} [options.rootStyle]
 * @param {InteractionManager} [options.manager] The interaction manager to
 *   mirror through, for a test with more than one panel; a new one unless
 *   given.
 * @param {(element: HTMLElement, spec: S) => void} [options.decorate] What
 *   else to do with each element, before its children are built.
 */
export async function pagePanel(
  children,
  { portal: own = {}, rootStyle = "", decorate, manager = new InteractionManager() } = {},
) {
  const root = document.createElement("div");
  root.id = "root";
  root.style.cssText = rootStyle;
  /** @type {Map<string, HTMLElement>} */
  const elements = new Map();
  /** @type {Map<string, Rect>} */
  const places = new Map();

  /**
   * @param {HTMLElement} parent
   * @param {S} spec
   */
  const build = (parent, spec) => {
    const element = document.createElement(spec.tag ?? "div");
    element.id = spec.id;
    element.style.cssText = spec.style ?? "";
    if (spec.text) {
      element.textContent = spec.text;
    }
    decorate?.(element, spec);
    element.getBoundingClientRect = () => clientRect(...spec.at);
    elements.set(spec.id, element);
    places.set(spec.id, spec.at);
    parent.appendChild(element);
    for (const child of spec.children ?? []) {
      build(element, /** @type {S} */ (child));
    }
  };
  root.getBoundingClientRect = () => clientRect(0, 0, 400, 300);
  for (const child of children) {
    build(root, child);
  }
  document.body.appendChild(root);

  const ctx = InteractionContext.set({}, manager);
  const portal = createPortal(ctx, { ...own, root, budget: 0 });
  const scene = new THREE.Group();
  portal.addTo(scene);
  await settle(portal);
  const panel = scene.children[0];

  return {
    root,
    elements,
    places,
    manager,
    portal,
    scene,
    panel,
    /** @param {string} id */
    get: (id) => /** @type {HTMLElement} */ (elements.get(id)),
  };
}
