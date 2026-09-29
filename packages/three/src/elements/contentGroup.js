/**
 * @import {Object3D} from 'three';
 */

/**
 * The group that carries an element's projected DOM children, one per box.
 *
 * Its whole purpose is scrolling: children are positioned in their parent's
 * *content* space — coordinates that a scroll does not change — and the
 * group is translated by minus the scroll offset, so a scroll is one
 * position write here instead of a re-measure of everything inside. The
 * portal attaches child objects through `getContentGroup`.
 *
 * This module is apart from `box`, which creates the groups, because the
 * scroll gesture also has to tell a content group from an object, and
 * `box` imports the scroll gesture.
 *
 * @type {WeakMap<Object3D, Object3D>}
 */
const contentGroups = new WeakMap();

/**
 * Where a node's projected children belong under its object: the content
 * group for a box, the object itself for anything that has none (the
 * portal's own container, an SVG `<g>`).
 *
 * @param {Object3D} object
 * @returns {Object3D}
 */
export function getContentGroup(object) {
  return contentGroups.get(object) ?? object;
}

/**
 * Record that `group`, a child of `object`, is where the children of
 * `object`'s element go.
 *
 * @param {Object3D} object
 * @param {Object3D} group
 * @returns {void}
 */
export function setContentGroup(object, group) {
  contentGroups.set(object, group);
}
