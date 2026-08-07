import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";
import { Derived, selector, toObservable } from "@apendua/signal";
import {
  getBoundingClientRectCached,
  getClipBoxCached,
  getComputedStyleCached,
  getTextLayout,
  PORTAL_ATTRIBUTE,
  setSubject,
} from "./cache.js";
import { UNCLIPPED } from "./clip.js";

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

  test("a scroll re-measures no text, however long the list is", () => {
    // The cost that scales with a list rather than with the part of it on
    // screen. Every number a text measurement reports is relative to the
    // parent's border box, which scrolls along with the text, so a scroller
    // sliding its content cannot change any of them — and a Range
    // measurement is the most expensive read in the file to spend proving it.
    // Which nodes were measured, rather than how many measurements ran: a
    // recompute can be driven more than once by dependencies that fire
    // separately, and that count is an implementation detail. Which text the
    // browser was asked about is not.
    /** @type {Set<Node>} */
    const measured = new Set();
    const originalCreateRange = document.createRange;
    const rect = () => ({ left: 10, top: 20, right: 40, bottom: 32, width: 30, height: 12 });
    document.createRange = () => {
      return /** @type {Range} */ (
        /** @type {unknown} */ ({
          /** @param {Node} node */
          selectNodeContents: (node) => measured.add(node),
          setStart: () => {},
          setEnd: () => {},
          getBoundingClientRect: rect,
          getClientRects: () => /** @type {DOMRectList} */ (/** @type {unknown} */ ([rect()])),
        })
      );
    };

    // scroller > row > #text — a row's label, which is where a list keeps
    // nearly all of its text.
    const scroller = document.createElement("div");
    const row = document.createElement("div");
    const label = document.createTextNode("hello world");
    row.appendChild(label);
    scroller.appendChild(row);
    document.body.appendChild(scroller);

    // …and text sitting directly in the scroller, which is the one case a
    // scroll really does move: the border box it is measured against is the
    // window, standing still while the text slides inside it.
    const loose = document.createTextNode("directly inside");
    scroller.appendChild(loose);

    /** @type {Subject<import("./cache.js").MutationBatch>} */
    const subject = new Subject();
    for (const node of [scroller, row, label, loose]) {
      setSubject(node, subject);
    }

    const layouts = [
      new Derived(() => getTextLayout(label)),
      new Derived(() => getTextLayout(loose)),
    ];
    const subscriptions = layouts.map((layout) => layout.subscribe({ next: () => layout.get() }));

    try {
      assert.deepEqual(measured, new Set([label, loose]), "both measured to begin with");

      measured.clear();
      subject.next({ types: new Set(["scroll"]), targets: new Set([scroller]) });
      assert.deepEqual(
        measured,
        new Set([loose]),
        "a row's label is not re-measured; the text whose own parent scrolled is",
      );

      // Anything that can genuinely re-break lines still re-measures both.
      measured.clear();
      subject.next({ types: new Set(["reflow"]), targets: null });
      assert.deepEqual(measured, new Set([label, loose]));

      measured.clear();
      subject.next({ types: new Set(["childList"]), targets: new Set([scroller]) });
      assert.deepEqual(measured, new Set([label, loose]));
    } finally {
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      subject.complete();
      scroller.remove();
      document.createRange = originalCreateRange;
    }
  });
});

/**
 * A portal-shaped tree with a layout, which jsdom does not otherwise have: a
 * container standing in for the portal's own element, a scroller that hides
 * its overflow behind a 2px border and 10px corners, and a row inside it that
 * slides as the list scrolls.
 */
function setupScroller() {
  let scrollTop = 0;
  let scrollerBottom = 100;

  const container = document.createElement("div");
  container.setAttribute(PORTAL_ATTRIBUTE, "");
  const scroller = document.createElement("div");
  const row = document.createElement("div");
  const label = document.createTextNode("row");

  scroller.style.overflow = "hidden";
  scroller.style.borderWidth = "2px";
  // Longhands, not the shorthand: jsdom does not expand `border-radius` into
  // the four corner properties the way a browser's computed style does.
  scroller.style.borderTopLeftRadius = "10px";
  scroller.style.borderTopRightRadius = "10px";
  scroller.style.borderBottomRightRadius = "10px";
  scroller.style.borderBottomLeftRadius = "10px";
  row.appendChild(label);
  scroller.appendChild(row);
  container.appendChild(scroller);
  document.body.appendChild(container);

  /** @type {Subject<import("./cache.js").MutationBatch>} */
  const mutations = new Subject();
  for (const node of [container, scroller, row, label]) {
    setSubject(node, mutations);
  }

  /**
   * @param {Element} element
   * @param {() => [number, number, number, number]} rect
   */
  const layout = (element, rect) => {
    element.getBoundingClientRect = () => {
      const [left, top, right, bottom] = rect();
      return /** @type {DOMRect} */ ({
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
      });
    };
  };
  layout(container, () => [0, 0, 200, 100]);
  layout(scroller, () => [0, 0, 200, scrollerBottom]);
  layout(row, () => [0, 20 - scrollTop, 200, 60 - scrollTop]);

  return {
    container,
    row,
    label,
    /** What a scroll does to a layout: the content moves, the window does not. */
    scrollBy: (/** @type {number} */ delta) => {
      scrollTop += delta;
      mutations.next({ types: new Set(["scroll"]), targets: new Set([scroller]) });
    },
    /** A change that does move the window, for contrast. */
    resizeTo: (/** @type {number} */ bottom) => {
      scrollerBottom = bottom;
      mutations.next({ types: new Set(["childList"]), targets: new Set([container]) });
    },
  };
}

describe("getClipBoxCached", () => {
  test("a scroller confines its descendants to its padding box", () => {
    const { container, row, label } = setupScroller();
    try {
      const clip = getClipBoxCached(row);
      assert.equal(clip.left, 2, "inside the border, where overflow is clipped");
      assert.equal(clip.top, 2);
      assert.equal(clip.right, 198);
      assert.equal(clip.bottom, 98);
      // The radius the padding box rounds by is the border-box radius less
      // the border sitting in front of it.
      assert.equal(clip.topLeft, 8);
      // Text inherits the same window: it has no overflow of its own to hide.
      assert.deepEqual(getClipBoxCached(label), clip);
    } finally {
      container.remove();
    }
  });

  test("the walk stops at the portal's container, not at the page around it", () => {
    const { container, row } = setupScroller();
    document.body.style.overflow = "hidden";
    try {
      // Whatever the page does with `body` is none of a panel's business —
      // and in a browserless layout its rect is all zeros, which would clip
      // the panel away to nothing if it were consulted.
      assert.equal(getClipBoxCached(row).right, 198);
      assert.equal(getClipBoxCached(container), UNCLIPPED);
    } finally {
      document.body.style.overflow = "";
      container.remove();
    }
  });

  test("scrolling moves the content without disturbing the window", () => {
    const { container, row, scrollBy, resizeTo } = setupScroller();
    try {
      const clip = new Derived(() => getClipBoxCached(row));
      let emissions = 0;
      const subscription = clip.subscribe({ next: () => emissions++ });
      const window = clip.get();

      scrollBy(50);

      assert.equal(getBoundingClientRectCached(row).top, -30, "the row has moved");
      assert.deepEqual(clip.get(), window, "the window it is clipped to has not");
      assert.equal(emissions, 0, "and a clip that has not moved does not propagate");

      // The window itself changing is a different matter, and does.
      resizeTo(60);
      assert.equal(clip.get().bottom, 58);
      assert.equal(emissions, 1);

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });
});

/**
 * The dropdown arrangement: a positioned anchor with a scroller in it, a row
 * inside the scroller, and a menu hanging off the row. Where the menu's
 * containing block sits decides who clips it — which is the thing under test.
 *
 * @param {string} anchorStyle
 * @param {string} rowStyle
 * @param {string} menuStyle
 */
function setupPositioned(anchorStyle, rowStyle, menuStyle) {
  const container = document.createElement("div");
  container.setAttribute(PORTAL_ATTRIBUTE, "");
  const anchor = document.createElement("div");
  anchor.style.cssText = anchorStyle;
  const scroller = document.createElement("div");
  scroller.style.overflow = "hidden";
  const row = document.createElement("div");
  row.style.cssText = rowStyle;
  const menu = document.createElement("div");
  menu.style.cssText = menuStyle;

  row.appendChild(menu);
  scroller.appendChild(row);
  anchor.appendChild(scroller);
  container.appendChild(anchor);
  document.body.appendChild(container);

  /**
   * @param {Element} element
   * @param {[number, number, number, number]} box
   */
  const layout = (element, [left, top, right, bottom]) => {
    element.getBoundingClientRect = () =>
      /** @type {DOMRect} */ ({
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
      });
  };
  layout(anchor, [5, 5, 195, 95]);
  layout(scroller, [10, 10, 190, 90]);

  return { container, scroller, row, menu };
}

describe("getClipBoxCached and positioned elements", () => {
  test("a dropdown menu escapes the scroller its trigger sits in", () => {
    // dropdown.js ships exactly this: a menu styled `position: absolute;
    // z-index: 1`. Its containing block is the anchor, above the scroller,
    // so the scroller's overflow — which binds the row — never reaches it.
    const { container, row, menu } = setupPositioned(
      "position: relative",
      "",
      "position: absolute; z-index: 1",
    );
    try {
      assert.equal(getClipBoxCached(row).left, 10, "the row is the scroller's to clip");
      assert.equal(getClipBoxCached(menu), UNCLIPPED);
    } finally {
      container.remove();
    }
  });

  test("a containing block inside the scroller keeps the menu clipped", () => {
    // The other common arrangement: the anchor is the row itself. The menu
    // then lives inside the scroller the way the row does, and scrolls away
    // with it.
    const { container, row, menu } = setupPositioned(
      "",
      "position: relative",
      "position: absolute; z-index: 1",
    );
    try {
      assert.deepEqual(getClipBoxCached(menu), getClipBoxCached(row));
      assert.equal(getClipBoxCached(menu).left, 10);
    } finally {
      container.remove();
    }
  });

  test("the containing block's own overflow is the clipping that does apply", () => {
    const { container, menu } = setupPositioned(
      "position: relative; overflow: hidden",
      "",
      "position: absolute; z-index: 1",
    );
    try {
      const clip = getClipBoxCached(menu);
      // The anchor's padding box, not the scroller's: clipping skips to the
      // containing block, and picks up everything from there on up.
      assert.deepEqual(
        { left: clip.left, top: clip.top, right: clip.right, bottom: clip.bottom },
        { left: 5, top: 5, right: 195, bottom: 95 },
      );
    } finally {
      container.remove();
    }
  });

  test("position: fixed escapes every ancestor there is", () => {
    const { container, menu } = setupPositioned(
      "position: relative; overflow: hidden",
      "",
      "position: fixed",
    );
    try {
      assert.equal(getClipBoxCached(menu), UNCLIPPED);
    } finally {
      container.remove();
    }
  });
});
