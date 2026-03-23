import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BehaviorSubject, map, tap } from "rxjs";
import { replaceSegment, toSegment } from "./helpers.js";
import { effectMap } from "./operators.js";
import { just } from "./factories.js";
import ListRenderer from "./ListRenderer.js";

describe("renders a simple DOM tree", () => {
  it("renders an element with children", () => {
    const innerHTML = inspectHTML(
      $("div", [
        children(
          $("span", [
            tap((span) => {
              span.textContent = "Hello,";
            }),
          ]),
          $("span", [
            tap((span) => {
              span.textContent = "World!";
            }),
          ]),
        ),
      ]),
    );
    assert.strictEqual(innerHTML.get(), "<div><span>Hello,</span><span>World!</span></div>");
    innerHTML.dispose();
    assert.strictEqual(innerHTML.get(), "<div></div>");
  });

  it("renders a list of items", () => {
    const items$ = just(["A", "B", "C"]);
    const innerHTML = inspectHTML(
      $("ul", [
        children(
          list(items$, (item) => {
            return $("li", [
              tap((li) => {
                li.textContent = item;
              }),
            ]);
          }),
        ),
      ]),
    );
    assert.strictEqual(innerHTML.get(), "<ul><li>A</li><li>B</li><li>C</li></ul>");
    innerHTML.dispose();
    assert.strictEqual(innerHTML.get(), "<ul></ul>");
  });

  it("updates HTML when items are added", () => {
    const items$ = new BehaviorSubject(["A"]);
    const innerHTML = inspectHTML(
      $("ul", [
        children(
          list(items$, (item) => {
            return $("li", [
              tap((li) => {
                li.textContent = item;
              }),
            ]);
          }),
        ),
      ]),
    );
    assert.strictEqual(innerHTML.get(), "<ul><li>A</li></ul>");
    items$.next(["A", "B"]);
    assert.strictEqual(innerHTML.get(), "<ul><li>A</li><li>B</li></ul>");
    innerHTML.dispose();
    assert.strictEqual(innerHTML.get(), "<ul></ul>");
  });

  it("updates HTML when items are removed", () => {
    const items$ = new BehaviorSubject(["A", "B", "C", "D"]);
    const innerHTML = inspectHTML(
      $("ul", [
        children(
          list(items$, (item) => {
            return $("li", [
              tap((li) => {
                li.textContent = item;
              }),
            ]);
          }),
        ),
      ]),
    );
    assert.strictEqual(innerHTML.get(), "<ul><li>A</li><li>B</li><li>C</li><li>D</li></ul>");
    items$.next(["A", "B", "C"]);
    assert.strictEqual(innerHTML.get(), "<ul><li>A</li><li>B</li><li>C</li></ul>");
    innerHTML.dispose();
    assert.strictEqual(innerHTML.get(), "<ul></ul>");
  });
});

/**
 * @import {Observable, MonoTypeOperatorFunction} from "rxjs"
 * @import {Mountable, Container} from "./types.js"
 */

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
function children(...children) {
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
 * @param {Observable<Array<T>>} items
 * @param {(item: T) => Observable<Mountable<Node>>} renderItem
 */
function list(items, renderItem) {
  return renderer.renderList(items, renderItem);
}

/**
 * @param {Node} node
 * @returns {Mountable<Node>}
 */
function toMountable(node) {
  return {
    replace: (segment) => {
      return replaceSegment(toSegment(node), segment);
    },
  };
}

/**
 * @template {Node} T
 * @param {T} node
 * @returns {T}
 */
function cloneNode(node) {
  const newNode = node.cloneNode(false);
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (!(child instanceof Comment)) {
      newNode.appendChild(cloneNode(child));
    }
  }
  return /** @type {T} */ (newNode);
}

/**
 * @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag
 * @param {MonoTypeOperatorFunction<HTMLElementTagNameMap[Tag]>[]} operators
 * @returns {Observable<Mountable<Node>>}
 */
function $(tag, operators = []) {
  return operators
    .reduce(
      (source, operator) => {
        return operator(source);
      },
      just(document.createElement(tag)),
    )
    .pipe(map((node) => toMountable(node)));
}

/**
 * @param {Observable<Mountable<Node>>} component
 */
function inspectHTML(component) {
  const container = document.createElement("body");
  const placeholder = container.appendChild(document.createComment(""));
  const subscription = component.subscribe({
    next: (mountable) => {
      mountable.replace([placeholder, placeholder]);
    },
    error: (err) => {
      Promise.reject(new Error(err.toString()));
    },
  });
  return {
    get() {
      return cloneNode(container).innerHTML;
    },
    dispose() {
      subscription.unsubscribe();
    },
  };
}
