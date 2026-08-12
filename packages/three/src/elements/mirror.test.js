import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { batch, Derived, selector, toObservable } from "@apendua/signal";
import {
  createMirror,
  getBorderBoxSize,
  getComputedStyleCached,
  getContentPosition,
  getInteriorClipBox,
  getLocalClipBox,
  getObjectPosition,
  getTextLayout,
  PORTAL_ATTRIBUTE,
} from "./mirror.js";
import { UNCLIPPED } from "./clip.js";

/**
 * @param {Element} element
 * @param {() => [number, number, number, number]} rect
 * @param {{ count?: () => void }} [options]
 */
function layout(element, rect, { count } = {}) {
  element.getBoundingClientRect = () => {
    count?.();
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
}

/**
 * @param {Element} element
 * @param {() => number} top
 */
function scrollable(element, top) {
  Object.defineProperty(element, "scrollTop", { configurable: true, get: top });
}

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
      const mirror = createMirror();
      mirror.adopt(element);

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
      mirror.attributeChanged(element);

      assert.equal(dependent.get(), "rgb(4, 5, 6)");
      subscription.unsubscribe();
    } finally {
      window.getComputedStyle = original;
      element.remove();
    }
  });

  test("a mutation restyles its target's parent subtree and nothing else", () => {
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

    const mirror = createMirror();
    for (const node of [root, branchA, branchB, leafA, leafB]) {
      mirror.adopt(node);
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
    mirror.attributeChanged(leafA);
    assert.deepEqual(reads, { leafA: 2, leafB: 1 });

    // On branchA it can restyle branchA's siblings too — `~` and `+` reach
    // across — and branchB's subtree comes with that.
    mirror.attributeChanged(branchA);
    assert.deepEqual(reads, { leafA: 3, leafB: 2 });

    // Fonts arriving restyle everything.
    mirror.fontsLoaded();
    assert.deepEqual(reads, { leafA: 4, leafB: 3 });

    // Text changing restyles nothing, targeted or not.
    mirror.characterDataChanged(leafA);
    assert.deepEqual(reads, { leafA: 4, leafB: 3 });

    // The animation clock's per-frame sample scopes exactly like a mutation.
    mirror.animatedStyles([leafA]);
    assert.deepEqual(reads, { leafA: 5, leafB: 3 });

    subscriptions.forEach((subscription) => subscription.unsubscribe());
    root.remove();
  });

  test("a write that did not change the value invalidates nothing", () => {
    // The hover handlers re-assert `data-xr-*` on every pointer event, and
    // the observer dutifully reports each write. The mirror compares against
    // the record's own `oldValue`, so a value that merely got written again
    // — including one that went A → B → A within a single flush — is not a
    // change at all.
    const element = document.createElement("div");
    element.setAttribute("data-xr-hover", "true");
    document.body.appendChild(element);

    const mirror = createMirror();
    mirror.adopt(element);

    let reads = 0;
    const dependent = new Derived(() => {
      reads += 1;
      return getComputedStyleCached(element).cursor;
    });
    const subscription = dependent.subscribe({ next: () => dependent.get() });
    dependent.get();
    assert.equal(reads, 1);

    /** @param {string | null} oldValue */
    const record = (oldValue) =>
      /** @type {MutationRecord} */ (
        /** @type {unknown} */ ({
          type: "attributes",
          target: element,
          attributeName: "data-xr-hover",
          oldValue,
          addedNodes: [],
          removedNodes: [],
        })
      );

    // The value is "true" and was "true" before: not a change.
    batch(() => mirror.ingest([record("true")]));
    assert.equal(reads, 1, "re-asserting an attribute costs nothing");

    // Went somewhere and came back within one flush: still not a change.
    batch(() => mirror.ingest([record("true"), record("gone")]));
    assert.equal(reads, 1, "a round trip within one flush costs nothing");

    // And an actual change still lands.
    batch(() => mirror.ingest([record("false")]));
    assert.equal(reads, 2);

    subscription.unsubscribe();
    element.remove();
  });

  test("a hover flag restyles without measuring; an author's attribute does both", () => {
    // The bargain hover is worth: the ray writes `data-xr-hover` onto every
    // element it crosses, and twice more on a press, so anything a flag
    // costs is paid at frame rate under a moving hand. The flags the portal
    // writes are declared presentational — they may restyle, they may not
    // move layout — and that turns the whole thing into style reads. `class`
    // and `style` belong to the author and keep their full strength.
    const element = document.createElement("div");
    document.body.appendChild(element);
    let rectReads = 0;
    layout(element, () => [0, 0, 10, 10], { count: () => rectReads++ });

    const mirror = createMirror();
    mirror.adopt(element);

    let styleReads = 0;
    const style = new Derived(() => {
      styleReads += 1;
      return getComputedStyleCached(element).backgroundColor;
    });
    const geometry = new Derived(() => getContentPosition(element));
    const subscriptions = [
      style.subscribe({ next: () => style.get() }),
      geometry.subscribe({ next: () => geometry.get() }),
    ];
    style.get();
    geometry.get();
    assert.deepEqual({ styleReads, rectReads }, { styleReads: 1, rectReads: 1 });

    /**
     * @param {string} name
     * @param {string | null} oldValue
     */
    const record = (name, oldValue) =>
      /** @type {MutationRecord} */ (
        /** @type {unknown} */ ({
          type: "attributes",
          target: element,
          attributeName: name,
          oldValue,
          addedNodes: [],
          removedNodes: [],
        })
      );

    element.setAttribute("data-xr-hover", "true");
    batch(() => mirror.ingest([record("data-xr-hover", null)]));
    assert.equal(styleReads, 2, "the hover restyles");
    assert.equal(rectReads, 1, "and measures nothing");

    element.removeAttribute("data-xr-hover");
    batch(() => mirror.ingest([record("data-xr-hover", "true")]));
    assert.equal(styleReads, 3);
    assert.equal(rectReads, 1, "leaving costs no more than arriving");

    // The author's own attributes are the ones that may move a layout, and
    // they still re-measure.
    element.setAttribute("class", "grown");
    batch(() => mirror.ingest([record("class", null)]));
    assert.equal(styleReads, 4);
    assert.equal(rectReads, 2, "a class change is allowed to have moved things");

    // A flush carrying both is worth a measurement, because the class in it
    // is: the flags are only presentational on their own.
    element.setAttribute("data-xr-hover", "true");
    element.setAttribute("class", "grown again");
    batch(() => mirror.ingest([record("data-xr-hover", null), record("class", "grown")]));
    assert.equal(rectReads, 3, "the class in the flush still carries the day");

    subscriptions.forEach((subscription) => subscription.unsubscribe());
    element.remove();
  });

  test("one observer flush settles the graph once", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.appendChild(first);
    document.body.appendChild(second);

    const mirror = createMirror();
    mirror.adopt(first);
    mirror.adopt(second);

    let reads = 0;
    const dependent = new Derived(() => {
      reads += 1;
      return `${getComputedStyleCached(first).cursor}/${getComputedStyleCached(second).cursor}`;
    });
    const subscription = dependent.subscribe({ next: () => dependent.get() });
    dependent.get();
    assert.equal(reads, 1);

    /** @param {Element} target */
    const record = (target) =>
      /** @type {MutationRecord} */ (
        /** @type {unknown} */ ({
          type: "attributes",
          target,
          attributeName: "class",
          oldValue: "was",
          addedNodes: [],
          removedNodes: [],
        })
      );

    // Two mutations, two elements, one flush — the portal wraps ingest in
    // batch(), so a dependent watching both recomputes once, not once per
    // record.
    batch(() => mirror.ingest([record(first), record(second)]));
    assert.equal(reads, 2, "two records, one recompute");

    subscription.unsubscribe();
    first.remove();
    second.remove();
  });
});

describe("measured geometry", () => {
  test("an attribute change re-measures its target's own subtree, nothing else", () => {
    // Attribute mutations cannot move layout — that contract stands — but
    // they can toggle a CSS transform, which changes the client rects of
    // exactly the mutated element's subtree.
    const parent = document.createElement("div");
    const child = document.createElement("div");
    const sibling = document.createElement("div");
    parent.appendChild(child);
    document.body.appendChild(parent);
    document.body.appendChild(sibling);

    const mirror = createMirror();
    for (const node of [parent, child, sibling]) {
      mirror.adopt(node);
    }

    // What is counted is the measurement itself — the rect read — not what
    // propagates from it: a re-measure that lands on the same numbers is
    // deliberately silent downstream, and that silence is half the design.
    const reads = { child: 0, sibling: 0 };
    layout(child, () => [0, 0, 10, 10], { count: () => reads.child++ });
    layout(sibling, () => [0, 20, 10, 30], { count: () => reads.sibling++ });

    const dependents = {
      child: new Derived(() => getContentPosition(child)),
      sibling: new Derived(() => getContentPosition(sibling)),
    };
    const subscriptions = Object.values(dependents).map((dependent) =>
      dependent.subscribe({ next: () => dependent.get() }),
    );
    Object.values(dependents).forEach((dependent) => dependent.get());
    assert.deepEqual(reads, { child: 1, sibling: 1 });

    // A transform toggled on parent moves child's rect; sibling's is
    // untouched and stays cached.
    mirror.attributeChanged(parent);
    assert.deepEqual(reads, { child: 2, sibling: 1 });

    // Structural mutations still re-measure everything: layout is non-local.
    mirror.childListChanged(parent);
    assert.deepEqual(reads, { child: 3, sibling: 2 });

    // The clock's style sample alone moves no rects…
    mirror.animatedStyles([parent]);
    assert.deepEqual(reads, { child: 3, sibling: 2 });

    // …an animating transform moves its own subtree's…
    mirror.reflowed([parent]);
    assert.deepEqual(reads, { child: 4, sibling: 2 });

    // …and an animating layout property moves anybody's.
    mirror.reflowed(null);
    assert.deepEqual(reads, { child: 5, sibling: 3 });

    // An image arriving takes the size the picture turned out to have and
    // pushes everything after it along, so it re-measures the portal — the
    // same shape of event as a font arriving.
    mirror.contentLoaded();
    assert.deepEqual(reads, { child: 6, sibling: 4 });

    subscriptions.forEach((subscription) => subscription.unsubscribe());
    parent.remove();
    sibling.remove();
  });

  test("a transform leaving mid-transition re-measures the subtree it polluted", () => {
    // The size of a transformed element is taken from layout offsets, and
    // its client rect — the transformed bounds — is not consulted while the
    // transform is there. The moment the transform goes, the cached numbers
    // have to be read again: a card that spent its transition rotated five
    // degrees would otherwise be drawn a tenth wider than it is. The frames
    // in between must cost nothing.
    const portal = document.createElement("div");
    portal.setAttribute(PORTAL_ATTRIBUTE, "");
    const card = document.createElement("div");
    const label = document.createElement("div");
    card.appendChild(label);
    portal.appendChild(card);
    document.body.appendChild(portal);

    const original = window.getComputedStyle;
    // Both elements read one live declaration each, following the card's
    // inline transform the way a browser's would follow the cascade.
    const live = {
      get transform() {
        return card.style.transform || "none";
      },
    };
    // @ts-expect-error -- a minimal stand-in for the live declaration.
    window.getComputedStyle = () => live;

    const mirror = createMirror();
    for (const node of [portal, card, label]) {
      mirror.adopt(node);
    }

    try {
      // Both ways of measuring the label count as a measurement: the client
      // rect on the untransformed path, the layout offsets under a
      // transform.
      let measurements = 0;
      layout(label, () => [0, 0, 10, 10], { count: () => measurements++ });
      Object.defineProperty(label, "offsetWidth", {
        configurable: true,
        get: () => {
          measurements++;
          return 10;
        },
      });
      Object.defineProperty(label, "offsetHeight", { configurable: true, get: () => 10 });

      const dependent = new Derived(() => getBorderBoxSize(label));
      const subscription = dependent.subscribe({ next: () => dependent.get() });
      dependent.get();
      assert.equal(measurements, 1);

      // The tilt goes on: the crossing re-measures, once and not per frame.
      card.style.transform = "matrix(1.026, 0.09, -0.09, 1.026, 0, 0)";
      mirror.attributeChanged(card);
      const afterCrossing = measurements;
      assert.ok(afterCrossing > 1, "crossing into a transform re-measures the subtree");

      // The transition runs. The clock samples styles every frame, and none
      // of those frames measures anything.
      for (let frame = 0; frame < 5; frame++) {
        mirror.animatedStyles([card]);
      }
      assert.equal(measurements, afterCrossing, "a transform in flight costs nothing per frame");

      // And it lands. This is the same style sample as every frame before it
      // — the only thing that makes it different is that the answer changed.
      card.style.transform = "";
      mirror.animatedStyles([card]);
      assert.equal(
        measurements,
        afterCrossing + 1,
        "the size taken under the transform is no longer usable",
      );

      subscription.unsubscribe();
    } finally {
      window.getComputedStyle = original;
      portal.remove();
    }
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
    const mirror = createMirror();
    mirror.adopt(parent);
    mirror.adopt(textNode);

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
    // What a layout animation does to a line of text: the whole subtree
    // slides, so the measurement has to run again, and every number it
    // yields is the number it yielded before. Rasterizing a texture is the
    // expensive thing hanging off these, and it must not re-run.
    let shifted = 0;
    let measurements = 0;
    // jsdom implements no Range geometry, and a `DOMRect` is what a browser
    // hands back here — an instance of a class, which is exactly the thing
    // the selector proxy cannot look inside. Taken off `window`, because that
    // is where jsdom puts it.
    const rect = () => new window.DOMRect(10, 20 - shifted, 30, 12);

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
    // The parent moves with the text it contains, which is the whole reason
    // the text's own position within it does not change.
    layout(parent, () => [0, -shifted, 100, 100 - shifted]);

    const mirror = createMirror();
    mirror.adopt(parent);
    mirror.adopt(textNode);

    const textLayout = selector(() => getTextLayout(textNode));

    let rasters = 0;
    const texture = new Derived(() => {
      rasters++;
      return `${textLayout.bounds.width}x${textLayout.bounds.height}/${textLayout.lines.length}`;
    });

    // Subscribed, because that is how the mirror reads this — an effect
    // hanging off the texture — and because equality only gets a chance to
    // stop anything on a graph something is actually watching.
    /** @type {string[]} */
    const drawn = [];
    const subscription = toObservable(texture).subscribe((value) => drawn.push(value));

    try {
      assert.deepEqual(drawn, ["30x12/1"]);
      assert.deepEqual({ measurements, rasters }, { measurements: 1, rasters: 1 });

      shifted = 8;
      mirror.reflowed([parent]);

      // Re-measured, because a subtree that moved is a subtree that has to
      // be read again…
      assert.equal(measurements, 2);
      // …the text is still where it was in the space the mirror draws in…
      const moved = getTextLayout(textNode);
      assert.deepEqual({ left: moved.left, top: moved.top }, { left: 10, top: 20 });
      // …and the texture was drawn once, and stays drawn.
      assert.deepEqual(drawn, ["30x12/1"]);
      assert.equal(rasters, 1);
    } finally {
      subscription.unsubscribe();
      parent.remove();
      document.createRange = originalCreateRange;
    }
  });

  test("a scroll re-measures no text at all, however long the list is", () => {
    // The cost that used to scale with a list rather than with the part of
    // it on screen. Text is measured in its parent's *content* space —
    // relative to the border box plus the scroll offset — so a scroller
    // sliding its content cannot change any number the measurement reports,
    // and it is not run: not for a row's label, and not even for text
    // sitting directly in the scroller, whose position in the old
    // client-rect terms really did change.
    /** @type {Set<Node>} */
    const measured = new Set();
    const originalCreateRange = document.createRange;
    let scrollTop = 0;
    const rect = () => ({
      left: 10,
      top: 20 - scrollTop,
      right: 40,
      bottom: 32 - scrollTop,
      width: 30,
      height: 12,
    });
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
    // nearly all of its text — and text sitting directly in the scroller.
    const scroller = document.createElement("div");
    const row = document.createElement("div");
    const label = document.createTextNode("hello world");
    row.appendChild(label);
    scroller.appendChild(row);
    document.body.appendChild(scroller);
    const loose = document.createTextNode("directly inside");
    scroller.appendChild(loose);

    layout(scroller, () => [0, 0, 200, 100]);
    layout(row, () => [0, 20 - scrollTop, 200, 60 - scrollTop]);
    scrollable(scroller, () => scrollTop);

    const mirror = createMirror();
    for (const node of [scroller, row, label, loose]) {
      mirror.adopt(node);
    }

    const layouts = [
      new Derived(() => getTextLayout(label)),
      new Derived(() => getTextLayout(loose)),
    ];
    const subscriptions = layouts.map((textLayout) =>
      textLayout.subscribe({ next: () => textLayout.get() }),
    );

    try {
      assert.deepEqual(measured, new Set([label, loose]), "both measured to begin with");
      const before = layouts.map((textLayout) => textLayout.get());

      measured.clear();
      scrollTop = 50;
      mirror.scrolled(scroller);
      assert.deepEqual(measured, new Set(), "a scroll measures nothing");
      assert.deepEqual(
        layouts.map((textLayout) => textLayout.get()),
        before,
        "and the content-space numbers are still right",
      );

      // Anything that can genuinely re-break lines still re-measures both.
      measured.clear();
      mirror.reflowed(null);
      assert.deepEqual(measured, new Set([label, loose]));

      measured.clear();
      mirror.childListChanged(scroller);
      assert.deepEqual(measured, new Set([label, loose]));
    } finally {
      subscriptions.forEach((subscription) => subscription.unsubscribe());
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
  let rectReads = 0;

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

  const mirror = createMirror();
  for (const node of [container, scroller, row, label]) {
    mirror.adopt(node);
  }

  const count = () => {
    rectReads += 1;
  };
  layout(container, () => [0, 0, 200, 100], { count });
  layout(scroller, () => [0, 0, 200, scrollerBottom], { count });
  layout(row, () => [0, 20 - scrollTop, 200, 60 - scrollTop], { count });
  scrollable(scroller, () => scrollTop);

  return {
    container,
    scroller,
    row,
    label,
    rectReads: () => rectReads,
    /** What a scroll does to a layout: the content moves, the window does not. */
    scrollBy: (/** @type {number} */ delta) => {
      scrollTop += delta;
      mirror.scrolled(scroller);
    },
    /** A change that does move the window, for contrast. */
    resizeTo: (/** @type {number} */ bottom) => {
      scrollerBottom = bottom;
      mirror.childListChanged(container);
    },
  };
}

describe("clip boxes", () => {
  test("a scroller confines its descendants to its padding box", () => {
    const { container, scroller, row } = setupScroller();
    try {
      // The window itself, in the scroller's own frame: inside the border,
      // where overflow is clipped, rounded by the border-box radius less the
      // border sitting in front of it.
      const window_ = getInteriorClipBox(scroller);
      assert.equal(window_.left, 2);
      assert.equal(window_.top, 2);
      assert.equal(window_.right, 198);
      assert.equal(window_.bottom, 98);
      assert.equal(window_.topLeft, 8);

      // The same window read in the row's frame: the row starts 20px down
      // the scroller, so the window sits 18px above the row's own origin.
      const clip = getLocalClipBox(row);
      assert.equal(clip.left, 2);
      assert.equal(clip.top, -18);
      assert.equal(clip.right, 198);
      assert.equal(clip.bottom, 78);
      assert.equal(clip.topLeft, 8);
    } finally {
      container.remove();
    }
  });

  test("the walk stops at the portal's container, not at the page around it", () => {
    const { container, scroller } = setupScroller();
    document.body.style.overflow = "hidden";
    try {
      // Whatever the page does with `body` is none of a panel's business —
      // and in a browserless layout its rect is all zeros, which would clip
      // the panel away to nothing if it were consulted.
      assert.equal(getLocalClipBox(scroller), UNCLIPPED);
      assert.equal(getInteriorClipBox(scroller).right, 198);
    } finally {
      document.body.style.overflow = "";
      container.remove();
    }
  });

  test("a scroll shifts the clip by arithmetic, and measures nothing", () => {
    const { container, row, rectReads, scrollBy, resizeTo } = setupScroller();
    try {
      const clip = new Derived(() => getLocalClipBox(row));
      const position = new Derived(() => getContentPosition(row));
      let clipEmissions = 0;
      let positionEmissions = 0;
      const subscriptions = [
        clip.subscribe({ next: () => clipEmissions++ }),
        position.subscribe({ next: () => positionEmissions++ }),
      ];
      assert.deepEqual(position.get(), { x: 0, y: 20 }, "content-space position");
      assert.equal(clip.get().top, -18);
      const readsBefore = rectReads();

      scrollBy(50);

      // The stored geometry — the window in its owner's frame, the row's
      // content-space position — is scroll-invariant, so nothing was
      // measured: the box the shader needs is the cached window shifted by
      // the offset, and that is the only thing that changed.
      assert.equal(rectReads(), readsBefore, "a scroll reads no rects");
      assert.deepEqual(position.get(), { x: 0, y: 20 }, "the row has not moved in content space");
      assert.equal(positionEmissions, 0, "and nothing downstream of its position hears anything");
      assert.equal(clip.get().top, 32, "the window slides the other way in the row's frame");
      assert.equal(clip.get().bottom, 128);
      assert.equal(clipEmissions, 1);

      // The window itself changing is a different matter: a re-layout
      // re-measures, and the new bottom lands in the row's frame.
      resizeTo(60);
      assert.equal(clip.get().bottom, 88);
      assert.equal(clipEmissions, 2);

      subscriptions.forEach((subscription) => subscription.unsubscribe());
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

  const mirror = createMirror();
  for (const node of [container, anchor, scroller, row, menu]) {
    mirror.adopt(node);
  }

  layout(anchor, () => [5, 5, 195, 95]);
  layout(scroller, () => [10, 10, 190, 90]);

  return { container, scroller, row, menu };
}

describe("clip boxes and positioned elements", () => {
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
      assert.equal(getLocalClipBox(row).left, 10, "the row is the scroller's to clip");
      assert.equal(getLocalClipBox(menu), UNCLIPPED);
    } finally {
      container.remove();
    }
  });

  test("a containing block inside the scroller keeps the menu clipped", () => {
    // The other common arrangement: the anchor is the row itself. The menu
    // then lives inside the scroller the way the row does, and scrolls away
    // with it. (Both boxes come out in coincident frames here — jsdom gives
    // the unmeasured row and menu the same zero rect — which is what lets
    // the boxes be compared directly.)
    const { container, row, menu } = setupPositioned(
      "",
      "position: relative",
      "position: absolute; z-index: 1",
    );
    try {
      assert.deepEqual(getLocalClipBox(menu), getLocalClipBox(row));
      assert.equal(getLocalClipBox(menu).left, 10);
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
      const clip = getLocalClipBox(menu);
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
      assert.equal(getLocalClipBox(menu), UNCLIPPED);
    } finally {
      container.remove();
    }
  });

  test("a menu anchored above a scroller holds still while its trigger scrolls away", () => {
    // The scene hangs the menu's object under its DOM parent — the row —
    // whose content group slides with the scroll. The menu's box hangs off
    // the anchor, which does not move; so the menu's own position has to
    // slide the other way, by exactly the scroll, computed from the cached
    // measurement without touching the DOM.
    let scrollTop = 0;
    let rectReads = 0;
    const count = () => {
      rectReads += 1;
    };

    const container = document.createElement("div");
    container.setAttribute(PORTAL_ATTRIBUTE, "");
    const anchor = document.createElement("div");
    anchor.style.cssText = "position: relative";
    const scroller = document.createElement("div");
    scroller.style.overflow = "hidden";
    const row = document.createElement("div");
    const menu = document.createElement("div");
    menu.style.cssText = "position: absolute; z-index: 1";

    row.appendChild(menu);
    scroller.appendChild(row);
    anchor.appendChild(scroller);
    container.appendChild(anchor);
    document.body.appendChild(container);

    const mirror = createMirror();
    for (const node of [container, anchor, scroller, row, menu]) {
      mirror.adopt(node);
    }

    layout(anchor, () => [0, 0, 200, 200], { count });
    layout(scroller, () => [0, 0, 200, 100], { count });
    layout(row, () => [0, 10 - scrollTop, 200, 50 - scrollTop], { count });
    // Anchored above the scroller, so a real browser would not move it on a
    // scroll — which is the fact under test.
    layout(menu, () => [10, 20, 110, 60], { count });
    scrollable(scroller, () => scrollTop);

    try {
      const position = new Derived(() => getObjectPosition(menu));
      const subscription = position.subscribe({ next: () => position.get() });

      // In the row's content frame: the menu sits 10px right of and 10px
      // below the row's border-box origin.
      assert.deepEqual(position.get(), { x: 10, y: 10 });
      const readsBefore = rectReads;

      scrollTop = 30;
      mirror.scrolled(scroller);

      // The row's content group slid up by 30, so holding still means
      // sitting 30 lower in it — pure arithmetic on the cached measurement.
      assert.deepEqual(position.get(), { x: 10, y: 40 });
      assert.equal(rectReads, readsBefore, "compensating a scroll reads no rects");

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });
});
