import * as THREE from "three";
import { Derived, effects, just, onCleanup, set } from "@apendua/signal";
import { keyedList } from "../core.js";
import { $, children } from "../operators.js";
import { applyClip, clipRaycast } from "../elements/clip.js";
import {
  createMeasurementClone,
  getAttributeCached,
  getChildNodes,
  getComputedStyleCached,
  getReflowContext,
  getTextDataCached,
  withMeasuringRange,
} from "../elements/mirror.js";
import { isSvgElement, PortalTemplatesContext, SVG_NAMESPACE } from "../elements/plugins.js";
import { place } from "../elements/place.js";
import { generateTextTexture, getTextRenderStyle } from "../elements/textHelpers.js";
import { preservesWhitespace } from "../elements/textLines.js";
import { frameFor, measureClientRect } from "../elements/panelFrame.js";
import { readTextScale, TextScaleContext } from "../elements/textScale.js";
import { matrixEqual, matrixScale, samplingScale } from "./geometry.js";
import { buildImageGeometry } from "./image.js";
import {
  chainEqual,
  clipUniforms,
  commitMatrix,
  drawnOpacity,
  isDrawnHidden,
  localMatrix,
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
 * @import {Component, XREventMap} from '../core.js';
 * @import {Instance} from './shape.js';
 */

/**
 * The elements inside a `<text>` whose characters are drawn: a `<tspan>`,
 * and an `<a>`, which is drawn as one is.
 */
const RUN_PARENTS = new Set(["text", "tspan", "a"]);

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
 * The computed properties the layout of a `<text>` depends on: the font's,
 * and the rest the browser places glyphs by. Read through a gate of their
 * own, so a restyle that changes none of them, a hover setting
 * `data-xr-hover`, measures nothing.
 */
const LAYOUT_PROPERTIES = [
  ...FONT_PROPERTIES,
  "display",
  "white-space",
  "direction",
  "unicode-bidi",
  "writing-mode",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "font-stretch",
  "font-kerning",
  "font-variation-settings",
  "font-feature-settings",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-east-asian",
  "font-size-adjust",
  "font-optical-sizing",
  "text-rendering",
  "text-transform",
];

/** Where `white-space` is in `LAYOUT_PROPERTIES`. */
const WHITE_SPACE = LAYOUT_PROPERTIES.indexOf("white-space");

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
  const end = data.trimEnd().length;
  return { start, end, text: data.slice(start, end).replace(/\s+/g, " ") };
}

/**
 * @param {readonly unknown[]} a
 * @param {readonly unknown[]} b
 * @returns {boolean}
 */
function arraysEqual(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * The text nodes a `<text>` draws, in document order, each with its parent.
 * Each node is adopted as a template is before anything reads it, since the
 * portal adopts a `<text>`'s children only after the `<text>` is built, and
 * a read cached before that would be read again only once it did
 * (`readRecordOf` in `mirror.js`). Every element and text node on the way
 * is then read as a dependency, and so is every attribute that places
 * characters, so the runs are measured again when any of them changes.
 *
 * @param {Element} element
 * @param {(node: Node) => void} adopt The portal's `PortalTemplatesContext`.
 * @param {(element: Element) => readonly string[]} layoutStyle The element's
 *   `LAYOUT_PROPERTIES`, behind their gate.
 * @returns {{ runs: { node: Text, parent: Element }[], relative: boolean }}
 *   The runs, and whether any length placing them is a percentage, which is
 *   what the viewport around the text is read for.
 */
function collectRuns(element, adopt, layoutStyle) {
  /** @type {{ node: Text, parent: Element }[]} */
  const runs = [];
  let relative = false;
  /** @param {Element} parent */
  const visit = (parent) => {
    layoutStyle(parent);
    for (const name of LAYOUT_ATTRIBUTES) {
      // Read before the test, so every attribute is a dependency.
      const value = getAttributeCached(parent, name);
      relative = relative || (value?.includes("%") ?? false);
    }
    for (const child of getChildNodes(parent)) {
      adopt(child);
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
 * The copy is the mirror's measurement clone (`createMeasurementClone`): the
 * element cloned deep, with every computed style of the `<text>` itself
 * copied onto it and its transform switched off, here in an `<svg>` at one
 * CSS pixel per unit. Where a length is a percentage, that `<svg>`'s
 * `viewBox` is the viewport the element is in, so the percentage resolves as
 * it does in place. The `<tspan>`s keep their classes, and the document's
 * stylesheets apply to them as usual; as with HTML text, a selector that
 * reaches above the `<text>` does not match the copy. In a copy made by a
 * `<use>`, the font is the drawn one. The runs are read through the mirror's
 * one range (`withMeasuringRange`).
 *
 * @param {Element} element
 * @param {{ node: Text, parent: Element }[]} found From `collectRuns`.
 * @param {{ width: number, height: number } | null} viewport The viewport a
 *   percentage is of, or null where nothing is a percentage.
 * @param {readonly string[]} fonts The `FONT_PROPERTIES` the `<text>` is
 *   drawn with.
 * @param {(element: Element) => readonly string[]} layoutStyle An element's
 *   `LAYOUT_PROPERTIES`, for its `white-space`.
 * @returns {TextRun[]}
 */
function measureRuns(element, found, viewport, fonts, layoutStyle) {
  const host = document.createElementNS(SVG_NAMESPACE, "svg");
  if (viewport) {
    host.setAttribute("width", String(viewport.width));
    host.setAttribute("height", String(viewport.height));
    host.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
  }
  host.style.setProperty("overflow", "visible", "important");
  const clone = createMeasurementClone(/** @type {SVGElement} */ (element), host);
  try {
    FONT_PROPERTIES.forEach((name, i) => {
      if (fonts[i]) {
        clone.style.setProperty(name, fonts[i]);
      }
    });
    const frame = frameFor(host);
    const origin = measureClientRect(host, frame);
    return withMeasuringRange((range) => {
      /** @type {TextRun[]} */
      const runs = [];
      for (const { node, parent } of found) {
        const drawn = drawnRange(node.data, layoutStyle(parent)[WHITE_SPACE]);
        if (!drawn) {
          continue;
        }
        const copy = counterpart(node, element, clone);
        range.setStart(copy, drawn.start);
        range.setEnd(copy, drawn.end);
        const rect = measureClientRect(range, frame);
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
    });
  } finally {
    host.remove();
  }
}

/**
 * What `getTextRenderStyle` reads off a style to draw a run with: the font,
 * and how its characters are transformed and decorated.
 */
const RENDER_PROPERTIES = [...FONT_PROPERTIES, "text-transform", "text-decoration-line"];

/**
 * The style a run is rasterized with, white for a mask: the font and spacing
 * its parent is drawn with, as `getTextRenderStyle` reads them off a computed
 * style.
 *
 * @param {(name: string) => string} read
 * @returns {CSSStyleDeclaration}
 */
function runStyle(read) {
  /** @type {Record<string, string>} */
  const style = { textShadow: "none", color: "#ffffff", textDecorationColor: "#ffffff" };
  for (const name of RENDER_PROPERTIES) {
    style[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = read(name);
  }
  return /** @type {CSSStyleDeclaration} */ (/** @type {unknown} */ (style));
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
 * Whether a ray can hit a run under the rule its parent's `pointer-events`
 * gives the fill, which is the region text has. Template content is drawn
 * and never hit, as it is in `shape`.
 *
 * @param {Element} parent The run's `<text>`, `<tspan>` or `<a>`.
 * @param {Instance | null} instance
 * @returns {boolean}
 */
function runHits(parent, instance) {
  return (
    !instance &&
    regionHits(
      parsePointerEvents(readProperty(getComputedStyleCached(parent), parent, "pointer-events"))
        .fill,
      () => readDrawnProperty(parent, "fill", instance),
      () => isDrawnHidden(parent, instance),
    )
  );
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
  const adopt = PortalTemplatesContext.get(ctx);

  const own = new Derived(() => localMatrix(element, instance), { isEqual: matrixEqual });
  const chain = new Derived(() => readChain(element, instance), { isEqual: chainEqual });
  const root = new Derived(() => chain.get().root);
  const opacity = new Derived(() => drawnOpacity(chain.get()));
  /**
   * CSS pixels per user unit, in steps. Apart from the panel's own scale,
   * which `generateTextTexture` caps for HTML text; this part is not capped,
   * or text in a small `viewBox` would be drawn soft.
   */
  const unitScale = new Derived(() => samplingScale(matrixScale(chain.get().ctm)));

  /** @type {WeakMap<Element, Derived<readonly string[]>>} */
  const layoutStyles = new WeakMap();
  /** @param {Element} target */
  const layoutStyle = (target) => {
    let signal = layoutStyles.get(target);
    if (!signal) {
      signal = new Derived(
        () => {
          const current = getComputedStyleCached(target);
          return LAYOUT_PROPERTIES.map((name) => readProperty(current, target, name));
        },
        { isEqual: arraysEqual },
      );
      layoutStyles.set(target, signal);
    }
    return signal.get();
  };
  const fonts = new Derived(
    () => FONT_PROPERTIES.map((name) => readDrawnProperty(element, name, instance)),
    { isEqual: arraysEqual },
  );

  const runs = new Derived(
    () => {
      // What moves text from outside its own subtree: a font arriving, or a
      // layout change the portal cannot name.
      getReflowContext(element);
      const { runs: found, relative } = collectRuns(element, adopt, layoutStyle);
      if (!found.length) {
        return [];
      }
      // Read only when a percentage needs it, so a root that resizes does
      // not measure text it does not move.
      const viewport = relative ? viewportSize(element, instance) : null;
      return measureRuns(element, found, viewport, fonts.get(), layoutStyle);
    },
    { isEqual: runsEqual },
  );

  /** Whether a ray can hit any run, which is what makes the text a target. */
  const hittable = new Derived(() => runs.get().some((run) => runHits(run.parent, instance)));

  const { clip, clipMatrix, clipBox, followClip } = clipUniforms(() => chain.get());

  /**
   * The mesh of the run for one text node. Mounted once per node by
   * `keyedList`, and following the node's run from then on, so a run that
   * moves or changes its characters is redrawn alone, and a node added or
   * taken away mounts or unmounts its own run and no other.
   *
   * @param {Text} node
   * @returns {Source<Component>}
   */
  const drawRun = (node) => {
    /** @type {TextRun | undefined} */
    let last;
    // The node's run, or the one it had last, for the moment between the
    // node being taken away and its mesh with it.
    const run = new Derived(() => {
      last = runs.get().find((each) => each.node === node) ?? last;
      return /** @type {TextRun} */ (last);
    });
    const parent = new Derived(() => run.get().parent);
    const characters = new Derived(
      () => {
        const { text, width, height } = run.get();
        return { text, width, height };
      },
      { isEqual: (a, b) => a.text === b.text && a.width === b.width && a.height === b.height },
    );
    const position = new Derived(
      () => {
        const { left, top } = run.get();
        return { left, top };
      },
      { isEqual: (a, b) => a.left === b.left && a.top === b.top },
    );
    /** @param {string} name */
    const read = (name) => readDrawnProperty(parent.get(), name, instance);
    const renderStyle = new Derived(() => getTextRenderStyle(runStyle(read)), {
      isEqual: (a, b) =>
        shallowEqual(
          /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (a)),
          /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (b)),
        ),
    });
    const textureData = new Derived(() => {
      const { text, width, height } = characters.get();
      return generateTextTexture(
        [{ text, left: 0, top: 0, width, height }],
        renderStyle.get(),
        { width, height },
        readTextScale(textScale),
        true,
        unitScale.get(),
      );
    });
    const paint = new Derived(() => parsePaint(read("fill")));
    const hidden = new Derived(() => isDrawnHidden(parent.get(), instance));
    const hits = new Derived(() => runHits(parent.get(), instance));

    const mesh = new THREE.Mesh();
    clipRaycast(mesh, clipBox, mesh, clipMatrix);
    const clipped = mesh.raycast;
    let rayHits = false;
    mesh.raycast = (raycaster, intersects) => {
      if (rayHits) {
        clipped(raycaster, intersects);
      }
    };

    return $(mesh, [
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
        const { left, top } = position.get();
        const geometry = buildImageGeometry({
          left,
          top,
          right: left + width,
          bottom: top + height,
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
        rayHits = hits.get();
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
    rayTarget(ctx, element, () => hittable.get()),
    effects((obj) => {
      obj.visible = style().display !== "none";
    }),
    ...followClip,
    children(
      keyedList(
        () => runs.get().map((run) => /** @type {[Text, TextRun]} */ ([run.node, run])),
        (_run, node) => drawRun(node),
      ),
    ),
  ]);
}
