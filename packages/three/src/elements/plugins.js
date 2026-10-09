import { createProperty } from "@apendua/signal";

/**
 * @import {Subscribable} from '@apendua/signal';
 * @import {Object3D} from 'three';
 */

/**
 * The namespace every SVG element is created in, which is how the portal
 * tells an `<svg>` and what is inside it apart from the HTML around it —
 * a `tagName` alone would not: SVG has a `<title>`, an `<a>` and a
 * `<style>` too.
 */
export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * @param {Node} node
 * @returns {boolean}
 */
export function isSvgElement(node) {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    /** @type {Element} */ (node).namespaceURI === SVG_NAMESPACE
  );
}

/**
 * The SVG element an id names in `element`'s document, or null for an id
 * that is missing, names nothing, or names an element of another namespace
 * or, with `localName`, of another kind.
 *
 * @param {Element} element
 * @param {string | null} id
 * @param {string | null} [localName] The kind it must be, `"marker"` or
 *   `"clipPath"`, or null for any.
 * @returns {Element | null}
 */
export function findSvgElement(element, id, localName = null) {
  const found = id ? element.ownerDocument.getElementById(id) : null;
  return found && isSvgElement(found) && (localName === null || found.localName === localName)
    ? found
    : null;
}

/**
 * Whether the node is an `<svg>` root: the one element in the namespace that
 * is also a CSS box in the HTML flow around it, with a background, a border
 * and a size the page laid out — and so the one the portal draws as a box
 * whether or not anything claims what is inside it.
 *
 * Only the outermost one, whose parent is HTML: an `<svg>` nested in another
 * is a viewport in user space, and is a plugin's to draw.
 *
 * @param {Node} node
 * @returns {boolean}
 */
export function isSvgRoot(node) {
  if (!isSvgElement(node) || /** @type {Element} */ (node).localName !== "svg") {
    return false;
  }
  const parent = node.parentNode;
  return !parent || parent.nodeType !== Node.ELEMENT_NODE || !isSvgElement(parent);
}

/**
 * Something that knows how to project a kind of element the portal does not.
 *
 * The portal draws boxes, text, checkboxes, text fields and list items with
 * their markers. Everything else in the DOM is a box as far as it can tell.
 * A plugin is asked first, for every element
 * the portal is about to build, and answers with the object tree to mirror
 * the element with — or `null`, to say it is not one of its. The portal
 * then falls back to its own dispatch, with one exception: an element in
 * the SVG namespace that nobody claimed is skipped, with everything under
 * it, because a `<path>` drawn as a CSS box is a transparent rectangle
 * measured for nothing. The `<svg>` root itself is still drawn as the box
 * it is.
 *
 * Plugins are the reason `@apendua/freedom/svg` can exist as a separate
 * entry point: triangulating a path costs three's whole shape subtree, and
 * a scene that has no SVG in it should not carry that for the one that
 * does. Register the plugin in the scene that needs it —
 * `render(Scene, { portalPlugins: [svgElements()] })` — or on one portal
 * through `PortalOptions.plugins`.
 *
 * What the returned source has to satisfy is what `div` and `text` already
 * do: it emits exactly one `Object3D` synchronously on subscription, keeps
 * it in step with the element for as long as the subscription lasts, and
 * tears everything down — materials, geometry, ray-target registrations —
 * when it is unsubscribed. The portal attaches the element's DOM children
 * to `getContentGroup(object)`, which is the object itself unless the
 * plugin registered a content group of its own through `box()`.
 *
 * @typedef {object} PortalPlugin
 * @property {(ctx: WeakKey, element: Element) => Subscribable<Object3D> | null} element
 *   The object tree for an element this plugin claims, or `null`.
 */

/**
 * The plugins in scope for the portals under a context. `render()` sets it
 * from `RenderOptions.portalPlugins`; a portal prepends its own
 * `PortalOptions.plugins`. Empty by default, which is the portal exactly as
 * it was.
 */
export const PortalPluginsContext = createProperty(
  /**
   * @returns {readonly PortalPlugin[]}
   */
  () => [],
);

/**
 * The first plugin's answer for an element, or `null` when none claims it.
 *
 * @param {readonly PortalPlugin[]} plugins
 * @param {WeakKey} ctx
 * @param {Element} element
 * @returns {Subscribable<Object3D> | null}
 */
export function projectWithPlugins(plugins, ctx, element) {
  for (const plugin of plugins) {
    const object$ = plugin.element(ctx, element);
    if (object$) {
      return object$;
    }
  }
  return null;
}
