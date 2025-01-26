/**
 * @typedef {Node & { parentNode: ParentNode }} NodeWithParent
 */

/**
 * @param {[Node, Node]} segment
 * @returns {asserts segment is [NodeWithParent, NodeWithParent]}
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
 * @param {Node} newNode
 * @param {NodeWithParent} oldNode
 * @returns {Node}
 */
function replaceNode(newNode, oldNode) {
  return oldNode.parentNode.replaceChild(newNode, oldNode);
}

/**
 * @param {Node | null} newNode
 * @param {[Node, Node]} segment
 * @returns {[Node, Node]}
 */
export function replaceSegment(newNode, segment) {
  assertValidSegment(segment);
  /** @type {Node | null} */
  let node = segment[0].nextSibling;
  while (node && node !== segment[1].nextSibling) {
    /** @type {Node | null} */
    const next = node.nextSibling;
    node.parentNode?.removeChild(node);
    node = next;
  }
  if (newNode instanceof DocumentFragment) {
    const { firstChild, lastChild } = newNode;
    console.log("REPLACE SEGMENT", segment, newNode, firstChild, lastChild);
    if (!firstChild || !lastChild) {
      return toSegment(replaceNode(document.createComment(""), segment[0]));
    }
    replaceNode(newNode, segment[0]);
    return encloseSegment([firstChild, lastChild]);
  }
  if (newNode) {
    return toSegment(replaceNode(newNode, segment[0]));
  }
  return toSegment(replaceNode(document.createComment(""), segment[0]));
}

/**
 * @param {[Node, Node]} segment
 */
export function removeSegment(segment) {
  console.log("REMOVE SEGMENT", segment);
  assertValidSegment(segment);
  /** @type {Node | null} */
  let node = segment[0];
  while (node && node !== segment[1].nextSibling) {
    /** @type {Node | null} */
    const next = node.nextSibling;
    node.parentNode?.removeChild(node);
    node = next;
  }
}

/**
 * @param {[Node, Node]} segment
 * @returns {[Node, Node]}
 */
export function encloseSegment(segment) {
  assertValidSegment(segment);
  return [
    segment[0].parentNode.insertBefore(document.createComment(""), segment[0]),
    segment[1].parentNode.insertBefore(
      document.createComment(""),
      segment[1].nextSibling,
    ),
  ];
}

/**
 * @param {Node} node
 * @returns {[Node, Node]}
 */
export function toSegment(node) {
  return [node, node];
}
