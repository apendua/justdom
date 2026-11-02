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
