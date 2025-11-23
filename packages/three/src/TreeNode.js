/**
 * @template T
 */
class TreeNode {
  /** @type {TreeNode<T> | null} */
  #nextSibling = null;

  /** @type {TreeNode<T> | null} */
  #previousSibling = null;

  /** @type {TreeNode<T> | null} */
  #parentNode = null;

  /** @type {TreeNode<T> | null} */
  #firstChild = null;

  /** @type {TreeNode<T> | null} */
  #lastChild = null;

  /** @type {T} */
  #value;

  /**
   * @param {T} value
   */
  constructor(value) {
    this.#value = value;
  }

  get value() {
    return this.#value;
  }

  get nextSibling() {
    return this.#nextSibling;
  }

  get previousSibling() {
    return this.#previousSibling;
  }

  get parentNode() {
    return this.#parentNode;
  }

  get firstChild() {
    return this.#firstChild;
  }

  get lastChild() {
    return this.#lastChild;
  }

  /**
   * @param {TreeNode<T>} node
   * @param {TreeNode<T> | null} before
   * @returns {TreeNode<T>}
   */
  insertBefore(node, before) {
    if (before && before.#parentNode !== this) {
      throw new Error("Reference node is not a child of this parent");
    }
    /** @type {TreeNode<T> | null} */
    let current = this;
    while (current) {
      if (current === node) {
        throw new Error("Cannot insert ancestor as child");
      }
      current = current.#parentNode;
    }
    if (node.#parentNode) {
      node.#parentNode.removeChild(node);
    }
    node.#parentNode = this;
    if (before === null) {
      if (this.#lastChild) {
        this.#lastChild.#nextSibling = node;
        node.#previousSibling = this.#lastChild;
        this.#lastChild = node;
      } else {
        this.#firstChild = node;
        this.#lastChild = node;
      }
    } else {
      node.#nextSibling = before;
      node.#previousSibling = before.#previousSibling;
      if (before.#previousSibling) {
        before.#previousSibling.#nextSibling = node;
      } else {
        this.#firstChild = node;
      }
      before.#previousSibling = node;
    }
    return node;
  }

  /**
   * @param {TreeNode<T>} node
   * @returns {TreeNode<T>}
   */
  removeChild(node) {
    if (node.#parentNode !== this) {
      throw new Error("Node is not a child of this parent");
    }
    if (node === this.#firstChild) {
      this.#firstChild = node.#nextSibling;
    }
    if (node === this.#lastChild) {
      this.#lastChild = node.#previousSibling;
    }
    if (node.#previousSibling) {
      node.#previousSibling.#nextSibling = node.#nextSibling;
    }
    if (node.#nextSibling) {
      node.#nextSibling.#previousSibling = node.#previousSibling;
    }
    node.#parentNode = null;
    node.#nextSibling = null;
    node.#previousSibling = null;
    return node;
  }

  /**
   * @param {TreeNode<T>} newNode
   * @param {TreeNode<T>} oldNode
   * @returns {TreeNode<T>}
   */
  replaceChild(newNode, oldNode) {
    if (oldNode.#parentNode !== this) {
      throw new Error("Old node is not a child of this parent");
    }
    this.insertBefore(newNode, oldNode);
    this.removeChild(oldNode);
    return oldNode;
  }

  /**
   * @param {TreeNode<T>} node
   * @returns {TreeNode<T>}
   */
  appendChild(node) {
    return this.insertBefore(node, null);
  }

  /**
   * @param {...TreeNode<T>} nodes
   * @returns {void}
   */
  append(...nodes) {
    for (const node of nodes) {
      this.appendChild(node);
    }
  }
}

export default TreeNode;
