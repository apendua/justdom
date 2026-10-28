/**
 * What a mounted panel draws in paint order, counted from one list. Phase 1
 * of `docs/freedom-paint-order-plan.md` wrote it to weigh paint order
 * against the lift, which freedom no longer has.
 *
 * `listPaintOrder` walks a panel's mirrored tree and lists what it draws:
 * each entry a kind (a box, a run, a picture or a shape), its element, its
 * layer and its draw level. `countPanel` builds the panel's BSP tree over
 * its layers' planes and adds up the draws under each way of getting the
 * order to the GPU. It counts one panel for one eye.
 *
 * The rules are freedom's own:
 *
 * - A layer is what `getLayer` says: the portal's root, an overlay or an
 *   element transformed out of its parent's plane. A box that clears a
 *   sibling with real height in it is not one.
 * - Within a layer, an element is at `getDrawLevel` and its content one
 *   level later.
 * - A layer's plane is its root's border box, placed by the offsets and
 *   own transforms from the panel's root down, with an overlay at
 *   `OVERLAY_LIFT`. Splitters are taken parent first and then by fewest
 *   splits; planes within `COPLANAR` of each other share a node.
 *
 * What a draw is:
 *
 * - Nothing counts under `display: none`, or at an opacity of 0
 *   (`getOpacity`, an ancestor's included; in a `<use>`'s or a marker's
 *   copy, the copy's chain's). An element with `visibility: hidden` draws
 *   nothing of its own, and its children still count, since a child that
 *   says `visible` is drawn (`isVisibilityHidden`). A hidden SVG shape
 *   draws no markers either.
 * - A box counts only when it paints: a background, a border or a shadow.
 * - A run is a text node with something to show, a field's value or a list
 *   item's marker, at its box's content level. A field's own child nodes,
 *   a `<textarea>`'s text or a `<select>`'s options, are its value and
 *   draw nothing else.
 * - A picture is an `<img>` or an SVG `<image>`. A shape is a checkbox's
 *   tick, an SVG `<text>`, an SVG shape's fill or stroke where it paints,
 *   each a mesh (`paintSlot` in `svg/shape.js`), or a marker's copy. A
 *   marker is drawn only on `MARKABLE_TAGS`, at each vertex
 *   `markerVertices` gives the position it names, and each copy draws the
 *   `<marker>`'s content, counted as any content is. The SVG walk follows
 *   `svgElements`: it goes into groups, draws a `<use>`'s target in its
 *   place, and skips the templates, `<defs>`, `<symbol>`, `<clipPath>` and
 *   the like. A `<use>`'s copy is read with the target's own computed
 *   style, not the one the `<use>` passes down. Each picture and shape is a
 *   draw of its own.
 * - A run's size class is the array its raster goes in (`sizeClass`). The
 *   text batch binds one array a draw, so two batches draw text a class at
 *   a time.
 * - Two batches: in each layer, a box draw per level with boxes and a text
 *   draw per level and size class with runs, plus its pictures and shapes,
 *   all of it once per piece of the layer.
 * - One batch: in each layer, one draw of its quads, broken once at each
 *   level holding a picture or a shape with quads past it, and once more
 *   each time a draw would sample more than `ARRAYS_PER_DRAW` arrays, plus
 *   the pictures and shapes, once per piece.
 * - One batch by node: the same, but the pieces that share a node of the
 *   tree, being coplanar, are one run in paint order (`comparePaintOrder`),
 *   the first piece's instances then the next's, so their quads break only
 *   at a picture or a shape, for arrays, or where the next piece tests
 *   other half-planes.
 * - A nested layer's two bucket breaks are counted as a column of their
 *   own and left out of both totals. A layer's draws above are already
 *   buckets of its own, and its instances are in no ancestor's, so a
 *   break splits an ancestor's draw only where that draw keeps its
 *   instances in paint order across the layer. At most, a break is a draw
 *   in each batch: the two-batch total plus twice the breaks, the one-batch
 *   total plus the breaks.
 * - Runs past the 256 one array holds draw themselves
 *   (`MAXIMUM_LAYERS` in `textBatch.js`), in every way of drawing alike, so
 *   none is charged for them here.
 *
 * Plain JavaScript over freedom's own derivations, so it runs wherever a
 * portal does: in jsdom over `paintOrderScenes.js`, under
 * `bench/paintOrderCount.jsdom.mjs` and `paintOrderCount.test.js`, and in a
 * page under `bench/paintOrderCount.browser.mjs`.
 */

import * as THREE from "three";

/**
 * @import {TextLine} from "../elements/textLines.js";
 * @import {Polygon} from "../elements/layerTree.js";
 */
import { getDrawLevel, getLayer, isOverlay, OVERLAY_LIFT } from "../elements/elevation.js";
import { composeTransform, getOwnTransform, hasDepthTransform } from "../elements/cssTransform.js";
import {
  getBorderBoxSize,
  getBoxOffset,
  getChildNodes,
  getComputedStyleCached,
  getFirstLine,
  getOpacity,
  getParentElement,
  getScrollOffset,
  getTextDataCached,
  getTextLayout,
  isVisibilityHidden,
} from "../elements/mirror.js";
import { comparePaintOrder, LayerTree, sameHalfPlanes } from "../elements/layerTree.js";
import { findSvgElement, isSvgElement } from "../elements/plugins.js";
import { PORTAL_ATTRIBUTE } from "../elements/portalRoot.js";
import { getDrawnBorderColor, parseAlpha } from "../elements/VisualProperties.js";
import { getListItemOrdinal, listMarkerText } from "../elements/listMarker.js";
import {
  contentBox,
  getRunRenderStyle,
  isTintableText,
  measureTextCanvas,
  measureTextRun,
  px,
} from "../elements/textHelpers.js";
import { PASSWORD_BULLET } from "../elements/textInput.js";
import { getShownValue, isTextInput } from "../elements/typing.js";
import { MARKABLE_TAGS, markerVertices } from "../svg/marker.js";
import { buildShapePath, readDrawnProperty, SHAPE_TAGS, viewportSize } from "../svg/shape.js";
import { parseNumber, parsePaint, parseUrlReference, readShapeGeometry } from "../svg/style.js";
import { findReferenced, GROUP_TAGS } from "../svg/template.js";

/**
 * @typedef {"box" | "run" | "picture" | "shape"} Kind
 *
 * @typedef {object} Entry
 * @property {Kind} kind
 * @property {Element} element
 * @property {Element} layer The root of the layer it is drawn in.
 * @property {number} level Its draw level, within its layer.
 * @property {string | null} size A run's size class, the array its raster
 *   goes in; null for a run that draws itself, empty for any other kind.
 */

/**
 * @param {Element} element
 * @returns {boolean}
 */
function isRoot(element) {
  return element.hasAttribute(PORTAL_ATTRIBUTE);
}

/**
 * @param {Element} element
 * @returns {boolean}
 */
function paints(element) {
  const style = getComputedStyleCached(element);
  return (
    parseAlpha(style.backgroundColor) > 0 ||
    (style.backgroundImage || "none") !== "none" ||
    parseAlpha(getDrawnBorderColor(style)) > 0 ||
    (style.boxShadow || "none") !== "none"
  );
}

/**
 * The run a box draws on itself, if it draws one, as what its raster is
 * drawn from: a text field's value or placeholder, laid out as
 * `textInput.js` lays it out, or a list item's marker, placed as
 * `markerRun` in `listMarker.js` places it. A `<textarea>` and a
 * `<select>` are counted a run of their `value` laid out as a field's,
 * as phase 1 counted them, though freedom draws neither one's text
 * (`portal.js` gives them `markedBox`): an overcount of one run each.
 *
 * @param {Element} element
 * @returns {{ style: CSSStyleDeclaration, text: string, width: number, height: number } | null}
 */
function surfaceRun(element) {
  const own = getComputedStyleCached(element);
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    if (tag === "INPUT" && !isTextInput(element)) {
      return null;
    }
    const field = /** @type {HTMLInputElement} */ (element);
    const value = tag === "INPUT" ? getShownValue(field) : field.value;
    const text = value
      ? field.type === "password"
        ? PASSWORD_BULLET.repeat(value.length)
        : value
      : field.placeholder || "";
    const { width } = measureTextRun(text, getRunRenderStyle(own));
    const { height } = contentBox(own, getBorderBoxSize(field));
    return { style: own, text, width, height };
  }
  if (own.display !== "list-item") {
    return null;
  }
  const marker = listMarkerText(
    own.listStyleType,
    () => getListItemOrdinal(/** @type {HTMLElement} */ (element)),
    own.direction === "rtl" ? "rtl" : "ltr",
  );
  if (!marker) {
    return null;
  }
  const style = getComputedStyleCached(element, "::marker");
  const run = measureTextRun(marker.text, getRunRenderStyle(style));
  const line = getFirstLine(/** @type {HTMLElement} */ (element));
  const height = line?.height || px(own.lineHeight) || run.ascent + run.descent;
  return { style, text: marker.text, width: run.width, height };
}

/**
 * How many run arrays one draw of the one batch may sample: the sixteen
 * texture units WebGL2 promises a fragment shader, less the gradient ramp's.
 */
const ARRAYS_PER_DRAW = 15;

/**
 * Which array a run's raster goes in, or null for a run the text batch
 * declines and that draws itself: one whose colours are baked into its
 * raster, text with a shadow or a decoration it cannot tint
 * (`isTintableText`). The batch keys an array by the canvas
 * `generateTextTexture` draws on, so this asks `measureTextCanvas` for that
 * canvas, from what the run's raster is drawn from.
 *
 * At a render scale of 1. The canvas is the texture's bounds, whole px,
 * times the scale, rounded up, so at any scale of 1 or more two runs share
 * a canvas exactly when they share one at 1, as long as neither reaches
 * the 2048 px texture cap. A run that does is scaled down by a factor of
 * its own, and textures of different sizes can come out one canvas:
 * 598x10 and 602x10 are both 2048x35 at scale 4. At that scale the cap
 * starts at a texture 512 px long, and above it the classes counted at 1
 * are an upper bound. A panel drawn at a scale below 1 can only share more.
 *
 * @param {CSSStyleDeclaration} style The style the run is drawn in.
 * @param {TextLine[]} lines
 * @param {{ width: number, height: number }} bounds
 * @returns {string | null}
 */
function sizeClass(style, lines, bounds) {
  if (!isTintableText(style)) {
    return null;
  }
  const { width, height } = measureTextCanvas(lines, getRunRenderStyle(style), bounds, 1);
  return `${width}x${height}`;
}

/**
 * An element's own `opacity`, without its ancestors'.
 *
 * @param {Element} element
 * @returns {number}
 */
function ownOpacity(element) {
  return parseNumber(getComputedStyleCached(element).opacity, 1);
}

/**
 * How many meshes an SVG shape draws of its own: one for its fill and one
 * for its stroke, each only when it paints. Its markers are content of
 * their own (`markersOf`).
 *
 * @param {Element} shape
 * @returns {number}
 */
function shapeLayers(shape) {
  /** @param {string} name */
  const read = (name) => readDrawnProperty(shape, name, null);
  let layers = 0;
  if (parsePaint(read("fill"))) {
    layers += 1;
  }
  if (parsePaint(read("stroke")) && !(parseFloat(read("stroke-width")) <= 0)) {
    layers += 1;
  }
  return layers;
}

/**
 * The `<marker>` drawn at each of a shape's vertices that has one, as
 * `svg/template.js` places them: `marker-start` at the first vertex,
 * `marker-end` at the last and `marker-mid` at every one between, on the
 * elements in `MARKABLE_TAGS` only.
 *
 * @param {Element} shape
 * @returns {Element[]}
 */
function markersOf(shape) {
  if (!MARKABLE_TAGS.has(shape.localName)) {
    return [];
  }
  /** @param {string} name */
  const named = (name) =>
    findSvgElement(shape, parseUrlReference(readDrawnProperty(shape, name, null)), "marker");
  const at = { start: named("marker-start"), mid: named("marker-mid"), end: named("marker-end") };
  if (!at.start && !at.mid && !at.end) {
    return [];
  }
  const geometry = readShapeGeometry(getComputedStyleCached(shape), shape, () =>
    viewportSize(shape),
  );
  const path = geometry ? buildShapePath(geometry) : null;
  if (!path) {
    return [];
  }
  /** @type {Element[]} */
  const markers = [];
  for (const vertex of markerVertices(path)) {
    const marker = at[vertex.position];
    if (marker) {
      markers.push(marker);
    }
  }
  return markers;
}

/**
 * What a panel draws, in tree order, with each entry's layer and its level,
 * and every layer it has, drawing or not: a layer that
 * draws nothing still has a plane that splits the others. A layer under
 * `display: none` or at an opacity of 0 has no plane in the tree.
 *
 * @param {Element} root The panel's root, the element carrying
 *   `data-xr-portal`.
 * @returns {{ entries: Entry[], layers: Element[] }}
 */
export function listPaintOrder(root) {
  /** @type {Entry[]} */
  const entries = [];
  /** @type {Element[]} */
  const layers = [];

  /**
   * @param {Kind} kind
   * @param {Element} element
   * @param {number} step 0 for the box, 1 for its content.
   * @param {string | null} [size] A run's size class, null for one that
   *   draws itself.
   */
  const push = (kind, element, step, size = "") => {
    entries.push({
      kind,
      element,
      layer: getLayer(element),
      level: getDrawLevel(element) + step,
      size,
    });
  };

  /**
   * What an `<svg>` element draws, at its root's content level: its shapes,
   * pictures and text, through its groups, its `<use>`s and its markers.
   *
   * The opacity is carried down the walk as a copy's chain is
   * (`readChain` in `svg/shape.js`), not read off the element's ancestors:
   * a `<use>`'s or a marker's copy takes its host's opacity, its
   * container's and each element's own on the way down, and not that of
   * the `<defs>` or `<g>` the template sits in. Outside a copy the two are
   * the same.
   *
   * @param {Element} element
   * @param {Element} root The `<svg>` box it is drawn on.
   * @param {Set<Element>} using The `<use>`s and `<marker>`s it is drawn
   *   through, which one already among them would draw forever.
   * @param {number} opacity The element's own opacity times its chain's.
   */
  const visitSvg = (element, root, using, opacity) => {
    const tag = element.localName;
    if (GROUP_TAGS.has(tag)) {
      visitSvgChildren(element, root, using, opacity);
    } else if (SHAPE_TAGS.has(tag)) {
      // Hidden, a shape draws nothing, its markers included: each copy
      // follows its host's `visibility` (`markers` in `svg/template.js`).
      if (isVisibilityHidden(element)) {
        return;
      }
      for (let i = shapeLayers(element); i > 0; i -= 1) {
        push("shape", root, 1);
      }
      for (const marker of markersOf(element)) {
        if (!using.has(marker)) {
          const through = new Set(using).add(marker);
          visitSvgChildren(marker, root, through, opacity * ownOpacity(marker));
        }
      }
    } else if (tag === "image" || tag === "text") {
      if (!isVisibilityHidden(element)) {
        push(tag === "image" ? "picture" : "shape", root, 1);
      }
    } else if (tag === "use" && !using.has(element)) {
      const target = findReferenced(element);
      if (target) {
        const through = new Set(using).add(element);
        if (target.localName === "symbol" || target.localName === "svg") {
          visitSvgChildren(target, root, through, opacity * ownOpacity(target));
        } else {
          visitSvgChild(target, root, through, opacity);
        }
      }
    }
  };

  /**
   * An element under `outer`, the opacity of what it is drawn in, unless
   * `display: none` or an opacity of 0 leaves nothing of it to count.
   *
   * @param {Element} element
   * @param {Element} root
   * @param {Set<Element>} using
   * @param {number} outer
   */
  const visitSvgChild = (element, root, using, outer) => {
    const opacity = outer * ownOpacity(element);
    if (getComputedStyleCached(element).display !== "none" && opacity > 0) {
      visitSvg(element, root, using, opacity);
    }
  };

  /**
   * @param {Element} element
   * @param {Element} root
   * @param {Set<Element>} using
   * @param {number} opacity
   */
  const visitSvgChildren = (element, root, using, opacity) => {
    for (const node of getChildNodes(element)) {
      if (isSvgElement(node)) {
        visitSvgChild(/** @type {Element} */ (node), root, using, opacity);
      }
    }
  };

  /**
   * @param {Element} element
   */
  const visit = (element) => {
    if (getComputedStyleCached(element).display === "none") {
      return;
    }
    if (getOpacity(element) <= 0) {
      return;
    }
    if (getLayer(element) === element) {
      layers.push(element);
    }
    // Hidden, an element draws nothing of its own, but a child that says
    // `visible` is drawn.
    const shown = !isVisibilityHidden(element);
    const tag = element.tagName;
    if (shown && tag === "IMG") {
      push("picture", element, 0);
    } else if (shown && paints(element)) {
      push("box", element, 0);
    }
    if (isSvgElement(element)) {
      visitSvgChildren(element, element, new Set(), getOpacity(element));
      return;
    }
    const surface = shown ? surfaceRun(element) : null;
    if (surface) {
      const { style, text, width, height } = surface;
      const lines = text ? [{ text, left: 0, top: 0, width, height }] : [];
      const bounds = { width: Math.max(width, 1), height: Math.max(height, 1) };
      push("run", element, 1, sizeClass(style, lines, bounds));
    }
    const input = /** @type {HTMLInputElement} */ (element);
    if (shown && tag === "INPUT" && input.type === "checkbox" && input.checked) {
      push("shape", element, 1);
    }
    // A field's child nodes are its value, drawn as its run above.
    if (tag === "TEXTAREA" || tag === "SELECT" || tag === "INPUT") {
      return;
    }
    for (const node of getChildNodes(element)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = /** @type {Text} */ (node);
        if (shown && getTextDataCached(text).trim() !== "") {
          const { lines, bounds } = getTextLayout(text);
          push("run", element, 1, sizeClass(getComputedStyleCached(text), lines, bounds));
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        visit(/** @type {Element} */ (node));
      }
    }
  };

  visit(root);
  return { entries, layers };
}

/** Scratch for one element's step down from its parent. */
const step = new THREE.Matrix4();

/**
 * Where an element's box sits in the panel's frame, as a matrix from its
 * own box to the root's: the offsets and own transforms from the root
 * down, each parent's scroll, and an overlay's lift. A child is placed in
 * its parent's content group, which `div.js` moves back by the parent's
 * scroll offset.
 *
 * @param {Element} element
 * @param {Map<Element, THREE.Matrix4>} cache
 * @returns {THREE.Matrix4}
 */
function frameOf(element, cache) {
  let matrix = cache.get(element);
  if (!matrix) {
    matrix = new THREE.Matrix4();
    const parent = isRoot(element) ? null : getParentElement(element);
    if (parent) {
      // The parent's first: it uses the same scratch.
      const outer = frameOf(parent, cache);
      const scroll = getScrollOffset(/** @type {HTMLElement} */ (parent));
      matrix.makeTranslation(-scroll.left || 0, -scroll.top || 0, 0).premultiply(outer);
      const html = /** @type {HTMLElement} */ (element);
      const offset = getBoxOffset(html);
      // Toward the viewer is local -z, as `div.js` places a box.
      const lift = isOverlay(html) ? -OVERLAY_LIFT : 0;
      const own = getOwnTransform(html);
      if (own) {
        composeTransform(step, offset.x, offset.y, lift, own.matrix, own.origin);
      } else {
        step.makeTranslation(offset.x, offset.y, lift);
      }
      matrix.multiply(step);
    }
    cache.set(element, matrix);
  }
  return matrix;
}

/**
 * @typedef {object} PanelCount
 * @property {number} entries
 * @property {Record<Kind, number>} kinds
 * @property {number} layers
 * @property {number} pieces
 * @property {number} nodes The tree's nodes, a plane each.
 * @property {number} mostHalfPlanes The most half-planes any piece carries.
 * @property {number} breaks Two bucket breaks per nested layer.
 * @property {number} deepestLayer The most levels any one layer draws at.
 * @property {number} runs
 * @property {number} classes The runs' size classes, an array each.
 * @property {number} twoBatches Draws under paint order, two batches.
 * @property {number} oneBatch Draws under paint order, one batch.
 * @property {number} oneBatchByNode The same, with the coplanar layers of
 *   one node drawn together.
 */

/**
 * What the benches call a panel in their tables: its root's id, or, for a
 * root without one, its place among the page's panels, from 1.
 *
 * @param {Element} root
 * @param {number} index Its place among the page's `[data-xr-portal]`
 *   roots, from 0.
 * @returns {string}
 */
export function panelName(root, index) {
  return root.id || `panel ${index + 1}`;
}

/**
 * Count one panel.
 *
 * @param {Element} root The panel's root, the element carrying
 *   `data-xr-portal`.
 * @returns {PanelCount}
 */
export function countPanel(root) {
  const { entries, layers: layerRoots } = listPaintOrder(root);

  /** @type {Record<Kind, number>} */
  const kinds = { box: 0, run: 0, picture: 0, shape: 0 };
  /** @type {Set<string>} */
  const classes = new Set();
  /**
   * @type {Map<Element, {
   *   boxLevels: Set<number>,
   *   runLevels: Map<number, Set<string>>,
   *   ownLevels: Set<number>,
   *   own: number,
   * }>}
   */
  const perLayer = new Map();
  for (const entry of entries) {
    kinds[entry.kind] += 1;
    let layer = perLayer.get(entry.layer);
    if (!layer) {
      layer = { boxLevels: new Set(), runLevels: new Map(), ownLevels: new Set(), own: 0 };
      perLayer.set(entry.layer, layer);
    }
    if (entry.kind === "box") {
      layer.boxLevels.add(entry.level);
    } else if (entry.kind === "run" && entry.size !== null) {
      classes.add(entry.size);
      const sizes = layer.runLevels.get(entry.level) ?? new Set();
      layer.runLevels.set(entry.level, sizes.add(entry.size));
    } else {
      layer.own += 1;
      layer.ownLevels.add(entry.level);
    }
  }

  /** @type {Map<Element, THREE.Matrix4>} */
  const frames = new Map();
  const tree = new LayerTree();
  tree.begin();
  /** @type {Set<Element>} */
  const planed = new Set();
  for (const layer of layerRoots) {
    let depth = 0;
    for (let el = getParentElement(layer); el && !isRoot(layer); el = getParentElement(el)) {
      if (getLayer(el) === el) depth += 1;
      if (isRoot(el)) break;
    }
    const { width, height } = getBorderBoxSize(/** @type {HTMLElement} */ (layer));
    if (tree.add(layer, depth, frameOf(layer, frames), width, height)) {
      planed.add(layer);
    }
  }
  tree.build();
  const { pieces, nodes } = tree;
  /** @type {Map<Element, number>} */
  const piecesOf = new Map();
  let mostHalfPlanes = 0;
  for (const piece of pieces) {
    piecesOf.set(piece.layer, (piecesOf.get(piece.layer) ?? 0) + 1);
    mostHalfPlanes = Math.max(mostHalfPlanes, piece.halfPlanes.length);
  }

  const nested = layerRoots.length - 1;
  const breaks = 2 * nested;
  let twoBatches = 0;
  let oneBatch = 0;
  let deepestLayer = 0;
  /**
   * Each layer's run in the one batch, level by level: whether it has
   * quads there, the size classes of its runs there, and whether a picture
   * or a shape breaks it there.
   *
   * @type {Map<Element, Step[]>}
   */
  const runOf = new Map();
  for (const [layer, counts] of perLayer) {
    const times = piecesOf.get(layer) ?? 1;
    let textDraws = 0;
    for (const sizes of counts.runLevels.values()) {
      textDraws += sizes.size;
    }
    twoBatches += times * (counts.boxLevels.size + textDraws + counts.own);
    const quadLevels = new Set([...counts.boxLevels, ...counts.runLevels.keys()]);
    const all = [...new Set([...quadLevels, ...counts.ownLevels])].sort((a, b) => a - b);
    const run = all.map((level) => ({
      quads: quadLevels.has(level),
      sizes: counts.runLevels.get(level) ?? new Set(),
      own: counts.ownLevels.has(level),
    }));
    runOf.set(layer, run);
    oneBatch += times * (segments(run) + counts.own);
    deepestLayer = Math.max(deepestLayer, all.length === 0 ? 0 : all[all.length - 1] + 1);
  }

  // One batch again, with the layers that share a node drawn as one run
  // in paint order, the first layer's instances then the next's: a draw
  // breaks only at a picture or a shape, or where the pieces' half-planes
  // change, since a draw's half-planes are its uniforms. A layer with no
  // plane is drawn whole, in a node of its own.
  /** @type {Map<number, { layer: Element, piece: Polygon | null }[]>} */
  const byNode = new Map();
  for (const piece of pieces) {
    let members = byNode.get(piece.node);
    if (!members) {
      members = [];
      byNode.set(piece.node, members);
    }
    members.push({ layer: piece.layer, piece });
  }
  for (const layer of layerRoots) {
    if (!planed.has(layer)) {
      byNode.set(-byNode.size - 1, [{ layer, piece: null }]);
    }
  }
  let oneBatchByNode = 0;
  for (const members of byNode.values()) {
    members.sort((a, b) => comparePaintOrder(a.layer, b.layer));
    /** @type {Step[]} */
    let run = [];
    let previous = members[0].piece;
    for (const member of members) {
      if (previous && member.piece && !sameHalfPlanes(previous, member.piece)) {
        oneBatchByNode += segments(run);
        run = [];
      }
      previous = member.piece;
      run.push(...(runOf.get(member.layer) ?? []));
      oneBatchByNode += perLayer.get(member.layer)?.own ?? 0;
    }
    oneBatchByNode += segments(run);
  }

  return {
    entries: entries.length,
    kinds,
    layers: layerRoots.length,
    // A layer with no plane to give is drawn whole, as one piece.
    pieces: pieces.length + layerRoots.length - planed.size,
    nodes,
    mostHalfPlanes,
    breaks,
    deepestLayer,
    runs: kinds.run,
    classes: classes.size,
    twoBatches,
    oneBatch,
    oneBatchByNode,
  };
}

/**
 * One level of a layer's run in the one batch.
 *
 * @typedef {object} Step
 * @property {boolean} quads Whether it draws boxes or runs.
 * @property {Set<string>} sizes The size classes of its runs.
 * @property {boolean} own Whether a picture or a shape breaks the run there.
 */

/**
 * How many draws of quads a run takes: one for each stretch that a picture
 * or a shape does not break, and one more each time a stretch's runs need
 * an array past the `ARRAYS_PER_DRAW` its draw already samples. Within a
 * level any order is right, so a draw may end anywhere in one.
 *
 * @param {Step[]} run
 * @returns {number}
 */
function segments(run) {
  let draws = 0;
  let open = false;
  /** @type {Set<string>} */
  let arrays = new Set();
  for (const step of run) {
    if (step.quads && !open) {
      draws += 1;
      open = true;
      arrays = new Set();
    }
    for (const size of step.sizes) {
      if (!arrays.has(size)) {
        if (arrays.size === ARRAYS_PER_DRAW) {
          draws += 1;
          arrays = new Set();
        }
        arrays.add(size);
      }
    }
    if (step.own) {
      open = false;
    }
  }
  return draws;
}

/**
 * Counts added up, for a look or an app made of several panels. The most
 * half-planes and the deepest layer are the most of any panel.
 *
 * @param {PanelCount[]} counts
 * @returns {PanelCount}
 */
export function sumCounts(counts) {
  /** @type {PanelCount} */
  const sum = {
    entries: 0,
    kinds: { box: 0, run: 0, picture: 0, shape: 0 },
    layers: 0,
    pieces: 0,
    nodes: 0,
    mostHalfPlanes: 0,
    breaks: 0,
    deepestLayer: 0,
    runs: 0,
    classes: 0,
    twoBatches: 0,
    oneBatch: 0,
    oneBatchByNode: 0,
  };
  for (const count of counts) {
    sum.entries += count.entries;
    for (const kind of /** @type {Kind[]} */ (["box", "run", "picture", "shape"])) {
      sum.kinds[kind] += count.kinds[kind];
    }
    sum.layers += count.layers;
    sum.pieces += count.pieces;
    sum.nodes += count.nodes;
    sum.mostHalfPlanes = Math.max(sum.mostHalfPlanes, count.mostHalfPlanes);
    sum.breaks += count.breaks;
    sum.deepestLayer = Math.max(sum.deepestLayer, count.deepestLayer);
    sum.runs += count.runs;
    sum.classes += count.classes;
    sum.twoBatches += count.twoBatches;
    sum.oneBatch += count.oneBatch;
    sum.oneBatchByNode += count.oneBatchByNode;
  }
  return sum;
}

/** The columns `formatCounts` prints, in order. */
const COLUMNS = /** @type {const} */ ([
  ["boxes", (/** @type {PanelCount} */ c) => c.kinds.box],
  ["runs", (/** @type {PanelCount} */ c) => c.runs],
  ["classes", (/** @type {PanelCount} */ c) => c.classes],
  ["pics", (/** @type {PanelCount} */ c) => c.kinds.picture],
  ["shapes", (/** @type {PanelCount} */ c) => c.kinds.shape],
  ["layers", (/** @type {PanelCount} */ c) => c.layers],
  ["pieces", (/** @type {PanelCount} */ c) => c.pieces],
  ["nodes", (/** @type {PanelCount} */ c) => c.nodes],
  ["max hp", (/** @type {PanelCount} */ c) => c.mostHalfPlanes],
  ["breaks", (/** @type {PanelCount} */ c) => c.breaks],
  ["levels", (/** @type {PanelCount} */ c) => c.deepestLayer],
  ["two", (/** @type {PanelCount} */ c) => c.twoBatches],
  ["one", (/** @type {PanelCount} */ c) => c.oneBatch],
  ["by node", (/** @type {PanelCount} */ c) => c.oneBatchByNode],
]);

/**
 * A Markdown table of named counts, the form the plan file takes them in.
 *
 * @param {[string, PanelCount][]} rows
 * @returns {string}
 */
export function formatCounts(rows) {
  const head = ["panel", ...COLUMNS.map(([name]) => name)];
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`];
  for (const [name, count] of rows) {
    const cells = [name, ...COLUMNS.map(([, read]) => String(read(count)))];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}
