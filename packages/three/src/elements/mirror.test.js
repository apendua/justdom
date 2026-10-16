import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { batch, Computation, Derived, Effect, selector, toObservable } from "@apendua/signal";
import {
  createMirror,
  getCheckedCached,
  getChildNodes,
  getBorderBoxSize,
  getComputedStyleCached,
  getContentPosition,
  getInteriorClipBox,
  getLocalClipBox,
  getObjectPosition,
  getTextLayout,
  isTransformed,
  resetMeasuringRangeForTests,
  trackCharacterEdges,
  tracksCharacterEdges,
} from "./mirror.js";
import { PORTAL_ATTRIBUTE } from "./portalRoot.js";
import { UNCLIPPED } from "./clip.js";
import { SVG_NAMESPACE } from "./plugins.js";
import { stagedRoot } from "../test/stagedRoot.js";

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
 * Stand in for the range text is measured with, which jsdom gives no
 * geometry. Every rect the range reports is `rect()`, and its line boxes are
 * that one rect; without `rect` it reports an empty range, no size and no
 * line boxes.
 *
 * @param {{ onSelect?: (node: Node) => void, rect?: () => DOMRectReadOnly }} [options]
 *   `onSelect` hears each node the range is pointed at, which is one per
 *   measurement.
 * @returns {() => void} Puts the document's own `createRange` back.
 */
function stubMeasuringRange({ onSelect, rect } = {}) {
  const original = document.createRange;
  resetMeasuringRangeForTests();
  const empty = () =>
    /** @type {DOMRect} */ ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  document.createRange = () =>
    /** @type {Range} */ (
      /** @type {unknown} */ ({
        selectNodeContents: (/** @type {Node} */ node) => onSelect?.(node),
        setStart: () => {},
        setEnd: () => {},
        getBoundingClientRect: rect ?? empty,
        getClientRects: () =>
          /** @type {DOMRectList} */ (/** @type {unknown} */ (rect ? [rect()] : [])),
      })
    );
  return () => {
    document.createRange = original;
    resetMeasuringRangeForTests();
  };
}

/**
 * Read `text`'s layout the way the mirror does, from an effect that holds it
 * until `dispose`, so that what the layout reads is held with it.
 *
 * @param {Text} text
 */
function holdTextLayout(text) {
  /** @type {import("./mirror.js").TextLayout | undefined} */
  let layout;
  const effect = new Effect(() => {
    layout = getTextLayout(text);
  });
  return {
    get layout() {
      return /** @type {import("./mirror.js").TextLayout} */ (layout);
    },
    dispose: () => effect.dispose(),
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
      const holder = new Effect(() => {
        seen.push(dependent.get());
      });
      assert.equal(dependent.get(), "rgb(1, 2, 3)");

      element.style.backgroundColor = "rgb(4, 5, 6)";
      mirror.attributeChanged(element);

      assert.equal(dependent.get(), "rgb(4, 5, 6)");
      holder.dispose();
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
    // An `Effect` holds each dependent open *and* pulls it. A bare
    // subscription does neither any more: it hears that the value may have
    // moved and never asks what it is, so nothing would be counted. What
    // these tests measure — which mutations reach which elements — is
    // exactly what re-runs an effect.
    const holders = Object.values(dependents).map((dependent) => new Effect(() => dependent.get()));
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

    // The animation clock's per-frame sample reaches the target's subtree.
    mirror.animatedStyles([leafA]);
    assert.deepEqual(reads, { leafA: 5, leafB: 3 });

    holders.forEach((effect) => effect.dispose());
    root.remove();
  });

  test("a presentational change restyles its own subtree, not its siblings", () => {
    // list
    // ├── rowA ── labelA
    // └── rowB ── labelB
    //
    // The shape that matters: hovering one row of a list must not cost the
    // other rows. Under the ordinary scope it does — `~` and `+` can restyle
    // a sibling, so a mutation on rowA reaches everything under `list` — and
    // in a long list that is the whole panel, on every row the ray crosses.
    const list = document.createElement("div");
    const rowA = document.createElement("div");
    const rowB = document.createElement("div");
    const labelA = document.createElement("span");
    const labelB = document.createElement("span");
    rowA.appendChild(labelA);
    rowB.appendChild(labelB);
    list.appendChild(rowA);
    list.appendChild(rowB);
    document.body.appendChild(list);

    const mirror = createMirror();
    for (const node of [list, rowA, rowB, labelA, labelB]) {
      mirror.adopt(node);
    }

    const reads = { labelA: 0, labelB: 0 };
    const dependents = {
      labelA: new Derived(() => {
        reads.labelA += 1;
        return getComputedStyleCached(labelA).color;
      }),
      labelB: new Derived(() => {
        reads.labelB += 1;
        return getComputedStyleCached(labelB).color;
      }),
    };
    // An `Effect` holds each dependent open *and* pulls it. A bare
    // subscription does neither any more: it hears that the value may have
    // moved and never asks what it is, so nothing would be counted. What
    // these tests measure — which mutations reach which elements — is
    // exactly what re-runs an effect.
    const holders = Object.values(dependents).map((dependent) => new Effect(() => dependent.get()));
    assert.deepEqual(reads, { labelA: 1, labelB: 1 });

    // An author's attribute on rowA can restyle rowB — that is what the
    // sibling half of the scope is for.
    mirror.attributeChanged(rowA);
    assert.deepEqual(reads, { labelA: 2, labelB: 2 });

    // Hover and press cannot: they are declared unable to style across a
    // sibling combinator, so the hover stops at rowA's subtree. labelA still
    // restyles — descendants inherit from what changed.
    mirror.attributeChanged(rowA, { presentational: true, selfScoped: true });
    assert.deepEqual(reads, { labelA: 3, labelB: 2 });

    // Hover styling is conventionally transitioned, so the clock re-reports
    // the hovered row on every frame the transition runs. Those frames are
    // scoped the same way, or the narrowing above would buy nothing.
    mirror.animatedStyles([rowA]);
    assert.deepEqual(reads, { labelA: 4, labelB: 2 });

    // A tick is presentational but not self-scoped, and the difference is
    // deliberate: `input:checked + label` is how a checkbox has always
    // struck through the thing it labels, and the flag exists to mirror
    // `:checked`. So it measures nothing and still reaches its siblings.
    mirror.attributeChanged(rowA, { presentational: true });
    assert.deepEqual(reads, { labelA: 5, labelB: 3 });

    holders.forEach((effect) => effect.dispose());
    list.remove();
  });

  test("an animation of nothing inherited restyles the element alone", () => {
    // card ─┬─ "text"
    //       └── label ── "inner"
    //
    // A card turning under a CSS transform: the transform is not inherited,
    // so no computed value under the card moves, and the clock says so by
    // asking for the element alone. At the subtree scope every frame of the
    // turn restyled the whole card.
    const card = document.createElement("div");
    const text = document.createTextNode("text");
    const label = document.createElement("span");
    label.appendChild(document.createTextNode("inner"));
    card.appendChild(text);
    card.appendChild(label);
    document.body.appendChild(card);

    const mirror = createMirror();
    for (const node of [card, text, label]) {
      mirror.adopt(node);
    }

    const reads = { card: 0, text: 0, label: 0 };
    const dependents = {
      card: new Derived(() => {
        reads.card += 1;
        return getComputedStyleCached(card).transform;
      }),
      // A text node's computed style is its parent's, so it has to follow
      // its parent's own changes too.
      text: new Derived(() => {
        reads.text += 1;
        return getComputedStyleCached(text).transform;
      }),
      label: new Derived(() => {
        reads.label += 1;
        return getComputedStyleCached(label).color;
      }),
    };
    const holders = Object.values(dependents).map((dependent) => new Effect(() => dependent.get()));
    assert.deepEqual(reads, { card: 1, text: 1, label: 1 });

    mirror.animatedStyles([card], { subtree: false });
    assert.deepEqual(reads, { card: 2, text: 2, label: 1 });

    // The subtree scope, for an animation that does reach the descendants.
    mirror.animatedStyles([card]);
    assert.deepEqual(reads, { card: 3, text: 3, label: 2 });

    holders.forEach((effect) => effect.dispose());
    card.remove();
  });

  test("a descendant still sees an ancestor's transform move under the narrow scope", () => {
    // What a descendant does derive from an ancestor's style it reads through
    // the ancestor's own memoized style — `isTransformed` above all — and
    // that is what the narrow scope still invalidates.
    const card = document.createElement("div");
    const label = document.createElement("span");
    card.appendChild(label);
    document.body.appendChild(card);

    const mirror = createMirror();
    for (const node of [card, label]) {
      mirror.adopt(node);
    }

    const transformed = new Derived(() => isTransformed(label));
    const holder = new Effect(() => transformed.get());
    assert.equal(transformed.get(), false);

    // Written as the browser resolves it, which jsdom does not do.
    card.style.transform = "matrix(0.996, 0.087, -0.087, 0.996, 0, 0)";
    mirror.animatedStyles([card], { subtree: false });
    assert.equal(transformed.get(), true);

    holder.dispose();
    card.remove();
  });

  test("which flag it is decides whether a sibling restyles", () => {
    // The test above drives `attributeChanged` directly, so it proves what
    // the two scopes do and nothing about which attribute gets which. This
    // one goes in through `ingest`, where the attribute's *name* is what
    // picks the scope — the difference between the two sets, which is the
    // part a wrong entry would silently undo.
    const list = document.createElement("div");
    const rowA = document.createElement("div");
    const rowB = document.createElement("div");
    list.appendChild(rowA);
    list.appendChild(rowB);
    document.body.appendChild(list);

    const mirror = createMirror();
    for (const node of [list, rowA, rowB]) {
      mirror.adopt(node);
    }

    let reads = 0;
    const sibling = new Derived(() => {
      reads += 1;
      return getComputedStyleCached(rowB).color;
    });
    const subscription = sibling.subscribe({ next: () => sibling.get() });
    sibling.get();
    assert.equal(reads, 1);

    /** @param {string} name */
    const wrote = (name) => {
      rowA.setAttribute(name, "true");
      return attributeRecord(rowA, name, null);
    };

    // Same element, same position in the tree, so the attribute's name is
    // the only thing that differs between these two.
    batch(() => mirror.ingest([wrote("data-xr-hover")]));
    assert.equal(reads, 1, "a hover does not reach its sibling");

    batch(() => mirror.ingest([wrote("data-xr-active")]));
    assert.equal(reads, 1, "nor does a press");

    batch(() => mirror.ingest([wrote("data-xr-focus")]));
    assert.equal(reads, 1, "nor does the keyboard's focus");

    batch(() => mirror.ingest([wrote("data-xr-checked")]));
    assert.equal(reads, 2, "a tick does — `input:checked + label` is the point");

    batch(() => mirror.ingest([wrote("class")]));
    assert.equal(reads, 3, "and an author's attribute always has");

    subscription.unsubscribe();
    list.remove();
  });

  test("a shape's geometry restyles the shape, not its siblings", () => {
    // page
    // ├── svg ─┬── circleA
    // │        ├── circleB
    // │        └── inner (a nested <svg>)
    // └── aside
    //
    // A drawing that moves writes `cx` and the like on many shapes a frame,
    // and under the ordinary scope each one restyled every shape beside it.
    // The root's `width` sizes a CSS box in the page, and is not narrowed;
    // nor is the same name on an HTML element.
    const page = document.createElement("div");
    const svg = document.createElementNS(SVG_NAMESPACE, "svg");
    const circleA = document.createElementNS(SVG_NAMESPACE, "circle");
    const circleB = document.createElementNS(SVG_NAMESPACE, "circle");
    const inner = document.createElementNS(SVG_NAMESPACE, "svg");
    const aside = document.createElement("div");
    svg.appendChild(circleA);
    svg.appendChild(circleB);
    svg.appendChild(inner);
    page.appendChild(svg);
    page.appendChild(aside);
    document.body.appendChild(page);

    const mirror = createMirror();
    for (const node of [page, svg, circleA, circleB, inner, aside]) {
      mirror.adopt(node);
    }

    const reads = { svg: 0, circleA: 0, circleB: 0, aside: 0 };
    /** @param {keyof typeof reads} key @param {Element} element */
    const follow = (key, element) =>
      new Effect(() => {
        reads[key] += 1;
        getComputedStyleCached(element);
      });
    const holders = [
      follow("svg", svg),
      follow("circleA", circleA),
      follow("circleB", circleB),
      follow("aside", aside),
    ];
    assert.deepEqual(reads, { svg: 1, circleA: 1, circleB: 1, aside: 1 });

    /** @param {Element} target @param {string} name */
    const wrote = (target, name) => {
      const oldValue = target.getAttribute(name);
      target.setAttribute(name, `${Number(oldValue ?? 0) + 1}`);
      return attributeRecord(target, name, oldValue);
    };

    batch(() =>
      mirror.ingest([
        wrote(circleA, "cx"),
        wrote(circleA, "r"),
        wrote(circleA, "dx"),
        wrote(circleA, "dy"),
        wrote(circleA, "rotate"),
        wrote(circleA, "transform"),
      ]),
    );
    assert.deepEqual(
      reads,
      { svg: 1, circleA: 2, circleB: 1, aside: 1 },
      "geometry stops at the shape",
    );

    batch(() => mirror.ingest([wrote(inner, "width")]));
    assert.deepEqual(
      reads,
      { svg: 1, circleA: 2, circleB: 1, aside: 1 },
      "a nested <svg>'s width is geometry too",
    );

    batch(() => mirror.ingest([wrote(circleA, "cx"), wrote(circleA, "class")]));
    assert.deepEqual(
      reads,
      { svg: 1, circleA: 3, circleB: 2, aside: 1 },
      "an author's class in the same flush still reaches the siblings",
    );

    batch(() => mirror.ingest([wrote(svg, "width")]));
    assert.deepEqual(
      reads,
      { svg: 2, circleA: 4, circleB: 3, aside: 2 },
      "the root's width reaches what is beside it in the page",
    );

    batch(() => mirror.ingest([wrote(aside, "width")]));
    assert.deepEqual(
      reads,
      { svg: 3, circleA: 5, circleB: 4, aside: 3 },
      "and so does the same name on an HTML element",
    );

    holders.forEach((effect) => effect.dispose());
    page.remove();
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
    // An effect, not a subscription: what makes two records one recompute is
    // the queue collapsing the effect's two invalidations into one run, and
    // a bare subscription does not go near the queue.
    const holder = new Effect(() => dependent.get());
    assert.equal(reads, 1);

    /** @param {string | null} oldValue */
    const record = (oldValue) => attributeRecord(element, "data-xr-hover", oldValue);

    // The value is "true" and was "true" before: not a change.
    batch(() => mirror.ingest([record("true")]));
    assert.equal(reads, 1, "re-asserting an attribute costs nothing");

    // Went somewhere and came back within one flush: still not a change.
    batch(() => mirror.ingest([record("true"), record("gone")]));
    assert.equal(reads, 1, "a round trip within one flush costs nothing");

    // And an actual change still lands.
    batch(() => mirror.ingest([record("false")]));
    assert.equal(reads, 2);

    holder.dispose();
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
    const holders = [new Effect(() => style.get()), new Effect(() => geometry.get())];
    assert.deepEqual({ styleReads, rectReads }, { styleReads: 1, rectReads: 1 });

    /**
     * @param {string} name
     * @param {string | null} oldValue
     */
    const record = (name, oldValue) => attributeRecord(element, name, oldValue);

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

    holders.forEach((effect) => effect.dispose());
    element.remove();
  });

  test("press, checked and focus are presentational too, and disabled is not", () => {
    // Every attribute the portal observes, and which side of the contract it
    // falls on. The four the portal writes itself to report what the ray and
    // the keyboard are doing are presentational; the three that belong to
    // the author — and `disabled` is one of them, a reflected DOM attribute
    // an application sets — keep the right to have moved the layout.
    const cases = [
      { name: "data-xr-hover", measures: false },
      { name: "data-xr-active", measures: false },
      { name: "data-xr-checked", measures: false },
      { name: "data-xr-focus", measures: false },
      { name: "disabled", measures: true },
      { name: "class", measures: true },
      { name: "style", measures: true },
    ];

    for (const { name, measures } of cases) {
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
      const holders = [new Effect(() => style.get()), new Effect(() => geometry.get())];

      element.setAttribute(name, "on");
      batch(() => mirror.ingest([attributeRecord(element, name, null)]));

      // Everything restyles — that half is never in question.
      assert.equal(styleReads, 2, `${name} restyles`);
      assert.equal(
        rectReads,
        measures ? 2 : 1,
        measures ? `${name} may have moved the layout` : `${name} is presentational`,
      );

      holders.forEach((effect) => effect.dispose());
      element.remove();
    }
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
    // An effect, not a subscription: what makes two records one recompute is
    // the queue collapsing the effect's two invalidations into one run, and
    // a bare subscription does not go near the queue.
    const holder = new Effect(() => dependent.get());
    assert.equal(reads, 1);

    /** @param {Element} target */
    const record = (target) => attributeRecord(target, "class", "was");

    // Two mutations, two elements, one flush — the portal wraps ingest in
    // batch(), so a dependent watching both recomputes once, not once per
    // record.
    batch(() => mirror.ingest([record(first), record(second)]));
    assert.equal(reads, 2, "two records, one recompute");

    holder.dispose();
    first.remove();
    second.remove();
  });
});

describe("measured geometry", () => {
  test("an attribute change re-measures its target's subtree and what follows it", () => {
    // An attribute can toggle a CSS transform, which changes the client
    // rects of exactly the mutated element's subtree, or change the
    // element's box, which moves the boxes after it. In block flow what
    // comes before it cannot have moved; a flex row is the test below.
    const earlier = document.createElement("div");
    const parent = document.createElement("div");
    const child = document.createElement("div");
    const sibling = document.createElement("div");
    parent.appendChild(child);
    document.body.appendChild(earlier);
    document.body.appendChild(parent);
    document.body.appendChild(sibling);

    const mirror = createMirror();
    for (const node of [earlier, parent, child, sibling]) {
      mirror.adopt(node);
    }

    // What is counted is the measurement itself — the rect read — not what
    // propagates from it: a re-measure that lands on the same numbers is
    // deliberately silent downstream, and that silence is half the design.
    const reads = { earlier: 0, child: 0, sibling: 0 };
    layout(earlier, () => [0, -20, 10, -10], { count: () => reads.earlier++ });
    layout(child, () => [0, 0, 10, 10], { count: () => reads.child++ });
    layout(sibling, () => [0, 20, 10, 30], { count: () => reads.sibling++ });

    const dependents = {
      earlier: new Derived(() => getContentPosition(earlier)),
      child: new Derived(() => getContentPosition(child)),
      sibling: new Derived(() => getContentPosition(sibling)),
    };
    // An `Effect` holds each dependent open *and* pulls it. A bare
    // subscription does neither any more: it hears that the value may have
    // moved and never asks what it is, so nothing would be counted. What
    // these tests measure — which mutations reach which elements — is
    // exactly what re-runs an effect.
    const holders = Object.values(dependents).map((dependent) => new Effect(() => dependent.get()));
    assert.deepEqual(reads, { earlier: 1, child: 1, sibling: 1 });

    // A transform toggled on parent moves child's rect, and a size changed
    // by the attribute would move the sibling after it, which re-measures
    // its own box. The element before it stays cached.
    mirror.attributeChanged(parent);
    assert.deepEqual(reads, { earlier: 1, child: 2, sibling: 2 });

    // A structural change moves what follows it the same way.
    mirror.childListChanged(parent);
    assert.deepEqual(reads, { earlier: 1, child: 3, sibling: 3 });

    // The clock's style sample alone moves no rects…
    mirror.animatedStyles([parent]);
    assert.deepEqual(reads, { earlier: 1, child: 3, sibling: 3 });

    // …an animating transform moves its own subtree's…
    mirror.reflowed([parent]);
    assert.deepEqual(reads, { earlier: 1, child: 4, sibling: 3 });

    // …and an animating layout property moves anybody's.
    mirror.reflowed(null);
    assert.deepEqual(reads, { earlier: 2, child: 5, sibling: 4 });

    // An image arriving takes the size the picture turned out to have and
    // pushes everything after it along, so it re-measures the portal — the
    // same shape of event as a font arriving.
    mirror.contentLoaded();
    assert.deepEqual(reads, { earlier: 3, child: 6, sibling: 5 });

    holders.forEach((effect) => effect.dispose());
    earlier.remove();
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
    const restoreRange = stubMeasuringRange({ onSelect: (node) => measured.push(node) });

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
      const held = holdTextLayout(textNode);
      assert.deepEqual(held.layout.lines, []);
      // The measurement ran against a clone's text, not the live node…
      assert.equal(measured.length, 1);
      assert.notEqual(measured[0], textNode);
      assert.equal(measured[0].textContent, "hello world");
      // …the live parent was never touched — no attributes, no style writes
      // a `transition: transform` could smooth into a lie…
      assert.equal(parent.style.transform, "matrix(2, 0, 0, 2, 0, 0)");
      // …and the clone did not outlive the last reader of the layout.
      held.dispose();
      assert.equal(document.body.childElementCount, childrenBefore);
    } finally {
      parent.remove();
      restoreRange();
    }
  });

  /**
   * Measure `text` through `getTextLayout` with the range stubbed, and
   * report the copy it was measured in, read while the copy is still in
   * the document: its text node, and the top of it, the child of the body
   * it was parked as. The copy is gone by the time this returns.
   *
   * @param {Text} text
   * @param {() => DOMRectReadOnly} [rect]
   */
  function measureThroughCopy(text, rect) {
    /** @type {Array<{ text: Node, root: HTMLElement }>} */
    const copies = [];
    const restoreRange = stubMeasuringRange({
      rect,
      onSelect: (node) => {
        let root = /** @type {HTMLElement} */ (node.parentElement);
        while (root.parentElement && root.parentElement !== document.body) {
          root = root.parentElement;
        }
        copies.push({ text: node, root });
      },
    });
    const childrenBefore = document.body.childElementCount;
    try {
      const held = holdTextLayout(text);
      const layout = held.layout;
      held.dispose();
      assert.equal(copies.length, 1);
      assert.notEqual(copies[0].text, text);
      assert.equal(copies[0].text.textContent, text.textContent);
      assert.equal(document.body.childElementCount, childrenBefore);
      return { layout, ...copies[0] };
    } finally {
      restoreRange();
    }
  }

  /**
   * A tilted card, `150px` wide, holding an `<i>`, the label `<span>` with
   * `text` in it, and a `<b>` after it, adopted by a mirror.
   *
   * @param {string} text
   */
  function tiltedCard(text) {
    const card = document.createElement("div");
    card.className = "card";
    card.style.width = "150px";
    card.style.transform = "matrix(0.996, 0.087, -0.087, 0.996, 0, 0)";
    const label = document.createElement("span");
    const textNode = document.createTextNode(text);
    label.appendChild(textNode);
    card.append(document.createElement("i"), label, document.createElement("b"));
    document.body.appendChild(card);
    const mirror = createMirror();
    mirror.adopt(card);
    mirror.adopt(label);
    mirror.adopt(textNode);
    return { card, label, textNode };
  }

  test("text in an inline parent is measured in a copy of the box its lines are in", () => {
    // The span's computed width is `auto`, so a copy of the span alone would
    // be laid out in the body with nothing to wrap against, and its text
    // would come back on one line. The copy has to be of the card, whose
    // width the lines break at.
    const { card, textNode } = tiltedCard("a note long enough to wrap");
    try {
      const { text, root } = measureThroughCopy(textNode);
      const label = /** @type {HTMLElement} */ (text.parentNode);
      assert.equal(label.localName, "span");
      assert.equal(label.parentNode, root);
      assert.notEqual(root, card);
      assert.equal(root.className, "card");
      assert.equal(root.style.width, "150px");
    } finally {
      card.remove();
    }
  });

  test("the copy holds everything the line box lays out, after the text too", () => {
    // What follows the text places it: it aligns the last line, takes space
    // in a flex box, and decides where a word running on past it breaks.
    const { card, textNode } = tiltedCard("a note");
    try {
      const { root } = measureThroughCopy(textNode);
      assert.deepEqual(
        Array.from(root.children, (child) => child.localName),
        ["i", "span", "b"],
      );
    } finally {
      card.remove();
    }
  });

  test("the inline parent's animations and transitions are off in the copy", () => {
    // An animation would start again on the copy at its first keyframe and
    // beat the resolved value copied onto it.
    const { card, label, textNode } = tiltedCard("a note");
    label.style.animation = "grow 2s infinite";
    label.style.transition = "letter-spacing 1s";
    try {
      const { text } = measureThroughCopy(textNode);
      const copy = /** @type {HTMLElement} */ (text.parentNode);
      for (const property of ["animation", "transition"]) {
        assert.equal(copy.style.getPropertyValue(property), "none", property);
        assert.equal(copy.style.getPropertyPriority(property), "important", property);
      }
    } finally {
      card.remove();
    }
  });

  test("the inline parent keeps its resolved style in the copy", () => {
    // A rule that reaches above the card matches the live span and not the
    // span in a copy parked in the body, so what it sets is copied over.
    const style = document.createElement("style");
    style.textContent = ".desk .card span { letter-spacing: 3px; }";
    document.head.appendChild(style);
    const desk = document.createElement("div");
    desk.className = "desk";
    const { card, textNode } = tiltedCard("a note");
    desk.appendChild(card);
    document.body.appendChild(desk);
    try {
      assert.equal(
        window.getComputedStyle(/** @type {Element} */ (textNode.parentElement)).letterSpacing,
        "3px",
      );
      const { text } = measureThroughCopy(textNode);
      assert.equal(/** @type {HTMLElement} */ (text.parentNode).style.letterSpacing, "3px");
    } finally {
      desk.remove();
      style.remove();
    }
  });

  test("the text's position is read against its own parent in the copy", () => {
    // The span starts 30px into the page and the card 10px; the text starts
    // at 50px. Measured against the span, as the untransformed path does, it
    // sits 20px in; against the card it would sit 40px in.
    const { card, textNode } = tiltedCard("a note");
    const original = window.HTMLElement.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      const left = this.localName === "span" ? 30 : 10;
      return new window.DOMRect(left, 0, 100, 20);
    };
    try {
      const { layout } = measureThroughCopy(textNode, () => new window.DOMRect(50, 4, 40, 12));
      assert.deepEqual({ left: layout.left, top: layout.top }, { left: 20, top: 4 });
    } finally {
      window.HTMLElement.prototype.getBoundingClientRect = original;
      card.remove();
    }
  });

  /**
   * A tilted card holding a `<span class="label">` with a text in it, a text
   * of the card's own, a `<b>` with a text, and an inline-block `<em>` with
   * a `<span class="inner">` and a text: four texts, three laid out in the
   * card's lines and one in the `<em>`'s, all adopted by a mirror.
   */
  function cardOfTexts() {
    const card = document.createElement("div");
    card.className = "card";
    card.style.width = "150px";
    card.style.transform = "matrix(0.996, 0.087, -0.087, 0.996, 0, 0)";
    const label = document.createElement("span");
    label.className = "label";
    const inLabel = document.createTextNode("in the label");
    label.appendChild(inLabel);
    const inCard = document.createTextNode(" in the card ");
    const bold = document.createElement("b");
    bold.className = "other";
    const inBold = document.createTextNode("in bold");
    bold.appendChild(inBold);
    const box = document.createElement("em");
    box.style.display = "inline-block";
    const inner = document.createElement("span");
    inner.className = "inner";
    const inBox = document.createTextNode("in a box of its own");
    inner.appendChild(inBox);
    box.appendChild(inner);
    card.append(label, inCard, bold, box);
    document.body.appendChild(card);
    const mirror = createMirror();
    for (const node of [card, label, inLabel, inCard, bold, inBold, box, inner, inBox]) {
      mirror.adopt(node);
    }
    return { card, mirror, texts: { inLabel, inCard, inBold, inBox } };
  }

  /**
   * Stub the range, and record the copy each measurement ran in: the child
   * of the body it was parked as.
   */
  function recordCopies() {
    /** @type {HTMLElement[]} */
    const roots = [];
    const restore = stubMeasuringRange({
      onSelect: (node) => {
        let root = /** @type {HTMLElement} */ (node.parentElement);
        while (root.parentElement && root.parentElement !== document.body) {
          root = root.parentElement;
        }
        roots.push(root);
      },
    });
    return { roots, restore };
  }

  /**
   * Tell `mirror` what `change` does to the DOM, as the portal's observer
   * would: the records a `MutationObserver` takes of it, ingested in a batch.
   *
   * @param {ReturnType<typeof createMirror>} mirror
   * @param {() => void} change
   */
  function changeAndIngest(mirror, change) {
    const observer = new window.MutationObserver(() => {});
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    });
    change();
    const records = observer.takeRecords();
    observer.disconnect();
    batch(() => mirror.ingest(records));
  }

  test("the texts of one line box share its copy, across tasks", async () => {
    // Measured in a copy each, the texts of a paragraph copy it once per
    // text, and a portal measures a panel a frame at a time. One copy serves
    // the box for as long as its texts are read, and a box of its own gets
    // its own.
    const { card, texts } = cardOfTexts();
    const { roots, restore } = recordCopies();
    const childrenBefore = document.body.childElementCount;
    try {
      const held = [holdTextLayout(texts.inLabel)];
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const text of [texts.inCard, texts.inBold, texts.inBox]) {
        held.push(holdTextLayout(text));
      }
      assert.equal(roots.length, 4);
      assert.equal(roots[0].className, "card");
      assert.equal(roots[1], roots[0]);
      assert.equal(roots[2], roots[0]);
      assert.equal(roots[3].localName, "em");
      assert.equal(document.body.childElementCount, childrenBefore + 2);
      // Parked in the page, kept out of focus and the accessibility tree.
      assert.equal(roots[0].hasAttribute("inert"), true);
      assert.equal(roots[0].getAttribute("aria-hidden"), "true");
      // A copy goes when the last text reading it lets go.
      held[0].dispose();
      held[1].dispose();
      assert.equal(roots[0].isConnected, true);
      held[2].dispose();
      assert.equal(roots[0].isConnected, false);
      held[3].dispose();
      assert.equal(document.body.childElementCount, childrenBefore);
    } finally {
      card.remove();
      restore();
    }
  });

  test("a change in the box rebuilds its copy, and a change elsewhere does not", () => {
    const { card, mirror, texts } = cardOfTexts();
    const elsewhere = document.createElement("div");
    const inside = document.createElement("span");
    elsewhere.appendChild(inside);
    document.body.appendChild(elsewhere);
    mirror.adopt(elsewhere);
    mirror.adopt(inside);
    const { roots, restore } = recordCopies();
    const held = [holdTextLayout(texts.inLabel), holdTextLayout(texts.inCard)];
    try {
      assert.equal(roots.length, 2);
      // A change elsewhere in the page moves nothing the copy holds.
      changeAndIngest(mirror, () => inside.setAttribute("data-moved", ""));
      assert.equal(roots.length, 2);
      // A change inside the box does, as deep in it as it is: both texts
      // are measured again, in a copy that has it, and the old copy is gone.
      const label = /** @type {HTMLElement} */ (texts.inLabel.parentElement);
      changeAndIngest(mirror, () => label.appendChild(document.createElement("u")));
      assert.equal(roots.length, 4);
      assert.notEqual(roots[2], roots[0]);
      assert.equal(roots[3], roots[2]);
      assert.equal(roots[2].querySelector(".label")?.lastElementChild?.localName, "u");
      assert.equal(roots[0].isConnected, false);
    } finally {
      held.forEach((reader) => reader.dispose());
      card.remove();
      elsewhere.remove();
      restore();
    }
  });

  test("a copy outlives what changes nothing it holds", async () => {
    // A portal adopts a panel a node at a time, frame after frame, and the
    // ray writes a hover flag on every element it crosses. Neither moves
    // what the copy was made from, so neither rebuilds it, even when the
    // one makes the box be read again with the other in it.
    const card = document.createElement("div");
    card.style.transform = "matrix(0.996, 0.087, -0.087, 0.996, 0, 0)";
    const first = document.createTextNode("first ");
    const link = document.createElement("a");
    const second = document.createTextNode("second");
    link.appendChild(second);
    card.append(first, link);
    document.body.appendChild(card);
    const mirror = createMirror();
    mirror.adopt(card);
    mirror.adopt(first);
    const { roots, restore } = recordCopies();
    const held = [holdTextLayout(first)];
    try {
      changeAndIngest(mirror, () => link.setAttribute("data-xr-hover", ""));
      // The rest of the box is adopted after the copy was made, and the
      // adoption is announced a microtask later.
      mirror.adopt(link);
      mirror.adopt(second);
      await Promise.resolve();
      held.push(holdTextLayout(second));
      assert.equal(roots.length, 2);
      assert.equal(roots[1], roots[0]);
      assert.equal(roots[0].isConnected, true);
    } finally {
      held.forEach((reader) => reader.dispose());
      card.remove();
      restore();
    }
  });

  test("a text replaced by one with the same characters is found in the copy", () => {
    // A clock label written every tick, or a re-render through `innerHTML`,
    // puts a new node where the old one was. The box's shape is the same,
    // so nothing need rebuild its copy, and the new node has to be found at
    // the old one's place. Not told to the mirror here, which is the state
    // of a box whose size the change did not move.
    const { card, mirror, texts } = cardOfTexts();
    const label = /** @type {HTMLElement} */ (texts.inLabel.parentElement);
    const { roots, restore } = recordCopies();
    const held = [holdTextLayout(texts.inLabel)];
    try {
      label.textContent = "in the label";
      const replacement = /** @type {Text} */ (label.firstChild);
      assert.notEqual(replacement, texts.inLabel);
      mirror.adopt(replacement);
      held.push(holdTextLayout(replacement));
      assert.equal(roots.length, 2);
      assert.equal(roots[1], roots[0]);
    } finally {
      held.forEach((reader) => reader.dispose());
      card.remove();
      restore();
    }
  });

  test("a copy with other characters at the text's place is not measured", () => {
    // Until the change reaches the copy, the place holds the old characters,
    // and measuring them would answer for a text that is no longer there.
    const { card, mirror, texts } = cardOfTexts();
    const label = /** @type {HTMLElement} */ (texts.inLabel.parentElement);
    const { roots, restore } = recordCopies();
    const held = [holdTextLayout(texts.inLabel)];
    try {
      label.textContent = "changed";
      const replacement = /** @type {Text} */ (label.firstChild);
      mirror.adopt(replacement);
      const reader = holdTextLayout(replacement);
      held.push(reader);
      assert.equal(reader.layout, undefined);
      assert.equal(roots.length, 1);
    } finally {
      held.forEach((reader) => reader.dispose());
      card.remove();
      restore();
    }
  });

  test("a text the copy does not hold yet is measured once it does", async () => {
    // Inserted into an element the portal had not adopted, a text reaches
    // the box's shape when the adoption is announced, a microtask after the
    // portal may already measure it. The measurement waits for it.
    const { card, mirror, texts } = cardOfTexts();
    const empty = document.createElement("i");
    card.appendChild(empty);
    const { roots, restore } = recordCopies();
    const held = [holdTextLayout(texts.inLabel)];
    try {
      const late = document.createTextNode("late");
      empty.appendChild(late);
      mirror.adopt(empty);
      mirror.adopt(late);
      const reader = holdTextLayout(late);
      held.push(reader);
      assert.equal(roots.length, 1);
      assert.equal(reader.layout, undefined);
      // The adoption reaches the shape, the copy is rebuilt with the text in
      // it, and both texts in the box are measured in the new copy.
      await Promise.resolve();
      assert.notEqual(reader.layout, undefined);
      assert.equal(roots.length, 3);
      assert.equal(roots[2], roots[1]);
      assert.notEqual(roots[1], roots[0]);
      assert.equal(roots[1].querySelector("i")?.textContent, "late");
    } finally {
      held.forEach((reader) => reader.dispose());
      card.remove();
      restore();
    }
  });

  test("a comment put into the box rebuilds its copy", () => {
    // Frameworks anchor to comments. The copy holds them as the box does,
    // and a text is found by a place that counts them, so a comment coming
    // or going has to rebuild the copy, or every text after it is looked
    // for one place off.
    const { card, mirror, texts } = cardOfTexts();
    const label = /** @type {HTMLElement} */ (texts.inLabel.parentElement);
    const { roots, restore } = recordCopies();
    const held = [texts.inLabel, texts.inCard, texts.inBold].map((text) => holdTextLayout(text));
    try {
      assert.equal(roots.length, 3);
      changeAndIngest(mirror, () => card.insertBefore(document.createComment("anchor"), label));
      assert.equal(roots.length, 6);
      assert.notEqual(roots[3], roots[0]);
      assert.equal(new Set(roots.slice(3)).size, 1);
      assert.equal(roots[3].firstChild?.nodeType, Node.COMMENT_NODE);
    } finally {
      held.forEach((reader) => reader.dispose());
      card.remove();
      restore();
    }
  });

  test("a dressed element keeps the custom properties it sets", () => {
    // Chromium enumerates no custom property in a computed style, so a copy
    // written from one alone loses the `--gap` an inline style sets, and a
    // child styled with `var(--gap)` with it.
    const realGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = (element, pseudo) => {
      const computed = realGetComputedStyle(element, pseudo);
      const names = Array.from({ length: computed.length }, (_, i) => computed[i]).filter(
        (name) => !name.startsWith("--"),
      );
      return /** @type {CSSStyleDeclaration} */ (
        new Proxy(computed, {
          get(target, key) {
            if (key === "length") {
              return names.length;
            }
            if (typeof key === "string" && /^\d+$/.test(key)) {
              return names[Number(key)];
            }
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      );
    };
    const { card, texts } = cardOfTexts();
    const label = /** @type {HTMLElement} */ (texts.inLabel.parentElement);
    label.style.setProperty("--gap", "8px");
    const { roots, restore } = recordCopies();
    const held = holdTextLayout(texts.inLabel);
    try {
      const copy = /** @type {HTMLElement} */ (roots[0].querySelector(".label"));
      assert.equal(copy.style.getPropertyValue("--gap"), "8px");
    } finally {
      held.dispose();
      card.remove();
      restore();
      window.getComputedStyle = realGetComputedStyle;
    }
  });

  test("a change beside an out-of-flow box keeps its copy", () => {
    // A tooltip or a centred dialog is laid out out of flow, and is told of
    // every settling in the panel; its own position moves nothing in it. A
    // text typed beside it re-measures none of its texts, and rebuilds no
    // copy of it.
    const panel = document.createElement("div");
    const box = document.createElement("div");
    box.style.position = "absolute";
    box.style.width = "150px";
    box.style.transform = "matrix(0.996, 0.087, -0.087, 0.996, 0, 0)";
    /** @type {Text[]} */
    const inBox = [];
    for (let i = 0; i < 10; i++) {
      const text = document.createTextNode(`text ${i} `);
      inBox.push(text);
      box.appendChild(text);
    }
    const beside = document.createElement("div");
    const typed = document.createTextNode("typed");
    beside.appendChild(typed);
    panel.append(box, beside);
    document.body.appendChild(panel);
    const mirror = createMirror();
    for (const node of [panel, box, ...inBox, beside, typed]) {
      mirror.adopt(node);
    }
    const { roots, restore } = recordCopies();
    const held = inBox.map((text) => holdTextLayout(text));
    try {
      for (const value of ["typed a", "typed ab", "typed abc"]) {
        changeAndIngest(mirror, () => {
          typed.data = value;
        });
      }
      assert.equal(new Set(roots).size, 1);
      assert.equal(roots.length, 10);
    } finally {
      held.forEach((reader) => reader.dispose());
      panel.remove();
      restore();
    }
  });

  test("a font that finished loading rebuilds the copy", () => {
    const { card, mirror, texts } = cardOfTexts();
    const { roots, restore } = recordCopies();
    const held = holdTextLayout(texts.inLabel);
    try {
      batch(() => mirror.fontsLoaded());
      assert.equal(roots.length, 2);
      assert.notEqual(roots[1], roots[0]);
    } finally {
      held.dispose();
      card.remove();
      restore();
    }
  });

  test("an attribute changed above the box rebuilds its copy", () => {
    // `.desk.night .card b` can restyle what is in the box from outside it.
    const desk = document.createElement("div");
    const { card, mirror, texts } = cardOfTexts();
    desk.appendChild(card);
    document.body.appendChild(desk);
    mirror.adopt(desk);
    const { roots, restore } = recordCopies();
    const held = holdTextLayout(texts.inLabel);
    try {
      changeAndIngest(mirror, () => desk.setAttribute("class", "night"));
      assert.equal(roots.length, 2);
      assert.notEqual(roots[1], roots[0]);
    } finally {
      held.dispose();
      desk.remove();
      restore();
    }
  });

  test("every element laid out in the box's lines keeps its resolved style", () => {
    // Shared by every text in the box, the copy dresses each inline element
    // in it, not only the path to the first text measured: which text came
    // first must not change what the others are measured against. What is
    // laid out in a box of its own keeps its classes only.
    const style = document.createElement("style");
    style.textContent = ".desk .card .other, .desk .card .inner { letter-spacing: 3px; }";
    document.head.appendChild(style);
    const desk = document.createElement("div");
    desk.className = "desk";
    const { card, texts } = cardOfTexts();
    desk.appendChild(card);
    document.body.appendChild(desk);
    const { roots, restore } = recordCopies();
    const held = holdTextLayout(texts.inLabel);
    try {
      const copy = roots[0];
      assert.equal(
        /** @type {HTMLElement} */ (copy.querySelector(".other")).style.letterSpacing,
        "3px",
      );
      assert.equal(
        /** @type {HTMLElement} */ (copy.querySelector(".inner")).style.letterSpacing,
        "",
      );
    } finally {
      held.dispose();
      desk.remove();
      style.remove();
      restore();
    }
  });

  test("the climb to the line box stops at the panel's root", () => {
    // An inline panel root with an inline element under it: the box the
    // lines are in would be the page's `<div>` above the root, which no
    // portal mirrors. The copy stops at the root, and drops the attribute
    // that would make it a panel of its own.
    const page = document.createElement("div");
    page.className = "page";
    const root = document.createElement("span");
    root.setAttribute(PORTAL_ATTRIBUTE, "");
    const bold = document.createElement("b");
    bold.style.transform = "matrix(2, 0, 0, 2, 0, 0)";
    const textNode = document.createTextNode("hello");
    bold.appendChild(textNode);
    root.appendChild(bold);
    page.appendChild(root);
    document.body.appendChild(page);
    const mirror = createMirror();
    mirror.adopt(bold);
    mirror.adopt(textNode);
    try {
      const { root: copy } = measureThroughCopy(textNode);
      assert.equal(copy.localName, "span");
      assert.equal(copy.hasAttribute(PORTAL_ATTRIBUTE), false);
    } finally {
      page.remove();
    }
  });
});

describe("a panel measured through a scale", () => {
  /**
   * A panel's root inside a stage the page scales to fit its window, by
   * `scale` in both directions, as the desk's `stage.ts` does. The root is
   * laid out at (10, 20) on the page, 300 by 200 layout px; what the page
   * reports is every client rect scaled about that corner.
   *
   * @param {number} scale
   */
  function scaledPanel(scale) {
    const staged = stagedRoot({ at: [10, 20], claimed: true });
    staged.setScale("stage", scale);
    staged.place(staged.root, 0, 0, 300, 200);
    return { ...staged, mirror: staged.adopt() };
  }

  test("a child's position is in the root's layout px, scroll included", () => {
    const { stage, root, child, place } = scaledPanel(0.5);
    place(child, 100, 50, 80, 60);
    scrollable(root, () => 10);
    try {
      assert.deepEqual(getContentPosition(child), { x: 100, y: 60 });
    } finally {
      stage.remove();
    }
  });

  test("a child's size is its layout size", () => {
    const { stage, child, place } = scaledPanel(0.5);
    place(child, 100, 50, 80, 60);
    try {
      assert.deepEqual(getBorderBoxSize(child), { width: 80, height: 60 });
    } finally {
      stage.remove();
    }
  });

  test("a turned card in a scrolled list is clipped where its box is drawn", () => {
    // Section 6 of the architecture plan: a turned card is placed from its
    // layout offsets, which no scale reaches, and clipped by a window read
    // from client rects, which the scale shrank. The two have to agree.
    const { stage, root, child: holder, place, mirror } = scaledPanel(0.5);
    holder.style.cssText = "position: relative; overflow: hidden";
    const list = document.createElement("div");
    list.style.overflow = "hidden";
    const card = document.createElement("div");
    card.style.cssText =
      "position: absolute; transform: matrix(0.7071, 0.7071, -0.7071, 0.7071, 0, 0)";
    list.appendChild(card);
    holder.appendChild(list);
    mirror.adopt(list);
    mirror.adopt(card);
    place(holder, 0, 0, 150, 150);
    place(list, 0, 0, 150, 150);
    scrollable(list, () => 10);
    // Laid out 100 px square at (20, 30) in the holder, turned about its
    // centre.
    const half = 50 * Math.SQRT2;
    place(card, 70 - half, 80 - half, 2 * half, 2 * half);
    for (const [name, value] of /** @type {const} */ ([
      ["offsetLeft", 20],
      ["offsetTop", 30],
      ["offsetWidth", 100],
      ["offsetHeight", 100],
      ["offsetParent", holder],
    ])) {
      Object.defineProperty(card, name, { configurable: true, value });
    }
    try {
      assert.ok(isTransformed(card));
      assert.equal(root.contains(card), true);
      const clip = getLocalClipBox(card);
      assert.deepEqual(
        { left: clip.left, top: clip.top, right: clip.right, bottom: clip.bottom },
        { left: -20, top: -30, right: 130, bottom: 120 },
      );
    } finally {
      stage.remove();
    }
  });

  test("a line of text is as tall as it is laid out", () => {
    const { stage, child, place, mirror } = scaledPanel(0.5);
    place(child, 0, 0, 300, 40);
    const text = document.createTextNode("hello");
    child.appendChild(text);
    mirror.adopt(text);
    // The text is laid out at (20, 5) in the child, 60 by 16 layout px.
    const rect = () => new window.DOMRect(10 + 20 * 0.5, 20 + 5 * 0.5, 60 * 0.5, 16 * 0.5);
    const restoreRange = stubMeasuringRange({ rect });
    try {
      const measured = getTextLayout(text);
      assert.deepEqual(
        { left: measured.left, top: measured.top, bounds: measured.bounds },
        { left: 20, top: 5, bounds: { width: 60, height: 16 } },
      );
      assert.deepEqual(
        measured.lines.map(({ width, height }) => ({ width, height })),
        [{ width: 60, height: 16 }],
      );
    } finally {
      stage.remove();
      restoreRange();
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

    // One range serves every measurement, so "a measurement happened" is a
    // node being selected, not a range being made.
    const restoreRange = stubMeasuringRange({ rect, onSelect: () => measurements++ });

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
      restoreRange();
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
    let scrollTop = 0;
    const rect = () => ({
      left: 10,
      top: 20 - scrollTop,
      right: 40,
      bottom: 32 - scrollTop,
      width: 30,
      height: 12,
    });
    const restoreRange = stubMeasuringRange({
      rect: () => /** @type {DOMRectReadOnly} */ (rect()),
      onSelect: (node) => measured.add(node),
    });

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

    let rowWidth = 200;
    let rowHeight = 40;
    layout(scroller, () => [0, 0, 200, 100]);
    layout(row, () => [0, 20 - scrollTop, rowWidth, 20 + rowHeight - scrollTop]);
    scrollable(scroller, () => scrollTop);

    const mirror = createMirror();
    for (const node of [scroller, row, label, loose]) {
      mirror.adopt(node);
    }

    const layouts = [
      new Derived(() => getTextLayout(label)),
      new Derived(() => getTextLayout(loose)),
    ];
    const holders = layouts.map((textLayout) => new Effect(() => textLayout.get()));

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

      // A row arriving in the list moves the text sitting directly in the
      // list, and leaves the label alone: a label is measured in its own
      // row's content space, and a row that came out the size it was cannot
      // have re-broken anything inside it. This is the whole saving on a long
      // list — the text is most of the panel and all of the expensive reads.
      measured.clear();
      mirror.childListChanged(scroller);
      assert.deepEqual(measured, new Set([loose]));

      // Unless the row got narrower, which is the one thing out in the list
      // that can reach into it. Taller would not do: a row grows taller
      // *because* its text re-broke, and text wraps to a width.
      measured.clear();
      rowWidth = 120;
      rowHeight = 80;
      mirror.childListChanged(scroller);
      assert.deepEqual(measured, new Set([label, loose]));
    } finally {
      holders.forEach((effect) => effect.dispose());
      scroller.remove();
      restoreRange();
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

/**
 * A panel shaped like every panel that has a list in it: a reading above,
 * and a scroller below with a row inside it. Rect reads are counted per
 * element, because the whole point of the boundary is which of them happen.
 *
 * @param {string} scrollerStyle
 * @param {string} [rowStyle]
 */
function setupBoundedList(scrollerStyle = "overflow: hidden", rowStyle = "") {
  const reads = { header: 0, scroller: 0, row: 0, footer: 0 };
  let panelWidth = 200;
  let headerHeight = 20;
  let scrollerHeight = 100;
  let rowHeight = 40;

  const container = document.createElement("div");
  container.setAttribute(PORTAL_ATTRIBUTE, "");
  const header = document.createElement("div");
  const headerText = document.createTextNode("0 m/s");
  const scroller = document.createElement("div");
  scroller.style.cssText = scrollerStyle;
  const row = document.createElement("div");
  row.style.cssText = rowStyle;
  const label = document.createTextNode("row one");
  // Something below the list, because that is who a list growing actually
  // moves. The reading above it is the control: it is before the list in the
  // flow, and nothing the list does can reach back up to it.
  const footer = document.createElement("div");

  header.appendChild(headerText);
  row.appendChild(label);
  scroller.appendChild(row);
  container.appendChild(header);
  container.appendChild(scroller);
  container.appendChild(footer);
  document.body.appendChild(container);

  const mirror = createMirror();
  for (const node of [container, header, headerText, scroller, row, label, footer]) {
    mirror.adopt(node);
  }

  layout(container, () => [0, 0, panelWidth, 200]);
  layout(header, () => [0, 0, panelWidth, headerHeight], { count: () => reads.header++ });
  layout(scroller, () => [0, headerHeight, panelWidth, headerHeight + scrollerHeight], {
    count: () => reads.scroller++,
  });
  layout(row, () => [0, headerHeight, panelWidth, headerHeight + rowHeight], {
    count: () => reads.row++,
  });
  layout(
    footer,
    () => [0, headerHeight + scrollerHeight, panelWidth, headerHeight + scrollerHeight + 20],
    { count: () => reads.footer++ },
  );

  return {
    container,
    mirror,
    header,
    headerText,
    scroller,
    row,
    label,
    footer,
    reads,
    /**
     * The list grows because its contents did — that being the only way a
     * container sized by its contents can grow, and the mirror now consults
     * the geometry rather than taking a mutation's word for how far it
     * travels. A fixture where the list grew and the row did not describes a
     * layout no browser would produce, and the walk would rightly stop at the
     * row.
     *
     * @param {number} height
     */
    growTheListBy: (height) => {
      rowHeight += height;
      scrollerHeight += height;
    },
    /**
     * And the other direction: the panel above the list changes size, which
     * is what leaves the list a different amount of room. Same requirement —
     * the header has to have actually changed for the news to be entitled to
     * travel past it.
     *
     * @param {number} height
     */
    growTheHeaderBy: (height) => {
      headerHeight += height;
      scrollerHeight -= height;
    },
    /**
     * And the change that actually re-lays-out what is inside the list: the
     * panel gets narrower, so the list does, so its rows re-break. A list
     * that only got shorter moves nothing inside it — its rows are stacked
     * from the top and stay there; it simply clips more of them.
     *
     * @param {number} width
     */
    narrowThePanelBy: (width) => {
      panelWidth -= width;
    },
  };
}

/**
 * A list of rows that lays itself out honestly: each row 20px tall, stacked in
 * document order, the list as tall as it has rows. Everything asked here is
 * about *which* rows a change moved, so a fixture handing out fixed boxes
 * would answer a different question.
 *
 * @param {string} [listStyle]
 */
function setupRowList(listStyle = "") {
  /** @type {Map<Element, number>} */
  const reads = new Map();

  const container = document.createElement("div");
  container.setAttribute(PORTAL_ATTRIBUTE, "");
  const list = document.createElement("div");
  list.style.cssText = listStyle;
  container.appendChild(list);
  document.body.appendChild(container);

  const mirror = createMirror();
  mirror.adopt(container);
  mirror.adopt(list);

  const indexOf = (/** @type {Element} */ row) => Array.prototype.indexOf.call(list.children, row);

  /** @param {Element} row */
  const track = (row) => {
    reads.set(row, 0);
    layout(row, () => [0, indexOf(row) * 20, 200, indexOf(row) * 20 + 20], {
      count: () => reads.set(row, (reads.get(row) ?? 0) + 1),
    });
  };

  layout(container, () => [0, 0, 200, list.children.length * 20]);
  layout(list, () => [0, 0, 200, list.children.length * 20]);

  /** @type {Element[]} */
  const rows = [];
  for (let index = 0; index < 4; index++) {
    const row = document.createElement("div");
    list.appendChild(row);
    mirror.adopt(row);
    track(row);
    rows.push(row);
  }

  /**
   * A row put in at `before`, adopted, tracked and announced exactly as the
   * observer would have announced it — `previousSibling` and all, since that
   * is what says where the change happened.
   *
   * @param {Node | null} before
   * @returns {Element}
   */
  const insertRow = (before) => {
    const row = document.createElement("div");
    const previousSibling = before ? before.previousSibling : list.lastChild;
    list.insertBefore(row, before);
    mirror.adopt(row);
    track(row);
    batch(() => mirror.ingest([childListRecord(list, previousSibling, [row], [], before)]));
    return row;
  };

  /**
   * @param {Element} row
   * @returns {void}
   */
  const removeRow = (row) => {
    const { previousSibling, nextSibling } = row;
    row.remove();
    batch(() => mirror.ingest([childListRecord(list, previousSibling, [], [row], nextSibling)]));
  };

  /** @param {Element} row */
  const readsOf = (row) => reads.get(row) ?? 0;

  return { container, mirror, list, rows, insertRow, removeRow, readsOf, track };
}

/**
 * An attribute record as the observer delivers it.
 *
 * @param {Element} target
 * @param {string} attributeName
 * @param {string | null} oldValue
 * @returns {MutationRecord}
 */
function attributeRecord(target, attributeName, oldValue) {
  return /** @type {MutationRecord} */ (
    /** @type {unknown} */ ({
      type: "attributes",
      target,
      attributeName,
      oldValue,
      addedNodes: [],
      removedNodes: [],
    })
  );
}

/**
 * The shape a MutationObserver hands over for a childList change. Written out
 * rather than driven through a real observer because `previousSibling` is the
 * whole point here, and a hand-built record is the only way to be sure which
 * one the mirror is being given.
 *
 * @param {Node} target
 * @param {Node | null} previousSibling
 * @param {Node[]} addedNodes
 * @param {Node[]} removedNodes
 * @param {Node | null} [nextSibling]
 * @returns {MutationRecord}
 */
function childListRecord(target, previousSibling, addedNodes, removedNodes, nextSibling = null) {
  return /** @type {MutationRecord} */ (
    /** @type {unknown} */ ({
      type: "childList",
      target,
      previousSibling,
      nextSibling,
      addedNodes,
      removedNodes,
      attributeName: null,
      oldValue: null,
    })
  );
}

describe("which siblings a change moves", () => {
  test("appending a row does not re-measure the rows already there", () => {
    // The whole of stage two in one assertion. A row added at the end of a
    // list is placed after everything in it, so nothing in it moved — and the
    // cost of adding it is the same whether the list has four rows or eight
    // hundred, which is what stops a list that streams in from being
    // quadratic in its own length.
    const { container, rows, insertRow, readsOf } = setupRowList();
    try {
      const watched = rows.map((row) => new Derived(() => getContentPosition(row)));
      const subscriptions = watched.map((signal) => signal.subscribe({ next: () => signal.get() }));
      watched.forEach((signal) => signal.get());
      const before = rows.map(readsOf);

      insertRow(null);

      assert.deepEqual(
        rows.map(readsOf),
        before,
        "not one row already in the list was measured again",
      );

      subscriptions.forEach((subscription) => subscription.unsubscribe());
    } finally {
      container.remove();
    }
  });

  test("inserting in the middle re-measures what is after it, and only after", () => {
    const { container, rows, insertRow, readsOf } = setupRowList();
    try {
      const watched = rows.map((row) => new Derived(() => getContentPosition(row)));
      const subscriptions = watched.map((signal) => signal.subscribe({ next: () => signal.get() }));
      watched.forEach((signal) => signal.get());
      const before = rows.map(readsOf);

      insertRow(rows[2]);

      assert.equal(readsOf(rows[0]), before[0], "the first row held still");
      assert.equal(readsOf(rows[1]), before[1], "and so did the second");
      assert.ok(readsOf(rows[2]) > before[2], "the row it went in front of moved down");
      assert.ok(readsOf(rows[3]) > before[3], "and everything after it");

      subscriptions.forEach((subscription) => subscription.unsubscribe());
    } finally {
      container.remove();
    }
  });

  test("removing a row re-measures what was below it", () => {
    const { container, rows, removeRow, readsOf } = setupRowList();
    try {
      const watched = rows.map((row) => new Derived(() => getContentPosition(row)));
      const subscriptions = watched.map((signal) => signal.subscribe({ next: () => signal.get() }));
      watched.forEach((signal) => signal.get());
      const before = rows.map(readsOf);

      removeRow(rows[1]);

      assert.equal(readsOf(rows[0]), before[0], "the row above the gap held still");
      assert.ok(readsOf(rows[2]) > before[2], "the rows below it came up");
      assert.ok(readsOf(rows[3]) > before[3]);

      subscriptions.forEach((subscription) => subscription.unsubscribe());
    } finally {
      container.remove();
    }
  });

  test("a container that places its children from the far end tells all of them", () => {
    // `column-reverse` stacks from the bottom, so a row appended in the
    // document goes *first* on screen and everything already there moves. The
    // whitelist exists for exactly this: a container that made no promise
    // about document order falls back to telling every child, which is what
    // the mirror did before it could tell the difference.
    const { container, rows, insertRow, readsOf } = setupRowList(
      "display: flex; flex-direction: column-reverse",
    );
    try {
      const watched = rows.map((row) => new Derived(() => getContentPosition(row)));
      const subscriptions = watched.map((signal) => signal.subscribe({ next: () => signal.get() }));
      watched.forEach((signal) => signal.get());
      const before = rows.map(readsOf);

      insertRow(null);

      assert.ok(readsOf(rows[0]) > before[0], "the first row was measured again");

      subscriptions.forEach((subscription) => subscription.unsubscribe());
    } finally {
      container.remove();
    }
  });

  test("and so does one that centres them", () => {
    // Same reason, the other common way to break document order: everything
    // in a centred list shifts when anything joins it.
    const { container, rows, insertRow, readsOf } = setupRowList(
      "display: flex; flex-direction: column; justify-content: center",
    );
    try {
      const watched = rows.map((row) => new Derived(() => getContentPosition(row)));
      const subscriptions = watched.map((signal) => signal.subscribe({ next: () => signal.get() }));
      watched.forEach((signal) => signal.get());
      const before = rows.map(readsOf);

      insertRow(null);

      assert.ok(readsOf(rows[0]) > before[0], "the first row was measured again");

      subscriptions.forEach((subscription) => subscription.unsubscribe());
    } finally {
      container.remove();
    }
  });

  test("a list that only got taller does not re-lay-out the rows in it", () => {
    // The other half of appending cheaply, and the one that decides whether
    // any of it is worth having: a list grows by exactly the row that joined
    // it, every time. If that height reached its rows through the parent-box
    // channel, every append would re-measure the whole list anyway. In block
    // flow it does not — rows are stacked from the top and a taller box
    // leaves them there — so only the inline extent is followed.
    const { container, mirror, rows, insertRow } = setupRowList();
    try {
      // A row's *contents* are what would pay: watch a box one level further
      // down than the rows the walk talks to.
      const inner = document.createElement("div");
      rows[0].appendChild(inner);
      mirror.adopt(inner);
      let innerReads = 0;
      layout(inner, () => [0, 0, 200, 20], { count: () => innerReads++ });

      const watched = new Derived(() => getContentPosition(inner));
      const subscription = watched.subscribe({ next: () => watched.get() });
      watched.get();
      const before = innerReads;

      insertRow(null);

      assert.equal(innerReads, before, "the list getting taller reached nothing inside a row");

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });
});

describe("which siblings a change restyles", () => {
  /**
   * An effect per row reading its colour, so that what is counted is which
   * rows a child-list change reaches through the style context — the number
   * that made a list streaming in quadratic, since every row restyled for
   * every row that arrived.
   *
   * @param {Element[]} rows
   */
  function watchStyles(rows) {
    /** @type {Map<Element, number>} */
    const restyles = new Map();
    const effects = rows.map(
      (row) =>
        new Effect(() => {
          restyles.set(row, (restyles.get(row) ?? 0) + 1);
          getComputedStyleCached(row).color;
        }),
    );
    return {
      restylesOf: (/** @type {Element} */ row) => restyles.get(row) ?? 0,
      dispose: () => effects.forEach((effect) => effect.dispose()),
    };
  }

  test("appending a row restyles the row that was last, and no other", () => {
    // `:last-child` is the one verdict an append can move on an existing
    // row. Everything before the old last row keeps its style, whatever
    // the list's length — the property that makes streaming linear.
    const { container, rows, insertRow } = setupRowList();
    const { restylesOf, dispose } = watchStyles(rows);
    try {
      assert.deepEqual(rows.map(restylesOf), [1, 1, 1, 1]);

      insertRow(null);

      assert.deepEqual(rows.map(restylesOf), [1, 1, 1, 2]);
    } finally {
      dispose();
      container.remove();
    }
  });

  test("inserting in the middle restyles the tail and the row before the gap", () => {
    // `:nth-child`, `+` and `~` can change on everything after the arrival;
    // `:last-child` on the row just before it. The rows above are untouched.
    const { container, rows, insertRow } = setupRowList();
    const { restylesOf, dispose } = watchStyles(rows);
    try {
      insertRow(rows[2]);

      assert.deepEqual(rows.map(restylesOf), [1, 2, 2, 2]);
    } finally {
      dispose();
      container.remove();
    }
  });

  test("removing the last row restyles the one that became last", () => {
    const { container, rows, removeRow } = setupRowList();
    const { restylesOf, dispose } = watchStyles(rows);
    try {
      removeRow(rows[3]);

      assert.deepEqual(rows.slice(0, 3).map(restylesOf), [1, 1, 2]);
    } finally {
      dispose();
      container.remove();
    }
  });

  test("removing a row in the middle restyles what closed the gap, and the row above it", () => {
    const { container, rows, removeRow } = setupRowList();
    const { restylesOf, dispose } = watchStyles(rows);
    try {
      removeRow(rows[1]);

      assert.deepEqual([rows[0], rows[2], rows[3]].map(restylesOf), [2, 2, 2]);
    } finally {
      dispose();
      container.remove();
    }
  });

  test("an arrival restyles the last earlier element of its own kind, for `:last-of-type`", () => {
    // div, span, div, div — then a span appended. The last div restyles for
    // `:last-child`; the span at index 1 was `:last-of-type` and is not any
    // more; the divs at 0 and 2 have nothing to hear.
    const { container, mirror, list, rows } = setupRowList();
    const span = document.createElement("span");
    list.replaceChild(span, rows[1]);
    mirror.adopt(span);
    const kinds = [rows[0], span, rows[2], rows[3]];
    const { restylesOf, dispose } = watchStyles(kinds);
    try {
      const arriving = document.createElement("span");
      list.appendChild(arriving);
      mirror.adopt(arriving);
      batch(() => mirror.ingest([childListRecord(list, rows[3], [arriving], [])]));

      assert.deepEqual(kinds.map(restylesOf), [1, 2, 1, 2]);
    } finally {
      dispose();
      container.remove();
    }
  });

  test("prepending restyles the whole list, since every position from the start moved", () => {
    const { container, rows, insertRow } = setupRowList();
    const { restylesOf, dispose } = watchStyles(rows);
    try {
      insertRow(rows[0]);

      assert.deepEqual(rows.map(restylesOf), [2, 2, 2, 2]);
    } finally {
      dispose();
      container.remove();
    }
  });

  /**
   * An element beside the list, inside the same parent, whose colour is
   * watched: what the list's siblings hear when its child list changes.
   *
   * @param {ReturnType<typeof createMirror>} mirror
   * @param {Element} list
   */
  function watchNeighbour(mirror, list) {
    const neighbour = document.createElement("div");
    list.after(neighbour);
    mirror.adopt(neighbour);
    return { neighbour, ...watchStyles([neighbour]) };
  }

  test("dropping the first row of a list that keeps rows restyles the rows, not the list's neighbours", () => {
    // A log that drops its oldest row as each new one arrives. Every row's
    // position from the start moved, so every row restyles; the list was
    // not empty before or after, so `:empty` held and nothing beside the
    // list has a verdict that could have moved.
    const { container, mirror, list, rows, removeRow } = setupRowList();
    const { restylesOf, dispose } = watchStyles(rows);
    const beside = watchNeighbour(mirror, list);
    try {
      removeRow(rows[0]);

      assert.deepEqual(rows.slice(1).map(restylesOf), [2, 2, 2]);
      assert.equal(beside.restylesOf(beside.neighbour), 1, "the list's neighbour kept its style");
    } finally {
      dispose();
      beside.dispose();
      container.remove();
    }
  });

  test("removing the last row left restyles the list's neighbours, since `:empty` flipped", () => {
    const { container, mirror, list, rows, removeRow } = setupRowList();
    rows.slice(0, 3).forEach((row) => removeRow(row));
    const beside = watchNeighbour(mirror, list);
    try {
      removeRow(rows[3]);

      assert.equal(beside.restylesOf(beside.neighbour), 2);
    } finally {
      beside.dispose();
      container.remove();
    }
  });

  test("the first row into an empty list restyles the list's neighbours, since `:empty` flipped", () => {
    const { container, mirror, list, rows, removeRow, insertRow } = setupRowList();
    rows.forEach((row) => removeRow(row));
    const beside = watchNeighbour(mirror, list);
    try {
      insertRow(null);

      assert.equal(beside.restylesOf(beside.neighbour), 2);
    } finally {
      beside.dispose();
      container.remove();
    }
  });

  test("the first row after a comment anchor restyles the list's neighbours, since `:empty` flipped", () => {
    // Lit, Svelte and Solid mark an empty list's slot with a comment, which
    // `:empty` ignores. The row arrives after the comment, not at the start.
    const { container, mirror, list, rows, removeRow, insertRow } = setupRowList();
    rows.forEach((row) => removeRow(row));
    const anchor = document.createComment("");
    list.append(anchor);
    batch(() => mirror.ingest([childListRecord(list, null, [anchor], [])]));
    const beside = watchNeighbour(mirror, list);
    try {
      insertRow(null);

      assert.equal(beside.restylesOf(beside.neighbour), 2);
    } finally {
      beside.dispose();
      container.remove();
    }
  });

  test("a row appended after a trailing comment anchor leaves the list's neighbours alone", () => {
    // justdom ends a list's rows with its anchor, so every append lands after
    // a comment. The comment says nothing about `:empty`; the rows before it
    // do. The last row restyles for `:last-of-type`, which the new row takes.
    const { container, mirror, list, rows, insertRow } = setupRowList();
    const anchor = document.createComment("");
    list.append(anchor);
    batch(() => mirror.ingest([childListRecord(list, rows[3], [anchor], [])]));
    const { restylesOf, dispose } = watchStyles(rows);
    const beside = watchNeighbour(mirror, list);
    try {
      insertRow(null);

      assert.deepEqual(rows.map(restylesOf), [1, 1, 1, 2]);
      assert.equal(beside.restylesOf(beside.neighbour), 1);
    } finally {
      dispose();
      beside.dispose();
      container.remove();
    }
  });

  test("a row put in before the list's leading text leaves the list's neighbours alone", () => {
    // Text counts toward `:empty` as an element does, so text next to the
    // change says the list was never empty.
    const { container, mirror, list, rows, insertRow } = setupRowList();
    const text = document.createTextNode("\n  ");
    list.insertBefore(text, rows[0]);
    batch(() => mirror.ingest([childListRecord(list, null, [text], [], rows[0])]));
    const { restylesOf, dispose } = watchStyles(rows);
    const beside = watchNeighbour(mirror, list);
    try {
      insertRow(text);

      assert.deepEqual(rows.map(restylesOf), [2, 2, 2, 2]);
      assert.equal(beside.restylesOf(beside.neighbour), 1);
    } finally {
      dispose();
      beside.dispose();
      container.remove();
    }
  });

  test("with no record to narrow from, the whole list restyles as it always did", () => {
    const { container, mirror, list, rows } = setupRowList();
    const { restylesOf, dispose } = watchStyles(rows);
    try {
      batch(() => mirror.childListChanged(list));

      assert.deepEqual(rows.map(restylesOf), [2, 2, 2, 2]);
    } finally {
      dispose();
      container.remove();
    }
  });
});

describe("layout boundaries", () => {
  test("a box that kept its size seals its interior, overflow or not", () => {
    // The general rule the overflow cases below are instances of. A block
    // formatting context is not what makes a box's interior its own
    // business: CSS lays a box out from the space it was given, so *any*
    // container that came out the size it was leaves everything inside it
    // where it already was. A list that happens not to have changed height
    // is sealed exactly as firmly as one that hides its overflow, and the
    // overwhelming majority of panels contain no `overflow` at all.
    const { container, mirror, headerText, row, reads } = setupBoundedList("");
    try {
      const inside = new Derived(() => getContentPosition(row));
      const subscription = inside.subscribe({ next: () => inside.get() });
      inside.get();
      const before = { ...reads };

      headerText.data = "12 m/s";
      mirror.characterDataChanged(headerText);

      assert.equal(reads.row, before.row, "the row inside a plain div was not measured");

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });

  test("a change in one row leaves its neighbours' contents alone", () => {
    // The saving, stated as the invariant it rests on. Geometry is stored
    // relative to the parent, so a row whose own box came out unchanged has
    // not moved anything inside it, whatever happened next door — and a row
    // that did change size moves its neighbours without reaching into them,
    // because their boxes did not change either. What that spares is the
    // text: a label is the most expensive read in the mirror, and on a list
    // it is most of what there is to read.
    const reads = { rowA: 0, labelBox: 0, rowB: 0 };
    let labelHeight = 16;
    let rowAHeight = 40;

    const container = document.createElement("div");
    container.setAttribute(PORTAL_ATTRIBUTE, "");
    const rowA = document.createElement("div");
    const labelBox = document.createElement("span");
    const labelText = document.createTextNode("first");
    const rowB = document.createElement("div");
    labelBox.appendChild(labelText);
    rowA.appendChild(labelBox);
    container.appendChild(rowA);
    container.appendChild(rowB);
    document.body.appendChild(container);

    const mirror = createMirror();
    for (const node of [container, rowA, labelBox, labelText, rowB]) {
      mirror.adopt(node);
    }

    layout(container, () => [0, 0, 200, 200]);
    layout(rowA, () => [0, 0, 200, rowAHeight], { count: () => reads.rowA++ });
    layout(labelBox, () => [0, 0, 100, labelHeight], { count: () => reads.labelBox++ });
    layout(rowB, () => [0, rowAHeight, 200, rowAHeight + 40], { count: () => reads.rowB++ });

    try {
      const watched = [
        new Derived(() => getContentPosition(labelBox)),
        new Derived(() => getContentPosition(rowB)),
      ];
      const subscriptions = watched.map((signal) => signal.subscribe({ next: () => signal.get() }));
      watched.forEach((signal) => signal.get());

      // A settle with nothing recorded yet reads as changed everywhere, so
      // the ledger is primed before anything is asserted about it.
      labelText.data = "second";
      mirror.characterDataChanged(labelText);
      let before = { ...reads };

      // The label is rewritten and the row absorbs it. Nothing outside the
      // row was disturbed, so nothing outside the row is measured.
      labelText.data = "third";
      mirror.characterDataChanged(labelText);
      assert.equal(reads.rowB, before.rowB, "the next row was not measured");

      // Now the row grows. Its neighbour moves and re-measures — and stops
      // there, its own box being what it was.
      before = { ...reads };
      labelHeight = 32;
      rowAHeight = 56;
      labelText.data = "fourth, long enough to wrap";
      mirror.characterDataChanged(labelText);
      assert.ok(reads.rowB > before.rowB, "the next row followed the one that grew");

      subscriptions.forEach((subscription) => subscription.unsubscribe());
    } finally {
      container.remove();
    }
  });

  test("an attribute that hides a row moves the rows after it, and the panel", () => {
    // F9 in the minesweeper register: `hidden` set on a row takes its box
    // out of the flow, so the row after it moves up and the panel around
    // them gets shorter. An author's attribute is a change in the row's own
    // box, so it climbs the walk a child arriving climbs.
    let rowAHeight = 40;

    const container = document.createElement("div");
    container.setAttribute(PORTAL_ATTRIBUTE, "");
    const rowA = document.createElement("div");
    const rowB = document.createElement("div");
    container.appendChild(rowA);
    container.appendChild(rowB);
    document.body.appendChild(container);

    const mirror = createMirror();
    for (const node of [container, rowA, rowB]) {
      mirror.adopt(node);
    }

    layout(container, () => [0, 0, 200, rowAHeight + 40]);
    layout(rowA, () => [0, 0, 200, rowAHeight]);
    layout(rowB, () => [0, rowAHeight, 200, rowAHeight + 40]);

    try {
      const watched = {
        rowB: new Derived(() => getContentPosition(rowB)),
        panel: new Derived(() => getBorderBoxSize(container)),
      };
      const holders = Object.values(watched).map((signal) => new Effect(() => signal.get()));
      assert.equal(watched.rowB.get().y, 40);
      assert.equal(watched.panel.get().height, 80);

      rowA.hidden = true;
      rowAHeight = 0;
      mirror.ingest([
        /** @type {MutationRecord} */ (
          /** @type {unknown} */ ({
            type: "attributes",
            target: rowA,
            attributeName: "hidden",
            oldValue: null,
            addedNodes: [],
            removedNodes: [],
          })
        ),
      ]);

      assert.equal(watched.rowB.get().y, 0, "the next row moved up");
      assert.equal(watched.panel.get().height, 40, "and the panel got shorter");

      holders.forEach((effect) => effect.dispose());
    } finally {
      container.remove();
    }
  });

  test("an attribute on a flex item re-measures the items before it", () => {
    // Items in a flex row share its width, so a class that widens the
    // second item shrinks the first. The row kept its size, so nothing but
    // the attribute's own climb tells the first item.
    let firstWidth = 100;

    const container = document.createElement("div");
    container.setAttribute(PORTAL_ATTRIBUTE, "");
    const row = document.createElement("div");
    row.style.display = "flex";
    const first = document.createElement("div");
    const second = document.createElement("div");
    row.appendChild(first);
    row.appendChild(second);
    container.appendChild(row);
    document.body.appendChild(container);

    const mirror = createMirror();
    for (const node of [container, row, first, second]) {
      mirror.adopt(node);
    }

    layout(container, () => [0, 0, 200, 20]);
    layout(row, () => [0, 0, 200, 20]);
    layout(first, () => [0, 0, firstWidth, 20]);
    layout(second, () => [firstWidth, 0, 200, 20]);

    try {
      const size = new Derived(() => getBorderBoxSize(first));
      const holder = new Effect(() => size.get());
      assert.equal(size.get().width, 100);

      second.className = "wide";
      firstWidth = 60;
      mirror.ingest([
        /** @type {MutationRecord} */ (
          /** @type {unknown} */ ({
            type: "attributes",
            target: second,
            attributeName: "class",
            oldValue: null,
            addedNodes: [],
            removedNodes: [],
          })
        ),
      ]);

      assert.equal(size.get().width, 60, "the first item shrank");

      holder.dispose();
    } finally {
      container.remove();
    }
  });

  for (const position of /** @type {const} */ (["absolute", "fixed"])) {
    test(`an inline style that moves a box positioned ${position} leaves the boxes beside it alone`, () => {
      // A scrollbar thumb is positioned absolutely and moved by `top` and
      // `height` on every scroll. Its box is out of the flow, so moving or
      // resizing it moves nothing beside it; taking `position` away moves
      // everything after it.
      const container = document.createElement("div");
      container.setAttribute(PORTAL_ATTRIBUTE, "");
      const thumb = document.createElement("div");
      thumb.style.position = position;
      const label = document.createElement("div");
      container.appendChild(thumb);
      container.appendChild(label);
      document.body.appendChild(container);

      const mirror = createMirror();
      for (const node of [container, thumb, label]) {
        mirror.adopt(node);
      }

      const reads = { label: 0, thumb: 0 };
      layout(container, () => [0, 0, 200, 20]);
      layout(thumb, () => [190, 0, 200, 10], { count: () => reads.thumb++ });
      layout(label, () => [0, 0, 200, 20], { count: () => reads.label++ });

      /** @param {string | null} oldValue */
      const styled = (oldValue) =>
        /** @type {MutationRecord} */ (
          /** @type {unknown} */ ({
            type: "attributes",
            target: thumb,
            attributeName: "style",
            oldValue,
            addedNodes: [],
            removedNodes: [],
          })
        );

      try {
        const watched = [
          new Derived(() => getContentPosition(label)),
          new Derived(() => getContentPosition(thumb)),
        ];
        const holders = watched.map((signal) => new Effect(() => signal.get()));
        // A first settle reads as changed everywhere, so the ledger is primed
        // before anything is asserted about it.
        thumb.style.width = "10px";
        mirror.ingest([styled(`position: ${position};`)]);
        const before = { ...reads };

        thumb.style.top = "8px";
        thumb.style.height = "12px";
        mirror.ingest([styled(`position: ${position}; width: 10px;`)]);
        assert.equal(reads.label, before.label, "the thumb moved nothing beside it");
        assert.equal(reads.thumb, before.thumb + 1, "and was measured where it went");

        thumb.style.removeProperty("top");
        mirror.ingest([styled(`position: ${position}; width: 10px; top: 8px; height: 12px;`)]);
        assert.equal(reads.label, before.label, "an offset taken off moved nothing beside it");
        assert.equal(reads.thumb, before.thumb + 2, "and the thumb was measured again");

        thumb.style.position = "static";
        mirror.ingest([styled(`position: ${position}; width: 10px; height: 12px;`)]);
        assert.equal(reads.label, before.label + 1, "taking it into the flow moved the label");

        holders.forEach((effect) => effect.dispose());
      } finally {
        container.remove();
      }
    });
  }

  test("an inline style that moves no box leaves the boxes after it alone", () => {
    // A gauge that writes `style.transform` every frame pays for its own
    // subtree. A width written the same way moves what follows it.
    const container = document.createElement("div");
    container.setAttribute(PORTAL_ATTRIBUTE, "");
    const bar = document.createElement("div");
    const label = document.createElement("div");
    container.appendChild(bar);
    container.appendChild(label);
    document.body.appendChild(container);

    const mirror = createMirror();
    for (const node of [container, bar, label]) {
      mirror.adopt(node);
    }

    const reads = { label: 0 };
    layout(container, () => [0, 0, 200, 40]);
    layout(bar, () => [0, 0, 200, 20]);
    layout(label, () => [0, 20, 200, 40], { count: () => reads.label++ });

    /** @param {string | null} oldValue */
    const styled = (oldValue) =>
      /** @type {MutationRecord} */ (
        /** @type {unknown} */ ({
          type: "attributes",
          target: bar,
          attributeName: "style",
          oldValue,
          addedNodes: [],
          removedNodes: [],
        })
      );

    try {
      const position = new Derived(() => getContentPosition(label));
      const holder = new Effect(() => position.get());
      // A first settle reads as changed everywhere, so the ledger is primed
      // before anything is asserted about it.
      bar.style.width = "200px";
      mirror.ingest([styled(null)]);
      const before = reads.label;

      bar.style.transform = "scaleX(0.5)";
      mirror.ingest([styled("width: 200px;")]);
      bar.style.transform = "scaleX(0.6)";
      bar.style.opacity = "0.5";
      mirror.ingest([styled("width: 200px; transform: scaleX(0.5);")]);
      assert.equal(reads.label, before, "a transform and an opacity moved nothing");

      bar.style.width = "180px";
      mirror.ingest([styled("width: 200px; transform: scaleX(0.6); opacity: 0.5;")]);
      assert.equal(reads.label, before + 1, "a width moved the label");

      bar.style.removeProperty("width");
      mirror.ingest([styled("width: 180px; transform: scaleX(0.6); opacity: 0.5;")]);
      assert.equal(reads.label, before + 2, "a width taken out moved it too");

      // The whole attribute goes, and what it held moved no box.
      bar.removeAttribute("style");
      mirror.ingest([styled("transform: scaleX(0.6); opacity: 0.5;")]);
      assert.equal(reads.label, before + 2, "a style of paint alone taken out moved nothing");

      // `collapse` takes a table row or a flex item out of the layout, so
      // the value decides and not the name.
      bar.style.visibility = "collapse";
      mirror.ingest([styled(null)]);
      assert.equal(reads.label, before + 3, "a collapse moved the label");
      bar.style.visibility = "visible";
      mirror.ingest([styled("visibility: collapse;")]);
      assert.equal(reads.label, before + 4, "and so did taking it off");

      // A keyword is case-insensitive, and `setProperty` with a priority
      // serializes as `collapse !important`. jsdom drops the priority, so
      // the attribute is written as a browser would write it.
      bar.setAttribute("style", "visibility: COLLAPSE !important");
      mirror.ingest([styled("visibility: visible;")]);
      assert.equal(reads.label, before + 5, "a collapse in another spelling moved it");

      holder.dispose();
    } finally {
      container.remove();
    }
  });

  test("an attribute inside an <svg> moves none of the shapes beside it", () => {
    // A shape is placed in user space, so its `d` or its `r` moves no
    // sibling, and a chart that rewrites one every frame must not have the
    // shapes and labels after it measured again. The `<svg>` root is a box
    // in the HTML flow, so its own `width` moves what follows it.
    const container = document.createElement("div");
    container.setAttribute(PORTAL_ATTRIBUTE, "");
    const svg = document.createElementNS(SVG_NAMESPACE, "svg");
    const dot = document.createElementNS(SVG_NAMESPACE, "circle");
    const ring = document.createElementNS(SVG_NAMESPACE, "circle");
    const caption = document.createElement("div");
    svg.appendChild(dot);
    svg.appendChild(ring);
    container.appendChild(svg);
    container.appendChild(caption);
    document.body.appendChild(container);

    const mirror = createMirror();
    for (const node of [container, svg, dot, ring, caption]) {
      mirror.adopt(node);
    }

    const reads = { ring: 0, caption: 0 };
    layout(container, () => [0, 0, 200, 140]);
    layout(svg, () => [0, 0, 100, 100]);
    layout(ring, () => [10, 10, 30, 30], { count: () => reads.ring++ });
    layout(caption, () => [0, 100, 200, 140], { count: () => reads.caption++ });

    try {
      const watched = [
        new Derived(() => getContentPosition(ring)),
        new Derived(() => getContentPosition(caption)),
      ];
      const holders = watched.map((signal) => new Effect(() => signal.get()));
      const before = { ...reads };

      dot.setAttribute("r", "8");
      mirror.attributeChanged(dot);
      assert.deepEqual(reads, before, "a shape's attribute moved nothing beside it");

      svg.setAttribute("width", "120");
      mirror.attributeChanged(svg);
      assert.equal(reads.caption, before.caption + 1, "the root's attribute moved the caption");

      holders.forEach((effect) => effect.dispose());
    } finally {
      container.remove();
    }
  });

  for (const [tag, display, promptRect] of /** @type {const} */ ([
    ["span", "inline", [0, 0, 60, 40]],
    // No box at all, so it measures 0x0 and, after its first settle, always
    // reads as having kept its size.
    ["span", "contents", [0, 0, 0, 0]],
    // A form control's box is atomic, but `display: contents` takes the box
    // away and its children flow in the parent's lines like any other.
    ["button", "contents", [0, 0, 0, 0]],
  ])) {
    test(`a <${tag}> with display: ${display} that kept its size still moves what follows it`, () => {
      // A terminal: a prompt several lines long, with a caret after it.
      // Typing on the last line moves where the prompt ends, and so the
      // caret, without changing the prompt's bounding box, which is as wide
      // as its widest line and as tall as its line count. An inline box
      // flows across line boxes, so its size says nothing about where its
      // neighbour starts.
      let caretLeft = 20;

      const container = document.createElement("div");
      container.setAttribute(PORTAL_ATTRIBUTE, "");
      const pre = document.createElement("pre");
      const prompt = document.createElement(tag);
      prompt.style.display = display;
      const promptText = document.createTextNode("READY.\n> H");
      const caret = document.createElement("span");
      caret.style.display = "inline-block";
      prompt.appendChild(promptText);
      pre.appendChild(prompt);
      pre.appendChild(caret);
      container.appendChild(pre);
      document.body.appendChild(container);

      const mirror = createMirror();
      for (const node of [container, pre, prompt, promptText, caret]) {
        mirror.adopt(node);
      }

      layout(container, () => [0, 0, 200, 200]);
      layout(pre, () => [0, 0, 200, 40]);
      layout(prompt, () => [...promptRect]);
      layout(caret, () => [caretLeft, 20, caretLeft + 10, 40]);

      try {
        const position = new Derived(() => getContentPosition(caret));
        const subscription = position.subscribe({ next: () => position.get() });
        assert.equal(position.get().x, 20);

        // Prime the ledger, as above: a first settle reads as changed.
        promptText.data = "READY.\n> HE";
        caretLeft = 30;
        mirror.characterDataChanged(promptText);
        assert.equal(position.get().x, 30);

        promptText.data = "READY.\n> HEL";
        caretLeft = 40;
        mirror.characterDataChanged(promptText);
        assert.equal(position.get().x, 40, "the caret followed the text before it");

        subscription.unsubscribe();
      } finally {
        container.remove();
      }
    });
  }

  for (const [name, build] of /** @type {const} */ ([
    [
      "an <svg>",
      () => {
        const svg = document.createElementNS(SVG_NAMESPACE, "svg");
        const label = document.createElementNS(SVG_NAMESPACE, "text");
        svg.appendChild(label);
        return { atomic: svg, inner: [label], textParent: label };
      },
    ],
    [
      "a <canvas>",
      () => {
        const canvas = document.createElement("canvas");
        return { atomic: canvas, inner: [], textParent: canvas };
      },
    ],
  ])) {
    test(`text rewritten inside ${name} that kept its size does not move what follows it`, () => {
      // A gauge whose label is rewritten every frame. SVG elements and
      // replaced elements compute to `inline`, but each is one atomic box
      // that never splits across lines, so the climb stops at it like at any
      // other box that kept its size. Climbing on would re-measure
      // everything after the gauge on every frame.
      let reads = 0;

      const container = document.createElement("div");
      container.setAttribute(PORTAL_ATTRIBUTE, "");
      const card = document.createElement("div");
      const { atomic, inner, textParent } = build();
      const text = document.createTextNode("10");
      textParent.appendChild(text);
      const after = document.createElement("div");
      card.appendChild(atomic);
      card.appendChild(after);
      container.appendChild(card);
      document.body.appendChild(container);

      const mirror = createMirror();
      for (const node of [container, card, atomic, ...inner, text, after]) {
        mirror.adopt(node);
      }

      layout(container, () => [0, 0, 200, 200]);
      layout(card, () => [0, 0, 200, 120]);
      layout(atomic, () => [0, 0, 100, 100]);
      for (const element of inner) {
        layout(element, () => [10, 10, 40, 30]);
      }
      layout(after, () => [0, 100, 200, 120], { count: () => reads++ });

      try {
        const position = new Derived(() => getContentPosition(after));
        const subscription = position.subscribe({ next: () => position.get() });
        position.get();

        // Prime the ledger: a first settle reads as changed.
        text.data = "11";
        mirror.characterDataChanged(text);
        const before = reads;

        for (let value = 12; value < 16; value++) {
          text.data = String(value);
          mirror.characterDataChanged(text);
        }
        assert.equal(reads, before, "what follows the gauge was not measured");

        subscription.unsubscribe();
      } finally {
        container.remove();
      }
    });
  }

  test("churn outside a scroller does not re-measure a single row inside it", () => {
    // The optimization, and the reason for it: an element that hides its
    // overflow establishes a block formatting context, so nothing out in the
    // panel reaches inside except by changing the container's size. A
    // reading ticking over above the list — the shape of every instrument
    // panel — used to re-measure every row and re-run a Range measurement
    // for every label. Now it re-measures the container, finds it the same
    // size, and stops there.
    const { container, mirror, headerText, row, reads } = setupBoundedList();
    try {
      const inside = new Derived(() => getContentPosition(row));
      const subscription = inside.subscribe({ next: () => inside.get() });
      inside.get();
      const before = { ...reads };

      headerText.data = "12 m/s";
      mirror.characterDataChanged(headerText);

      assert.equal(reads.row, before.row, "the row inside was not measured");
      assert.ok(reads.scroller > before.scroller, "the scroller's own size was checked");

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });

  test("a change inside the scroller still reaches the rest of the inside", () => {
    // The wall is not a lid: a row that grew moves the rows after it, and
    // that news travels within the container exactly as it always did.
    const { container, mirror, label, row, reads } = setupBoundedList();
    try {
      const inside = new Derived(() => getContentPosition(row));
      const subscription = inside.subscribe({ next: () => inside.get() });
      inside.get();
      const before = { ...reads };

      label.data = "row one, now longer";
      mirror.characterDataChanged(label);

      assert.ok(reads.row > before.row, "the inside re-measures");

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });

  test("churn inside a list of a fixed size leaves the panel around it alone", () => {
    // The same wall, from the other side: a clipping box does not let its
    // contents out — they are clipped, and take no part in the layout beyond
    // it — so rows arriving and leaving cannot move the panel unless they
    // move the container itself. A log filling up, a list being filtered, a
    // reading redrawn inside a bordered box: none of it re-measures the
    // panel around it.
    const { container, mirror, label, header, reads } = setupBoundedList();
    try {
      const outside = new Derived(() => getContentPosition(header));
      const subscription = outside.subscribe({ next: () => outside.get() });
      outside.get();

      // The first change is the one that records the container's size: with
      // nothing to compare against, the news travels as it always did.
      label.data = "row one, changed";
      mirror.characterDataChanged(label);
      const before = { ...reads };

      // From here on the container is known, and known not to have moved.
      for (let index = 0; index < 5; index++) {
        label.data = `row one, changed ${index}`;
        mirror.characterDataChanged(label);
      }

      assert.equal(reads.header, before.header, "the panel outside was not measured");

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });

  test("a list that changes size does tell the panel below it, and only below", () => {
    // The channel out, and it has to work: a container that grows with its
    // contents — anything not given a size of its own — moves everything
    // after it. And *only* what is after it, which is the other half of the
    // same fact: the reading above the list is earlier in the flow, so no
    // amount of growing downward can reach it.
    const { container, mirror, label, header, footer, reads, growTheListBy } = setupBoundedList();
    try {
      const watched = [
        new Derived(() => getContentPosition(header)),
        new Derived(() => getContentPosition(footer)),
      ];
      const subscriptions = watched.map((signal) => signal.subscribe({ next: () => signal.get() }));
      watched.forEach((signal) => signal.get());

      label.data = "row one, changed";
      mirror.characterDataChanged(label);
      const before = { ...reads };

      // The label wraps onto a second line, so the row grows and the list
      // with it.
      growTheListBy(40);
      label.data = "row one, changed again";
      mirror.characterDataChanged(label);

      assert.ok(reads.footer > before.footer, "a list that grew moved what sits below it");
      assert.equal(reads.header, before.header, "and nothing above it");

      subscriptions.forEach((subscription) => subscription.unsubscribe());
    } finally {
      container.remove();
    }
  });

  test("the scroller resizing re-measures everything inside it", () => {
    // The one channel the outside has, and it has to work: when the panel
    // really does resize the container, its contents re-lay-out.
    const { container, mirror, headerText, row, reads, narrowThePanelBy } = setupBoundedList();
    try {
      const inside = new Derived(() => getContentPosition(row));
      const subscription = inside.subscribe({ next: () => inside.get() });
      inside.get();
      const before = { ...reads };

      // The panel is narrower, so the list is, so everything in it re-breaks.
      narrowThePanelBy(40);
      headerText.data = "a reading in a narrower panel";
      mirror.characterDataChanged(headerText);

      assert.ok(reads.row > before.row, "a resized container re-measures its contents");

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });

  test("fonts arriving reach inside every wall", () => {
    // A face landing re-breaks the lines inside a scroller without moving
    // the scroller by a pixel, so it is the one layout event no boundary is
    // allowed to hold back.
    const { container, mirror, row, reads } = setupBoundedList();
    try {
      const inside = new Derived(() => getContentPosition(row));
      const subscription = inside.subscribe({ next: () => inside.get() });
      inside.get();
      const before = { ...reads };

      mirror.fontsLoaded();

      assert.ok(reads.row > before.row, "the inside re-measures for fonts");

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });

  test("an ancestor restyled above the wall still re-measures inside it", () => {
    // The other way in: a font size or a line height set on an ancestor is
    // inherited through the container, and changes how its contents lay out
    // without touching the container's size. Targeted reflow climbs past
    // walls for exactly this reason.
    const { container, mirror, row, reads } = setupBoundedList();
    try {
      const inside = new Derived(() => getContentPosition(row));
      const subscription = inside.subscribe({ next: () => inside.get() });
      inside.get();
      const before = { ...reads };

      mirror.attributeChanged(container);

      assert.ok(reads.row > before.row, "an inherited restyle re-measures the inside");

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });

  test("a positioned box inside a scroller is not sealed in by it", () => {
    // An absolutely positioned element hangs off a containing block that may
    // sit outside the container — the menu anchored above a list is exactly
    // that — so what happens out there moves it, and it keeps listening to
    // the panel at large.
    const { container, mirror, headerText, row, reads } = setupBoundedList(
      "overflow: hidden",
      "position: absolute",
    );
    try {
      const inside = new Derived(() => getContentPosition(row));
      const subscription = inside.subscribe({ next: () => inside.get() });
      inside.get();
      const before = { ...reads };

      headerText.data = "12 m/s";
      mirror.characterDataChanged(headerText);

      assert.ok(reads.row > before.row, "a positioned box still follows the outside");

      subscription.unsubscribe();
    } finally {
      container.remove();
    }
  });
});

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

/**
 * A clipping holder, 150px square with no border, and in it a child laid out
 * 100px square at (20, 30) and turned by 45 degrees. The child's client
 * rect is what a browser reports for a turned box: the bounding box of the
 * turned square, centred on the same point and bigger. Its layout offsets
 * are where it sits before the turn.
 *
 * @param {string} childStyle
 */
function setupTurned(childStyle) {
  const container = document.createElement("div");
  container.setAttribute(PORTAL_ATTRIBUTE, "");
  const holder = document.createElement("div");
  holder.style.cssText = "position: relative; overflow: hidden";
  const child = document.createElement("div");
  child.style.cssText = childStyle;
  holder.appendChild(child);
  container.appendChild(holder);
  document.body.appendChild(container);

  const mirror = createMirror();
  for (const node of [container, holder, child]) {
    mirror.adopt(node);
  }

  layout(holder, () => [0, 0, 150, 150]);
  // Turned by 45 degrees about its centre, (70, 80): half of the bounding
  // box is 50 * (cos 45 + sin 45) across.
  const half = 50 * Math.SQRT2;
  layout(child, () => [70 - half, 80 - half, 70 + half, 80 + half]);
  for (const [name, value] of /** @type {const} */ ([
    ["offsetLeft", 20],
    ["offsetTop", 30],
    ["offsetWidth", 100],
    ["offsetHeight", 100],
    ["offsetParent", holder],
  ])) {
    Object.defineProperty(child, name, { configurable: true, value });
  }
  return { container, child };
}

describe("clip boxes under a transform", () => {
  // A quarter of a right angle, written as the browser computes it.
  const turned = "transform: matrix(0.7071, 0.7071, -0.7071, 0.7071, 0, 0)";
  for (const [kind, style] of [
    ["in the flow", turned],
    ["positioned", `position: absolute; ${turned}`],
  ]) {
    test(`a turned child ${kind} is clipped where its layout puts it, at any angle`, () => {
      // The holder's window in the child's frame is the window less the
      // child's layout offset, (20, 30). Placed by the turned client rect
      // instead, whose corner the turn moved up and left, the window slid
      // about 21px right and down: the radar sweep cut along a diagonal.
      const { container, child } = setupTurned(style);
      try {
        assert.ok(isTransformed(child));
        const clip = getLocalClipBox(child);
        assert.deepEqual(
          { left: clip.left, top: clip.top, right: clip.right, bottom: clip.bottom },
          { left: -20, top: -30, right: 130, bottom: 120 },
        );
      } finally {
        container.remove();
      }
    });
  }
});

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

describe("character edges", () => {
  const CHAR = 10;
  const LINE = 16;
  const COLUMNS = 4;

  /**
   * A layout engine for a monospace face in a box four characters wide: the
   * i-th character sits in column `i % 4` of line `i / 4`. Small enough to
   * assert against, and the only kind of engine jsdom leaves room for.
   *
   * @param {number} index
   * @returns {{ left: number, right: number, top: number, bottom: number }}
   */
  function charRect(index) {
    const line = Math.floor(index / COLUMNS);
    const column = index % COLUMNS;
    return {
      left: column * CHAR,
      right: (column + 1) * CHAR,
      top: line * LINE,
      bottom: (line + 1) * LINE,
    };
  }

  /**
   * @param {{ onRect?: () => void }} [options]
   * @returns {() => void}
   */
  function installRange({ onRect } = {}) {
    const original = document.createRange;
    resetMeasuringRangeForTests();
    document.createRange = () => {
      let start = 0;
      let end = 0;
      /**
       * @returns {Array<{ left: number, top: number, right: number, bottom: number, width: number, height: number }>}
       */
      const rects = () => {
        /** @type {Map<number, { left: number, top: number, right: number, bottom: number, width: number, height: number }>} */
        const byLine = new Map();
        for (let index = start; index < end; index++) {
          const rect = charRect(index);
          const line = Math.floor(index / COLUMNS);
          const found = byLine.get(line);
          if (!found) {
            byLine.set(line, {
              ...rect,
              width: rect.right - rect.left,
              height: rect.bottom - rect.top,
            });
            continue;
          }
          found.left = Math.min(found.left, rect.left);
          found.right = Math.max(found.right, rect.right);
          found.width = found.right - found.left;
        }
        return [...byLine.values()];
      };
      return /** @type {Range} */ (
        /** @type {unknown} */ ({
          selectNodeContents: (/** @type {Node} */ node) => {
            start = 0;
            end = (node.textContent || "").length;
          },
          setStart: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
            start = offset;
          },
          setEnd: (/** @type {Node} */ _node, /** @type {number} */ offset) => {
            end = offset;
          },
          getBoundingClientRect: () => {
            onRect?.();
            const all = rects();
            if (all.length === 0) {
              return /** @type {DOMRect} */ ({
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
                width: 0,
                height: 0,
              });
            }
            const left = Math.min(...all.map((rect) => rect.left));
            const top = Math.min(...all.map((rect) => rect.top));
            const right = Math.max(...all.map((rect) => rect.right));
            const bottom = Math.max(...all.map((rect) => rect.bottom));
            return /** @type {DOMRect} */ ({
              left,
              top,
              right,
              bottom,
              width: right - left,
              height: bottom - top,
            });
          },
          getClientRects: () => /** @type {DOMRectList} */ (/** @type {unknown} */ (rects())),
        })
      );
    };
    return () => {
      document.createRange = original;
      resetMeasuringRangeForTests();
    };
  }

  /**
   * @param {string} content
   * @param {boolean} tracked
   * @returns {{ layout: import('./mirror.js').TextLayout, rects: number }}
   */
  function measure(content, tracked) {
    let rects = 0;
    const restore = installRange({
      onRect: () => {
        rects += 1;
      },
    });
    const parent = document.createElement("p");
    const node = document.createTextNode(content);
    parent.appendChild(node);
    document.body.appendChild(parent);
    const mirror = createMirror();
    mirror.adopt(parent);
    mirror.adopt(node);
    const stop = tracked ? trackCharacterEdges(node) : () => {};
    try {
      return { layout: getTextLayout(node), rects };
    } finally {
      stop();
      parent.remove();
      restore();
    }
  }

  test("a label that did not ask is measured exactly as it always was", () => {
    const { layout } = measure("abcdefgh", false);
    assert.equal(layout.reveal, null);
    assert.deepEqual(
      layout.lines.map((line) => line.text),
      ["abcd", "efgh"],
    );
  });

  test("a node that asked gets a boundary between every character it draws", () => {
    const { layout } = measure("abcdefgh", true);
    assert.ok(layout.reveal);
    assert.equal(layout.reveal.length, 8, "rendered characters across the whole run");
    assert.deepEqual(
      layout.reveal.lines.map((line) => [line.start, line.length, line.top, line.bottom]),
      [
        [0, 4, 0, LINE],
        [4, 4, LINE, 2 * LINE],
      ],
      "each line knows where it begins in the stream",
    );
    for (const line of layout.reveal.lines) {
      assert.deepEqual([...(line.edges ?? [])], [0, CHAR, 2 * CHAR, 3 * CHAR, 4 * CHAR]);
    }
  });

  test("the boundaries are what the extra reads buy, and nobody else pays for them", () => {
    const plain = measure("abcdefgh", false);
    const revealed = measure("abcdefgh", true);
    assert.equal(revealed.rects - plain.rects, 8, "one read per character drawn, and not one more");
  });

  test("a single-line run is measured the same way", () => {
    const { layout } = measure("abc", true);
    assert.ok(layout.reveal);
    assert.equal(layout.reveal.lines.length, 1);
    assert.deepEqual([...(layout.reveal.lines[0].edges ?? [])], [0, CHAR, 2 * CHAR, 3 * CHAR]);
  });

  test("tracking is per node, and is given back", () => {
    const node = document.createTextNode("abc");
    assert.equal(tracksCharacterEdges(node), false);
    const stop = trackCharacterEdges(node);
    assert.equal(tracksCharacterEdges(node), true);
    stop();
    assert.equal(tracksCharacterEdges(node), false);
  });
});

describe("the range text is measured with", () => {
  test("is made once, serves every measurement, and lets go of the node afterwards", () => {
    // A Range is live — the document keeps every one it hands out and
    // updates it on every mutation — so one per measurement left a mount's
    // worth of stale ranges for every later mutation to walk, each still
    // pointing into the text it had measured. One is made, and between
    // measurements it points at the document, where nothing in a panel can
    // move it and nothing is held.
    let made = 0;
    let selected = 0;
    /** @type {Array<[Node, number]>} */
    const boundaries = [];
    const rect = () => new window.DOMRect(0, 0, 30, 12);

    const originalCreateRange = document.createRange;
    resetMeasuringRangeForTests();
    document.createRange = () => {
      made++;
      return /** @type {Range} */ (
        /** @type {unknown} */ ({
          selectNodeContents: () => {
            selected++;
          },
          setStart: (/** @type {Node} */ node, /** @type {number} */ offset) => {
            boundaries.push([node, offset]);
          },
          setEnd: (/** @type {Node} */ node, /** @type {number} */ offset) => {
            boundaries.push([node, offset]);
          },
          getBoundingClientRect: rect,
          getClientRects: () => /** @type {DOMRectList} */ (/** @type {unknown} */ ([rect()])),
        })
      );
    };

    const first = document.createElement("div");
    first.appendChild(document.createTextNode("one"));
    const second = document.createElement("div");
    second.appendChild(document.createTextNode("two"));
    document.body.append(first, second);
    layout(first, () => [0, 0, 100, 20]);
    layout(second, () => [0, 20, 100, 20]);

    const mirror = createMirror();
    for (const node of [first, first.firstChild, second, second.firstChild]) {
      mirror.adopt(/** @type {Node} */ (node));
    }

    try {
      getTextLayout(/** @type {Text} */ (first.firstChild));
      getTextLayout(/** @type {Text} */ (second.firstChild));

      assert.equal(selected, 2, "two measurements");
      assert.equal(made, 1, "on one range");
      // The last two boundary writes of each measurement park the range on
      // the document. Both measurements ended that way, so the tail reads
      // (document, 0) twice over.
      assert.deepEqual(boundaries.slice(-2), [
        [document, 0],
        [document, 0],
      ]);
    } finally {
      first.remove();
      second.remove();
      document.createRange = originalCreateRange;
      resetMeasuringRangeForTests();
    }
  });
});

describe("two layout changes settled in one flush", () => {
  test("a level reached first from further down still hears an earlier change of its own", () => {
    // Two childList records in one observer flush. The first is inside the
    // last row, and its climb reaches the container first, telling it "from
    // row 3". The second names the container itself — a row inserted after
    // row 0 — so the container also owes rows 1 and 2. The settle used to see
    // a level it had already visited and drop the second entry whole.
    const container = document.createElement("div");
    container.setAttribute(PORTAL_ATTRIBUTE, "");
    document.body.appendChild(container);
    layout(container, () => [0, 0, 200, 80]);

    /** @type {number[]} */
    const reads = [0, 0, 0, 0];
    const rows = reads.map((_, i) => {
      const row = document.createElement("div");
      container.appendChild(row);
      layout(row, () => [0, i * 20, 200, i * 20 + 20], { count: () => (reads[i] += 1) });
      return row;
    });

    const mirror = createMirror();
    mirror.adopt(container);
    for (const row of rows) {
      mirror.adopt(row);
    }
    const positions = rows.map((row) => new Derived(() => getContentPosition(row)));
    const subscriptions = positions.map((position) =>
      position.subscribe({ next: () => position.get() }),
    );
    for (const position of positions) {
      position.get();
    }

    /**
     * @param {Element} target
     * @param {Node | null} previousSibling
     */
    const childList = (target, previousSibling) =>
      /** @type {MutationRecord} */ (
        /** @type {unknown} */ ({
          type: "childList",
          target,
          addedNodes: [],
          removedNodes: [],
          previousSibling,
          nextSibling: previousSibling ? previousSibling.nextSibling : target.firstChild,
        })
      );

    try {
      const before = [...reads];
      batch(() => mirror.ingest([childList(rows[3], null), childList(container, rows[0])]));

      assert.ok(reads[1] > before[1], "row 1 is told");
      assert.ok(reads[2] > before[2], "row 2 is told");
      assert.equal(reads[0], before[0], "row 0, before both changes, is not");
    } finally {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
      container.remove();
    }
  });
});

describe("a node read before any portal adopted it", () => {
  test("is read again once one does, and follows its record from then on", async () => {
    // A portal builds a budget at a time, so something drawn early can read
    // a node that is built, and adopted, a frame or two later.
    const parent = document.createElement("div");
    parent.appendChild(document.createElement("span"));
    document.body.appendChild(parent);
    /** @type {number[]} */
    const seen = [];
    const subscription = toObservable(new Derived(() => getChildNodes(parent).length)).subscribe(
      (count) => seen.push(count),
    );
    assert.deepEqual(seen, [1]);

    const mirror = createMirror();
    mirror.adopt(parent);
    parent.appendChild(document.createElement("span"));
    mirror.childListChanged(parent);
    // The adoption is announced from a microtask (see `announceAdoption`).
    await Promise.resolve();
    assert.equal(seen.at(-1), 2, "the change reaches what read the node before");
    subscription.unsubscribe();
    parent.remove();
  });

  test("has its style read again too, not only what has a new value", async () => {
    // The style context is a sum of counters, and the fresh record's all
    // read 0: the adoption has to move the sum on its own, or a style cached
    // before the record stays as it was read, deaf to what the page did to
    // the node in between.
    const element = document.createElement("div");
    document.body.appendChild(element);
    /** @type {string[]} */
    const seen = [];
    const subscription = toObservable(
      new Derived(() => getComputedStyleCached(element).position || "static"),
    ).subscribe((position) => seen.push(position));
    assert.deepEqual(seen, ["static"]);

    // Restyled before any portal adopts it, which no mirror hears.
    element.style.position = "absolute";
    const mirror = createMirror();
    mirror.adopt(element);
    await Promise.resolve();
    assert.equal(seen.at(-1), "absolute", "the style cached before the record is read again");
    subscription.unsubscribe();
    element.remove();
  });

  test("is told from a microtask, so a reader that adopts is not re-entered", async () => {
    // The SVG plugin adopts a template, and the list marker an item's
    // children, from inside a `Derived`. A frame callback evaluating such a
    // `Derived` runs under no batch, so the adoption, written then and there,
    // would drain the queue in the middle of its computation; an effect that
    // had read the node before, and reads the `Derived` too, would meet it
    // still empty.
    const parent = document.createElement("div");
    parent.appendChild(document.createElement("span"));
    document.body.appendChild(parent);
    const mirror = createMirror();
    const adopting = new Derived(() => {
      mirror.adopt(parent);
      return getChildNodes(parent).length;
    });
    /** @type {number[]} */
    const seen = [];
    let readsAdopting = false;
    const subscription = toObservable(
      new Derived(() => {
        const count = getChildNodes(parent).length;
        return readsAdopting ? adopting.get() + count : count;
      }),
    ).subscribe((count) => seen.push(count));
    assert.deepEqual(seen, [1]);
    readsAdopting = true;

    // As `useFrame` evaluates it: a computation of its own, under no batch.
    const frame = new Computation();
    assert.equal(
      frame.track(() => adopting.get()),
      1,
    );
    assert.deepEqual(seen, [1], "nothing re-ran inside the frame's computation");
    await Promise.resolve();
    assert.deepEqual(seen, [1, 2], "and the early read came round after it");
    subscription.unsubscribe();
    parent.remove();
  });
});

describe("the module graph", () => {
  /**
   * The relative modules a source file imports or re-exports statically.
   * Type-only `import("…")` in JSDoc is not a statement and is not matched.
   *
   * @param {URL} url
   * @returns {URL[]}
   */
  function staticImports(url) {
    const source = readFileSync(url, "utf8");
    const statement = /^(?:import|export)\s(?:[^;"']*?\sfrom\s*)?["'](\.[^"']+)["']/gm;
    return [...source.matchAll(statement)].map((match) => new URL(match[1], url));
  }

  test("nothing mirror.js imports leads back to it", () => {
    // The header calls `mirror.js` the leaf module everything on both
    // sides of the portal imports. A path back to it is a cycle, which
    // runs only while every module on it uses the others' exports at call
    // time, and the next top-level use reads an uninitialised binding.
    const root = new URL("./mirror.js", import.meta.url);
    /** @type {string[]} */
    const cycles = [];
    const visited = new Set();
    /**
     * @param {URL} url
     * @param {string[]} path
     */
    function walk(url, path) {
      for (const next of staticImports(url)) {
        const name = next.pathname.split("/").pop() ?? next.pathname;
        if (next.href === root.href) {
          cycles.push([...path, name].join(" -> "));
        } else if (!visited.has(next.href)) {
          visited.add(next.href);
          walk(next, [...path, name]);
        }
      }
    }
    walk(root, ["mirror.js"]);
    assert.ok(visited.size > 0, "the walk found mirror.js's own imports");
    assert.deepEqual(cycles, []);
  });
});

describe("a checkbox's checked property", () => {
  test("is heard by every watcher, and left as it was when the last one goes", () => {
    // Two panels over one box, as when a panel re-mounts while the one it
    // replaces is still coming down. The first lets go of the box, and the
    // second reads it afresh: an assignment still reaches the reader the
    // first panel left behind, and the box keeps no accessor of ours once
    // nobody reads it.
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.appendChild(box);
    /** @type {boolean[]} */
    const first = [];
    const firstSubscription = toObservable(new Derived(() => getCheckedCached(box))).subscribe(
      (checked) => first.push(checked),
    );
    const mirror = createMirror();
    mirror.adopt(box);
    mirror.forget(box);
    /** @type {boolean[]} */
    const second = [];
    const secondSubscription = toObservable(new Derived(() => getCheckedCached(box))).subscribe(
      (checked) => second.push(checked),
    );

    box.checked = true;
    assert.deepEqual(first, [false, true], "the first reader hears it");
    assert.deepEqual(second, [false, true], "and so does the second");

    firstSubscription.unsubscribe();
    assert.ok(Object.hasOwn(box, "checked"), "kept while a reader is left");
    box.checked = false;
    assert.deepEqual(second, [false, true, false]);
    secondSubscription.unsubscribe();
    assert.ok(!Object.hasOwn(box, "checked"), "and taken off after the last");
    box.remove();
  });
});

describe("a read of a node the mirror let go of", () => {
  /**
   * A card in a panel, read for its width, and how to change what the page
   * lays it out at.
   */
  function readCard() {
    const root = document.createElement("div");
    root.setAttribute(PORTAL_ATTRIBUTE, "");
    const card = document.createElement("div");
    root.appendChild(card);
    document.body.appendChild(root);
    const mirror = createMirror();
    mirror.adopt(root);
    mirror.adopt(card);
    let width = 50;
    layout(card, () => [0, 0, width, 10]);
    /** @type {number[]} */
    const seen = [];
    const subscription = toObservable(new Derived(() => getBorderBoxSize(card).width)).subscribe(
      (read) => seen.push(read),
    );
    return {
      root,
      card,
      mirror,
      seen,
      /** @param {number} next */
      setWidth: (next) => {
        width = next;
      },
      done: () => {
        subscription.unsubscribe();
        root.remove();
      },
    };
  }

  test("keeps what it said until the node is taken back", async () => {
    // The card leaves the panel, and its objects are drawn until the commit.
    // Out of the document it measures as nothing, and a read that ran again
    // then, for the removal or for a font arriving, drew it as nothing.
    const { root, card, mirror, seen, setWidth, done } = readCard();
    card.remove();
    setWidth(0);
    mirror.release(card);
    mirror.fontsLoaded();
    await Promise.resolve();
    assert.deepEqual(seen, [50], "the card is read as it was");

    // Put back before the commit, it is read as the page has it now.
    root.appendChild(card);
    setWidth(30);
    mirror.reclaim(card);
    await Promise.resolve();
    assert.deepEqual(seen, [50, 30], "taken back, it is read again");
    mirror.fontsLoaded();
    setWidth(40);
    mirror.fontsLoaded();
    assert.deepEqual(seen, [50, 30, 40], "and follows the panel again");
    done();
  });

  test("keeps what it said for good once the node is forgotten", async () => {
    // The commit forgets the card while its objects wait for their
    // teardowns, and another panel may adopt it before they run.
    const { card, mirror, seen, setWidth, done } = readCard();
    card.remove();
    setWidth(0);
    mirror.release(card);
    mirror.forget(card);
    mirror.fontsLoaded();
    const other = createMirror();
    other.adopt(card);
    other.fontsLoaded();
    await Promise.resolve();
    assert.deepEqual(seen, [50]);
    done();
  });

  test("of a node's style tells its readers nothing", () => {
    // The computed style is a live object that tells its readers on every
    // run, and a reader that ran again read a node out of the document.
    const { card, mirror, done } = readCard();
    let runs = 0;
    const reader = new Effect(() => {
      runs += 1;
      getComputedStyleCached(card);
    });
    card.remove();
    mirror.release(card);
    mirror.fontsLoaded();
    assert.equal(runs, 1);
    reader.dispose();
    done();
  });
});

describe("a node two panels have let go of", () => {
  test("stays the second panel's when the first forgets it", () => {
    // The first panel lets go of the node; before its commit the page moves
    // it into the second panel, which adopts it and then lets go of it too.
    // The first panel's commit forgets the node, and the second, taking it
    // back, still has the record its reads hang from.
    const node = document.createElement("div");
    document.body.appendChild(node);
    const first = createMirror();
    const second = createMirror();
    first.adopt(node);
    first.release(node);
    second.adopt(node);
    /** @type {number[]} */
    const seen = [];
    const subscription = toObservable(new Derived(() => getChildNodes(node).length)).subscribe(
      (count) => seen.push(count),
    );
    second.release(node);
    first.forget(node);
    second.reclaim(node);
    node.appendChild(document.createElement("span"));
    second.childListChanged(node);
    assert.deepEqual(seen, [0, 1], "the second panel's change still reaches the read");
    subscription.unsubscribe();
    node.remove();
  });
});
