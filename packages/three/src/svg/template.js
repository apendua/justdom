import * as THREE from "three";
import { Derived, effects, flatMap, just, Stream, use } from "@apendua/signal";
import { getChildNodes, getComputedStyleCached } from "../elements/mirror.js";
import { isSvgElement, PortalTemplatesContext } from "../elements/plugins.js";
import { IDENTITY, matrixEqual, multiply } from "./geometry.js";
import { image } from "./image.js";
import {
  findMarker,
  MARKABLE_TAGS,
  markerMatrix,
  markerVertices,
  parseMarkerReference,
  readMarkerSpec,
} from "./marker.js";
import { commitMatrix, group, shape, SHAPE_TAGS } from "./shape.js";
import { readProperty } from "./style.js";

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
  const style = () => getComputedStyleCached(element);
  const adopt = PortalTemplatesContext.get(ctx);
  const expanding = hostInstance?.expanding ?? new Set();
  /** @param {string} name */
  const named = (name) => {
    const marker = findMarker(element, parseMarkerReference(readProperty(style(), element, name)));
    if (!marker || expanding.has(marker)) {
      return null;
    }
    // Before anything reads it: a `<defs>` later in the panel than this
    // path, or in another `<svg>` in it, is not in the mirror yet, and a
    // read cached now would never hear an edit inside the marker. One
    // outside the panel is not this portal's to follow, and stays as read.
    adopt(marker);
    return marker;
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
