# `justdom-signal`: the pull-based core

**Status:** implemented. `packages/signal` is now a pull-based library with
three node kinds — `Signal`, `Derived`, `Effect` — and no notion of depth
anywhere in the graph.

This supersedes the earlier experiment recorded in
[`signal-pull-vs-push-experiment.md`](./signal-pull-vs-push-experiment.md),
which built a pull core, measured it against push, and did not merge it. That
document's §5 listed what would change the answer. Two of the four did.

---

## 1. The defect that reopened the question

The push core ordered recomputation by **depth**: every node carried its
distance from the nearest source, and the update queue drained
shallowest-first so a dependency always ran before its dependents. Depth was
computed on every recomputation as `max(depth of dependencies) + 1`.

That works only while the queue can see the shape of the graph. It could not.
`toObservable(derived)` returned a plain RxJS `Observable`, which carries no
depth; `getPriority` answered `0` for it, meaning "this is a source, schedule
whatever reads it first". Every wrapper in the package had the same hole —
`toObservable`, `valueOf`'s proxy, `onEachValue` — and so did every RxJS
operator downstream of them.

Measured on a five-deep chain read two ways:

```
direct chain:                        s=0  a=1  b=2  c=3
the same chain via toObservable:     s=0  a=1  b=1  c=2
observable(() => c.get()) read back:                 1   (should be 5)
Derived.from(toObservable(c)):                       2   (should be 5)
```

The consequence is not a slow graph, it is a wrong one. A node reading a
depth-5 value through a wrapper and a depth-1 value directly was scheduled at
depth 2, recomputed against the stale deep value, and published a number the
graph never held:

```
reads the deep node directly:        observed []          2 evaluations
reads it through toObservable:       observed [-1, 0]     3 evaluations
```

`-1` is arithmetically impossible for that graph. This is §5.2 of the earlier
document — "the next real defect traced to depth-priority bookkeeping shifts
the balance" — arriving.

A patch was possible: annotate each wrapper with a link to its source and
walk the chain in `getPriority`. RxJS sets `.source` on every operator
observable, so that would have covered `pipe`, `share` and friends for free,
and it fixed the repro. But it only ever converges on "the depth we can still
see", and switch-map shaped operators change which upstream is live over
time, so the number stays a lower bound. The number itself was the problem.

## 2. What replaced it

### 2.1 Three kinds of node

|           | reads | has a value | scheduled |
| --------- | ----- | ----------- | --------- |
| `Signal`  | no    | yes         | no        |
| `Derived` | yes   | yes         | no        |
| `Effect`  | yes   | no          | **yes**   |

The split is what lets the queue leave the value path entirely. Under push,
`Derived` did double duty — it was both the transformation and the thing that
had to be ordered — so every value in the graph went through the queue.
Now only effects do, and the queue no longer needs to know anything about
graph shape.

`Computation` survives outside the table, because it is none of the three: a
tracking scope with no value at all. Two things want one. A **relay** stands
in for a foreign source so it can be shared, filtered or cached before the
graph depends on it — what `memoizeDependency` builds, and what a
`ReactiveMap`'s per-key streams are made of; having no value, it announces
every invalidation and bumps its version each time, because a dependent
resolving a `CHECK` against it has nothing to compare and must conclude
"changed". A **listener wrapper** gives an event handler its own tracking
scope, so what the handler reads belongs to the handler rather than to
whatever happened to be evaluating when the event arrived — which is what
`Emitter.on` and freedom's frame listeners use it for.

### 2.2 Marking, in two colours

A write marks its direct dependents `DIRTY` and everything below them
`CHECK`, then stops. The walk is cut short at any node already marked,
because everything beneath it was marked when _it_ was, so a burst of writes
into one subgraph costs one walk rather than one per write.

`CHECK` means "ask, don't assume". Resolving one compares each dependency's
version against the version this node last saw; if every dependency comes
back unchanged, the node returns to `CLEAN` without evaluating. That is what
keeps an `isEqual` cutoff worth anything — with a single colour, a write at
the root of a chain would re-evaluate the whole chain to discover that
nothing downstream moved.

Foreign `Subscribable` dependencies have no version of their own, so the edge
counts emissions for them and the comparison works uniformly.

### 2.3 Ordering

There is none to arrange. `Derived#get` resolves its dependencies before
returning, so the call stack of a read is the topological order — and it is
exact rather than approximate, because it is made of the reads that actually
happened, including conditional ones, including reads through anything an
application wrapped a node in.

`src/pull.test.js` keeps this honest: the same diamond read directly, read
through `toObservable`, and read through `toObservable().pipe(map, map,
shareReplay)` produces identical observations and identical evaluation
counts.

### 2.4 Channels, and correcting their order

Effects belong to an `UpdateChannel`. Channels drain in `order`; within a
channel, effects run in the order they were invalidated, which is all the
ordering an output needs.

An effect may invalidate an effect in a **later** channel. The other
direction is a mistake, and the queue corrects it rather than warning about
it: the channel that was written into is raised above the one that wrote and
re-sorted, so the pass reaches it again on its way down. The correction is
immediate _and_ permanent, and `channel.order` reads back the corrected
value. `fixedOrder` opts out and warns instead; the default channel is fixed
at 0, because moving it would reorder every effect in a program that never
asked for channels.

Two guards bound the pathological cases:

- **Mutually triggering channels** cannot be fixed by any ordering, so
  corrections are capped per pass; past the cap the work waits for the next
  pass and the queue says why.
- **Two effects that each write what the other reads** are an application
  cycle, not a scheduling problem, and raise `CircularDependencyError` rather
  than hanging. Whichever guard sees it first says so: an effect that ends a
  hundred consecutive runs still owing itself another, or — for a cycle whose
  hops never nest — any effect that runs 200 times in a single pass.

An effect that writes something it reads _itself_ is allowed, because one
that clamps or normalises its input settles on the second run. It is only an
error if it has not settled after a hundred consecutive runs.

The re-run happens **inside the effect**, not through the queue. A run that
invalidates itself is still on the stack when the queue hears about it, and
re-entering it would settle the outer run's dependency bookkeeping against
flags an inner run had already reset, and pair every teardown with the wrong
run. So a queued task that arrives while its effect is running declines, and
the run loops once it has unwound — which is also what the consecutive-run
count has always assumed.

### 2.5 What the queue became

`UpdateQueue` kept the channel machinery — passes, budgets, triggers,
`maxStalePasses` escalation, deferred flush requests — and lost the whole of
the priority apparatus: the per-channel grid of FIFO buckets indexed by
depth, the re-prioritisation of queued tasks whose depth changed, the
stale-slot recognition at drain time, and the out-of-grid list for depths too
large to index. What is left per channel is an array, a read cursor and a
`queued` flag.

## 3. Measurements

Three interleaved rounds of `develop` at `2c6f9cf` against this branch's head,
alternating within one session — never across sessions, per §6 of the earlier
document. Medians of the three per-round medians, ops/sec:

| benchmark                            | develop | branch |    change |
| ------------------------------------ | ------: | -----: | --------: |
| `Signal#get`                         |  160.2M | 160.1M |         — |
| `Signal#set` (no subscriber)         |   9.57M |  9.71M |         — |
| `Signal#set` (1 subscriber)          |   9.39M |  9.33M |         — |
| `Derived#get` (unsubscribed)         |   5.68M | 13.81M | **+143%** |
| `Derived#get` (subscribed, memoized) |  123.9M | 147.2M |  **+19%** |
| 10-level deep chain update           |    194k |   578k | **+199%** |
| 100-way fan-out                      |   31.5k |  77.6k | **+147%** |
| diamond update                       |    662k |  1.65M | **+149%** |
| `batch()` — 100 writes               |   45.8k |  70.0k |  **+53%** |
| scroll frame, 100 rows               |   2,225 |  3,438 |  **+55%** |
| scroll frame, 300 rows               |     640 |  1,050 |  **+64%** |
| 1 write/frame, eager                 |   5,347 | 10,876 | **+103%** |
| 8 writes/frame, eager                |     690 |  1,394 | **+102%** |
| 8 writes/frame, batched              |   3,316 |  8,188 | **+147%** |

The first three are written as unchanged rather than as a percentage on
purpose: `Signal#get` lands within 3% across all six runs, and `Signal#set`'s
own per-run spread reaches 25–52% on some rounds, so any number quoted for it
would be noise dressed up as a result. Nothing on the write path got faster or
slower; what changed is everything downstream of it.

The same benchmark reports a **deterministic** count of recomputations per
frame, and it is identical on both sides:

| writes/frame | develop, eager | batched | branch, eager | batched |
| -----------: | -------------: | ------: | ------------: | ------: |
|            1 |            420 |     420 |           420 |     420 |
|            2 |            850 |     450 |           850 |     450 |
|            4 |          1,700 |     500 |         1,700 |     500 |
|            8 |          3,400 |     600 |         3,400 |     600 |

Which settles the obvious suspicion about a doubled throughput figure: the
branch is not faster because it computes less. It performs exactly the same
recomputations and pays less per recomputation, because the queue is no longer
on the value path.

Two caveats on reading the timings.

**The scroll-frame and write/frame rows are not the same file on both sides.**
Those benchmarks held their chains open with
`subscribe({ next: () => node.get() })`, which forces evaluation under push;
under pull a bare subscription hears that a value may have moved and never
asks what it is, so the ported versions use an `Effect`. The workload is the
same — one write propagating through 300×3 chains, every leaf read — but the
harness differs. Every other row is the same file on both sides, modulo an
import path and one assertion.

**These are much larger differences than the earlier experiment found**, and
that is worth being suspicious of. It reported pull and push+opts
indistinguishable, with −12% on memoized reads and −12% on wide fan-out.
Two things plausibly account for the gap, and both are consequences of the
design rather than of tuning:

1. **The earlier pull core still scheduled computations.** It kept `Derived`
   doing double duty, so values continued to travel through the queue.
   Splitting `Effect` out takes the queue off the value path entirely, which
   is exactly where the deep-chain, diamond and fan-out benchmarks spend
   their time.
2. **The memoized-read regression was closed** — §5.4 of that document
   predicted it was not fundamental. `Derived#get` now answers from two field
   reads (`#current !== null && state === CLEAN`) before reaching any of the
   liveness or validation machinery.

The browser-level result of the earlier experiment (§3.3, a wash) has **not**
been re-measured here, and nothing in this document claims a frame-time
improvement in a real headset. What is claimed is correctness, and a
microbenchmark profile that no longer argues against it.

### 3.1 Bundle size

Shipped output, `vite build` under `rush build`, `develop` at `2c6f9cf`
against this branch. Totals over every `.js` file each app emits:

| app                   | develop gz | branch gz |   delta |
| --------------------- | ---------: | --------: | ------: |
| `marblerun`           |    451,541 |   452,555 | +0.22 % |
| `castle-xr`           |    435,827 |   436,780 | +0.22 % |
| `todo-xr`             |    373,646 |   374,736 | +0.29 % |
| `kanban-webrtc`       |     34,687 |    35,706 |  +2.9 % |
| `minesweeper-vanilla` |     29,372 |    30,444 |  +3.6 % |
| `signal-ssr`          |     16,508 |    17,567 |  +6.4 % |

The absolute cost is the same everywhere — **+3.4 to 3.6 KB raw, about +1 KB
gzipped** — because it is the library, not anything the apps do with it. What
changes is the denominator: against an XR app carrying three.js it is a fifth
of a percent, and against a DOM app it is a few percent.

It does not treeshake away. Bundling only the symbols the workspace actually
imports saves under 200 bytes against bundling the whole barrel, because this
library's surface all reaches the core.

Where it goes, per module (esbuild, minified bytes, `rxjs` external):

| module             |  delta |
| ------------------ | -----: |
| `Node.js` (new)    | +3,511 |
| `Derived.js` (new) | +2,277 |
| `Effect.js` (new)  | +1,552 |
| `UpdateChannel.js` |   +666 |
| `interop.js` (new) |   +357 |
| `operators.js`     |   +214 |
| `Computation.js`   | −2,533 |
| `Signal.js`        | −1,838 |
| `core.js`          |   −488 |
| `UpdateQueue.js`   |   −167 |

The three-way split is what costs: the old `Signal.js` carried both `Signal`
and `Derived`, and the old `Computation.js` was their base, so those two give
back 4.4 KB while `Node`/`Derived`/`Effect` cost 7.3 KB. `UpdateChannel` grows
by the order-correction machinery and its diagnostics.

One number deserves a caveat against the claim in §2.5. `UpdateQueue` lost the
whole depth-indexed priority apparatus and came out **167 bytes smaller** —
780 lines to 705, 414 non-comment lines to 376. The structural simplification
is real, but it very nearly paid for itself rather than being a saving: what
the priority grid gave back went straight into the FIFO lanes, the
channel-order correction and the cycle guards.

### 3.2 Teardown, and which value owns it

A `Derived` that holds an expensive resource and releases it through
`onCleanup` needs its teardown and its value to stay in step, and the
equality cutoff is where that can come apart.

The push core ran the previous teardowns on the way _into_ an evaluation and
then always stored the new value, using `isEqual` only to decide whether to
notify. The first version of this pull core kept the same teardown-first
order but _did_ let `isEqual` decide the value — so a node that said "the
rebuild is the same as what I hold" kept the old value whose teardown had
already fired, and handed its readers a disposed handle.

Teardowns are therefore staged rather than run: the previous run's are set
aside, the evaluation happens, and whichever set belongs to the value that did
**not** survive is the one that runs.

| outcome                    | value kept           | teardowns run                                  |
| -------------------------- | -------------------- | ---------------------------------------------- |
| the new value differs      | the new one          | the previous run's, after the new value exists |
| `isEqual` says it does not | the one already held | the rebuild's                                  |
| the evaluation threw       | none                 | both                                           |

Which makes `isEqual` mean what it says. Telling dependents that nothing
changed while swapping the object underneath them was never coherent; now the
held resource is the one that stays, and the speculative rebuild is what gets
released. Three tests in `Signal.test.js` cover it, and all three fail against
either previous core.

This is also the sharp edge of "a `Derived` must be pure", and the one that
caught this library itself. A node that _sets something up_ — starts an
interval, adds a listener — and registers an `onCleanup` to undo it, while
returning a value `isEqual` to its last, has that setup torn down the moment
it happens: the rule cannot tell "you rebuilt a texture you already had" from
"you just started something". `use()` was built that way, returning the same
`NEVER` singleton on every evaluation, which is how it went unnoticed until a
marble emitter stopped emitting. It is an `Effect` now, like `effects()`.

The cost is that both resources exist briefly, which is unavoidable: there is
no way to know a rebuild is equal without building it. A node that wants to
avoid the rebuild entirely should depend on what the resource is built _from_,
which is the right shape anyway.

One thing to know: the cache is a property of being **connected**, not of
being a `Derived`. A node holding none of its dependencies open has nothing
keeping a cached value coherent, so it rebuilds on every read — releasing the
read before it, and leaving the last one to nobody, since a node that was
never connected is never disconnected. A node that owns a resource wants an
`Effect` reading it.

Connected is not the same as being read, and the difference is exactly what
`cacheTTL` buys: during the window the last reader has gone but the node is
still subscribed and still holding its value, so a read then is an ordinary
cached read. Treating it as a read of a node that owns nothing would run the
held value's teardowns on the way in and re-record its dependency versions on
the way out — a cache whose resource is disposed and whose bookkeeping claims
it is current.

## 4. Deliberate semantic changes

- **A `Derived` must be pure.** It evaluates when read, which may be never.
  Side effects inside one no longer run; they belong in an `Effect`. This is
  the migration that bites, because it fails quietly.
- **`subscribe()` notifies on invalidation, not on change,** and does not
  evaluate anything. It fires on the transition from clean to stale; a
  subscriber that pulls in the handler re-arms it.
- **Unbatched writes cost one evaluation, not one each.** `batch()` still
  keeps an _effect_ from running twice; it is no longer what keeps a value
  from being computed twice.
- **`getPriority` / `setPriority` / `getChannelOrder` are gone.** Nothing in
  this repository used them.
- **`effect()` builds an `Effect`;** the old teardown-only helper is
  `resource()`, and `addSideEffect` is `addResource`.
- **`getEvaluations()` counts drop.** Work that used to be done eagerly and
  discarded is not done at all.

## 5. What the migration of `freedom` and `justdom` cost

`justdom` needed **no source changes at all**: 62/62 before and
after. Nothing in it depends on when a `Derived` runs.

`justdom-three` needed three changes, and its suite scores **331/331 both
before and after**: no regressions, and — contrary to what earlier drafts of
this section claimed — no fixes either.

That took four attempts to get right, and the three wrong ones share a cause
worth recording: every one came from a hand-assembled `node_modules` rather
than from `rush install`.

- **293 → 309, twenty-two failures blamed on jsdom.** jsdom **30** was
  installed where `@justdom/jsdom-env` pins **^26.1.0**; jsdom 30 stops
  expanding the `overflow` shorthand into `overflowX`/`overflowY` on a
  computed style, and freedom's clip-box tests set the shorthand and read the
  longhands back.
- **314 → 330, sixteen tests "fixed"** — seven in `scrollable`, five in
  `dropdown`, four in `keyboard`. All three files import `justdom`,
  and that is the tell: the baseline pointed freedom's `justdom-signal` at
  the old core but left `justdom`'s pointing at the new one, so one process
  held **two signal module instances** and nodes built by one were not
  `instanceof` the other's `ReactiveNode`.
- **330/331, "a pre-existing keyboard/canvas failure".** There is no such
  failure. `canvas` is a real dependency of the workspace and `rush install`
  installs it; the hand-built tree simply lacked it.

`rush install` followed by `rush build` resolves all three in about three
minutes, and builds and tests all 38 projects besides. There was never a
reason not to use it.

What justifies this change is therefore §1 — a defect demonstrated by a repro
that involves no jsdom, no justdom and no freedom at all — and §3, a straight
A/B of one package against itself. Nothing in freedom's suite exercises the
diamond-through-a-wrapper shape, which is why it was neither broken before nor
fixed after.

Measured on Node 22.22.2 under `rush install` (jsdom 26.1.0), `develop` at
`2c6f9cf` against this branch.

### 5.1 `subscribe` and pull do not batch

This is the one thing that surprised. The idiom

```js
const subscription = node.subscribe({ next: () => node.get() });
```

still _works_ — the handler pulls, which resolves the node and re-arms the
notification — but it no longer collapses. Observers are notified
synchronously, inside the write, so a handler that pulls does its work in the
middle of the batch and is notified again on the next write. Two mutations in
one flush produce two recomputations where the push core produced one.

An `Effect` is the fix and was always the right spelling: it goes on the
queue, which dedups it, so two invalidations in a batch are one run.

```js
const holder = new Effect(() => node.get());
```

Twenty-six further instances of the idiom remain in freedom's test files.
They all pass, because none of them depends on batching — but they are the
old spelling, and any of them that grows to care about how many times
something ran will need converting first.

### 5.2 What is still failing

Nothing. `rush build` is green across all 38 projects, freedom included.
