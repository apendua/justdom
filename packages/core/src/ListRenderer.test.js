import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BehaviorSubject } from "rxjs";
import { each, just, map, use } from "justdom-signal";
import { replaceSegment, toSegment } from "./helpers.js";
import fc from "fast-check";
import ListRenderer, { longestRunInOrder } from "./ListRenderer.js";

/**
 * @import {EntityEffect} from "justdom-signal"
 * @import {Mountable, Container} from "./types.js"
 */

describe("renders a simple DOM tree", () => {
  it("renders an element with children", () => {
    const innerHTML = inspectHTML(
      $("div", [
        children(
          $("span", [
            (span) => {
              span.textContent = "Hello,";
            },
          ]),
          $("span", [
            (span) => {
              span.textContent = "World!";
            },
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
              (li) => {
                li.textContent = item;
              },
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
              (li) => {
                li.textContent = item;
              },
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

  it("an emission that changes nothing touches no nodes", () => {
    // A moved node is a removal and an insertion as far as the DOM is
    // concerned, even when it lands exactly where it stood — and downstream,
    // a portal answers any childList mutation with a portal-wide re-measure.
    // The last item has no successor to be compared against, and used to be
    // re-appended on every emission for exactly that reason: one phantom
    // mutation per emission, per list.
    const items$ = new BehaviorSubject(["A", "B", "C"]);
    const innerHTML = inspectHTML(
      $("ul", [
        children(
          list(items$, (item) => {
            return $("li", [
              (li) => {
                li.textContent = item;
              },
            ]);
          }),
        ),
      ]),
    );
    const ul = innerHTML.container.querySelector("ul");
    assert.ok(ul);
    const spy = new window.MutationObserver(() => {});
    spy.observe(ul, { childList: true, subtree: true });

    items$.next(["A", "B", "C"]);
    items$.next(["A", "B", "C"]);
    assert.deepEqual(spy.takeRecords(), [], "same items, same order, no mutations");

    // Reordering is still a move, so the guard is not a bypass.
    items$.next(["C", "A", "B"]);
    assert.notEqual(spy.takeRecords().length, 0, "a real reorder still moves nodes");
    assert.strictEqual(innerHTML.get(), "<ul><li>C</li><li>A</li><li>B</li></ul>");

    spy.disconnect();
    innerHTML.dispose();
  });

  it("updates HTML when items are removed", () => {
    const items$ = new BehaviorSubject(["A", "B", "C", "D"]);
    const innerHTML = inspectHTML(
      $("ul", [
        children(
          list(items$, (item) => {
            return $("li", [
              (li) => {
                li.textContent = item;
              },
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

describe("moves only the items that must move", () => {
  /**
   * Renders `initial` as a list of `<li>`s and counts the items each later
   * emission inserts: a new item, or an existing one moved.
   *
   * @param {string[]} initial
   */
  function mountList(initial) {
    const items$ = new BehaviorSubject(initial);
    const innerHTML = inspectHTML(
      $("ul", [
        children(
          list(items$, (item) =>
            $("li", [
              (li) => {
                li.textContent = item;
              },
            ]),
          ),
        ),
      ]),
    );
    const ul = innerHTML.container.querySelector("ul");
    assert.ok(ul);
    const spy = new window.MutationObserver(() => {});
    spy.observe(ul, { childList: true });
    return {
      /** @param {string[]} items */
      emit(items) {
        spy.takeRecords();
        items$.next(items);
        return spy
          .takeRecords()
          .flatMap((record) => [...record.addedNodes])
          .filter((node) => node.nodeName === "LI").length;
      },
      text: () => [...ul.querySelectorAll("li")].map((li) => li.textContent),
      dispose() {
        spy.disconnect();
        innerHTML.dispose();
      },
    };
  }

  const letters = [..."ABCDEFGHIJ"];

  it("swapping two items moves two", () => {
    const view = mountList(letters);
    const swapped = [..."AICDEFGHBJ"];
    assert.equal(view.emit(swapped), 2);
    assert.deepEqual(view.text(), swapped);
    view.dispose();
  });

  it("removing an item moves none of the others", () => {
    const view = mountList(letters);
    assert.equal(view.emit([..."ABCDFGHIJ"]), 0);
    assert.deepEqual(view.text(), [..."ABCDFGHIJ"]);
    assert.equal(view.emit([..."BCDFGHIJ"]), 0);
    assert.deepEqual(view.text(), [..."BCDFGHIJ"]);
    view.dispose();
  });

  it("reversing n items moves n - 1", () => {
    const view = mountList(letters);
    const reversed = [...letters].reverse();
    assert.equal(view.emit(reversed), letters.length - 1);
    assert.deepEqual(view.text(), reversed);
    view.dispose();
  });

  it("any new order renders in that order, moving at most the items outside the run", () => {
    const pool = [..."ABCDEFGHIJKLMNOP"];
    const order = fc.uniqueArray(fc.constantFrom(...pool), { maxLength: pool.length });
    fc.assert(
      fc.property(order, fc.array(order, { maxLength: 4 }), (first, rest) => {
        const view = mountList(first);
        let previous = first;
        for (const next of rest) {
          const indexes = new Map(previous.map((key, index) => [key, index]));
          const run = longestRunInOrder(next, (key) => key, indexes);
          const added = next.filter((key) => !indexes.has(key)).length;
          const inserted = view.emit(next);
          assert.deepEqual(view.text(), next);
          assert.ok(
            inserted <= next.length - run.size,
            `inserted ${inserted}, at most ${next.length - run.size} (${added} new)`,
          );
          previous = next;
        }
        view.dispose();
      }),
    );
  });
});

describe("longestRunInOrder", () => {
  /** @param {string[]} previous @param {string[]} next */
  const run = (previous, next) =>
    [...longestRunInOrder(next, (key) => key, new Map(previous.map((key, i) => [key, i])))].sort();

  it("keeps everything when nothing moved", () => {
    assert.deepEqual(run([..."ABC"], [..."ABC"]), [..."ABC"]);
  });

  it("keeps one of the middle three when the outer two of them swap", () => {
    // A, B, E and A, C, E and A, D, E are all longest; any one will do.
    const kept = run([..."ABCDE"], [..."ADCBE"]);
    assert.equal(kept.length, 3);
    assert.deepEqual([kept[0], kept[2]], ["A", "E"]);
  });

  it("leaves out new keys and a key's second appearance", () => {
    assert.deepEqual(run([..."ABC"], [..."AXBBC"]), [..."ABC"]);
  });

  it("is empty for an empty list", () => {
    assert.deepEqual(run([..."ABC"], []), []);
  });
});

/**
 * @returns {Container}
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
 * @param {Array<import("justdom-signal").Subscribable<Mountable>>} children
 * @returns {EntityEffect<T>}
 */
function children(...children) {
  return (node) => {
    use(
      each(renderer.renderFragment(children), (mountable) => {
        if (!node.firstChild || !node.lastChild) {
          const placeholder = node.appendChild(document.createComment(""));
          mountable.replace([placeholder, placeholder]);
        } else {
          mountable.replace([node.firstChild, node.lastChild]);
        }
      }),
    );
  };
}

/**
 * @template T
 * @param {import("justdom-signal").Subscribable<Array<T>>} items
 * @param {(item: T) => import("justdom-signal").Subscribable<Mountable>} renderItem
 */
function list(items, renderItem) {
  return renderer.renderList(items, (item) => item, renderItem);
}

/**
 * @param {Node} node
 * @returns {Mountable}
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
 * @param {EntityEffect<HTMLElementTagNameMap[Tag]>[]} effects
 * @returns {import("justdom-signal").Source<Mountable>}
 */
function $(tag, effects = []) {
  return map((/** @type {HTMLElementTagNameMap[Tag]} */ node) => toMountable(node))(
    just(document.createElement(tag), effects),
  );
}

/**
 * @param {import("justdom-signal").Subscribable<Mountable>} component
 */
function inspectHTML(component) {
  const container = document.createElement("body");
  const placeholder = container.appendChild(document.createComment(""));
  const subscription = component.subscribe({
    next: (mountable) => {
      mountable.replace([placeholder, placeholder]);
    },
    error: (/** @type {unknown} */ err) => {
      Promise.reject(new Error(String(err)));
    },
  });
  return {
    container,
    get() {
      return cloneNode(container).innerHTML;
    },
    dispose() {
      subscription.unsubscribe();
    },
  };
}
