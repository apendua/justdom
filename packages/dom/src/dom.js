import { effectMap, just, observable } from "@apendua.dev/signal";
import ListRenderer from "./ListRenderer.js";
import { replaceSegment, toSegment } from "./helpers.js";
import { defer, map, tap } from "rxjs";

/**
 * @import {Observable, MonoTypeOperatorFunction} from 'rxjs';
 * @import {Mountable, Container} from "./types.js";
 */

/**
 * Creates an element observable.
 *
 * The element itself is created on *subscribe*, not when `$()` is called. That
 * matters for two reasons:
 *
 * - Without `defer`, the argument evaluation order makes children get created
 *   before their parents, which is the reverse of document order. Creating on
 *   subscribe means elements are acquired top-down instead, matching the order
 *   the operator chain runs in.
 * - The same element observable can be mounted in more than one place. Eager
 *   creation gave every subscriber the *same* node, so the second mount stole
 *   it from the first and only one copy was rendered.
 *
 * @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag
 * @param {MonoTypeOperatorFunction<HTMLElementTagNameMap[Tag]>[]} operators
 * @returns {Observable<Mountable<Node>>}
 */
export function $(tag, operators = []) {
  return defer(() => just(document.createElement(tag), operators)).pipe(map(toMountable));
}

/**
 * @template {keyof SVGElementTagNameMap} Tag
 * @param {Tag} tag
 * @param {MonoTypeOperatorFunction<SVGElementTagNameMap[Tag]>[]} operators
 * @returns {Observable<Mountable<Node>>}
 */
export function $$(tag, operators = []) {
  return defer(() =>
    just(document.createElementNS("http://www.w3.org/2000/svg", tag), operators),
  ).pipe(map(toMountable));
}

/**
 * @returns {Container<Node>}
 */
function createContainer() {
  /** @type {Node} */
  const fragment = document.createDocumentFragment();
  /** @type {[Node, Node]} */
  const envelope = [
    fragment.appendChild(createPlaceholder()),
    fragment.appendChild(createPlaceholder()),
  ];
  return {
    /**
     * @param {Node} child
     */
    appendChild(child) {
      if (!envelope[1].parentNode) {
        throw new Error("Cannot append child to a removed container.");
      }
      return envelope[1].parentNode.insertBefore(child, envelope[1]);
    },
    toMountable() {
      return {
        /**
         * @param {[Node, Node]} segment
         */
        replace: (segment) => {
          return replaceSegment(envelope, segment);
        },
      };
    },
  };
}

/**
 * @returns {Node}
 */
function createPlaceholder() {
  return document.createComment("");
}

const renderer = new ListRenderer({
  createContainer,
  createPlaceholder,
});

/**
 * @template {Node} T
 * @param {Array<Observable<Mountable<Node>>>} children
 * @returns {MonoTypeOperatorFunction<T>}
 */
export function children(...children) {
  return effectMap((node) => {
    return renderer.renderFragment(children).pipe(
      tap((mountable) => {
        if (!node.firstChild || !node.lastChild) {
          const placeholder = node.appendChild(document.createComment(""));
          mountable.replace([placeholder, placeholder]);
        } else {
          mountable.replace([node.firstChild, node.lastChild]);
        }
      }),
    );
  });
}

/**
 * @template T
 * @param {Observable<T> | (() => T)} value
 */
function normalize(value) {
  if (typeof value === "function") {
    return observable(value);
  }
  return value;
}

/**
 * @template T
 * @param {Observable<Iterable<T>> | (() => Iterable<T>)} items
 * @param {(item: T, getIndex: () => number) => Observable<Mountable<Node>>} renderItem
 */
export function list(items, renderItem) {
  items = normalize(items);
  return renderer.renderList(items, (item) => item, renderItem);
}

/**
 * @template K
 * @template T
 * @param {Observable<Iterable<[K, T]>> | (() => Iterable<[K, T]>) } items
 * @param {(item: T, key: K, index: () => number) => Observable<Mountable<Node>>} renderItem
 */
export function keyedList(items, renderItem) {
  items = normalize(items);
  return renderer.renderList(
    items,
    (item) => item[0],
    (item, index) => renderItem(item[1], item[0], index),
  );
}

/**
 * @param {Node} node
 * @returns {Mountable<Node>}
 */
export function toMountable(node) {
  return {
    replace: (segment) => {
      return replaceSegment(toSegment(node), segment);
    },
  };
}
