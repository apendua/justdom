import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";
import { Derived, selector, toObservable } from "@apendua/signal";
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

describe("text layout as a dependency", () => {
  test("text that only moved is re-measured, and nothing downstream hears about it", () => {
    // What a scroll does to a line of text: the whole subtree slides through
    // the viewport, so the measurement has to run again, and every number it
    // yields is the number it yielded before. Rasterizing a texture is the
    // expensive thing hanging off these, and it must not re-run — which is
    // why the bounds are a size rather than the rectangle they were read
    // from. Each frame of a scroll would otherwise re-draw every label.
    let scrolled = 0;
    let measurements = 0;
    // jsdom implements no Range geometry, and a `DOMRect` is what a browser
    // hands back here — an instance of a class, which is exactly the thing
    // the selector proxy cannot look inside. Taken off `window`, because that
    // is where jsdom puts it.
    const rect = () => new window.DOMRect(10, 20 - scrolled, 30, 12);

    const originalCreateRange = document.createRange;
    document.createRange = () => {
      measurements++;
      return /** @type {Range} */ (
        /** @type {unknown} */ ({
          selectNodeContents: () => {},
          setStart: () => {},
          setEnd: () => {},
          getBoundingClientRect: rect,
          getClientRects: () => /** @type {DOMRectList} */ (/** @type {unknown} */ ([rect()])),
        })
      );
    };

    const parent = document.createElement("div");
    const textNode = document.createTextNode("hello world");
    parent.appendChild(textNode);
    document.body.appendChild(parent);
    // The parent scrolls away with the text it contains, which is the whole
    // reason the text's own position within it does not change.
    parent.getBoundingClientRect = () =>
      /** @type {DOMRect} */ (
        /** @type {unknown} */ ({ left: 0, top: -scrolled, right: 100, bottom: 100 })
      );

    /** @type {Subject<import("./cache.js").MutationBatch>} */
    const subject = new Subject();
    setSubject(textNode, subject);

    const layout = selector(() => getTextLayout(textNode));

    let rasters = 0;
    const texture = new Derived(() => {
      rasters++;
      return `${layout.bounds.width}x${layout.bounds.height}/${layout.lines.length}`;
    });

    // Subscribed, because that is how the mirror reads this — an effect
    // hanging off the texture — and because equality only gets a chance to
    // stop anything on a graph something is actually watching. A bare `get()`
    // recomputes on demand and would report nothing either way.
    /** @type {string[]} */
    const drawn = [];
    const subscription = toObservable(texture).subscribe((value) => drawn.push(value));

    try {
      assert.deepEqual(drawn, ["30x12/1"]);
      assert.deepEqual({ measurements, rasters }, { measurements: 1, rasters: 1 });

      scrolled = 8;
      subject.next({ types: new Set(["reflow"]), targets: new Set([parent]) });

      // Re-measured, because a client rect that moved is a client rect that
      // has to be read again…
      assert.equal(measurements, 2);
      // …the text is still where it was in the space the mirror draws in…
      const moved = getTextLayout(textNode);
      assert.deepEqual({ left: moved.left, top: moved.top }, { left: 10, top: 20 });
      // …and the texture was drawn once, and stays drawn.
      assert.deepEqual(drawn, ["30x12/1"]);
      assert.equal(rasters, 1);
    } finally {
      subscription.unsubscribe();
      subject.complete();
      parent.remove();
      document.createRange = originalCreateRange;
    }
  });
});
