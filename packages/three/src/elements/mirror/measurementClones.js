import { isSvgElement } from "../plugins.js";
import { PORTAL_ATTRIBUTE } from "../portalRoot.js";

/**
 * A detached, untransformed copy of `element` to measure instead of the real
 * thing, parked off-screen outside the portal's observed subtree.
 *
 * Touching the live elements is not an option: masking a transform with an
 * !important rule interacts with `transition: transform` at the browser's
 * pace, not ours — a synchronous flush updates the transition *baseline*
 * while transitions themselves are only generated at frames — so any
 * mask-and-restore protocol either swallows a transition the mutation meant
 * to start or manufactures one out of the restore. A clone has no
 * transitions to disturb.
 *
 * The clone's layout reproduces the original's because every resolved style
 * — the used width included — is copied onto its root; descendants keep
 * their classes and the document's stylesheets apply as usual. The one
 * blind spot: a descendant selector that reaches *above* the cloned element
 * (`.card[data-state] p`) has no ancestors to match against and falls back
 * to base styling.
 *
 * The clone is appended to the body, or, given a `host`, to the host, which
 * is appended to the body in its place and parked instead: an SVG `<text>`
 * is laid out only inside an `<svg>` (`measureRuns` in `svg/text.js`). The
 * clone's own `visibility` hides it either way, since the style copied onto
 * it says `visible`; what is parked is only moved off-screen, and marked
 * `inert` and `aria-hidden`, which keep it out of focus and the
 * accessibility tree. A clone of a panel's root drops `PORTAL_ATTRIBUTE`, so
 * that it is measured in the body's frame rather than taken for a panel of
 * its own. The caller removes what was appended, the host if it gave one.
 *
 * @template {HTMLElement | SVGElement} T
 * @param {T} element
 * @param {HTMLElement | SVGElement | null} [host] What the clone is laid out
 *   in, if not the body.
 * @returns {T}
 */
export function createMeasurementClone(element, host = null) {
  return parkMeasurementClone(element, /** @type {T} */ (element.cloneNode(true)), host);
}

/**
 * The second half of `createMeasurementClone`, for a copy of `element` the
 * caller has made itself: dress it in the element's resolved style, with
 * its transform, transitions and animations switched off (`copyStillStyle`),
 * and park it.
 *
 * @template {HTMLElement | SVGElement} T
 * @param {T} element
 * @param {T} clone
 * @param {HTMLElement | SVGElement | null} host
 * @returns {T}
 */
export function parkMeasurementClone(element, clone, host) {
  copyStillStyle(element, clone);
  clone.removeAttribute(PORTAL_ATTRIBUTE);
  clone.style.setProperty("visibility", "hidden", "important");
  const parked = host ?? clone;
  parked.style.setProperty("position", "absolute", "important");
  parked.style.setProperty("top", "0", "important");
  parked.style.setProperty("left", "-99999px", "important");
  parked.setAttribute("inert", "");
  parked.setAttribute("aria-hidden", "true");
  if (host) {
    host.appendChild(clone);
  }
  document.body.appendChild(parked);
  return clone;
}

/**
 * Write every resolved style of `element` onto `clone` inline, so that the
 * clone is laid out as the element is wherever it is put, and switch its
 * transform, transitions and animations off. An animation would start
 * again on the clone at its first keyframe, and an animated value beats an
 * inline one that is not `!important`.
 *
 * @param {HTMLElement | SVGElement} element
 * @param {HTMLElement | SVGElement} clone
 * @param {CSSStyleDeclaration} [computed] The element's computed style, if
 *   the caller has it already.
 * @returns {void}
 */
export function copyStillStyle(element, clone, computed = window.getComputedStyle(element)) {
  // Written as one declaration list, which the browser parses once, rather
  // than a `setProperty` per property: a computed style has some 350.
  const declarations = stillDeclarations(computed);
  // The custom properties the clone's own inline style sets go after them,
  // since Chromium enumerates none in a computed style, and a child styled
  // with `var(--gap)` would lose the `--gap` the element sets. Those alone:
  // the rest of the inline style is in the computed values already, and an
  // `!important` on it would outrank them. A custom property keeps its
  // priority, since nothing in the computed list can be outranked by it, and
  // an inline `!important` is what beats a stylesheet's.
  for (let i = 0; i < clone.style.length; i++) {
    const property = clone.style[i];
    if (property.startsWith("--")) {
      const priority = clone.style.getPropertyPriority(property);
      declarations.push(
        `${property}: ${clone.style.getPropertyValue(property)}${priority ? ` !${priority}` : ""}`,
      );
    }
  }
  clone.style.cssText = declarations.join("; ");
  // WebKit reads `transform: none` on an SVG element, an inline
  // `!important` one included, as no CSS transform, and falls back to the
  // `transform` attribute. There a minesweeper count, a `<text>` under
  // `translate(…) scale(20)`, was laid out twenty times too big.
  if (isSvgElement(clone)) {
    clone.removeAttribute("transform");
  }
}

/**
 * Every resolved property of `computed` as a declaration, and then the
 * transform, transitions and animations switched off: `copyStillStyle`'s
 * list, but for the custom properties.
 *
 * @param {CSSStyleDeclaration} computed
 * @returns {string[]}
 */
function stillDeclarations(computed) {
  /** @type {string[]} */
  const declarations = [];
  for (let i = 0; i < computed.length; i++) {
    const property = computed[i];
    declarations.push(`${property}: ${computed.getPropertyValue(property)}`);
  }
  declarations.push(
    "transform: none !important",
    "transition: none !important",
    "animation: none !important",
  );
  return declarations;
}

/**
 * A pseudo-element's resolved style as one declaration list, as a copy is
 * dressed in it (`copyStillStyle`), with its transform, transitions and
 * animations off. Two equal strings lay the box out alike, so a restyle of
 * the element that leaves its pseudo-element as it was measures nothing.
 *
 * @param {CSSStyleDeclaration} style
 * @returns {string}
 */
export function describeStillStyle(style) {
  return stillDeclarations(style).join("; ");
}
