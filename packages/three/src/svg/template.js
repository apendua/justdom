import * as THREE from "three";
import { Derived, effects, flatMap, just, Stream, use } from "@apendua/signal";
import { getAttributeCached, getChildNodes, getComputedStyleCached } from "../elements/mirror.js";
import { findSvgElement, isSvgElement } from "../elements/plugins.js";
import {
  IDENTITY,
  intersectRects,
  matrixEqual,
  multiply,
  parsePreserveAspectRatio,
  parseViewBox,
  rectEqual,
  transformRect,
  translation,
  viewportMatrix,
} from "./geometry.js";
import { image } from "./image.js";
import { drawText } from "./text.js";
import {
  MARKABLE_TAGS,
  markerFrame,
  markerMatrix,
  markerVertices,
  readMarkerSpec,
} from "./marker.js";
import {
  chainEqual,
  commitMatrix,
  group,
  localMatrix,
  nearestViewBoxOrigin,
  paintSlot,
  readChain,
  readClipRect,
  readDrawnProperty,
  viewportSize,
  shape,
  SHAPE_TAGS,
} from "./shape.js";
import {
  clipsViewport,
  parseLengthIn,
  parseNumber,
  parseUrlReference,
  readProperty,
} from "./style.js";

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
 * @import {Rect} from './geometry.js';
 */

/** Elements that only group, inside a template as outside one. */
const GROUP_TAGS = new Set(["g", "a", "switch", "svg"]);

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
    return group(ctx, element, {
      instance,
      decorate: [templateChildren(ctx, element, instance)],
    });
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
  if (element.localName === "text") {
    return drawText(ctx, element, instance);
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
  const expanding = hostInstance?.expanding ?? new Set();
  /** @param {string} name */
  const named = (name) => {
    const marker = findSvgElement(element, parseUrlReference(host.read(name)), "marker");
    // A `<defs>` later in the panel than this path, or in another `<svg>`
    // in it, is not in the mirror yet. What is read of it now is read again
    // once the portal's walk adopts it (`readRecordOf` in `mirror.js`). One
    // outside the panel is not this portal's to follow, and stays as read.
    return !marker || expanding.has(marker) ? null : marker;
  };

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
    for (const { marker, index } of placements.get()) {
      const matrix = new Derived(
        () => {
          const vertex = vertices.get()[index];
          return vertex
            ? markerMatrix(readMarkerSpec(marker), vertex, host.strokeWidth())
            : IDENTITY;
        },
        { isEqual: matrixEqual },
      );
      /**
       * What the marker clips its content to, in its box's frame, as the
       * matrix from the box to the path's user space and the rect there:
       * the box itself when its `overflow` clips, and what its own
       * `clip-path` leaves, which is in that frame as a nested `<svg>`'s is
       * in the space its `x` and `y` are in. Null when neither clips.
       */
      const box = new Derived(
        () => {
          const style = getComputedStyleCached(marker);
          const vertex = vertices.get()[index];
          if (!vertex) {
            return null;
          }
          const spec = readMarkerSpec(marker);
          const rect = intersectRects(
            clipsViewport(style.overflow)
              ? { left: 0, top: 0, right: spec.width, bottom: spec.height }
              : null,
            readClipRect(marker, style, hostInstance, spec),
          );
          return rect ? { frame: markerFrame(spec, vertex, host.strokeWidth()), rect } : null;
        },
        {
          isEqual: (a, b) =>
            a === b || (!!a && !!b && matrixEqual(a.frame, b.frame) && rectEqual(a.rect, b.rect)),
        },
      );
      /** @type {Instance} */
      const instance = {
        template: marker,
        chain: () => {
          const at = host.chain();
          const current = box.get();
          return {
            ctm: multiply(at.ctm, matrix.get()),
            // The marker is a container its content is drawn in, so its own
            // opacity fades the copy; the walk stops below it.
            opacity: at.opacity * parseNumber(getComputedStyleCached(marker).opacity, 1),
            root: at.root,
            clip: current
              ? intersectRects(
                  at.clip,
                  transformRect(multiply(at.ctm, current.frame), current.rect),
                )
              : at.clip,
          };
        },
        slot: host.markerSlot,
        viewport: () => {
          const spec = readMarkerSpec(marker);
          return spec.viewBox ?? { width: spec.width, height: spec.height };
        },
        viewBoxOrigin: () => {
          const viewBox = readMarkerSpec(marker).viewBox;
          return { x: viewBox?.x ?? 0, y: viewBox?.y ?? 0 };
        },
        // A marker's content inherits from where the marker is defined, not
        // from the path it is drawn on.
        inherit: null,
        expanding: new Set([...expanding, marker]),
      };
      mountInto(
        obj,
        just(new THREE.Object3D(), [
          effects((copy) => {
            commitMatrix(copy, matrix.get());
          }),
          effects((copy) => {
            copy.visible = !host.hidden();
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

/**
 * The element a `<use>` draws, or null for none: a missing id, a reference
 * to another document, and a reference to the `<use>` itself or to anything
 * around it, which would draw forever.
 *
 * @param {Element} use
 * @returns {Element | null}
 */
export function findReferenced(use) {
  const href = getAttributeCached(use, "href") ?? getAttributeCached(use, "xlink:href") ?? "";
  if (!href.startsWith("#") || href.length < 2) {
    return null;
  }
  const found = findSvgElement(use, href.slice(1));
  return found && !found.contains(use) ? found : null;
}

/**
 * The viewport size a `<use>` gives a `<symbol>` or an `<svg>`: its own
 * `width` and `height`, or the target's, or the whole of the nearest
 * viewport, which is what the initial `100%` comes to. A percentage is of
 * that viewport too. Null when none of them says, and the target's content
 * is drawn in its own units.
 *
 * @param {Element} use
 * @param {Element} symbol
 * @param {Instance | null} instance The instance the `<use>` is part of.
 * @returns {{ width: number, height: number } | null}
 */
function symbolViewport(use, symbol, instance) {
  const style = getComputedStyleCached(use);
  const viewport = viewportSize(use, instance);
  /**
   * @param {"width" | "height"} name
   */
  const size = (name) => {
    const own = parseLengthIn(readProperty(style, use, name), viewport?.[name], Number.NaN);
    if (!Number.isNaN(own)) {
      return own;
    }
    const symbols = parseLengthIn(
      getAttributeCached(symbol, name) ?? "",
      viewport?.[name],
      Number.NaN,
    );
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
 * Where a `<use>` puts its copy: its `x` and `y`, a percentage being of the
 * viewport it stands in.
 *
 * @param {Element} use
 * @param {Instance | null} instance The instance the `<use>` is part of.
 * @returns {[number, number]}
 */
function useOrigin(use, instance) {
  const style = getComputedStyleCached(use);
  const viewport = viewportSize(use, instance);
  return [
    parseLengthIn(readProperty(style, use, "x"), viewport?.width, 0),
    parseLengthIn(readProperty(style, use, "y"), viewport?.height, 0),
  ];
}

/**
 * A `<use>`: a copy of the element its `href` names, drawn at its `x`, `y`.
 *
 * The `<use>`'s object carries its own `transform`. Below it, one object
 * carries the move to `x`, `y` and, for a `<symbol>` or an `<svg>`, the
 * viewport the `<use>` gives it, and the copy is drawn below that as an
 * instance. A `<symbol>` or an `<svg>` is a template whose children are
 * drawn; anything else, a `<g>` or a `<path>` drawn once already where it
 * stands, is drawn whole. The `x`, `y` and `transform` of an `<svg>` target
 * are not followed.
 *
 * The copy inherits from the `<use>`, as a browser's clone does, through
 * `readDrawnProperty`. It follows edits to the referenced content when that
 * content is inside the panel, which is all the portal observes. It is
 * drawn and never hit, as a marker is. A new `href` draws the target it
 * names. Not followed: a target that appears only after the `<use>`
 * mounted, which may be anywhere on the page. The `<use>` looks its target
 * up again when it is restyled.
 *
 * @param {WeakKey} ctx
 * @param {Element} element
 * @param {Instance | null} [instance] The instance the `<use>` is part of.
 * @returns {Source<THREE.Object3D>}
 */
export function drawUse(ctx, element, instance = null) {
  const style = () => getComputedStyleCached(element);
  const own = new Derived(() => localMatrix(element, instance), { isEqual: matrixEqual });
  const chain = new Derived(() => readChain(element, instance), { isEqual: chainEqual });
  const referenced = new Derived(() => {
    // Read for the invalidation: a `<use>` restyled is a reason to look
    // again. A `<symbol>` in a `<defs>` the portal's walk has not reached
    // yet is read again once it does, as a marker is.
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
      const expanding = instance?.expanding ?? new Set();
      if (!target || expanding.has(target)) {
        return;
      }
      // An `<svg>`, a root elsewhere on the page included, is drawn as a
      // `<symbol>` is: its children, in a viewport the `<use>` sizes.
      const isViewport = target.localName === "symbol" || target.localName === "svg";
      /** The target's `viewBox`, how it fits, and the viewport it fills. */
      const frame = new Derived(() => {
        if (!isViewport) {
          return null;
        }
        return {
          viewBox: parseViewBox(getAttributeCached(target, "viewBox")),
          aspect: parsePreserveAspectRatio(getAttributeCached(target, "preserveAspectRatio")),
          size: symbolViewport(element, target, instance),
        };
      });
      const placement = new Derived(
        () => {
          const [x, y] = useOrigin(element, instance);
          const moved = translation(x, y);
          const fit = frame.get();
          return fit?.size
            ? multiply(
                moved,
                viewportMatrix(fit.viewBox, fit.aspect, fit.size.width, fit.size.height),
              )
            : moved;
        },
        { isEqual: matrixEqual },
      );
      /**
       * What the target clips its content to, in the `<use>`'s user space,
       * or null for no clip: its viewport, unless it has no size to clip to
       * or its `overflow` shows what spills out of it, and what its own
       * `clip-path` leaves. The target is drawn as an `<svg>` at the origin
       * of the space the `<use>`'s `x` and `y` move to, so its `clip-path`
       * is in that space, as a nested `<svg>`'s is in the space its own `x`
       * and `y` are in, and is moved by them here. An element other than a
       * symbol or an `<svg>` is drawn whole, and its chain reads its
       * `clip-path`.
       */
      const viewport = new Derived(
        () => {
          if (!isViewport) {
            return null;
          }
          const style = getComputedStyleCached(target);
          const size = frame.get()?.size;
          const [x, y] = useOrigin(element, instance);
          /** @type {Rect | null} */
          let own = null;
          if (size && clipsViewport(style.overflow)) {
            own = { left: x, top: y, right: x + size.width, bottom: y + size.height };
          }
          const clipped = readClipRect(target, style, instance, size ?? null);
          return intersectRects(own, clipped && transformRect(translation(x, y), clipped));
        },
        { isEqual: rectEqual },
      );
      /** @type {Instance} */
      const copy = {
        template: isViewport ? target : /** @type {Element} */ (target.parentElement),
        chain: () => {
          const at = chain.get();
          const rect = viewport.get();
          return {
            ctm: multiply(at.ctm, placement.get()),
            // A `<symbol>` or `<svg>` is a container in the copy, so its own
            // opacity fades it; the walk stops below it. The parent of an
            // element drawn whole is not in the copy, and adds nothing.
            opacity: isViewport
              ? at.opacity * parseNumber(getComputedStyleCached(target).opacity, 1)
              : at.opacity,
            root: at.root,
            clip: rect ? intersectRects(at.clip, transformRect(at.ctm, rect)) : at.clip,
          };
        },
        slot: () => paintSlot(element, chain.get().root, instance, 0),
        viewport: () => {
          const fit = frame.get();
          // Content drawn whole stands where the `<use>` does, in its
          // viewport. A target's `viewBox` sets the units of its own.
          return fit ? (fit.viewBox ?? fit.size) : viewportSize(element, instance);
        },
        viewBoxOrigin: () => {
          const fit = frame.get();
          return fit
            ? { x: fit.viewBox?.x ?? 0, y: fit.viewBox?.y ?? 0 }
            : nearestViewBoxOrigin(element, instance);
        },
        inherit: {
          boundary: /** @type {Element} */ (target.parentElement),
          read: (name) => readDrawnProperty(element, name, instance),
        },
        expanding: new Set([...expanding, target]),
      };
      /** @type {EntityEffect<THREE.Object3D>[]} */
      const content = [];
      if (isViewport) {
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
