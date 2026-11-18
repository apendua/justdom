/**
 * `data-xr-name`: an element's name, given to every object a panel draws
 * it with, so that a scene can be searched for an element the way it is
 * searched for any object, with `getObjectByName`.
 *
 * What an element is drawn with is its node's object (the one the portal
 * maps back to it) and everything under that object that is not some
 * other node's: its quad, the blocker an overlay puts behind itself, a
 * control's own marks (a tick, a caret, a list marker) and its `::before`
 * and `::after`, which are its own painting and carry no attributes of
 * their own. Two kinds of object below it are left alone: its content
 * group, which holds its child nodes, and the objects of those child nodes,
 * text nodes included, which answer for themselves.
 *
 * The node's object is the first of them in any walk of the scene, since
 * the others are under it, so `getObjectByName` finds that one, and a ray
 * that hits a part finds the name on the mesh it hit.
 *
 * A part can be mounted and taken off long after the node was built: a
 * quad goes while a box has neither a colour nor a ray to take, and a
 * `::before` comes and goes with its rule. So a named node's parts are
 * followed through three's `childadded` and `childremoved` events: what
 * arrives under a part takes the name, and what leaves gets its own name
 * back, so that a part mounted again later finds the name as it is then.
 * A node with no name costs one `getAttribute` when it is built and
 * nothing after that.
 */

import { objectNodes } from "../../drawOrder.js";
import { getContentGroup } from "../contentGroup.js";

/**
 * @import {Object3D, Object3DEventMap} from 'three';
 */

/** The attribute an element is named by. */
export const NAME_ATTRIBUTE = "data-xr-name";

/**
 * The name each named node's object is carrying, by that object.
 *
 * @type {WeakMap<Object3D, string>}
 */
const rootNames = new WeakMap();

/**
 * The node's object each named part belongs to, the node's object itself
 * included.
 *
 * @type {WeakMap<Object3D, Object3D>}
 */
const owners = new WeakMap();

/**
 * The name each named part had before it was named, to give back: a
 * `::before`'s quad is called `::before` when its element has no name.
 *
 * @type {WeakMap<Object3D, string>}
 */
const ownNames = new WeakMap();

/**
 * Whether `object`, found under `root`, is something other than `root`'s
 * own painting: its content group, or another node's object.
 *
 * @param {Object3D} root
 * @param {Object3D} object
 * @returns {boolean}
 */
function isElsewhere(root, object) {
  return object !== root && (object === getContentGroup(root) || objectNodes.has(object));
}

/**
 * Give `name` to `object` and to every part below it.
 *
 * @param {Object3D} object
 * @param {Object3D} root
 * @param {string} name
 * @returns {void}
 */
function claim(object, root, name) {
  if (!ownNames.has(object)) {
    ownNames.set(object, object.name);
    object.addEventListener("childadded", onChildAdded);
    object.addEventListener("childremoved", onChildRemoved);
  }
  owners.set(object, root);
  object.name = name;
  for (const child of object.children) {
    if (!isElsewhere(root, child)) {
      claim(child, root, name);
    }
  }
}

/**
 * Give `object`, and every part below it that `claim` named, its own name
 * back, and stop following it.
 *
 * @param {Object3D} object
 * @param {Object3D} root
 * @returns {void}
 */
function release(object, root) {
  const own = ownNames.get(object);
  if (own === undefined) {
    return;
  }
  object.name = own;
  ownNames.delete(object);
  owners.delete(object);
  object.removeEventListener("childadded", onChildAdded);
  object.removeEventListener("childremoved", onChildRemoved);
  for (const child of object.children) {
    if (!isElsewhere(root, child)) {
      release(child, root);
    }
  }
}

/**
 * @param {Object3DEventMap["childadded"] & { target: Object3D }} event
 * @returns {void}
 */
function onChildAdded({ target, child }) {
  const root = owners.get(target);
  const name = root && rootNames.get(root);
  if (root && name !== undefined && !isElsewhere(root, child)) {
    claim(child, root, name);
  }
}

/**
 * @param {Object3DEventMap["childremoved"] & { target: Object3D }} event
 * @returns {void}
 */
function onChildRemoved({ target, child }) {
  const root = owners.get(target);
  if (root && !isElsewhere(root, child)) {
    release(child, root);
  }
}

/**
 * Name a node's object and its parts `name`, or, given null, give them
 * back the names they had. Called by the portal as it builds an element's
 * object, and again whenever the attribute changes.
 *
 * @param {Object3D} root The node's object.
 * @param {string | null} name The element's `data-xr-name`.
 * @returns {void}
 */
export function nameNodeObjects(root, name) {
  const was = rootNames.get(root);
  if (name === null) {
    if (was !== undefined) {
      rootNames.delete(root);
      release(root, root);
    }
    return;
  }
  if (was === name) {
    return;
  }
  rootNames.set(root, name);
  claim(root, root, name);
}
