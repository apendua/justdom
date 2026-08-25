# `justdom-signal`: pull-based reactivity, tried and measured

**Status:** experiment concluded, **not merged** — but the question was
reopened and answered differently. See
[`signal-pull-model.md`](./signal-pull-model.md): the defect §5.2 was waiting
for turned up, the §5.4 regressions were closed, and a pull core with a
separate `Effect` node shipped. Read this document for the method and the
control; read that one for what is in the tree.

**Original status:** experiment concluded, not merged. The working implementation
is preserved on `claude/signal-pull-based-refactor-agwmz8` (PR #163); the
strategy-neutral optimizations it turned up were split out into
`claude/signal-push-micro-opts-agwmz8` (PR #164), which is worth merging on
its own.
**Scope of the experiment:** `packages/signal/src/UpdateQueue.js`,
`Computation.js`, `Signal.js`, `core.js`.
**Question asked:** the library propagates changes by *pushing* — a write
eagerly recomputes every dependent, in dependency order, through a
depth-priority queue. The well-known alternative is to *pull*: a write only
invalidates, and computations re-run on demand when something reads them.
Does pull make `justdom-three`'s portals faster?
**Answer:** no. Once both strategies carry the same micro-optimizations they
are indistinguishable in a browser, and pull is slightly behind on the two
hot paths that matter most here. The gains first attributed to the strategy
belonged almost entirely to optimizations that work just as well under push.

---

## 1. Why this was worth trying

The push core is clever and, in places, intricate. `UpdateQueue` maintained a
per-channel grid of FIFO buckets indexed by a node's depth in the graph, plus
re-prioritisation when a node's depth changed while queued, plus stale-slot
recognition at drain time, plus an out-of-grid list for priorities too large
to index. The reason for all of it is glitch-freedom: a dependent must not
recompute before its dependencies, so the queue has to know how deep every
node is and drain shallowest-first.

Pull promises to make that machinery unnecessary. If a write only marks nodes
stale and evaluation happens on demand, then a node that validates itself
pulls its dependencies first — evaluation order is topological by
construction, and there is nothing to sort. It also promises to do strictly
less work: a computation nobody reads never runs at all.

Both promises are real. Neither turned out to be worth much *here*, for
reasons that are specific enough to be worth writing down.

## 2. What was built

A complete, working pull core — all 160 signal tests and all 331 freedom
tests pass against it, the whole monorepo builds, and `showcase-xr`'s visual
baselines are unchanged. The public API survived intact: **no changes to
`justdom-three` or to any app were needed.**

### 2.1 Marking and validation

Every `Signal` and `Derived` carries a **version**, bumped whenever its value
actually changes (as judged by `isEqual`). Staleness is a three-state flag,
as in [Reactively]-style graph colouring:

- `CLEAN` — the cached value is current;
- `CHECK` — something upstream *may* have changed; verify before trusting it;
- `DIRTY` — a direct dependency really changed (or a non-versioned dependency
  emitted); the cache is definitely stale.

`signal.set(v)`, when the value really changes, bumps the signal's version and
marks its direct dependents `DIRTY`. A computation that goes from `CLEAN` to
stale propagates `CHECK` to *its* dependents, transitively — flags only, no
evaluation, cut off at nodes that are already stale. A write is therefore
O(edges reached) in cheap flag work and recomputes nothing.

A read (`derived.get()`) validates on demand:

- `CHECK` → ask each versioned dependency to bring itself up to date, then
  compare. If nothing moved, the node is `CLEAN` again **without having
  recomputed** — this is pull's structural advantage: an equal value in the
  middle of a chain stops recomputation of everything below it, even though
  the stale marks already travelled all the way down.
- `DIRTY` → recompute. If the fresh value differs, bump the version.

### 2.2 Version sums

The obvious way to answer "did any dependency change since I last ran" is to
record a version per edge and compare them one by one. Since versions only
ever increase, their **sum** carries the same information: `Σ dep.version`
moves if and only if some dependency's version moved. So a node keeps one
number, captured after each evaluation, and a `CHECK` validation is one
addition per edge with no per-edge bookkeeping at read time at all.

### 2.3 The queue that remains

`UpdateQueue` loses the priority grid entirely — 531 lines net — and becomes
per-channel FIFO lanes. Only two kinds of node are ever queued:

- a stale node with **external observers**, which owes them a notification if
  its value turns out to have changed, and
- a stale node in an **on-demand channel**, which must wake its channel's
  trigger and settle inside that channel's budget.

The interior of the graph is never queued at all; it is revalidated when some
settled node pulls it, or not at all.

### 2.4 Channels still work, and why that was not obvious

The worry — raised while this was being built, and a good one — is that pull
should break update channels. Publishing a change becomes nearly free, so
there is nothing left in the write to defer; what costs is the *read*, and a
read happens whenever somebody asks, not when the frame budget allows.

What resolves it is a **freeze rule**. A stale node in an on-demand channel
that has a cached value serves that cached value to every pull arriving while
its channel is not the drain target, and suppresses mark propagation
downstream — and, crucially, **enqueues itself**. So the expensive reads are
exactly what sits in the lane waiting for frame time, and the lane's
population is essentially the set of nodes push would have queued. Budgets,
triggers, `manual` mode, `pause`/`resume`, `maxStalePasses`,
`hasPendingUpdates` and `pendingCount` all behave as before; freedom's portal
pump works unchanged.

The one real difference is **granularity**. Settling an entry pulls its stale
upstream ancestors atomically, so a budget can overrun by one *chain* rather
than one *node*. In exchange, a cut-off can no longer leave a region torn —
under push, a budget exhausted mid-pass could leave new rects with old clip
boxes; under pull, every settled chain agrees with itself. Portal graphs are
shallow (store key → rect → clip → visibility → effect), so the overrun is
small against a 5 ms budget.

### 2.5 Deliberate semantic changes

- A budgeted drain preempts between dependency chains, not between nodes
  (§2.4).
- Reads inside a `batch()` validate eagerly and return fresh values, where
  push served the pre-batch value until the batch flushed. External
  notification still happens once, at the end.
- A node nobody reads and nobody subscribes to no longer recomputes on
  invalidation, so `getEvaluations()` counts can legitimately drop.
- `setPriority`/`getPriority` remain exported but no longer influence
  scheduling.

## 3. What the measurements said

### 3.1 The confound, and the control

The first round of measurement looked like a clear win: +30–45% on the
portal-shaped microbenchmarks. But the refactor had also introduced several
optimizations that have **nothing to do with push versus pull**:

- dependent computations registered directly and invalidated through a plain
  method call, instead of a per-edge observer object on a shared list;
- a node's priority as a data property instead of a `WeakMap` entry — it is
  read for every dependency on every recomputation;
- the update queue's per-task entry on the task instead of a `WeakMap`;
- no `Array.from` copy of the dependency set per recomputation.

All four apply perfectly well to the push strategy. So they were ported onto
unchanged push (PR #164) to serve as a **control**, and all three variants
were then run interleaved in one session — baseline push, push + opts, pull —
so that session drift could not be handed to whichever ran last.

### 3.2 Three-way attribution

Medians of three interleaved rounds, ops/sec:

| benchmark | push | push + opts | pull | opts alone | **strategy alone** |
| --- | ---: | ---: | ---: | ---: | ---: |
| `Derived#get` (unsubscribed) | 3.15M | 4.18M | 4.12M | +33% | −1% |
| `Derived#get` (subscribed, memoized) | 75.0M | 74.0M | 65.0M | −1% | **−12%** |
| `Signal#set` (1 subscriber) | 6.51M | 6.91M | 6.36M | +6% | −8% |
| 10-level deep chain update | 119k | 160k | 176k | +35% | **+10%** |
| 100-way fan-out | 17.6k | 23.1k | 20.4k | +32% | **−12%** |
| diamond update | 477k | 534k | 532k | +12% | −0% |
| `batch()` — 100 writes | 32.1k | 33.8k | 33.6k | +5% | −1% |
| 1 write/frame, eager | 2,597 | 3,953 | 3,483 | +52% | −12% |
| 8 writes/frame, batched | 1,442 | 2,314 | 2,642 | +60% | **+14%** |
| scroll frame, 100 rows | 1,065 | 1,601 | 1,549 | +50% | −3% |
| scroll frame, 300 rows | 286 | 415 | 360 | +45% | **−13%** |

(`Signal#get` is omitted: it is a read of a field behind a function call,
measured in the hundreds of millions of ops/sec, and its spread across rounds
exceeded the differences being claimed.)

**The bulk of the improvement is the optimizations, not the strategy.** With
both sides equally optimized, pull is ahead where writes coalesce (+14% at 8
writes per frame) and on deep chains (+10%), behind on wide fan-out (−12%)
and on memoized reads (−12%), and inside the noise elsewhere.

### 3.3 In a real browser

`apps/showcase-xr/bench` driving `todo-xr` (825 mirrored elements) under
Playwright/SwiftShader, three interleaved rounds, **push + opts versus pull**,
medians:

| scenario | counter / time | push + opts | pull |
| --- | --- | ---: | ---: |
| scroll | `getBoundingClientRect` per frame | 16.5 | 16.3 |
| scroll | frame gap median, ms | 58.5 | 61.2 |
| mutate | `getBoundingClientRect` per frame | 32.7 | 31.9 |
| mutate | frame gap median, ms | 52.5 | 50.3 |

**Indistinguishable**, in the counters and in the times alike. The harness's
own null test puts the noise floor on times at ~17%, and every difference
here is well inside it.

This corrected an earlier, wrong conclusion. A *cross-session* comparison of
baseline push against pull had shown pull performing a third fewer forced
layouts on `mutate` (37.4 → 25.2 per frame), which was reported as pull's
laziness skipping measurement chains nothing read. The controlled rerun shows
32.7 versus 31.9 — the earlier gap was session drift. Unlike the steady-state
scenarios, `mutate`'s counters are **not** stable across benchmark sessions,
which the bench's own documentation does not warn about and which is worth
remembering the next time a counter is treated as noise-free evidence.

### 3.4 The jsdom mirror benchmark

`packages/three/src/elements/mirror.bench.js`, wall-clock ms. These numbers
compare *baseline push* against *pull*, so they carry the same confound as
§3.1 and should be read only for shape:

| scenario | push | pull |
| --- | --- | --- |
| mount 100/200/400/800 (normal flow) | 442/876/2161/3564 | 360/800/1576/3526 |
| mount 100/200/400/800 (clipped) | 861/1703/3631/3816 | 632/858/1325/2853 |
| +1 row on a panel of 100/200/400/800 | 26/42/116/203 | 40/62/146/218 |
| built one row per flush, 100…800 | 964/3890/13692/68942 | 1310/5768/22422/84444 |

Mounting is faster; structural-mutation flushes are slower. Profiling put the
whole of the latter in the mark wave and the validation walks: a mutation
flush re-measures every element, so nearly every write's *potentially*-
affected closure has to be marked and validated, where push's equality gates
pruned the actually-quiet portion before it reached the queue. Pull pays
O(potentially affected) in cheap flag work; push pays O(actually changed) in
expensive recomputation. In a real browser, where the mirror's cost is layout
and raster rather than graph walking, this difference disappears (§3.3).

## 4. Why it was not merged

1. **The regressions land on the hottest paths.** Memoized `Derived#get` is
   the most-executed operation in the library, and wide fan-out is exactly
   the shape a portal produces on every frame of a scroll. Both are −12%. The
   wins sit on less critical paths.
2. **No browser-level benefit to pay for that.** §3.3 is a wash.
3. **Risk is asymmetric.** The push core is battle-tested, and its comments
   record real production bugs found and fixed — lanes renumbering mid-pass,
   stale slots, the scroll-and-clip tearing regression. The pull core is new,
   and its subtlety is concentrated in exactly the places where reactive
   protocols usually go wrong: the mark-generation guard against writes
   landing mid-evaluation, the skip-reader rule, frozen-boundary propagation,
   convergent write-during-evaluate cycles. Every one of those is tested; the
   concern is the case nobody thought to test.
4. **The simplification is smaller than it looks.** `UpdateQueue` lost 531
   lines, but the complexity moved rather than vanished — into
   `Computation`/`Derived` as the mark-and-validate protocol. The scheduler
   got simpler; the node got subtler.

## 5. What would change the answer

Any one of these makes the question worth reopening — the implementation is
already written, tested, and rebased onto a strategy-only diff:

1. **Laziness gets something to skip.** Today freedom subscribes to
   essentially every computation it builds, so "unread work is never
   evaluated" has no work to decline. Features with large *unobserved*
   regions — offscreen panels kept warm, speculative layout, headless state
   trees — change pull's economics outright.
2. **The push queue costs a bug.** Its complexity is currently paid-for. The
   next real defect traced to depth-priority bookkeeping shifts the balance.
3. **On-device profiling disagrees with the container.** The benchmarks here
   run on a server under SwiftShader. If a Quest profile shows frame time
   dominated by many-invalidations-per-frame shapes, pull's +14% there is the
   win that would matter.
4. **The two regressions get closed.** Both have identified causes — the
   per-read field checks on the memoized path, and mark-wave volume on wide
   fan-out — and neither looked fundamental. Optimization simply stopped once
   the attribution question was answered.

## 6. What to take from this regardless

- **PR #164** — the four strategy-neutral optimizations, on unchanged push,
  worth +30–60% on update-heavy paths with no semantic change at all. That is
  the shippable result of this experiment.
- **Interleave A/B rounds, and never compare across sessions.** The one wrong
  conclusion in this whole exercise came from a cross-session counter
  comparison that looked authoritative because counters are usually
  deterministic.
- **Control for incidental changes before crediting an architecture.** A
  refactor of this size cannot help but carry optimizations that are
  orthogonal to the idea being tested. Without PR #164 as a control, this
  document would have claimed a 30–50% win for pull-based reactivity, and it
  would have been wrong.

[Reactively]: https://github.com/milomg/reactively
