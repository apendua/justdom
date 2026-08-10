# Change Log - @apendua/signal

This log was last generated on Mon, 10 Aug 2026 07:14:43 GMT and should not be manually modified.

## 0.1.2
Mon, 10 Aug 2026 07:14:43 GMT

### Patches

- The update queue drains from priority buckets instead of a binary heap. Priorities are graph depths — small consecutive integers — so a heap paid comparator calls and index bookkeeping on every sift to maintain an order the priorities never had; buckets make push and pop O(1) with no comparisons, and drain each level in insertion order. Wide fan-out — one hot signal driving thousands of small computations, the shape a scrolling list projected by @apendua/freedom produces every frame — runs about twice as fast end to end, and the shape now has a benchmark (fanout.bench.js) and the queue its own semantic tests.
- Delete Heap.js and its tests, which the bucketed update queue left with no callers anywhere in the repo. Two corner cases the queue's new test suite exposed are fixed along the way: a batch body that threw used to leave the batching flag set, wedging the queue so that every later invalidation was silently swallowed; and a priority too large to index a bucket with used to leave the drain cursor climbing levels forever. Such priorities — Infinity included, which a hand-written priority function may reasonably pass to mean "after everything" — are now held aside and drained after every ordinary level, in priority order, so Infinity really does run last rather than merely running late.

## 0.1.1
Thu, 06 Aug 2026 07:34:16 GMT

### Patches

- Built with TypeScript 7. Each @overload in operators.js now sits in its own JSDoc block; packing several into one block made every @template share a scope, which TypeScript 7 rejects as a duplicate identifier. No API change.

## 0.1.0
Tue, 04 Aug 2026 21:29:33 GMT

_Initial release_

