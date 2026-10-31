import { box } from "../elements/div.js";
import { isSvgElement, isSvgRoot } from "../elements/plugins.js";
import { toMatrix4 } from "./geometry.js";
import { image } from "./image.js";
import { group, rootMatrix } from "./shape.js";
import { drawShape, drawUse } from "./template.js";
import { drawText } from "./text.js";

/**
 * @import {PortalPlugin} from '../elements/plugins.js';
 */

/**
 * Inline SVG in a portal, as a plugin.
 *
 * A separate entry point — `justdom-three/svg` — and not part of the main
 * one, because drawing a shape means triangulating it: three's `ShapePath`,
 * its curves and the earcut triangulator, plus the stroker from
 * `SVGLoader`, none of which a panel of boxes and text has any use for. A
 * scene that has SVG in it registers the plugin once and pays for that
 * once; a scene that does not never loads it, and an `<svg>` in such a scene
 * is drawn as the CSS box it also is, with nothing inside.
 *
 * ```js
 * import { render } from "justdom-three";
 * import { svgElements } from "justdom-three/svg";
 *
 * render(Scene, { portalPlugins: [svgElements()] });
 * ```
 *
 * What it draws, and from what, is in the package README under *SVG*, and
 * what it does not yet draw is in `docs/freedom-svg-plan.md`.
 *
 * @returns {PortalPlugin}
 */
export function svgElements() {
  return {
    element(ctx, element) {
      if (!isSvgElement(element)) {
        return null;
      }
      switch (element.localName) {
        case "svg":
          // The outermost `<svg>` is a CSS box in the page's flow — a
          // background, a border, a size the page laid out, a place in the
          // clip chain — and is drawn as exactly that. Its shapes hang off
          // its content group like any children, and the content group
          // carries the viewport, so they are in user space below it. One
          // nested inside another is a group whose matrix is its viewport,
          // and a ray target under `cursor: pointer` as any group is.
          return isSvgRoot(element)
            ? box(ctx, /** @type {HTMLElement} */ (element), {
                contentMatrix: (target) => {
                  toMatrix4(rootMatrix(element), target);
                },
              })
            : group(ctx, element);
        case "a":
          // One inside a `<text>` is a run of it, drawn by the `<text>` as a
          // `<tspan>` is, and declined for the same reason.
          return element.closest("text") ? null : group(ctx, element);
        case "g":
        case "switch":
          return group(ctx, element);
        case "path":
        case "rect":
        case "circle":
        case "ellipse":
        case "line":
        case "polyline":
        case "polygon":
          return drawShape(ctx, element);
        case "image":
          return image(ctx, element);
        case "use":
          return drawUse(ctx, element);
        case "text":
          return drawText(ctx, element);
        default:
          // `<defs>`, `<symbol>`, `<marker>`, `<clipPath>`, `<mask>`, the
          // gradients and patterns: templates, drawn only where something
          // refers to them, which for a `<marker>` or a `<symbol>` is
          // `svg/template.js`. `<foreignObject>`: not drawn yet. Declined, and
          // so skipped by the portal with everything under them, which for a
          // template is the right answer in itself. A `<tspan>` is drawn by
          // its `<text>`, and declined here for the same reason: the portal
          // adopts it as it adopts a template, and builds nothing for it.
          return null;
      }
    },
  };
}

export { shape, group } from "./shape.js";
export { image } from "./image.js";
export { drawText } from "./text.js";
