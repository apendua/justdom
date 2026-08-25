# Task brief: make a scroll cost O(rows on screen) in `justdom-three`

A self-contained brief for a coding agent. Phase P8 of
[`freedom-dom-projection-plan.md`](./freedom-dom-projection-plan.md);
read that file's P1 and P5 sections for the invalidation and clipping
model this builds on.

## The problem

Dragging a long scrolling list in a portal drops frames, and the cost
grows with the length of the list rather than with how much of it is on
screen.

A scroll invalidates client rects for the scroller's **whole subtree** —
`affectsRect` in `packages/freedom/src/elements/cache.js` asks
`target.contains(node)` — and the culling in `div.js` (`obj.visible` plus
the reactive gate on `makeInteractive`) only prunes the render traversal
and the raycast set. The reactive graph goes on measuring rows nobody can
see.

Measured on `apps/todo-xr`'s row shape (`li > span > #text`,
`button > #text`), one scroll frame, with four rows visible throughout:

| rows | rect reads/frame | Range measurements/frame |
| ---- | ---------------- | ------------------------ |
| 10   | 51               | 20                       |
| 50   | 251              | 100                      |
| 100  | 501              | 200                      |
| 200  | 1001             | 400                      |

The Range column is already gone: text layout no longer re-measures on a
scroll (`affectsTextLayout`, same file), because every number
`measureTextRects` reports is relative to something that scrolls with the
text. That took the rect reads to 3 per row. **This task is the rest.**

## The observation to build on

A scroll translates a subtree rigidly. Two consequences:

1. Every element keeps its size.
2. Every element keeps its position _relative to its parent_ — because an
   element's mirrored position is `elementRect − parentRect`, and parent
   and child move together.

The only object whose parent-relative position actually changes is the
scroller's own content child. So the hundreds of rect reads per frame
recompute numbers that were already correct. What genuinely changes is
one offset per scroller, and each descendant's clip box, which is
`clip − element origin` in the element's own px.

## What to build

Give each scroller a signal holding its current `scrollTop`/`scrollLeft`,
invalidated by the `scroll` batch the portal already emits. Express a
descendant's client rect as its last measured _layout_ rect plus the
accumulated scroll offsets of its scrolling ancestors, so that a scroll
invalidates the offsets rather than the rects. Structural mutations,
`attributes` and `reflow` keep re-measuring exactly as they do now — this
changes what a `scroll` batch means, and nothing else.

The clip chain in `getClipBoxCached` already derives per level and should
take its origin from the same offset rather than from a fresh rect read.

Design decisions deliberately left to you: whether the offset lives in a
new cache keyed by scroller or is folded into `getBoundingClientRectCached`;
whether descendants find their scrolling ancestors by walk or by a derived
chain (the clip chain is a working precedent for the latter, and its
memoization is the property to imitate).

## Constraints

- **Do not change what a non-scroll batch does.** The bargain that keeps
  hover cheap (attributes re-measure only the mutated subtree) and the
  animation clock's `reflow` semantics both stay as they are.
- **Keep the clip chain memoized per level.** The current chain derives
  each node's clip from its parent's; a rewrite that re-walks ancestors
  per node would trade one O(N) for another.
- **Nested scrollers must compose.** A list inside a scrolling panel is
  the case to get right; offsets accumulate.
- **`position: fixed`/`absolute` escape scroll offsets** the same way they
  escape clipping — see the containing-block rule in `getClipBoxCached`.
  An absolutely positioned box does not move with a scroller below its
  containing block.
- Out of scope, and unmirrored today either way: scroll-driven
  animations and container queries keyed on scroll position, both of
  which can restyle during a scroll.

## How to reproduce the numbers

jsdom performs no layout, so the harness describes one. Create a test
that builds N rows under a scroller, subscribes the same signals `div()`
and `text()` do (`getBoundingClientRectCached` and `getClipBoxCached` per
element, `getTextLayout` per text node), counts calls to a stubbed
`getBoundingClientRect`/`document.createRange`, then fires one batch:

```js
mutations.next({ types: new Set(["scroll"]), targets: new Set([scroller]) });
```

Run it at several values of N. Today the counts are linear in N; the
exit criterion is that they are not. `packages/freedom/src/elements/cache.test.js`
has the setup idioms (`setSubject`, stubbed `getBoundingClientRect`, the
`selectNodeContents` recorder used by "a scroll re-measures no text").

## Definition of done

- Rect reads per scroll frame are O(rows on screen), not O(rows).
- A regression test asserts the count does not scale with list length.
- `apps/todo-xr` holds frame rate with ~500 rows in the desktop emulator,
  dragged by hand. jsdom cannot check this; do it manually and say so.
- The existing clipping, culling, gesture and text-measurement tests pass
  **unchanged** — if one needs editing, that is a signal to re-read the
  constraint it encodes, not to edit it.
- `cd packages/freedom && npm test` green (runs `tsc --noEmit` first),
  `npx prettier --check` and `npx eslint` clean on changed files, and a
  change file added under `common/changes/justdom-three/` with a type
  of `patch`, since this is an optimization — or CI's
  `rush change --verify` step fails.

## Watch out for

- **Sub-pixel drift.** A synthesized rect can disagree with what the
  browser would report. Any non-scroll batch re-measures and resets the
  baseline, which is the mitigation — make sure that path stays intact.
- **The scroller's own rect** does not move when it scrolls; its content
  child's does. Getting these two the wrong way round produces a list
  that scrolls at double speed or not at all.
- **`scrollBy` clamps.** `scroll.js` relies on the browser clamping
  `scrollTop` at the ends of the travel; a modelled offset must clamp the
  same way or the list will drift past its end during an inertial glide.
