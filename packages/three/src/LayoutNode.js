import * as THREE from "three";
import { filter, NEVER, Subject } from "rxjs";
import { batch } from "@apendua.dev/signal";
import { decorate, invalidate, invalidateFn, memo } from "@apendua.dev/store4";
import { just, replaceSegment, store } from "@apendua.dev/reactive";
import TreeNode from "./TreeNode.js";

/**
 * @import {Observable, MonoTypeOperatorFunction} from "rxjs";
 * @import {INode, Mountable, Container} from "@apendua.dev/reactive";
 * @import {Component} from './core.js';
 */

/**
 * @typedef {INode<LayoutNode>} ILayoutNode
 */

/**
 * @typedef {Container<LayoutNode>} LayoutNodeContainer
 */

/**
 * @typedef {'X' | 'Y' | 'Z'} LayoutDirection
 */

/**
 * @typedef {'POSITIVE' | 'NEGATIVE'} LayoutOrientation
 */

/**
 * @typedef {'START' | 'CENTER' | 'END' | 'STRETCH'} LayoutAlignment
 */

/**
 * @typedef {'START' | 'CENTER' | 'END' | 'SPACE_BETWEEN'} LayoutJustify
 */

/**
 * @typedef {"UPDATED_CHILDREN" | "UPDATED_PARENT"} LayoutNodeEventType
 */

/** @type {WeakMap<object, Subject<LayoutNodeEventType>>} */
const events = new WeakMap();

/**
 * @typedef {object} State
 * @property {LayoutDirection} direction
 * @property {boolean} visible
 * @property {Record<LayoutDirection, number>} padding
 * @property {Record<LayoutDirection, number>} spacing
 * @property {Record<LayoutDirection, number>} minSize
 * @property {Record<LayoutDirection, number>} stretch
 * @property {Record<LayoutDirection, LayoutAlignment>} alignment
 * @property {Record<LayoutDirection, LayoutJustify>} justify
 * @property {Record<LayoutDirection, LayoutOrientation>} orientation
 */

/**
 * @typedef {object} LayoutOptions
 * @property {LayoutDirection} [direction]
 * @property {boolean} [visible]
 * @property {number} [padding]
 * @property {number} [paddingX]
 * @property {number} [paddingY]
 * @property {number} [paddingZ]
 * @property {number} [spacing]
 * @property {number} [spacingX]
 * @property {number} [spacingY]
 * @property {number} [spacingZ]
 * @property {number} [stretch]
 * @property {number} [stretchX]
 * @property {number} [stretchY]
 * @property {number} [stretchZ]
 * @property {LayoutAlignment} [alignment]
 * @property {LayoutAlignment} [alignmentX]
 * @property {LayoutAlignment} [alignmentY]
 * @property {LayoutAlignment} [alignmentZ]
 * @property {LayoutJustify} [justify]
 * @property {LayoutJustify} [justifyX]
 * @property {LayoutJustify} [justifyY]
 * @property {LayoutJustify} [justifyZ]
 * @property {LayoutOrientation} [orientation]
 * @property {LayoutOrientation} [orientationX]
 * @property {LayoutOrientation} [orientationY]
 * @property {LayoutOrientation} [orientationZ]
 */

/**
 * @template {THREE.Object3D} [T=THREE.Object3D]
 * @implements {ILayoutNode}
 * @implements {LayoutNodeContainer}
 */
class LayoutNode {
  /** @type {State} */
  #state;

  /** @type {Subject<LayoutNodeEventType>} */
  #events = new Subject();

  /** @type {TreeNode<LayoutNode>} */
  #treeNode = new TreeNode(this);

  /** @type {T} */
  #object;

  /** @type {Observable<unknown>} */
  #effects;

  /**
   * @param {T} object
   * @param {LayoutOptions} [options]
   * @param {MonoTypeOperatorFunction<LayoutNode<T>>[]} [operators]
   */
  constructor(object, options = {}, operators = []) {
    const {
      direction = "Y",
      visible = true,
      padding = 0,
      paddingX = padding,
      paddingY = padding,
      paddingZ = padding,
      spacing = 0,
      spacingX = spacing,
      spacingY = spacing,
      spacingZ = spacing,
      stretch = 0,
      stretchX = stretch,
      stretchY = stretch,
      stretchZ = stretch,
      alignment = "START",
      alignmentX = alignment,
      alignmentY = alignment,
      alignmentZ = alignment,
      justify = "START",
      justifyX = justify,
      justifyY = justify,
      justifyZ = justify,
      orientation = "POSITIVE",
      orientationX = orientation,
      orientationY = orientation,
      orientationZ = orientation,
    } = options;
    this.#state = store({
      direction,
      visible,
      padding: { X: paddingX, Y: paddingY, Z: paddingZ },
      spacing: { X: spacingX, Y: spacingY, Z: spacingZ },
      minSize: { X: 0, Y: 0, Z: 0 },
      stretch: { X: stretchX, Y: stretchY, Z: stretchZ },
      alignment: { X: alignmentX, Y: alignmentY, Z: alignmentZ },
      justify: { X: justifyX, Y: justifyY, Z: justifyZ },
      orientation: { X: orientationX, Y: orientationY, Z: orientationZ },
    });
    this.#object = object;
    this.#effects = just(this, operators);
    events.set(this, this.#events);
  }

  /**
   * @returns {T}
   */
  get object() {
    return this.#object;
  }

  /**
   * @returns {LayoutNode | null}
   */
  get parentNode() {
    return this.#treeNode.parentNode?.value ?? null;
  }

  /**
   * @returns {LayoutNode | null}
   */
  get nextSibling() {
    return this.#treeNode.nextSibling?.value ?? null;
  }

  /**
   * @returns {LayoutNode | null}
   */
  get previousSibling() {
    return this.#treeNode.previousSibling?.value ?? null;
  }

  /**
   * @returns {LayoutNode | null}
   */
  get firstChild() {
    return this.#treeNode.firstChild?.value ?? null;
  }

  /**
   * @returns {LayoutNode | null}
   */
  get lastChild() {
    return this.#treeNode.lastChild?.value ?? null;
  }

  get position() {
    if (!this.parentNode) {
      return new THREE.Vector3(0, 0, 0);
    }
    return this.parentNode.getChildPosition(this);
  }

  get sizeX() {
    return this.getSize("X");
  }

  get sizeY() {
    return this.getSize("Y");
  }

  get sizeZ() {
    return this.getSize("Z");
  }

  get direction() {
    return this.#state.direction;
  }

  set direction(value) {
    this.#state.direction = value;
  }

  get visible() {
    return this.#state.visible;
  }

  set visible(value) {
    this.#state.visible = value;
  }

  get minSizeX() {
    return this.#state.minSize.X;
  }

  set minSizeX(value) {
    this.#state.minSize.X = value;
  }

  get minSizeY() {
    return this.#state.minSize.Y;
  }

  set minSizeY(value) {
    this.#state.minSize.Y = value;
  }

  get minSizeZ() {
    return this.#state.minSize.Z;
  }

  set minSizeZ(value) {
    this.#state.minSize.Z = value;
  }

  /**
   * @overload
   * @param {number} sizeXYZ
   * @returns {void}
   */
  /**
   * @overload
   * @param {number} sizeX
   * @param {number} sizeY
   * @param {number} sizeZ
   * @returns {void}
   */
  /**
   * @param {number} sizeX
   * @param {number} [sizeY]
   * @param {number} [sizeZ]
   * @returns {void}
   */
  setMinSize(sizeX, sizeY = sizeX, sizeZ = sizeX) {
    batch(() => {
      this.#state.minSize.X = sizeX;
      this.#state.minSize.Y = sizeY;
      this.#state.minSize.Z = sizeZ;
    });
  }

  get justifyX() {
    return this.#state.justify.X;
  }

  set justifyX(value) {
    this.#state.justify.X = value;
  }

  get justifyY() {
    return this.#state.justify.Y;
  }

  set justifyY(value) {
    this.#state.justify.Y = value;
  }

  get justifyZ() {
    return this.#state.justify.Z;
  }

  set justifyZ(value) {
    this.#state.justify.Z = value;
  }

  /**
   * @overload
   * @param {LayoutJustify} justifyXYZ
   * @returns {void}
   */
  /**
   * @overload
   * @param {LayoutJustify} justifyX
   * @param {LayoutJustify} justifyY
   * @param {LayoutJustify} justifyZ
   * @returns {void}
   */
  /**
   * @param {LayoutJustify} justifyX
   * @param {LayoutJustify} [justifyY]
   * @param {LayoutJustify} [justifyZ]
   * @returns {void}
   */
  setJustify(justifyX, justifyY = justifyX, justifyZ = justifyX) {
    batch(() => {
      this.#state.justify.X = justifyX;
      this.#state.justify.Y = justifyY;
      this.#state.justify.Z = justifyZ;
    });
  }

  get alignmentX() {
    return this.#state.alignment.X;
  }

  set alignmentX(value) {
    this.#state.alignment.X = value;
  }

  get alignmentY() {
    return this.#state.alignment.Y;
  }

  set alignmentY(value) {
    this.#state.alignment.Y = value;
  }

  get alignmentZ() {
    return this.#state.alignment.Z;
  }

  set alignmentZ(value) {
    this.#state.alignment.Z = value;
  }

  /**
   * @overload
   * @param {LayoutAlignment} alignmentXYZ
   * @returns {void}
   */
  /**
   * @overload
   * @param {LayoutAlignment} alignmentX
   * @param {LayoutAlignment} alignmentY
   * @param {LayoutAlignment} alignmentZ
   * @returns {void}
   */
  /**
   * @param {LayoutAlignment} alignmentX
   * @param {LayoutAlignment} [alignmentY]
   * @param {LayoutAlignment} [alignmentZ]
   * @returns {void}
   */
  setAlignment(alignmentX, alignmentY = alignmentX, alignmentZ = alignmentX) {
    batch(() => {
      this.#state.alignment.X = alignmentX;
      this.#state.alignment.Y = alignmentY;
      this.#state.alignment.Z = alignmentZ;
    });
  }

  get orientationX() {
    return this.#state.orientation.X;
  }

  set orientationX(value) {
    this.#state.orientation.X = value;
  }

  get orientationY() {
    return this.#state.orientation.Y;
  }

  set orientationY(value) {
    this.#state.orientation.Y = value;
  }

  get orientationZ() {
    return this.#state.orientation.Z;
  }

  set orientationZ(value) {
    this.#state.orientation.Z = value;
  }

  /**
   * @overload
   * @param {LayoutOrientation} orientationXYZ
   * @returns {void}
   */
  /**
   * @overload
   * @param {LayoutOrientation} orientationX
   * @param {LayoutOrientation} orientationY
   * @param {LayoutOrientation} orientationZ
   * @returns {void}
   */
  /**
   * @param {LayoutOrientation} orientationX
   * @param {LayoutOrientation} [orientationY]
   * @param {LayoutOrientation} [orientationZ]
   * @returns {void}
   */
  setOrientation(
    orientationX,
    orientationY = orientationX,
    orientationZ = orientationX,
  ) {
    batch(() => {
      this.#state.orientation.X = orientationX;
      this.#state.orientation.Y = orientationY;
      this.#state.orientation.Z = orientationZ;
    });
  }

  get paddingX() {
    return this.#state.padding.X;
  }

  set paddingX(value) {
    this.#state.padding.X = value;
  }

  get paddingY() {
    return this.#state.padding.Y;
  }

  set paddingY(value) {
    this.#state.padding.Y = value;
  }

  get paddingZ() {
    return this.#state.padding.Z;
  }

  set paddingZ(value) {
    this.#state.padding.Z = value;
  }

  /**
   * @overload
   * @param {number} paddingXYZ
   * @returns {void}
   */
  /**
   * @overload
   * @param {number} paddingX
   * @param {number} paddingY
   * @param {number} paddingZ
   * @returns {void}
   */
  /**
   * @param {number} paddingX
   * @param {number} [paddingY]
   * @param {number} [paddingZ]
   * @returns {void}
   */
  setPadding(paddingX, paddingY = paddingX, paddingZ = paddingX) {
    batch(() => {
      this.#state.padding.X = paddingX;
      this.#state.padding.Y = paddingY;
      this.#state.padding.Z = paddingZ;
    });
  }

  get spacingX() {
    return this.#state.spacing.X;
  }

  set spacingX(value) {
    this.#state.spacing.X = value;
  }

  get spacingY() {
    return this.#state.spacing.Y;
  }

  set spacingY(value) {
    this.#state.spacing.Y = value;
  }

  get spacingZ() {
    return this.#state.spacing.Z;
  }

  set spacingZ(value) {
    this.#state.spacing.Z = value;
  }

  /**
   * @overload
   * @param {number} spacingXYZ
   * @returns {void}
   */
  /**
   * @overload
   * @param {number} spacingX
   * @param {number} spacingY
   * @param {number} spacingZ
   * @returns {void}
   */
  /**
   * @param {number} spacingX
   * @param {number} [spacingY]
   * @param {number} [spacingZ]
   * @returns {void}
   */
  setSpacing(spacingX, spacingY = spacingX, spacingZ = spacingX) {
    batch(() => {
      this.#state.spacing.X = spacingX;
      this.#state.spacing.Y = spacingY;
      this.#state.spacing.Z = spacingZ;
    });
  }

  get stretchX() {
    return this.#state.stretch.X;
  }

  set stretchX(value) {
    this.#state.stretch.X = value;
  }

  get stretchY() {
    return this.#state.stretch.Y;
  }

  set stretchY(value) {
    this.#state.stretch.Y = value;
  }

  get stretchZ() {
    return this.#state.stretch.Z;
  }

  set stretchZ(value) {
    this.#state.stretch.Z = value;
  }

  /**
   * @overload
   * @param {number} stretchXYZ
   * @returns {void}
   */
  /**
   * @overload
   * @param {number} stretchX
   * @param {number} stretchY
   * @param {number} stretchZ
   * @returns {void}
   */
  /**
   * @param {number} stretchX
   * @param {number} [stretchY]
   * @param {number} [stretchZ]
   * @returns {void}
   */
  setStretch(stretchX, stretchY = stretchX, stretchZ = stretchX) {
    batch(() => {
      this.#state.stretch.X = stretchX;
      this.#state.stretch.Y = stretchY;
      this.#state.stretch.Z = stretchZ;
    });
  }

  /**
   * @returns {LayoutNode[]}
   */
  getChildren() {
    /** @type {LayoutNode[]} */
    const children = [];
    let child = this.firstChild;
    while (child) {
      if (child.visible) {
        children.push(child);
      }
      child = child.nextSibling;
    }
    return children;
  }

  /**
   * @param {LayoutDirection} direction
   * @returns {Map<LayoutNode, number>}
   */
  getOffsets(direction) {
    /** @type {Map<LayoutNode, number>} */
    const offsets = new Map();
    const innerSize = this.getInnerSize(direction);
    const children = this.getChildren();
    const totalFixedSize = this.getTotalFixedSize(direction);
    const totalWeight = this.getTotalWeight(direction);
    const unitSize = this.getUnitSize(direction);
    const totalSpacing = innerSize - totalFixedSize - totalWeight * unitSize;

    /** @type {number} */
    let spacing;
    switch (this.#state.justify[direction]) {
      case "START":
      case "END":
      case "CENTER":
        spacing = this.#state.spacing[direction];
        break;
      case "SPACE_BETWEEN":
        spacing =
          children.length > 1 ? totalSpacing / (children.length - 1) : 0;
        break;
    }

    const totalSize =
      totalFixedSize + totalWeight * unitSize + spacing * (children.length - 1);

    /** @type {number} */
    let start;
    switch (this.#state.justify[direction]) {
      case "START":
      case "SPACE_BETWEEN":
        if (this.#state.orientation[direction] === "POSITIVE") {
          start = -innerSize / 2;
        } else {
          start = innerSize / 2;
        }
        break;
      case "CENTER":
        if (this.#state.orientation[direction] === "POSITIVE") {
          start = -totalSize / 2;
        } else {
          start = totalSize / 2;
        }
        break;
      case "END":
        if (this.#state.orientation[direction] === "POSITIVE") {
          start = innerSize / 2;
        } else {
          start = -innerSize / 2;
        }
        break;
    }
    if (this.#state.orientation[direction] === "POSITIVE") {
      for (const child of children) {
        const childSize = child.getSize(direction);
        offsets.set(child, start + childSize / 2);
        start += childSize + spacing;
      }
    } else {
      for (const child of children) {
        const childSize = child.getSize(direction);
        offsets.set(child, start - childSize / 2);
        start -= childSize + spacing;
      }
    }
    return offsets;
  }

  /**
   * @param {LayoutNode} node
   * @param {LayoutDirection} direction
   * @returns {number}
   */
  getChildOffset(node, direction) {
    if (this.direction !== direction) {
      return 0;
    }
    return this.getOffsets(direction).get(node) ?? 0;
  }

  /**
   * @param {LayoutNode} node
   * @param {LayoutDirection} direction
   * @returns {number}
   */
  getChildAlignment(node, direction) {
    if (this.direction === direction) {
      return 0;
    }
    switch (this.#state.alignment[direction]) {
      case "START":
        if (this.#state.orientation[direction] === "POSITIVE") {
          return (
            -this.getInnerSize(direction) / 2 + node.getSize(direction) / 2
          );
        }
        return this.getInnerSize(direction) / 2 - node.getSize(direction) / 2;
      case "END":
        if (this.#state.orientation[direction] === "POSITIVE") {
          return this.getInnerSize(direction) / 2 - node.getSize(direction) / 2;
        }
        return -this.getInnerSize(direction) / 2 + node.getSize(direction) / 2;
      case "CENTER":
      case "STRETCH":
        return 0;
    }
  }

  /**
   * @param {LayoutNode} node
   * @returns {THREE.Vector3}
   */
  getChildPosition(node) {
    return new THREE.Vector3(
      this.getChildAlignment(node, "X") + this.getChildOffset(node, "X"),
      this.getChildAlignment(node, "Y") + this.getChildOffset(node, "Y"),
      this.getChildAlignment(node, "Z") + this.getChildOffset(node, "Z"),
    );
  }

  /**
   * @param {LayoutDirection} direction
   * @returns {number}
   */
  getSize(direction) {
    if (!this.parentNode) {
      return this.getMinSize(direction);
    }
    const parentInnerSize = this.parentNode.getInnerSize(direction);
    if (this.parentNode.direction !== direction) {
      if (this.parentNode.#state.alignment[direction] === "STRETCH") {
        return parentInnerSize;
      }
      return this.getMinSize(direction);
    }
    if (this.#state.stretch[direction] > 0) {
      return (
        this.#state.stretch[direction] * this.parentNode.getUnitSize(direction)
      );
    }
    return this.getMinSize(direction);
  }

  /**
   * @param {LayoutDirection} direction
   * @returns {number}
   */
  getInnerSize(direction) {
    return this.getSize(direction) - this.#state.padding[direction] * 2;
  }

  /**
   * @param {LayoutDirection} direction
   * @returns {number}
   */
  getUnitSize(direction) {
    const innerSize = this.getInnerSize(direction);
    const totalWeight = this.getTotalWeight(direction);
    if (totalWeight === 0) {
      return 0;
    }
    const children = this.getChildren();
    const totalFixedSize = this.getTotalFixedSize(direction);
    const availableSize =
      innerSize -
      totalFixedSize -
      this.#state.spacing[direction] * (children.length - 1);
    return availableSize / totalWeight;
  }

  /**
   * @param {LayoutDirection} direction
   * @returns {number}
   */
  getMinUnitSize(direction) {
    const children = this.getChildren();
    let minUnitSize = 0;
    for (const child of children) {
      if (child.#state.stretch[direction] > 0) {
        minUnitSize = Math.max(
          minUnitSize,
          child.getMinSize(direction) / child.#state.stretch[direction],
        );
      }
    }
    return minUnitSize;
  }

  /**
   * @param {LayoutDirection} direction
   * @returns {number}
   */
  getTotalFixedSize(direction) {
    const children = this.getChildren();
    let totalFixedSize = 0;
    for (const child of children) {
      if (child.#state.stretch[direction] === 0) {
        totalFixedSize += child.getMinSize(direction);
      }
    }
    return totalFixedSize;
  }

  /**
   * @param {LayoutDirection} direction
   * @returns {number}
   */
  getTotalWeight(direction) {
    const children = this.getChildren();
    let totalWeight = 0;
    for (const child of children) {
      if (child.#state.stretch[direction] > 0) {
        totalWeight += child.#state.stretch[direction];
      }
    }
    return totalWeight;
  }

  /**
   * @param {LayoutDirection} direction
   * @returns {number}
   */
  getMinSize(direction) {
    const children = this.getChildren();
    if (direction === this.direction) {
      const minUnitSize = this.getMinUnitSize(direction);
      const totalFixedSize = this.getTotalFixedSize(direction);
      const totalWeight = this.getTotalWeight(direction);
      return Math.max(
        this.#state.minSize[direction],
        totalFixedSize +
          minUnitSize * totalWeight +
          this.#state.padding[direction] * 2 +
          this.#state.spacing[direction] * (children.length - 1),
      );
    }
    let minSize = 0;
    for (const child of children) {
      const childMinSize = child.getMinSize(direction);
      if (childMinSize > minSize) {
        minSize = childMinSize;
      }
    }
    return Math.max(
      this.#state.minSize[direction],
      minSize + this.#state.padding[direction] * 2,
    );
  }

  /**
   * @param {LayoutNode} node
   * @param {LayoutNode | null} before
   * @returns {LayoutNode}
   */
  insertBefore(node, before) {
    this.#treeNode.insertBefore(
      node.#treeNode,
      before ? before.#treeNode : null,
    );
    this.#object.add(node.#object);
    this.#events.next("UPDATED_CHILDREN");
    node.#events.next("UPDATED_PARENT");
    return node;
  }

  /**
   * @param {LayoutNode} node
   * @returns {LayoutNode}
   */
  removeChild(node) {
    this.#treeNode.removeChild(node.#treeNode);
    this.#object.remove(node.#object);
    this.#events.next("UPDATED_CHILDREN");
    node.#events.next("UPDATED_PARENT");
    return node;
  }

  /**
   * @param {LayoutNode} newNode
   * @param {LayoutNode} oldNode
   * @returns {LayoutNode}
   */
  replaceChild(newNode, oldNode) {
    this.#treeNode.replaceChild(newNode.#treeNode, oldNode.#treeNode);
    this.#object.remove(oldNode.#object);
    this.#object.add(newNode.#object);
    this.#events.next("UPDATED_CHILDREN");
    newNode.#events.next("UPDATED_PARENT");
    oldNode.#events.next("UPDATED_PARENT");
    return oldNode;
  }

  /**
   * @param {LayoutNode} node
   * @returns {LayoutNode}
   */
  appendChild(node) {
    this.#treeNode.insertBefore(node.#treeNode, null);
    this.#object.add(node.#object);
    this.#events.next("UPDATED_CHILDREN");
    node.#events.next("UPDATED_PARENT");
    return node;
  }

  /**
   * @param {...LayoutNode} nodes
   * @returns {void}
   */
  append(...nodes) {
    for (const node of nodes) {
      this.#treeNode.appendChild(node.#treeNode);
      this.#object.add(node.#object);
      node.#events.next("UPDATED_PARENT");
    }
    this.#events.next("UPDATED_CHILDREN");
  }

  /**
   * @returns {Component & Mountable<LayoutNode>}
   */
  toMountable() {
    return {
      /**
       * @param {THREE.Object3D} parent
       */
      addTo: (parent) => {
        const subscription = this.#effects.subscribe();
        parent.add(this.#object);
        return () => {
          parent.remove(this.#object);
          subscription.unsubscribe();
        };
      },
      /**
       * @param {[LayoutNode, LayoutNode]} segment
       */
      replace: (segment) => {
        return replaceSegment([this, this], segment);
      },
    };
  }
}

/**
 *
 * @param {WeakKey} obj
 * @param {LayoutNodeEventType} eventType
 */
function fromEvent(obj, eventType) {
  const myEvents = events.get(obj);
  if (!myEvents) {
    return NEVER;
  }
  return myEvents.pipe(filter((event) => event === eventType));
}

/**
 * @template {object} T
 * @param {LayoutNodeEventType} eventType
 */
function invalidateOn(eventType) {
  return invalidate(
    /** @this {T} */
    function () {
      return fromEvent(this, eventType);
    },
  );
}

decorate(LayoutNode.prototype, "parentNode", invalidateOn("UPDATED_PARENT"));

// We do not use the @memo decorator directly because it's not yet supported for
// classes defined in plain JavaScript.
decorate(
  LayoutNode.prototype,
  "getChildren",
  invalidateFn(function () {
    return fromEvent(this, "UPDATED_CHILDREN");
  }),
);

decorate(LayoutNode.prototype, "getOffsets", memo());
decorate(LayoutNode.prototype, "getSize", memo());
decorate(LayoutNode.prototype, "getInnerSize", memo());
decorate(LayoutNode.prototype, "getUnitSize", memo());
decorate(LayoutNode.prototype, "getMinUnitSize", memo());
decorate(LayoutNode.prototype, "getTotalFixedSize", memo());
decorate(LayoutNode.prototype, "getTotalWeight", memo());
decorate(LayoutNode.prototype, "getMinSize", memo());

export default LayoutNode;
