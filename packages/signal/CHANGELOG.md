# Change Log - @apendua/signal

This log was last generated on Thu, 13 Aug 2026 21:23:25 GMT and should not be manually modified.

## 0.3.0
Thu, 13 Aug 2026 21:23:25 GMT

### Minor changes

- A `Signal` no longer goes through the update queue. It is a source — nothing depends on it being ordered after anything else — so `set()` now notifies its subscribers directly, and the queue holds only computations. The write wraps that notification in a batch, which is what keeps the graph glitch-free: telling a dependent queues it, and outside a batch a queued dependent drains immediately, so an unbatched notification would let the first dependent recompute, and everything below it with it, before the second dependent had been told, and a diamond would update once per branch instead of once in total. The visible change is that repeated writes to the same signal inside one `batch()` notify a *direct* subscriber once per write rather than once in total; every value reported is a value the signal really held, and computations below are still deduped by the queue and recompute once. Writes got substantially cheaper for dropping the round trip: with no subscriber about 2.7x, with one subscriber about 1.2x, a 100-way fan-out about 1.4x.

### Patches

- `store()` property writes and `ReactiveMap`/`ReactiveSet` mutations announce a change as one update rather than one per dependent. They are sources too, and had the same problem `Signal.set()` did — but for the collections it was not merely an extra recomputation, it was a torn read: a computation reading a map key and that map's `size` saw the key deleted while `size` still reported 1, `clear()` showed one key gone and the next still present, and a store write reached the key's readers before the `ownKeys` readers heard about it. Seven such shapes across the three now report a single, consistent update.
- The update queue's end-of-flush sweep of stale bucket entries only runs when the drain completed. The sweep cannot tell an abandoned entry from a live one — an empty queue is what tells it — so running it with work still queued would strand that work permanently, the tasks keeping their membership entries with no bucket entry left to reach them by and `#push` refusing to re-enqueue a task already queued at the same priority. Today's drain loop only ever exits empty, so this makes an existing precondition explicit rather than repairing a live bug; it is what will let a drain stop early, on a time budget or otherwise.
- The benchmark harness shared by `Signal.bench.js` and `fanout.bench.js` measures what it claims to. It previously warmed up 200 iterations, ran a single 500 ms window and printed one number, which was enough to report a 3% improvement as a 2x regression. It now warms up to steady state, runs iterations in chunks sized so that reading the clock costs a negligible share of a sample — the old loop read it every iteration, which cost about as much as the cheapest operations being timed and understated them by an order of magnitude — takes five windows, and reports the median with the spread so an untrustworthy number says so. Warm-up, calibration and sampling share one loop, since the optimiser works per call site and a separate warm-up leaves the timed loop cold. Also fixes a benchmark that measured nothing: `batch() — 100 signal writes` wrote each signal's existing value back, so every write short-circuited on `isEqual`. Numbers from this harness are not comparable with the previous one's.

## 0.2.0
Mon, 10 Aug 2026 22:34:42 GMT

### Minor changes

- Remove deprecated setPriorityFn

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

