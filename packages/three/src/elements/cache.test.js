import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";
import { Derived } from "@apendua/signal";
import {
  getBoundingClientRectCached,
  getComputedStyleCached,
  getTextLayout,
  setSubject,
} from "./cache.js";

describe("getComputedStyleCached", () => {
  test("style invalidations propagate even though the declaration is a live object", () => {
    // Browsers return the *same* live CSSStyleDeclaration on every call, so
    // an equality-gated cache would swallow every invalidation. Simulate the
    // browser behavior explicitly: one stable object whose values follow the
    // element's inline style.
    const element = document.createElement("div");
    element.style.backgroundColor = "rgb(1, 2, 3)";
    document.body.appendChild(element);

    const original = window.getComputedStyle;
    const live = {
      get backgroundColor() {
        return element.style.backgroundColor;
      },
    };
    // @ts-expect-error -- a minimal stand-in for the live declaration.
    window.getComputedStyle = () => live;

    try {
      /** @type {Subject<import("./cache.js").MutationBatch>} */
      const subject = new Subject();
      setSubject(element, subject);

      /** @type {string[]} */
      const seen = [];
      const dependent = new Derived(() => {
        return getComputedStyleCached(element).backgroundColor;
      });
      const subscription = dependent.subscribe({
        next: () => {
          seen.push(dependent.get());
        },
      });
      assert.equal(dependent.get(), "rgb(1, 2, 3)");

      element.style.backgroundColor = "rgb(4, 5, 6)";
      subject.next({ types: new Set(["attributes"]), targets: new Set([element]) });

      assert.equal(dependent.get(), "rgb(4, 5, 6)");
      subscription.unsubscribe();
    } finally {
      window.getComputedStyle = original;
      element.remove();
    }
  });

  test("a style batch reaches its target's parent subtree and nothing else", () => {
    // root
    // ├── branchA ── leafA
    // └── branchB ── leafB
    const root = document.createElement("div");
    const branchA = document.createElement("div");
    const branchB = document.createElement("div");
    const leafA = document.createElement("div");
    const leafB = document.createElement("div");
    branchA.appendChild(leafA);
    branchB.appendChild(leafB);
    root.appendChild(branchA);
    root.appendChild(branchB);
    document.body.appendChild(root);

    // One subject shared by the whole tree, the way a portal shares one.
    /** @type {Subject<import("./cache.js").MutationBatch>} */
    const subject = new Subject();
    for (const node of [root, branchA, branchB, leafA, leafB]) {
      setSubject(node, subject);
    }

    const reads = { leafA: 0, leafB: 0 };
    const dependents = {
      leafA: new Derived(() => {
        reads.leafA += 1;
        return getComputedStyleCached(leafA).cursor;
      }),
      leafB: new Derived(() => {
        reads.leafB += 1;
        return getComputedStyleCached(leafB).cursor;
      }),
    };
    const subscriptions = Object.values(dependents).map((dependent) =>
      dependent.subscribe({ next: () => dependent.get() }),
    );
    Object.values(dependents).forEach((dependent) => dependent.get());
    assert.deepEqual(reads, { leafA: 1, leafB: 1 });

    // An attribute change on leafA can restyle at most leafA's siblings;
    // nothing under branchB needs another look.
    subject.next({ types: new Set(["attributes"]), targets: new Set([leafA]) });
    assert.deepEqual(reads, { leafA: 2, leafB: 1 });

    // On branchA it can restyle branchA's siblings too — `~` and `+` reach
    // across — and branchB's subtree comes with that.
    subject.next({ types: new Set(["attributes"]), targets: new Set([branchA]) });
    assert.deepEqual(reads, { leafA: 3, leafB: 2 });

    // No targets means the whole portal: fonts arriving restyle everything.
    subject.next({ types: new Set(["fontLoaded"]), targets: null });
    assert.deepEqual(reads, { leafA: 4, leafB: 3 });

    // A type styles pay no attention to does nothing, targeted or not.
    subject.next({ types: new Set(["characterData"]), targets: new Set([leafA]) });
    assert.deepEqual(reads, { leafA: 4, leafB: 3 });

    // The animation clock's per-frame sample scopes exactly like a mutation.
    subject.next({ types: new Set(["animated"]), targets: new Set([leafA]) });
    assert.deepEqual(reads, { leafA: 5, leafB: 3 });

    subscriptions.forEach((subscription) => subscription.unsubscribe());
    root.remove();
  });

  test("an attribute batch re-measures its target's own subtree, nothing else", () => {
    // Attribute mutations cannot move layout — that contract stands — but
    // they can toggle a CSS transform, which changes the client rects of
    // exactly the mutated element's subtree.
    const parent = document.createElement("div");
    const child = document.createElement("div");
    const sibling = document.createElement("div");
    parent.appendChild(child);
    document.body.appendChild(parent);
    document.body.appendChild(sibling);

    /** @type {Subject<import("./cache.js").MutationBatch>} */
    const subject = new Subject();
    for (const node of [parent, child, sibling]) {
      setSubject(node, subject);
    }

    const reads = { child: 0, sibling: 0 };
    const dependents = {
      child: new Derived(() => {
        reads.child += 1;
        return getBoundingClientRectCached(child);
      }),
      sibling: new Derived(() => {
        reads.sibling += 1;
        return getBoundingClientRectCached(sibling);
      }),
    };
    const subscriptions = Object.values(dependents).map((dependent) =>
      dependent.subscribe({ next: () => dependent.get() }),
    );
    Object.values(dependents).forEach((dependent) => dependent.get());
    assert.deepEqual(reads, { child: 1, sibling: 1 });

    // A transform toggled on parent moves child's rect; sibling's is
    // untouched and stays cached.
    subject.next({ types: new Set(["attributes"]), targets: new Set([parent]) });
    assert.deepEqual(reads, { child: 2, sibling: 1 });

    // Structural mutations still re-measure everything: layout is non-local.
    subject.next({ types: new Set(["childList"]), targets: new Set([parent]) });
    assert.deepEqual(reads, { child: 3, sibling: 2 });

    // The clock's style sample alone moves no rects…
    subject.next({ types: new Set(["animated"]), targets: new Set([parent]) });
    assert.deepEqual(reads, { child: 3, sibling: 2 });

    // …an animating transform moves its own subtree's…
    subject.next({ types: new Set(["reflow"]), targets: new Set([parent]) });
    assert.deepEqual(reads, { child: 4, sibling: 2 });

    // …and an animating layout property moves anybody's.
    subject.next({ types: new Set(["reflow"]), targets: null });
    assert.deepEqual(reads, { child: 5, sibling: 3 });

    subscriptions.forEach((subscription) => subscription.unsubscribe());
    parent.remove();
    sibling.remove();
  });
});

describe("text layout under transforms", () => {
  test("a transformed parent is measured through a clone, and the clone is cleaned up", () => {
    // jsdom implements no Range geometry; a minimal stand-in lets the clone
    // path run to completion. It records which trees were measured.
    /** @type {Node[]} */
    const measured = [];
    const originalCreateRange = document.createRange;
    document.createRange = () =>
      /** @type {Range} */ (
        /** @type {unknown} */ ({
          selectNodeContents: (/** @type {Node} */ node) => {
            measured.push(node);
          },
          setStart: () => {},
          setEnd: () => {},
          getBoundingClientRect: () =>
            /** @type {DOMRect} */ ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
          getClientRects: () => /** @type {DOMRectList} */ (/** @type {unknown} */ ([])),
        })
      );

    const parent = document.createElement("div");
    parent.style.transform = "matrix(2, 0, 0, 2, 0, 0)";
    parent.style.transition = "transform 0.3s";
    const textNode = document.createTextNode("hello world");
    parent.appendChild(textNode);
    document.body.appendChild(parent);
    setSubject(parent, new Subject());
    setSubject(textNode, new Subject());

    const childrenBefore = document.body.childElementCount;
    try {
      const layout = getTextLayout(textNode);
      assert.deepEqual(layout.lines, []);
      // The measurement ran against a clone's text, not the live node…
      assert.equal(measured.length, 1);
      assert.notEqual(measured[0], textNode);
      assert.equal(measured[0].textContent, "hello world");
      // …the live parent was never touched — no attributes, no style writes
      // a `transition: transform` could smooth into a lie…
      assert.equal(parent.style.transform, "matrix(2, 0, 0, 2, 0, 0)");
      // …and the clone did not outlive the measurement.
      assert.equal(document.body.childElementCount, childrenBefore);
    } finally {
      parent.remove();
      document.createRange = originalCreateRange;
    }
  });
});
