/**
 * @import { INode, NodeWithParent, SegmentOf } from './nodes.js';
 */

/**
 * @template {INode<T>} T
 * @param {SegmentOf<T>} segment
 * @returns {asserts segment is [NodeWithParent<T>, NodeWithParent<T>]}
 */
function assertValidSegment(segment) {
  if (!segment[0].parentNode || !segment[1].parentNode) {
    throw new Error("Invalid segment. Both ends must have a parent.");
  }
  if (segment[0].parentNode !== segment[1].parentNode) {
    throw new Error("Invalid segment. Both ends must have the same parent.");
  }
}

/**
 * @template {INode<T>} T
 * @param {SegmentOf<T>} newSegment
 * @param {SegmentOf<T>} oldSegment
 * @returns {SegmentOf<T>}
 */
export function replaceSegment(newSegment, oldSegment) {
  assertValidSegment(oldSegment);
  const { parentNode } = oldSegment[0];
  /** @type {T | null} */
  let node = oldSegment[0].nextSibling;
  while (node && node !== oldSegment[1].nextSibling) {
    /** @type {T | null} */
    const next = node.nextSibling;
    parentNode.removeChild(node);
    node = next;
  }
  node = newSegment[0];
  while (node && node !== newSegment[1]) {
    /** @type {T | null} */
    const next = node.nextSibling;
    parentNode.insertBefore(node, oldSegment[0]);
    node = next;
  }
  parentNode.replaceChild(newSegment[1], oldSegment[0]);
  return newSegment;
}

/**
 * Moves the nodes of `segment` into `parent`, in front of `before`, or to its
 * end when `before` is `null`, keeping their order.
 *
 * @template {INode<T>} T
 * @param {SegmentOf<T>} segment
 * @param {T} parent
 * @param {T | null} before
 * @returns {SegmentOf<T>}
 */
export function insertSegment(segment, parent, before) {
  /** @type {T | null} */
  let node = segment[0];
  while (node) {
    /** @type {T | null} */
    const next = node === segment[1] ? null : node.nextSibling;
    parent.insertBefore(node, before);
    node = next;
  }
  return segment;
}

/**
 * @template {INode<T>} T
 * @param {SegmentOf<T>} segment
 */
export function removeSegment(segment) {
  assertValidSegment(segment);
  const endNode = segment[1].nextSibling;
  /** @type {T | null} */
  let node = segment[0];
  while (node) {
    /** @type {T | null} */
    const next = node.nextSibling;
    node.parentNode?.removeChild(node);
    node = next;
    if (node === endNode) {
      break;
    }
  }
}

/**
 * @template {INode<T>} T
 * @param {T} node
 * @returns {SegmentOf<T>}
 */
export function toSegment(node) {
  return [node, node];
}

/**
 * A node that is on its way out of the tree together with everything under
 * it, while what is mounted inside it is being taken down. `null` the rest
 * of the time.
 *
 * Whoever removes a segment unsubscribes what is mounted in it first, and
 * each of those mountings removes its own segment in turn. Left alone, a
 * subtree leaves one node at a time, from the leaves up: a table row of
 * eight elements was eight `removeChild` calls, where removing the row is
 * enough. So while a single node is being released, `unmountSegment` names
 * it here, and a segment found under it stays where it is and leaves with
 * its ancestor.
 *
 * So the nodes under a removed root stay attached to each other. For an
 * element `$()` made nobody can tell. A node the caller owns, mounted in
 * such a subtree, used to end up empty and with no parent, and now keeps
 * its children and its place under the removed root. Mounting it again
 * through `children()` replaces what it holds.
 *
 * The test is containment, by walking up from the segment, and not a bare
 * "something is leaving". A mounting torn down inside a leaving subtree can
 * own nodes elsewhere, a dialog it put on `document.body`, and those still
 * have to be removed.
 *
 * @type {unknown}
 */
let leavingAncestor = null;

/**
 * @template {INode<T>} T
 * @param {T} node
 * @returns {boolean}
 */
function isLeaving(node) {
  if (leavingAncestor === null) {
    return false;
  }
  /** @type {T | null} */
  let current = node;
  while (current) {
    if (current === leavingAncestor) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * Runs `release`, which takes down what is mounted in `segment`, with the
 * segment marked as leaving, so that nothing inside it is removed node by
 * node. Only a segment of one node can be marked. Inside a longer one, a list
 * with its envelope say, each mounting removes its own nodes as before,
 * unless an ancestor further up is already leaving.
 *
 * For a caller whose segment is already out of the tree, or is about to be
 * removed by other means. `unmountSegment` is the usual entry.
 *
 * @template {INode<T>} T
 * @param {SegmentOf<T>} segment
 * @param {() => void} release
 * @returns {void}
 */
export function releaseLeaving(segment, release) {
  if (segment[0] !== segment[1]) {
    release();
    return;
  }
  const previous = leavingAncestor;
  leavingAncestor = segment[0];
  try {
    release();
  } finally {
    leavingAncestor = previous;
  }
}

/**
 * Takes down what is mounted in `segment` and then removes its nodes, in
 * that order: a mounting is let go of before its nodes come out of the tree.
 *
 * Two kinds of segment are released and not removed:
 *
 * - One under an ancestor that is itself leaving. It goes when the ancestor
 *   does.
 * - One that is out of the tree already. Nodes are taken out by whoever
 *   gets to them first, and that is not always the mounting that put them
 *   in: a list removes the nodes of an item that left before it lets the
 *   item go, and those of a longer item come out one by one, so what the
 *   item mounted inside finds its own nodes loose. A failure travelling up
 *   takes the tree down from the top while the mounting that failed is
 *   still closing. A second `children()` on one element replaces what the
 *   first put there. The mounting still has to be let go of, and has
 *   nothing left to remove.
 *
 * This covers taking a mounting down, and nothing else. A mounting that is
 * still up and updates after its nodes were taken out, a child of the
 * first `children()` that emits again after the second replaced it, still
 * fails with `Invalid segment`: it has nowhere to put what it emitted.
 *
 * @template {INode<T>} T
 * @param {SegmentOf<T>} segment
 * @param {() => void} release
 * @returns {void}
 */
export function unmountSegment(segment, release) {
  const leaving = isLeaving(segment[0]);
  try {
    releaseLeaving(segment, release);
  } finally {
    // Also when a cleanup threw: the nodes come out all the same, and a
    // node that was named as leaving does leave.
    if (!leaving && segment[0].parentNode) {
      removeSegment(segment);
    }
  }
}
