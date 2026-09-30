import * as THREE from "three";
import { Derived, effects, flatMap, just, Stream, use } from "@apendua/signal";
import { getChildNodes, getComputedStyleCached } from "../elements/mirror.js";
import { isSvgElement } from "../elements/plugins.js";
import {
  IDENTITY,
  matrixEqual,
  multiply,
  parsePreserveAspectRatio,
  parseViewBox,
  translation,
  viewportMatrix,
} from "./geometry.js";
import { image } from "./image.js";
import {
  findMarker,
  MARKABLE_TAGS,
  markerMatrix,
  markerVertices,
  parseMarkerReference,
  readMarkerSpec,
} from "./marker.js";
import {
  chainEqual,
  commitMatrix,
  group,
  localMatrix,
  paintSlot,
  readChain,
  readDrawnProperty,
  viewportSize,
  shape,
  SHAPE_TAGS,
} from "./shape.js";
import { parseLengthIn, readProperty } from "./style.js";

/**
 * Templates: SVG content defined in one place and drawn in others. A
 * `<marker>` sits in a `<defs>`, which the portal builds nothing for, and is
 * drawn at the vertices of every path that names it.
 *
 * A copy of a template's content is an `Instance`. Its elements are drawn by
 * the same `shape`, `group` and `image` as the rest of the SVG, each told
 * the instance. Their chains stop at the template and continue from where
 * the instance is drawn, so a marker is placed by one matrix on one object,
 * and a path that moves moves its markers without rebuilding them.
 *
 * The portal adopts a template's nodes into its mirror without building
 * them, so an edit inside a `<marker>` reaches every copy of it.
 *
 * @import {EntityEffect, Source, Subscribable} from '@apendua/signal';
 * @import {Instance, ShapeHost} from './shape.js';
 * @import {MarkerVertex} from './marker.js';
 */

/** Elements that only group, inside a template as outside one. */
const GROUP_TAGS = new Set(["g", "a", "switch", "svg"]);

/**
 * How deep instances may nest: a `<use>` of a symbol that holds a `<use>`,
 * a marker on a path inside a marker. Deep enough for any real drawing, and
 * what stops one that ends up drawing itself.
 */
const MAX_DEPTH = 8;

/**
 * Keep `source`'s object a child of `parent` for as long as the surrounding
 * computation stands.
 *
 * @param {THREE.Object3D} parent
 * @param {Subscribable<THREE.Object3D>} source
 * @returns {void}
 */
function mountInto(parent, source) {
  use(
    flatMap(
      (/** @type {THREE.Object3D} */ child) =>
        new Stream(() => {
          parent.add(child);
          return () => {
            parent.remove(child);
          };
        }),
    )(source),
  );
}

/**
 * Draw the element children of `parent`, a template or an element inside
 * one, into the object this effect runs on. It follows `parent`'s child
 * list, so a shape added to a `<marker>` appears in every copy of it.
 *
 * @param {WeakKey} ctx
 * @param {Element} parent
 * @param {Instance} instance
 * @returns {EntityEffect<THREE.Object3D>}
 */
function templateChildren(ctx, parent, instance) {
  return effects((obj) => {
    for (const node of getChildNodes(parent)) {
      if (!isSvgElement(node)) {
        continue;
      }
      const source = drawInstanced(ctx, /** @type {Element} */ (node), instance);
      if (source) {
        mountInto(obj, source);
      }
    }
  });
}

/**
 * One element of a template's content, drawn as part of an instance, or
 * null for one that draws nothing.
 *
 * @param {WeakKey} ctx
 * @param {Element} element
 * @param {Instance} instance
 * @returns {Source<THREE.Object3D> | null}
 */
function drawInstanced(ctx, element, instance) {
  if (GROUP_TAGS.has(element.localName)) {
    return group(ctx, element, [templateChildren(ctx, element, instance)]);
  }
  if (SHAPE_TAGS.has(element.localName)) {
    return drawShape(ctx, element, instance);
  }
  if (element.localName === "image") {
    return image(ctx, element, instance);
  }
  if (element.localName === "use") {
    return drawUse(ctx, element, instance);
  }
  return null;
}

/**
 * @param {MarkerVertex[]} a
 * @param {MarkerVertex[]} b
 * @returns {boolean}
 */
function verticesEqual(a, b) {
  return (
    a.length === b.length &&
    a.every(
      (vertex, index) =>
        vertex.x === b[index].x &&
        vertex.y === b[index].y &&
        vertex.angle === b[index].angle &&
        vertex.position === b[index].position,
    )
  );
}

/**
 * Which `<marker>` is drawn at which vertex.
 *
 * @typedef {object} MarkerPlacement
 * @property {Element} marker
 * @property {number} index The vertex's place in the path's vertex list.
 */

/**
 * @param {MarkerPlacement[]} a
 * @param {MarkerPlacement[]} b
 * @returns {boolean}
 */
function placementsEqual(a, b) {
  return (
    a.length === b.length &&
    a.every((placement, i) => placement.marker === b[i].marker && placement.index === b[i].index)
  );
}

/**
 * The markers on a shape: one object per vertex that has a marker, each
 * carrying that marker's matrix, with a copy of the marker's content below
 * it.
 *
 * Which markers go where is rebuilt only when the list of them changes: a
 * new `marker-*`, or a path with a different number of vertices. A path
 * whose vertices move, a stroke width animated, an edited `refX` are a
 * matrix write on each copy.
 *
 * @param {WeakKey} ctx
 * @param {Element} element
 * @param {ShapeHost} host
 * @param {Instance | null} hostInstance The instance the shape is part of.
 * @returns {EntityEffect<THREE.Object3D>}
 */
function markers(ctx, element, host, hostInstance) {
  /** @param {string} name */
  const named = (name) => findMarker(element, parseMarkerReference(host.read(name)));

  const referenced = new Derived(
    () => ({ start: named("marker-start"), mid: named("marker-mid"), end: named("marker-end") }),
    { isEqual: (a, b) => a.start === b.start && a.mid === b.mid && a.end === b.end },
  );

  const vertices = new Derived(
    () => {
      const current = referenced.get();
      const path = current.start || current.mid || current.end ? host.path() : null;
      return path ? markerVertices(path) : [];
    },
    { isEqual: verticesEqual },
  );

  const placements = new Derived(
    () => {
      const current = referenced.get();
      /** @type {MarkerPlacement[]} */
      const list = [];
      vertices.get().forEach((vertex, index) => {
        const marker = current[vertex.position];
        if (marker) {
          list.push({ marker, index });
        }
      });
      return list;
    },
    { isEqual: placementsEqual },
  );

  return effects((obj) => {
    const depth = (hostInstance?.depth ?? 0) + 1;
    if (depth > MAX_DEPTH) {
      return;
    }
    for (const { marker, index } of placements.get()) {
      const matrix = new Derived(
        () => {
          // The marker's attributes are not CSS, but its computed style is
          // what the mirror invalidates when one of them changes.
          getComputedStyleCached(marker);
          const vertex = vertices.get()[index];
          return vertex
            ? markerMatrix(readMarkerSpec(marker), vertex, host.strokeWidth())
            : IDENTITY;
        },
        { isEqual: matrixEqual },
      );
      /** @type {Instance} */
      const instance = {
        template: marker,
        chain: () => {
          const at = host.chain();
          return { ctm: multiply(at.ctm, matrix.get()), opacity: at.opacity, root: at.root };
        },
        slot: host.markerSlot,
        // A marker's content inherits from where the marker is defined, not
        // from the path it is drawn on.
        inherit: null,
        depth,
      };
      mountInto(
        obj,
        just(new THREE.Object3D(), [
          effects((copy) => {
            commitMatrix(copy, matrix.get());
          }),
          templateChildren(ctx, marker, instance),
        ]),
      );
    }
  });
}

/**
 * A shape, with the markers its `marker-*` properties name when it is one
 * that takes them.
 *
 * @param {WeakKey} ctx
 * @param {Element} element
 * @param {Instance | null} [instance]
 * @returns {Source<THREE.Object3D>}
 */
export function drawShape(ctx, element, instance = null) {
  return shape(ctx, element, {
    instance,
    decorate: MARKABLE_TAGS.has(element.localName)
      ? (host) => [markers(ctx, element, host, instance)]
      : undefined,
  });
}

/** The legacy namespace of `xlink:href`. */
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/**
 * The element a `<use>` draws, or null for none: a missing id, a reference
 * to another document, and a reference to the `<use>` itself or to anything
 * around it, which would draw forever.
 *
 * @param {Element} use
 * @returns {Element | null}
 */
export function findReferenced(use) {
  const href = use.getAttribute("href") ?? use.getAttributeNS(XLINK_NAMESPACE, "href") ?? "";
  if (!href.startsWith("#") || href.length < 2) {
    return null;
  }
  const found = use.ownerDocument.getElementById(href.slice(1));
  if (!found || !isSvgElement(found) || found.contains(use)) {
    return null;
  }
  return found;
}

/**
 * The viewport size a `<use>` gives a `<symbol>`: its own `width` and
 * `height`, or the symbol's, or the whole of the nearest viewport, which is
 * what the initial `100%` comes to. A percentage is of that viewport too.
 * Null when none of them says, and the symbol's content is drawn in its own
 * units.
 *
 * @param {Element} use
 * @param {Element} symbol
 * @returns {{ width: number, height: number } | null}
 */
function symbolViewport(use, symbol) {
  const style = getComputedStyleCached(use);
  const viewport = viewportSize(use);
  /**
   * @param {"width" | "height"} name
   */
  const size = (name) => {
    const own = parseLengthIn(readProperty(style, use, name), viewport?.[name], Number.NaN);
    if (!Number.isNaN(own)) {
      return own;
    }
    const symbols = parseLengthIn(symbol.getAttribute(name) ?? "", viewport?.[name], Number.NaN);
    if (!Number.isNaN(symbols)) {
      return symbols;
    }
    return viewport ? viewport[name] : Number.NaN;
  };
  const width = size("width");
  const height = size("height");
  return Number.isNaN(width) || Number.isNaN(height) ? null : { width, height };
}

/**
 * A `<use>`: a copy of the element its `href` names, drawn at its `x`, `y`.
 *
 * The `<use>`'s object carries its own `transform`. Below it, one object
 * carries the move to `x`, `y` and, for a `<symbol>`, the symbol's viewport,
 * and the copy is drawn below that as an instance. A `<symbol>` is a
 * template whose children are drawn; anything else, a `<g>` or a `<path>`
 * drawn once already where it stands, is drawn whole.
 *
 * The copy inherits from the `<use>`, as a browser's clone does, through
 * `readDrawnProperty`. It follows edits to the referenced content, since the
 * mirror follows that content wherever it is. It is drawn and never hit, as
 * a marker is. Not followed: an `href` changed after the copy was made,
 * which the portal's observer does not watch.
 *
 * @param {WeakKey} ctx
 * @param {Element} element
 * @param {Instance | null} [instance] The instance the `<use>` is part of.
 * @returns {Source<THREE.Object3D>}
 */
export function drawUse(ctx, element, instance = null) {
  const style = () => getComputedStyleCached(element);
  const own = new Derived(() => localMatrix(element), { isEqual: matrixEqual });
  const chain = new Derived(() => readChain(element, instance), { isEqual: chainEqual });
  const referenced = new Derived(() => {
    // Read for the invalidation: a `<use>` restyled is a reason to look
    // again.
    style();
    return findReferenced(element);
  });

  return just(new THREE.Object3D(), [
    effects((obj) => {
      commitMatrix(obj, own.get());
    }),
    effects((obj) => {
      obj.visible = style().display !== "none";
    }),
    effects((obj) => {
      const target = referenced.get();
      const depth = (instance?.depth ?? 0) + 1;
      if (!target || depth > MAX_DEPTH) {
        return;
      }
      const isSymbol = target.localName === "symbol";
      const placement = new Derived(
        () => {
          const current = style();
          const viewport = viewportSize(element);
          const x = parseLengthIn(readProperty(current, element, "x"), viewport?.width, 0);
          const y = parseLengthIn(readProperty(current, element, "y"), viewport?.height, 0);
          const moved = translation(x, y);
          if (!isSymbol) {
            return moved;
          }
          // The symbol's attributes are not CSS; its computed style is what
          // the mirror invalidates when one of them changes.
          getComputedStyleCached(target);
          const size = symbolViewport(element, target);
          return size
            ? multiply(
                moved,
                viewportMatrix(
                  parseViewBox(target.getAttribute("viewBox")),
                  parsePreserveAspectRatio(target.getAttribute("preserveAspectRatio")),
                  size.width,
                  size.height,
                ),
              )
            : moved;
        },
        { isEqual: matrixEqual },
      );
      /** @type {Instance} */
      const copy = {
        template: isSymbol ? target : /** @type {Element} */ (target.parentElement),
        chain: () => {
          const at = chain.get();
          return { ctm: multiply(at.ctm, placement.get()), opacity: at.opacity, root: at.root };
        },
        slot: () => paintSlot(element, chain.get().root, instance, 0),
        inherit: {
          boundary: /** @type {Element} */ (target.parentElement),
          read: (name) => readDrawnProperty(element, name, instance),
        },
        depth,
      };
      /** @type {EntityEffect<THREE.Object3D>[]} */
      const content = [];
      if (isSymbol) {
        content.push(templateChildren(ctx, target, copy));
      } else {
        const drawn = drawInstanced(ctx, target, copy);
        if (drawn) {
          content.push((/** @type {THREE.Object3D} */ placed) => {
            mountInto(placed, drawn);
          });
        }
      }
      mountInto(
        obj,
        just(new THREE.Object3D(), [
          effects((placed) => {
            commitMatrix(placed, placement.get());
          }),
          ...content,
        ]),
      );
    }),
  ]);
}
