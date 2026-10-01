import * as THREE from "three";
import { Derived, effects, just, onCleanup, set } from "@apendua/signal";
import { applyClip, clipRaycast } from "../elements/clip.js";
import {
  getAttributeCached,
  getChildNodes,
  getComputedStyleCached,
  getReflowContext,
  getTextDataCached,
} from "../elements/mirror.js";
import { isSvgElement, SVG_NAMESPACE } from "../elements/plugins.js";
import { place } from "../elements/place.js";
import { generateTextTexture, getTextRenderStyle } from "../elements/textHelpers.js";
import { preservesWhitespace } from "../elements/textLines.js";
import { TextScaleContext } from "../elements/textScale.js";
import { matrixEqual, matrixScale, samplingScale } from "./geometry.js";
import { buildImageGeometry } from "./image.js";
import {
  chainEqual,
  clipUniforms,
  commitMatrix,
  isDrawnHidden,
  localMatrix,
  mountInto,
  paintSlot,
  rayTarget,
  readChain,
  readDrawnProperty,
  regionHits,
  viewportSize,
} from "./shape.js";
import { parseNumber, parsePaint, parsePointerEvents, readProperty } from "./style.js";

/**
 * A `<text>` inside inline SVG, projected into the scene as one textured quad
 * per run of characters, in the element's user space.
 *
 * The browser lays the text out: `x`, `y`, `dx`, `dy`, `text-anchor`, the
 * `<tspan>`s and the font are all its business, and what comes back is a box
 * per run. It is measured the way the mirror measures HTML text under a
 * transform: not in place, where the rects are screen-space bounds after
 * every matrix above, but in a detached copy with its own transform switched
 * off, laid out in an `<svg>` of its own that maps one user unit to one CSS
 * pixel. What that copy reports is already in the element's user space, so
 * the runs hang under the element's object like a shape's geometry does, and
 * a rotation on a `<g>` turns the text with it. A copy is measured off the
 * page, so text inside a `<symbol>` or a `<marker>` measures the same way.
 *
 * Each run is drawn by the same rasterizer as HTML text, as a coverage mask
 * tinted by `fill`, so a colour change is a uniform write. The texture is
 * drawn at as many device pixels per user unit as the root's viewport and
 * the matrices above give it, rounded to a step so a scale animation does
 * not redraw it every frame.
 *
 * @import {Source} from '@apendua/signal';
 * @import {XREventMap} from '../core.js';
 * @import {Instance} from './shape.js';
 */

/** The elements inside a `<text>` whose characters are drawn. */
const RUN_PARENTS = new Set(["text", "tspan"]);

/** The attributes that place a `<text>`'s characters and are not CSS. */
const LAYOUT_ATTRIBUTES = ["x", "y", "dx", "dy", "rotate", "textLength", "lengthAdjust"];

/**
 * The properties a run is laid out and drawn with. In a copy made by a
 * `<use>` they are read through `readDrawnProperty`, so the copy takes the
 * `<use>`'s font where the text sets none.
 */
const FONT_PROPERTIES = [
  "font-family",
  "font-size",
  "font-style",
  "font-variant-caps",
  "font-weight",
  "letter-spacing",
  "word-spacing",
  "text-anchor",
];

/**
 * One run of a `<text>`: the characters of one text node, where the browser
 * put them, in the `<text>`'s user space.
 *
 * @typedef {object} TextRun
 * @property {Text} node The text node in the document.
 * @property {Element} parent The `<text>` or `<tspan>` it is in, whose style
 *   it is drawn with.
 * @property {string} text What is drawn: the characters between the first
 *   and the last that are not white space, with runs of white space
 *   collapsed to one where `white-space` collapses them.
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 */

/**
 * @param {TextRun[]} a
 * @param {TextRun[]} b
 * @returns {boolean}
 */
function runsEqual(a, b) {
  return (
    a.length === b.length &&
    a.every((run, i) => {
      const other = b[i];
      return (
        run.node === other.node &&
        run.parent === other.parent &&
        run.text === other.text &&
        run.left === other.left &&
        run.top === other.top &&
        run.width === other.width &&
        run.height === other.height
      );
    })
  );
}

/**
 * The part of a text node that is drawn, as offsets into it, and the text
 * drawn for it. Where `white-space` collapses, white space at either end is
 * left out, since the browser drops it at the ends of a `<text>` and folds
 * it into a neighbour's between runs, and a run inside is one space. Where it
 * preserves, the whole node is drawn, a tab or a line break as a space.
 *
 * @param {string} data
 * @param {string} whiteSpace Computed `white-space` of the node's parent.
 * @returns {{ start: number, end: number, text: string } | null} Null for a
 *   node with nothing to draw.
 */
export function drawnRange(data, whiteSpace) {
  if (preservesWhitespace(whiteSpace)) {
    return data.length
      ? { start: 0, end: data.length, text: data.replace(/[\t\n\r]/g, " ") }
      : null;
  }
  const start = data.search(/\S/);
  if (start < 0) {
    return null;
  }
  const end = data.length - (data.length - data.trimEnd().length);
  return { start, end, text: data.slice(start, end).replace(/\s+/g, " ") };
}

/**
 * The text nodes a `<text>` draws, in document order, each with its parent.
 * Every element and text node on the way is read as a dependency, and so is
 * every attribute that places characters, so the runs are measured again
 * when any of them changes.
 *
 * @param {Element} element
 * @returns {{ runs: { node: Text, parent: Element }[], relative: boolean }}
 *   The runs, and whether any length placing them is a percentage, which is
 *   what the viewport around the text is read for.
 */
function collectRuns(element) {
  /** @type {{ node: Text, parent: Element }[]} */
  const runs = [];
  let relative = false;
  /** @param {Element} parent */
  const visit = (parent) => {
    getComputedStyleCached(parent);
    for (const name of LAYOUT_ATTRIBUTES) {
      relative ||= getAttributeCached(parent, name)?.includes("%") ?? false;
    }
    for (const child of getChildNodes(parent)) {
      if (child.nodeType === Node.TEXT_NODE) {
        getTextDataCached(/** @type {Text} */ (child));
        runs.push({ node: /** @type {Text} */ (child), parent });
      } else if (isSvgElement(child) && RUN_PARENTS.has(/** @type {Element} */ (child).localName)) {
        visit(/** @type {Element} */ (child));
      }
    }
  };
  visit(element);
  return { runs, relative };
}

/**
 * The node at the same place under `to` as `node` is under `from`, which a
 * deep clone keeps.
 *
 * @param {Node} node
 * @param {Node} from
 * @param {Node} to
 * @returns {Node}
 */
function counterpart(node, from, to) {
  /** @type {number[]} */
  const path = [];
  for (let current = node; current !== from; current = /** @type {Node} */ (current.parentNode)) {
    path.unshift(Array.prototype.indexOf.call(current.parentNode?.childNodes ?? [], current));
  }
  return path.reduce((current, index) => current.childNodes[index], to);
}

/**
 * Lay a `<text>` out in a detached copy and read back where each run went,
 * in its user space.
 *
 * The copy is the element cloned deep, with every computed style of the
 * `<text>` itself copied onto it and its transform switched off, in an
 * `<svg>` at one CSS pixel per unit. Where a length is a percentage, that
 * `<svg>`'s `viewBox` is the viewport the element is in, so the percentage
 * resolves as it does in place. The `<tspan>`s keep their classes, and the
 * document's stylesheets apply to them as usual; as with HTML text, a
 * selector that reaches above the `<text>` does not match the copy. In a copy
 * made by a `<use>`, the font is the drawn one.
 *
 * @param {Element} element
 * @param {Instance | null} instance
 * @returns {TextRun[]}
 */
function measureRuns(element, instance) {
  // What moves text from outside its own subtree: a font arriving, or a
  // layout change the portal cannot name.
  getReflowContext(element);
  const { runs: found, relative } = collectRuns(element);
  if (!found.length) {
    return [];
  }
  // Read only when a percentage needs it, so a root that resizes does not
  // measure text it does not move.
  const viewport = relative ? viewportSize(element, instance) : null;
  const fonts = FONT_PROPERTIES.map((name) => [name, readDrawnProperty(element, name, instance)]);

  const host = document.createElementNS(SVG_NAMESPACE, "svg");
  if (viewport) {
    host.setAttribute("width", String(viewport.width));
    host.setAttribute("height", String(viewport.height));
    host.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
  }
  for (const [name, value] of [
    ["position", "absolute"],
    ["left", "-99999px"],
    ["top", "0"],
    ["overflow", "visible"],
    ["visibility", "hidden"],
  ]) {
    host.style.setProperty(name, value, "important");
  }
  const clone = /** @type {SVGElement} */ (element.cloneNode(true));
  const computed = window.getComputedStyle(element);
  for (let i = 0; i < computed.length; i++) {
    const property = computed[i];
    clone.style.setProperty(property, computed.getPropertyValue(property));
  }
  for (const [name, value] of fonts) {
    if (value) {
      clone.style.setProperty(name, value);
    }
  }
  clone.style.setProperty("transform", "none", "important");
  clone.style.setProperty("transition", "none", "important");
  clone.style.setProperty("animation", "none", "important");
  clone.style.setProperty("visibility", "hidden", "important");
  host.appendChild(clone);
  document.body.appendChild(host);
  try {
    const origin = host.getBoundingClientRect();
    const range = document.createRange();
    /** @type {TextRun[]} */
    const runs = [];
    for (const { node, parent } of found) {
      const drawn = drawnRange(
        node.data,
        readProperty(getComputedStyleCached(parent), parent, "white-space"),
      );
      if (!drawn) {
        continue;
      }
      const copy = counterpart(node, element, clone);
      range.setStart(copy, drawn.start);
      range.setEnd(copy, drawn.end);
      const rect = range.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) {
        continue;
      }
      runs.push({
        node,
        parent,
        text: drawn.text,
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
      });
    }
    return runs;
  } finally {
    host.remove();
  }
}

/**
 * The style a run is rasterized with, white for a mask: the font and spacing
 * its parent is drawn with, as `getTextRenderStyle` reads them off a computed
 * style.
 *
 * @param {(name: string) => string} read
 * @returns {CSSStyleDeclaration}
 */
function runStyle(read) {
  return /** @type {CSSStyleDeclaration} */ (
    /** @type {unknown} */ ({
      fontFamily: read("font-family"),
      fontSize: read("font-size"),
      fontStyle: read("font-style"),
      fontVariantCaps: read("font-variant-caps"),
      fontWeight: read("font-weight"),
      letterSpacing: read("letter-spacing"),
      wordSpacing: read("word-spacing"),
      textTransform: read("text-transform"),
      textDecorationLine: read("text-decoration-line"),
      textShadow: "none",
      color: "#ffffff",
      textDecorationColor: "#ffffff",
    })
  );
}

/**
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @returns {boolean}
 */
function shallowEqual(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * @param {WeakKey} ctx
 * @param {Element} element
 * @param {Instance | null} [instance] The instance the text is part of, when
 *   it is template content drawn somewhere else.
 * @returns {Source<THREE.Object3D>}
 */
export function drawText(ctx, element, instance = null) {
  /** @type {THREE.Object3D<XREventMap>} */
  const object = new THREE.Object3D();
  const style = () => getComputedStyleCached(element);
  const textScale = TextScaleContext.get(ctx);

  const own = new Derived(() => localMatrix(element, instance), { isEqual: matrixEqual });
  const chain = new Derived(() => readChain(element, instance), { isEqual: chainEqual });
  const root = new Derived(() => chain.get().root);
  const opacity = new Derived(() => chain.get().opacity);
  /** Device pixels per user unit, in steps. */
  const scale = new Derived(
    () =>
      samplingScale(matrixScale(chain.get().ctm)) *
      (textScale ? textScale() : window.devicePixelRatio || 1),
  );

  const runs = new Derived(() => measureRuns(element, instance), { isEqual: runsEqual });

  /**
   * Whether a ray can hit the text. Its region is its fill, as SVG says, and
   * the quads of its runs stand in for the glyph cells. Template content is
   * drawn and never hit, as it is in `shape`.
   */
  const hittable = new Derived(
    () =>
      !instance &&
      regionHits(
        parsePointerEvents(readProperty(style(), element, "pointer-events")).fill,
        () => readDrawnProperty(element, "fill", instance),
        () => isDrawnHidden(element, instance),
      ),
  );

  const { clip, clipMatrix, clipBox, followClip } = clipUniforms(() => chain.get());

  /**
   * One run's mesh.
   *
   * @param {TextRun} run
   * @returns {Source<THREE.Object3D>}
   */
  const drawRun = (run) => {
    /** @param {string} name */
    const read = (name) => readDrawnProperty(run.parent, name, instance);
    const renderStyle = new Derived(() => getTextRenderStyle(runStyle(read)), {
      isEqual: (a, b) =>
        shallowEqual(
          /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (a)),
          /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (b)),
        ),
    });
    const textureData = new Derived(() =>
      generateTextTexture(
        [{ text: run.text, left: 0, top: 0, width: run.width, height: run.height }],
        renderStyle.get(),
        { width: run.width, height: run.height },
        scale.get(),
        true,
      ),
    );
    const paint = new Derived(() => parsePaint(read("fill")));
    const hidden = new Derived(() => isDrawnHidden(run.parent, instance));

    const mesh = new THREE.Mesh();
    clipRaycast(mesh, clipBox, mesh, clipMatrix);
    const clipped = mesh.raycast;
    let rayHits = false;
    mesh.raycast = (raycaster, intersects) => {
      if (rayHits) {
        clipped(raycaster, intersects);
      }
    };

    return just(mesh, [
      set("material", () => {
        const material = new THREE.MeshBasicMaterial({
          side: THREE.DoubleSide,
          forceSinglePass: true,
          transparent: true,
          depthWrite: false,
        });
        applyClip(material, clip, clipMatrix);
        onCleanup(() => {
          material.dispose();
        });
        return material;
      }),
      effects((obj) => {
        const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
        // A coverage mask, white on black, read through the alpha map; the
        // colour comes from the material. Three compiles a program with an
        // alpha map or without one, so only the first texture recompiles.
        if (!material.alphaMap) {
          material.needsUpdate = true;
        }
        material.alphaMap = textureData.get().texture;
      }),
      set("geometry", () => {
        const { width, height } = textureData.get();
        const geometry = buildImageGeometry({
          left: run.left,
          top: run.top,
          right: run.left + width,
          bottom: run.top + height,
          u0: 0,
          v0: 0,
          u1: 1,
          v1: 1,
        });
        onCleanup(() => {
          geometry.dispose();
        });
        return geometry;
      }),
      effects((obj) => {
        const material = /** @type {THREE.MeshBasicMaterial} */ (obj.material);
        const current = paint.get();
        if (current) {
          material.color.copy(current.color);
        }
        material.opacity =
          (current?.alpha ?? 0) * parseNumber(read("fill-opacity"), 1) * opacity.get();
      }),
      effects((obj) => {
        const drawn = paint.get() !== null && !hidden.get();
        rayHits = hittable.get();
        /** @type {THREE.MeshBasicMaterial} */ (obj.material).visible = drawn;
        obj.visible = drawn || rayHits;
      }),
      effects((obj) => {
        place(obj, 0, 0, 0);
        obj.renderOrder = paintSlot(element, root.get(), instance, 0).start;
      }),
    ]);
  };

  return just(object, [
    effects((obj) => {
      commitMatrix(obj, own.get());
    }),
    rayTarget(ctx, element, () => hittable.get() && runs.get().length > 0),
    effects((obj) => {
      obj.visible = style().display !== "none";
    }),
    ...followClip,
    effects((obj) => {
      for (const run of runs.get()) {
        mountInto(obj, drawRun(run));
      }
    }),
  ]);
}
