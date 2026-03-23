import * as THREE from "three";
import { div } from "./div.js";
import { text } from "./text.js";

/**
 * @import {Observable} from 'rxjs';
 * @import {Mountable} from "@apendua.dev/reactive";
 * @import {Object3D} from 'three';
 */

/**
 * @param {WeakKey} ctx
 */
export function createPortal(ctx) {
  /** @type {WeakMap<Node, Object3D>} */
  const nodeToObject = new WeakMap();

  /** @type {WeakMap<Object3D, Node>} */
  const objectToNode = new WeakMap();

  /** @type {WeakMap<Object3D, () => void>} */
  const objectToCleanup = new WeakMap();

  /**
   * @param {Node} node
   */
  function cleanup(node) {
    const object = nodeToObject.get(node);
    if (object) {
      const cleanupFn = objectToCleanup.get(object);
      if (cleanupFn) {
        cleanupFn();
        objectToCleanup.delete(object);
      }
      object.children.forEach((child) => {
        const childNode = objectToNode.get(child);
        if (childNode) {
          cleanup(childNode);
        }
      });
      nodeToObject.delete(node);
      objectToNode.delete(object);
    }
    node.childNodes.forEach((childNode) => {
      cleanup(childNode);
    });
  }

  /**
   * @param {Node} node
   * @returns {THREE.Object3D | undefined}
   */
  function getOrCreateObjectForNode(node) {
    if (nodeToObject.has(node)) {
      return nodeToObject.get(node);
    }
    /** @type {Observable<THREE.Object3D> | undefined} */
    let observable;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = /** @type {HTMLElement} */ (node);
      switch (element.tagName.toLowerCase()) {
        default: {
          observable = div(ctx, element);
        }
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      observable = text(ctx, /** @type {Text} */ (node));
    }
    if (!observable) {
      return undefined;
    }
    /** @type {THREE.Object3D | undefined} */
    let object;
    const subscription = observable.subscribe({
      next: (value) => {
        object = value;
      },
    });
    if (!object) {
      throw new Error("Failed to create Object3D for node");
    }
    nodeToObject.set(node, object);
    objectToNode.set(object, node);
    objectToCleanup.set(object, () => {
      subscription.unsubscribe();
    });
    let childNode = node.firstChild;
    while (childNode) {
      const childObject = getOrCreateObjectForNode(childNode);
      if (childObject) {
        object.add(childObject);
      }
      childNode = childNode.nextSibling;
    }
    return object;
  }

  const containerElement = document.createElement("div");
  containerElement.style.position = "absolute";
  containerElement.style.top = "0";
  containerElement.style.left = "0";
  containerElement.style.visibility = "hidden";
  document.body.appendChild(containerElement);

  const containerObject = new THREE.Group();

  /**
   * @param {ResizeObserverEntry[]} entries
   */
  function resizeCallback(entries) {
    console.log("resize observed", entries);
    const scale = 0.01;
    const boundingRect = containerElement.getBoundingClientRect();
    const sizeX = scale * boundingRect.width;
    const sizeY = scale * boundingRect.height;
    containerObject.scale.set(scale, scale, scale);
    containerObject.rotation.set(Math.PI, 0, 0);
    containerObject.position.set(-sizeX / 2, sizeY / 2, 0);
  }

  const resizeObserver = new ResizeObserver(resizeCallback);
  resizeObserver.observe(containerElement);

  /**
   * @param {MutationRecord[]} mutationList
   */
  const mutationCallback = (mutationList) => {
    console.log("mutations observed", mutationList);
    /** @type {Set<Node>} */
    const alreadySeen = new Set();
    for (const mutation of mutationList) {
      const parentObject = nodeToObject.get(mutation.target);
      if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          alreadySeen.add(node);
          const childObject = getOrCreateObjectForNode(node);
          if (childObject && parentObject) {
            parentObject.add(childObject);
          }
        });
      }
    }
    for (const mutation of mutationList) {
      const parentObject = nodeToObject.get(mutation.target);
      if (mutation.type === "childList") {
        mutation.removedNodes.forEach((node) => {
          // If this node was added somewhere else it does not make sense to clean it up,
          // so if we detect that it was already seen, we skip it.
          if (!alreadySeen.has(node)) {
            const childObject = nodeToObject.get(node);
            if (childObject && parentObject) {
              parentObject.remove(childObject);
            }
            cleanup(node);
          }
        });
      }
    }
  };

  const mutationObserver = new MutationObserver(mutationCallback);
  mutationObserver.observe(containerElement, { childList: true, subtree: true });

  objectToCleanup.set(containerObject, () => {
    if (containerElement.parentNode) {
      containerElement.parentNode.removeChild(containerElement);
    }
    if (containerObject.parent) {
      containerObject.parent.remove(containerObject);
    }
    resizeObserver.disconnect();
    mutationObserver.disconnect();
  });
  nodeToObject.set(containerElement, containerObject);
  objectToNode.set(containerObject, containerElement);

  return {
    /**
     * @param {Object3D} parent
     */
    addTo(parent) {
      parent.add(containerObject);
    },
    /**
     * @param {Mountable<Node>} mountable
     */
    mount(mountable) {
      if (containerElement.firstChild && containerElement.lastChild) {
        mountable.replace([containerElement.firstChild, containerElement.lastChild]);
      } else {
        const placeholder = document.createComment("");
        containerElement.appendChild(placeholder);
        mountable.replace([placeholder, placeholder]);
      }
    },
    disconnect() {
      cleanup(containerElement);
    },
  };
}
