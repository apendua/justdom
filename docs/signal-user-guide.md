# `justdom-signal` and `justdom`: a user guide

> **Note (superseded in part).** This guide was written against the
> push-based core. `packages/signal` is now pull-based, with a third node
> kind (`Effect`) and no depth ordering anywhere. The operator layer and the
> collections behave as described, and so does most of the rest — but §1 in
> particular is staler than "some timing changed", so read
> [`signal-pull-model.md`](./signal-pull-model.md) first. What this guide
> still gets wrong:
>
> - **When a `Derived` runs.** It is lazy: a write marks, and the value is
>   computed when somebody reads it. It may never run.
> - **What `subscribe` means.** It is an invalidation channel — it fires on
>   the transition from clean to stale, evaluates nothing, and does not
>   batch. It is not a value stream.
> - **Where side effects belong.** In an `Effect`, which is the third node
>   kind and the only one that is scheduled or belongs to a channel. A
>   `Derived` must be pure.
> - **§1.1's class hierarchy.** `ReactiveNode` is the base of `Signal`,
>   `Derived` and `Effect`. `Computation` is no longer that base — it is a
>   value-less tracking scope used as a relay or a listener wrapper — and
>   side effects are attached with `addResource`, not `addSideEffect`.
> - **§1.3's caching rule.** Caching follows being **connected**, not having
>   "an active subscriber": a bare `subscribe` connects a node but does not
>   evaluate it, and a `cacheTTL` window keeps a node connected after its
>   last reader leaves. `resetOnRefCountZero` is gone; `cacheTTL` is the
>   knob.
> - **`toObservable`.** It is now an `Effect` per subscriber that reads the
>   node and pushes what it read, rather than a wrapper that calls `next` on
>   subscribe and on every change.

This guide documents `packages/signal` (a hand-rolled reactivity/signals library
built on top of RxJS) and `packages/justdom` (a non-VDOM DOM renderer that consumes
those signals). It is based entirely on reading the source, the test suites,
and the apps in this monorepo that use both packages (`apps/todo-vanilla`,
`apps/minesweeper-vanilla`, `apps/kanban-webrtc`, `apps/signal-ssr`). Neither
package has a README or design doc of its own — the one exception is
`apps/signal-ssr/README.md`, which documents the server-rendering and
hydration path (§3.7) — and the git history available in this clone is
shallow (50 commits), so anything about _intent_ beyond what the code and
commit messages show is explicitly flagged as inference, not fact.

---

## 1. Core primitives

### 1.1 `Computation` — the base reactive node

`packages/signal/src/Computation.js` is the engine underneath everything else.
It is **not exported from the package's public API directly by name in most
call sites**, but it is exported (`export { default as Computation }` in
`index.js`) and both `Signal` and `Derived` extend it.

A `Computation`:

- implements `Subscribable<void>` (an RxJS-compatible `subscribe()`),
- tracks a `Set` of **dependencies** (other `Subscribable`s it has read from)
  and a `Set` of **side effects** (dependencies that should stay subscribed
  even when not read during the last `run()`, used e.g. to run cleanup/render
  effects),
- exposes `run(fn)`, which sets itself as the _active computation_, executes
  `fn`, collects whatever dependencies got registered via `addDependency`
  during that call, and unsubscribes from any dependency that was _not_
  touched this time (fine-grained dependency tracking, recomputed on every
  run — same idea as Solid's/Vue's "collect on read" tracking),
- turns into a **shared, ref-counted** Observable via RxJS's `share()`
  (`Computation.js:63-68`). While nobody is subscribed, `resetOnRefCountZero`
  (by default `true`, but overridable — see `Derived`'s `cacheTTL` option)
  tears the whole thing down and re-subscribes to dependencies from scratch
  next time something subscribes.
- runs registered `onCleanup` callbacks before every re-run and when the last
  subscriber disconnects.

This "active/inactive" duality is the single most important thing to
understand about the whole library: **a `Computation` behaves differently
depending on whether anything is subscribed to it** (see §2).

### 1.2 `Signal<T>` — writable state

`packages/signal/src/Signal.js:243-301`.

```js
const count = Signal.of(0);
count.get(); // 0, and registers `count` as a dependency of the
// currently active computation, if any
count.set(1); // no-op if isEqual(old, new); otherwise invalidates
count.setFn((n) => n + 1); // update by function of current value
```

- `get()` throws `NoValueError` if the signal was constructed without an
  initial value (`Signal.of()` with no argument).
- `set()` compares with `isEqual` (`Object.is` by default, itself run
  non-reactively via `makeNonReactive`) and only pushes an invalidation
  (`updateQueue.invalidate(this)`) if the value actually changed.
- A `Signal` is itself a `Dependency`/`Subscribable`; subscribing to it gives
  you a stream of "something changed" notifications (no payload — you call
  `get()` to read the new value).

### 1.3 `Derived<T>` — computed values

`packages/signal/src/Signal.js:50-237`. This is the "computed"/"memo"
equivalent.

```js
const doubled = new Derived(() => count.get() * 2);
doubled.get(); // runs the evaluate function, tracking `count` as a dependency
```

Key behavior, directly asserted by the test suite
(`packages/signal/src/Signal.bench.js:47-77`, `Signal.test.js:7-31`):

- **If nobody is subscribed to a `Derived`, `get()` re-evaluates the function
  every single call.** There is no caching without an active subscriber.
- **Once something is subscribed** (`derived.subscribe(...)`), the value is
  memoized: `get()` returns the cached value, and the cache is only
  invalidated when a dependency notifies a change (push-based). This is
  proven in the bench file with an explicit "unsubscribed re-evaluates on
  every get() / subscribed does not re-evaluate" pair of tests.
- `invalidate()` is overridden to actually **re-run the computation and
  compare old vs. new value** with `isEqual` before propagating the
  invalidation further (`Signal.js:125-153`). This is what gives you a
  glitch-free diamond dependency graph: a `Derived` that depends on two
  signals which both changed in the same `batch()` recomputes once, and a
  `Derived` two levels downstream only re-notifies if its _own_ value
  actually changed, not just because an upstream input changed. This is
  explicitly tested (`Signal.bench.js:80-102`, "diamond graph: terminal node
  evaluates exactly once", and 144-187 for deep chains / fan-out).
- Circular dependencies are detected and thrown as `CircularDependencyError`,
  both for a signal set from within its own dependent computation
  (`Signal.test.js:174-185`) and for two `Derived`s that depend on each other
  (`Signal.test.js:204-211`). Note the subtlety tested at
  `Signal.test.js:187-202`: a "circular-looking" pattern that converges to a
  fixed point in one iteration (e.g. `s1.set(Math.abs(s1.get()))`) is
  tolerated rather than treated as an error, because the second write is a
  no-op.
- `options.cacheTTL` (default `-1`, meaning "tear down immediately when
  refcount hits 0") lets you keep a `Derived`'s subscription/cache alive for
  some milliseconds after the last subscriber leaves (`resetOnRefCountZero:
() => interval(this.#cacheTTL)`), useful for values that get
  subscribed/unsubscribed rapidly — i.e. any host that tears down and
  resubscribes on every render.
- `Derived.from(observable, { cacheTTL })` turns a plain RxJS `Observable`
  into a `Derived` by writing every emission into an internal `Signal`
  — a documented interop path from "push stream" back into "pull signal".

### 1.4 `core.js` — the tracking machinery

`packages/signal/src/core.js` holds the module-level "currently active
computation" pointer and the free functions used everywhere else:

- `activeComputation` — the single global mutable slot; `withComputation(c, fn)`
  swaps it in/out for the duration of `fn` (this is how a `Signal.get()` deep
  inside a call stack knows which `Derived`/effect is doing the reading —
  same technique as Solid's/Vue's global "current observer").
- `addDependency(dependency)` — registers `dependency` on the active
  computation, no-op if there is none.
- `onCleanup(fn)` — registers a teardown callback on the active computation;
  logs a warning and runs `fn` immediately if called outside any computation
  (to avoid silent leaks).
- `makeNonReactive(fn)` — wraps `fn` so that it always runs with
  `activeComputation` set to `null`, i.e. reads inside `fn` don't get tracked.
  Used pervasively to prevent accidental dependencies (e.g. the `isEqual`
  comparator on `Signal`, or the `has key in newValue` check inside `store()`).
- `getPriority` / `setPriority` — a `WeakMap`-based
  side-table assigning each dependency a numeric "depth" used by the
  scheduler (§2.3).
- `valueOf(dependency, getDefaultValue?)` — synchronously pulls the _current_
  value out of a "replaying" observable (a `BehaviorSubject`/`ReplaySubject`/
  `shareReplay(1)` source) by subscribing and immediately unsubscribing,
  throwing `NoValueError` if nothing was emitted synchronously. Bridges
  "push" observables back into pull-style signal reads.
- `toObservable(signal)` — the canonical way to turn a `{ get, subscribe }`
  signal into a plain RxJS `Observable<T>` that emits the current value on
  subscribe and again on every subsequent change (used everywhere the DOM
  layer needs an `Observable<T>` rather than a signal object, e.g.
  `factories.js`'s `observable()`). Notably, the file has a `// TODO: Explain
why this does not work.` comment above a commented-out simpler
  implementation using `getChanges().pipe(startWith(...))` — a sign that this
  bridging function had a subtle, apparently non-obvious bug that the author
  had to work around and hasn't fully documented. **Flag: I could not
  determine what exactly breaks in the simpler version; treat this as a
  known rough edge.**

### 1.5 Batching and scheduling — `UpdateQueue`

`packages/signal/src/UpdateQueue.js`.

```js
import { batch } from "justdom-signal";

batch(() => {
  s1.set(3);
  s2.set(5);
}); // downstream Derived recomputes once, not twice
```

- Every `Derived` invalidation goes through a single module-level
  `UpdateQueue` instance (`Signal.js:29`). **Sources do not**: a `Signal`
  write, a `store()` property write, a `ReactiveMap`/`ReactiveSet` mutation —
  none has dependencies to be ordered after, so each notifies its subscribers
  directly.
- **Every source wraps its notification in a batch**, and that is what keeps
  the graph glitch-free. Telling a dependent queues it, and outside a batch a
  queued dependent drains immediately — so an unbatched announcement would let
  the first dependent recompute, and everything below it with it, before the
  second dependent had heard anything. A computation reading two keys of one
  store, or a map key and that map's `size`, would recompute once per branch
  and would see the collection halfway through the mutation on the first of
  them. The batch holds the drain until every dependent is queued, which is
  precisely what the queue needs in order to order them by depth.
- The visible consequence for signals is that repeated writes to the same
  signal inside one `batch()` notify a _direct_ subscriber once per write
  rather than once in total; computations below are still deduped by the queue
  and recompute once.
- `batch(fn)` sets an `isBatching` flag, runs `fn`, then flushes. Nested
  `batch()` calls are flattened (only the outermost one flushes).
- Invalidated computations ("tasks") are bucketed by **priority**, not
  insertion order: one FIFO per priority level, plus a cursor that walks
  upward. `flush()` takes the shallowest pending task and calls
  `.invalidate()` on it repeatedly until the queue is empty — and
  `invalidate()` can itself push more tasks (e.g. invalidating a `Derived`
  may cause it to recompute, which may write to another `Signal`), including
  _below_ the cursor, which moves it back. That ordering is what a plain
  insertion-order queue could not give.
- **Priority = topological depth.** `Derived#recompute()`'s `onAfterRun`
  callback sets `setPriority(this, maxPriority)` to
  `1 + max(priority of every dependency read this run)`
  (`Signal.js:181-187`). Combined with the ascending drain (shallowest level
  first — i.e. deepest/most-downstream nodes are invalidated last), this is
  what gives the "diamond problem"-free guarantee under `batch()`: a node
  that depends (transitively) on two changed signals is guaranteed to have
  both upstream invalidations processed (raising its own priority as needed)
  before it is itself finally invalidated and recomputed — matching the
  glitch-free semantics tested in `Signal.bench.js`.
- Because priorities are depths — small consecutive integers — the levels
  need no sorting: push and pop are O(1) array operations with no
  comparisons. A task whose priority changes while queued is not moved; it
  is appended to its new bucket, and the entry left behind goes stale and is
  skipped at drain time. A priority too large for the grid — `Infinity` — is
  held aside and drained after every ordinary level, in priority order.
  `UpdateQueue.test.js` covers the ordering, re-prioritization, batching, and
  error-recovery corner cases.

### 1.5a Update channels — deferring work to a frame

`packages/signal/src/UpdateChannel.js`.

```js
import { UpdateChannel, Derived } from "justdom-signal";
import { animationFrames } from "rxjs";

const presentation = new UpdateChannel({
  name: "presentation",
  order: 1, // drains after the default channel, which is 0
  trigger: animationFrames(), // when a pass may happen
  budget: 4, // ms of wall clock one pass may spend
});

const row = new Derived(() => layout(model.get()), { channel: presentation });

presentation.hasPendingUpdates; // reactive boolean
presentation.pendingCount; // plain number, for diagnostics
presentation.flush({ budget: Infinity }); // settle it now — tests, screenshots
```

- A channel is a **scheduling class**. The queue drains by
  `(channel order, depth)`, channel first — every task in channel 0 before any
  task in channel 1, depth deciding within a channel. Two channels may share
  an order, and are then simply not ordered relative to each other.
- A channel with a **trigger** never drains because something was queued in
  it, only when the trigger fires. Between two triggers its work sits, which
  means the nodes in it keep serving their cached values — a panel mirrored
  into the DOM lags its inputs by up to a frame, on purpose.
- A **budget** bounds a pass in milliseconds. It bounds the tasks a pass
  _starts_, not the time it takes: one slow recomputation can overrun it and
  nothing can preempt that. Whatever does not fit waits for the next trigger,
  resuming at the depth the pass stopped at.
- Budgets can starve deep work: continuous input re-queues the shallow nodes,
  depth ordering keeps preferring them, and the deep ones never come up. After
  `maxStalePasses` (3 by default) passes cut short in a row, the next one
  ignores the budget — a hitch instead of a permanently stale subtree.
- **Channels must be terminal.** A node must not read a dependency from a
  later channel than its own, or channel-major order schedules it before the
  value it reads. `Derived` warns once per node when it sees such an edge.
  Practically: put the _whole_ region in the channel, not just the node at its
  boundary. Deferral does reach the whole subtree from the boundary alone —
  nothing below is told until the boundary runs — but a node left in the
  default channel is not counted against the channel's budget, and a pass cut
  short leaves it to be drained by the next unrelated write.
- **Sources never name a channel.** `Signal.set()`, a `store()` write and a
  collection mutation each wrap their announcement in `batch()`, and that is
  all they do about scheduling. `batch()` suppresses _auto-draining_, and only
  channels without a trigger auto-drain, so one global batch covers exactly
  what needs covering. Channel membership is a property of the reader.
- **Glitch-freedom is per channel.** A computation reading across a channel
  boundary sees the earlier channel's update first and the later channel's on
  its next pass. Each phase is internally consistent — there is no torn
  intermediate within a pass — but the whole-graph guarantee of §1.5 holds
  only within a channel, which is the price of the deferral.
- Channels are a property of the **subscribed** graph. An inactive `Derived`
  has no cache, so `get()` re-evaluates against live upstream state and
  ignores the channel entirely.

`UpdateChannel.test.js` covers the ordering, the budget, the catch-up pass,
the pending flag, pausing, and the deferred flush inside a batch.

### 1.6 `Emitter` — plain (non-signal) events

`packages/signal/src/Emitter.js`. A typed `addEventListener`/
`removeEventListener`/`emit` pub-sub class, deliberately **not** part of the
signal graph — `emit()` runs listeners inside `withComputation(null, ...)` so
that firing an event never accidentally registers a dependency. It backs:

- `on(event, handler)` — an operator (used pervasively by the DOM layer, see
  §3) that adds/removes a listener over the lifetime of a subscription and
  forwards handler errors to the outer subscriber.
- `fromEvent(emitter, event)` — turns an emitter's event into a plain
  `Observable`.
- The module-level `emit(data, event, payload)` in `store.js` looks up a
  `WeakMap<object, Emitter>` registered against a `store()` proxy, so
  arbitrary "component" objects can emit custom events without being
  `Emitter` instances themselves (see `TodoItem`'s `emit(props, "change",
...)` in the worked example below).

### 1.7 `store()` — a reactive proxy over plain objects

`packages/signal/src/store.js`. Given a plain object, `store(data, operators)`
returns a `Proxy` wrapping a (recursively "store-ified") copy, where:

- every property `get` calls `addDependency(getChangesAtKey(key))` — a
  per-key RxJS stream memoized via `memoizeDependency`/`createRecursiveCache`,
  so reading `store.foo` only creates a dependency on changes to `foo`, not the
  whole object;
- every property `set` diffs against the current value (`Object.is`), wraps
  plain-object values in a nested `store()`, and — if the _old_ value was
  itself a plain-object store — calls `replace()` to reconcile it in place
  (via `batch`) rather than tearing down and reassigning, presumably so that
  other parts of the app holding a reference to the nested store keep
  working;
- getters/setters defined on the original object are preserved but wrapped:
  a getter becomes a memoized `Derived` per proxy instance so it participates
  in dependency tracking like any other reactive read;
- `ownKeys`/`has`/`deleteProperty` are also instrumented, so `for...in`,
  spread, and `in` checks are reactive too;
- the proxy also exposes non-enumerable-looking `addEventListener`/
  `removeEventListener` intercepted directly in the `get` trap, wired to a
  private `Emitter` registered in the module-level `emitters` `WeakMap`
  (this is what the top-level `emit()` function and `on(event, handler)`
  operator hook into).
- `useEffects(proxy, operators)` immediately applies any operators passed to
  `store()` as a "self-effect" pipeline (see `TodoItem`'s
  `store(defaults, operators)` below, where `operators` are the `set(...)`/
  `on(...)` calls a parent passes in — a props/event API for
  vanilla-JS "components").

### 1.8 `selector()` / `arraySelector()` — read-only structural views

`packages/signal/src/selector.js`. Given a getter function returning an
object or array, returns a `Proxy` whose every trap (`get`, `ownKeys`, `has`,
`getOwnPropertyDescriptor`, `getPrototypeOf`) is backed by a memoized
`Derived`. The point is **structural memoization**: reading `selector(...).a`
returns another selector/arraySelector (for nested objects/arrays) or a
primitive, each independently memoized by key, so that if only one property
of a large object actually changed, only the parts of a UI that read that
specific property re-run — without you needing to hand-write per-field
`Derived`s.

### 1.9 `ReactiveMap` / `ReactiveSet`

`packages/signal/src/ReactiveMap.js`, `ReactiveSet.js`. Thin reactive wrappers
around native `Map`/`Set`: every read method (`get`, `has`, `size`, `keys`,
`values`, `entries`) calls `addDependency` on an RxJS `Subject` of change
events, filtered down to the relevant key/value where possible (via
`memoizeDependency`), so that, e.g., `map.has('x')` only depends on changes
to key `'x'`, not the whole map. `keys()`/`values()`/`entries()` return a
`LazyIterable` (`LazyIterable.js`) — a wrapper that defers to
`Map.prototype.keys()` etc. lazily on each iteration, because returning an
already-created (stateful) native iterator, or a plain object with a
`Symbol.iterator` method, would both break the caching/reconciliation
strategies used elsewhere in the codebase (per the inline comment).

### 1.10 `memoize` / `memoizeDerived` / `weakMemoize`

`packages/signal/src/memoize.js`. These implement "memoize a factory function
by key, but let the cache entry expire itself using the underlying reactive
node's own lifecycle" — i.e. instead of an LRU or manual cache-invalidation
policy, the cache entry adds a `addSideEffect` teardown observable that
inserts itself into the cache on subscribe and removes itself on
unsubscribe. So a memoized `Derived` naturally evicts itself from the cache
once nothing references it anymore. `createRecursiveCache()`
(`cache.js`) backs the default multi-argument key case: a trie of `Map`s
keyed on each argument in turn, so `getKey`-less multi-arg memoization
"just works" without needing to serialize argument tuples into a string key.

### 1.11 Decorators — `@memo`, `@memoFn`, `@mutate`

`packages/signal/src/decorators.js`. These are [stage-3 JS decorators]
(used with plain `decorate(target, key, ...decorators)` since this is a
JS+JSDoc codebase, not TypeScript-with-experimentalDecorators):

- `@memo` turns a getter into a per-instance memoized `Derived`
  (`WeakMap`-keyed on `this`), so `get foo() { ... }` on a class becomes
  reactive and cached exactly like a hand-written `Derived`.
- `@memoFn` does the same for a method, with an optional `getKey` to control
  cache-key derivation from arguments.
- `@mutate` wraps a method so that its body always runs non-reactively
  (`withComputation(null, ...)`) and wrapped in `batch(...)` — intended for
  "action" methods that write to multiple signals and shouldn't themselves be
  tracked as a read.

### 1.12 Factories and operators — the RxJS glue

`packages/signal/src/factories.js` and `operators.js` are what make signals
composable with RxJS pipelines, which is how the DOM layer (§3) is built.

- `observable(fn)` = `toObservable(new Derived(fn))` — the main "give me a
  push stream that always reflects this reactive expression" primitive.
- `component(fn)` wraps a function returning an `Observable` so that it
  itself becomes reactive to _its own_ internal signal reads, and
  re-subscribes to whatever `Observable` it returns whenever those change
  (implemented via `observable(() => fn(...args))` piped through
  `onEachValue(subscribeTo(v => v))`, i.e. a signal-aware `switchMap`).
- `just(value, operators)` — wraps a plain value as a `ReplaySubject(1)`-backed
  shared observable and immediately applies a list of "operator" functions to
  it (this is the DOM layer's way of doing "create a DOM node and apply a
  declarative list of imperative setup functions to it").
- `effects(fn)` / `effectMap(fn)` / `map(fn)` / `flatMap(fn)` /
  `takeNothing()` — the standard vocabulary of "operator" functions
  everything else (`set`, `attr`, `style`, `data`, `on`, `children`, `list`)
  is built from. `effects(fn)` re-runs `fn(value)` reactively as a pure side
  effect (via a throwaway `Derived` wrapped in `toObservable`), without
  changing what the pipeline emits; `effectMap` is the same but the returned
  inner `Observable<unknown>` is subscribed to for the whole time the emitted
  value is current (used when the side effect itself needs to run additional
  async/reactive logic, e.g. `set("className", value)` which needs to keep
  observing `value`).
- `use(observableOrThunk)` registers an observable purely for its side
  effects/lifetime as a dependency of the current computation, discarding
  its emitted values (`addDependency(observable.pipe(takeNothing()))`).
- `observe(target)` / `observeFn(target)` wrap a plain object/its methods in
  a `Proxy` that turns every property read (or method call) into an
  `Observable` via `toObservable(new Derived(() => target[name]))` — this is
  the bridge used to turn "some object with reactive getters" (a `store()`,
  a class with `@memo` getters, a plain object with getters) into
  "a bag of named Observables" for consumption from RxJS-flavored code (see
  `Game.ts` in §5).

---

## 2. How reactivity propagates

Putting the above together, propagation works like this:

1. **Reading** (`signal.get()`, a `store()` property access, `selector(...)`
   navigation, a `ReactiveMap`/`ReactiveSet` method) calls `addDependency`,
   which — if there is an `activeComputation` (i.e. you are inside a
   `Derived`'s evaluate function, or inside an operator pipeline built from
   one) — registers the thing being read as a dependency of that
   computation. Reads outside of any computation (top-level code, event
   handlers wrapped in `makeNonReactive`) are simply not tracked.

2. **Two very different regimes depending on subscription**:
   - **Not subscribed (no active listeners downstream)**: nothing is cached.
     Every `.get()` on a `Derived` re-runs its evaluate function from
     scratch, walking the whole dependency chain underneath it, and any
     dependencies it registers are torn down again as soon as the call
     returns (nothing stays subscribed to source `Signal`s). This is "pull,
     always" mode — cheap to set up, no memory held, but O(work in the
     entire upstream graph) per read.
   - **Subscribed** (`.subscribe(...)` called anywhere downstream, directly
     or via RxJS's `share()`/reference counting through several layers of
     `pipe()`): the computation's `run()` actually subscribes to every
     dependency it read, the result is cached (`#current`), and it stays
     cached until a dependency notifies a change. This is "push,
     memoized" mode.

   This dual behavior is deliberate and tested explicitly
   (`Signal.bench.js:47-77`) — it means the _same_ `Derived` object is cheap
   to read once ad hoc, and cheap to read repeatedly once something is
   actually watching it (e.g. mounted in the DOM), with no separate API for
   the two cases.

3. **Writing** (`signal.set(value)`) compares with `isEqual`; if changed, it
   stores the new value and calls `this.invalidate()` inside
   `updateQueue.batch(...)`. The signal itself never enters the queue — it has
   no dependencies, so there is nothing to order it after. The batch is what
   holds the drain until the notification has reached every dependent; unless
   we are already inside a `batch()`, the queue flushes as the write returns.

4. **Flushing** pops the highest-priority (deepest) task and calls its
   `.invalidate()`. A plain `Signal`'s `invalidate()` (inherited from
   `Computation`) just calls `this.#notifier.next()`, synchronously notifying
   every direct subscriber (i.e. every `Computation` that depends on it via
   `#subscribeTo`, whose `onInvalidateDependency` callback in turn calls
   `updateQueue.invalidate(dependent, priority)` — enqueuing the dependent
   rather than recomputing it right away); since the write above calls that
   directly, the tasks in the queue are always `Derived`. For a `Derived`,
   `invalidate()` is
   overridden: it actually **recomputes right there** (`#recompute()`),
   compares old vs. new with `isEqual`, and only propagates
   (`super.invalidate()` → notifies its own subscribers) if the value
   genuinely changed. So propagation is a mix of "eagerly recompute this
   node now, because we're processing it in priority order" and "lazily
   invalidate anything downstream by re-enqueueing it," which is what
   collapses a diamond-shaped dependency graph into exactly one recomputation
   of the shared descendant per `batch()` (or per individual `set()` outside
   a batch).

5. **`batch(fn)`** just defers the "flush" step until `fn` returns, so
   multiple `set()` calls only cause one pass through the priority queue.
   Each write still notifies its direct subscribers as it happens; what the
   batch collapses is the recomputation, not the notification.

6. **Cleanup** — `onCleanup(fn)` registered inside a computation's evaluate
   function runs right before the next `run()` (i.e. before recomputation)
   and when the last subscriber disconnects and the shared `Observable`'s
   `share()` teardown fires. This is the escape hatch for anything that
   needs imperative teardown (removing an event listener, closing a
   WebSocket) tied to the reactive lifetime rather than to garbage
   collection.

7. Because every reactive primitive here (`Signal`, `Derived`, `Emitter`'s
   `on()`, `store()`'s per-key change streams, `ReactiveMap`/`Set`'s change
   streams) is ultimately backed by RxJS `Subject`/`Observable`, **everything
   composes with ordinary RxJS operators** (`switchMap`, `combineLatest`,
   `filter`, `distinctUntilChanged`, `share`, ...). This is unlike most
   signal libraries, where signals and async streams are two separate
   worlds bridged by adapter functions — see §6.

---

## 3. How the DOM layer consumes signals

`packages/justdom` has **no virtual DOM**. Every reactive value is wired directly
to a concrete, imperative DOM mutation through an RxJS subscription; there is
no diffing pass over a tree of "vnodes."

### 3.1 Elements as observables

`$(tag, operators)` / `$$(tag, operators)` (`dom.js:33-55`) create a real DOM
(or SVG) element with `document.createElement`, wrap it with `just(...)` (a
`ReplaySubject(1)`-backed shared observable, §1.12), pipe it through a list
of **operators**, and `map` the result to a `Mountable<Node>` — an object
with a single `replace(oldSegment) => newSegment` method. Every helper in
`operators.js` (`attr`, `data`, `style`, `set` in `dom/src/operators.js`,
re-exporting `set`/`on` from the signal package) is one of these
"operator" functions: `(source: Observable<Element>) => Observable<Element>`
that subscribes to a value (a signal, an `Observable`, or a thunk `() => T`)
and reactively applies a DOM mutation (`setAttribute`, `style[prop] = ...`,
`element.dataset[key] = ...`, `addEventListener`) for as long as the element
observable stays subscribed. When the element is unmounted, the whole
operator chain unsubscribes and its `onCleanup`s (e.g. `removeEventListener`)
run.

Note that the element is created on **subscribe**, not when `$()` is called —
the body is wrapped in `defer`. Two reasons, both called out in the source:
argument evaluation order would otherwise create children before their
parents (the reverse of document order), and an eagerly created element would
be handed to _every_ subscriber, so mounting the same element observable in
two places had the second mount steal the node from the first. Deferring also
gives hydration its opening: the element is claimed from existing markup via
`claimElement(tag)` when one is available, and only falls back to
`document.createElement` otherwise (§3.7).

### 3.2 `children(...)` and `ListRenderer`

`children(...childObservables)` (`dom.js:159-175`) renders a **fixed-arity**
list of children by reserving one placeholder comment node per child up
front, then subscribing to each child's `Observable<Mountable<Node>>` and
calling `.replace(oldSegment)` whenever a new value arrives — i.e. each
positional child can independently swap its own DOM subtree in place without
touching its siblings. This is implemented via
`ListRenderer.renderFragment` (`ListRenderer.js:74`), except while hydrating,
where `hydrateFragment` (`dom.js:190-229`) takes over — see §3.7.

`list(items$, renderItem)` (`dom.js:247-250`) renders a **dynamic, keyed**
list via `ListRenderer.renderList` (`ListRenderer.js:125`): it tracks a
`Map<Key, Segment>` and `Map<Key, Subscription>`, diffs the incoming iterable
against what's currently rendered, inserts placeholders for new keys in the
correct position (looking ahead to the next already-known segment to
`insertBefore`), removes segments for keys no longer present, and — crucially
— exposes each rendered item's **live index** as a `() => number` accessor
backed by its own `Derived` (so an item can reactively render "item N of M"
even as siblings are inserted/removed, without re-rendering the whole list).
Index updates for a batch of reordered items are themselves wrapped in
`batch(...)`.

`list()` keys each item by the item itself (reference identity), which works
naturally when the items are `store()` proxies, since those are stable
per-element references. When identity is not a usable key — plain objects
rebuilt on every emission, or values that are primitives — use
`keyedList(items$, renderItem)` (`dom.js:258-265`) instead, which takes an
`Iterable<[key, value]>` and hands `renderItem` the `(value, key, index)`
triple. Both funnel into the same `renderList`; they differ only in how the
key is extracted. `justdom-three` exposes the same pair.

This "segment" model — every rendered thing is represented as a `[startNode,
endNode]` pair (`helpers.js`), with `replaceSegment`/`removeSegment` doing
the actual `insertBefore`/`removeChild` DOM surgery — is what lets a
single reactive value (e.g. a `Derived<Mountable<Node>>` behind a
`switchMap`) swap out an entire arbitrarily-sized subtree for another,
without the parent needing to know anything structural about it.

### 3.3 Text

`text` template tag and `renderText` (`text.js`) interpolate
`Renderable` values (`Primitive | Observable<Primitive> | (() => Primitive)`)
into a template string, `combineLatest`-ing all interpolations into one
`Observable<string>`, then `textNode(...)` creates a single `Text` DOM node
whose `.textContent` is reactively kept up to date. So `` text`Hello
${nameSignal}` `` produces exactly one `Text` node that mutates in place —
no re-creation of DOM nodes for pure text updates.

### 3.4 Class names and stylesheets

`className`/`stylesheet` (`stylesheet.js`) generate a random class name,
inject a `<style>` element into `document.head` containing CSS built the
same way as `text` (interpolating `Renderable`s, including nested
signals for dynamic CSS values), and clean the `<style>` element up when
unsubscribed. This is a CSS-in-JS mechanism entirely built out of the same
Observable/operator vocabulary as the rest of the library — there's no
separate styling system.

### 3.5 Suspense-like async gating

`suspend`/`waitFor`/`withFallback` (`suspend.js`) implement a Suspense-style
pattern using the `WeakKey`-chained `createProperty` context mechanism from
the signal package (§1 — `createProperty` returns `{ get(ctx), set(ctx,
value) }`, where `set` returns `Object.assign(Object.create(ctx), {...})`, a
prototype-chain-based context akin to how Solid/React context providers
nest, but manual and explicit rather than JSX-scoped): a component calls
`ctx = suspend(ctx, fallback)`, registers pending promises via
`waitFor(ctx, promise)`, and wraps its real content with
`withFallback(ctx, content)`, which `switchMap`s between the fallback and
the real content observable based on whether any registered promise is still
pending — while keeping both subscribed via `takeUntil(shared.pipe(takeNothing()))`
so side effects/cleanup in the "losing" branch still run correctly.

### 3.6 The render tree _is_ a subscription tree

There is no separate "unmount" API. Calling `.subscribe()` on the outermost
`just(root, [children(App())])` (see `main.ts` in the worked example)
mounts the whole app by cascading subscriptions down through every operator
and computation; calling `.unsubscribe()` on that top-level `Subscription`
tears the whole thing down, in dependency order, running every registered
`onCleanup`. This is the same mental model RxJS itself uses for resource
management, extended uniformly to DOM lifecycle.

### 3.7 Server rendering and hydration

Both exist, and neither required changes to the reactive core.

**Rendering on the server** is a synchronous _mount → serialize → unmount_
cycle, implemented in `apps/signal-ssr/src/renderToString.js`. Because
`packages/justdom` builds real nodes through the ambient `document` rather than a
virtual tree, all SSR needs is a `document` outside a browser:
`setupJsdom({ html })` from `packages/jsdom-env` installs one on `globalThis`,
the component is mounted with the exact same
`just(root, [children(component(ctx))]).subscribe()` call a browser app uses,
`dom.serialize()` is called **while the subscription is still alive**, and only
then is it torn down. Serializing before unsubscribing is what gets the
`<style>` elements injected by `className` into the rendered `<head>`, so no
separate style-extraction step exists. Since nothing is awaited between mount
and unmount, concurrent requests cannot observe each other's document despite
the globals being process-wide.

Two consequences worth knowing:

- **`attr()`, not `set()`, for anything that must survive serialization.**
  `set()` assigns DOM _properties_, and only reflected ones (`className`,
  `type`, `href`, …) appear in serialized markup. `input.value` and
  `input.checked` are not reflected, so `set("value", …)` serializes an
  `<input>` with no `value` attribute at all. Pinned down by a test in
  `apps/signal-ssr/src/renderToString.test.js`.
- **`suspend` boundaries serialize as their fallback.** `renderToString` is
  synchronous and a boundary only settles a tick after mount, so the real
  content never reaches the markup. The intended pattern is to resolve data
  _before_ rendering and seed the signals from it, leaving `suspend`/`waitFor`
  for post-hydration transitions.

**Hydration** lives in `packages/justdom/src/hydrate.js`, exported from the
`justdom/hydrate` subpath. `hydrate(root, ...content)` mounts the same
component tree against markup that is already in the document: instead of
creating nodes, the operators _claim_ them through `claimElement`,
`claimText`, `claimComment` and `claimSegment`, walking a cursor
(`withCursor`) over the existing children. `children(...)` branches on
`isHydrating()` and delegates to `hydrateFragment`, which adopts the first
emission per child and only routes _later_ emissions through the usual
`replace`. `list()` seeds its key→segment map from the adopted nodes, which is
what lets it insert and remove around markup it did not create. A structural
mismatch raises `HydrationMismatchError`; the client falls back to a full
render and logs it.

The precondition is that the client must render the _same_ tree the server
did, which means the state has to travel with the page —
`apps/signal-ssr/src/server.js` serializes it into a
`<script type="application/json">` and `src/client/main.js` seeds the same
signals from it before mounting. Measured in Chromium against that app, the
client creates **zero** DOM nodes and every server-rendered `<li>` survives.
The app also works with JavaScript disabled, because the same components carry
both a `<form>` submission and an `on("click")` that intercepts it.

---

## 4. Worked examples from the repo

### 4.1 A todo item (`apps/todo-vanilla/src/components/TodoItem.ts`)

```ts
const TodoItem = component((_: WeakKey, id: string, operators: Op<TodoProps, TodoEvents>) => {
  const props = store(defaults, operators);

  const toggleCompleted = makeNonReactive(() => {
    emit(props, "change", !props.completed);
  });

  return $("li", [
    set("className", itemStyle),
    children(
      $("input", [
        set({
          type: "checkbox",
          get checked() {
            return props.completed;
          },
        }),
        on("change", toggleCompleted),
      ]),
      $("span", [
        set("className", textStyle),
        style("textDecoration", () => (props.completed ? "line-through" : "none")),
        style("color", () => (props.completed ? "#888" : "inherit")),
        children(text`${() => props.text}`),
        on("click", toggleCompleted),
      ]),
      $("button", [
        set("className", deleteButtonStyle),
        children(text`Delete`),
        on("click", () => emit(props, "delete", id)),
      ]),
    ),
  ]);
});
```

This is a compact illustration of most of the vocabulary above:

- `store(defaults, operators)` creates a reactive "props" object whose
  _initial_ fields come from the parent (`operators` is a list of `set(...)`
  calls the parent passed in — see `TodoApp` below), and which also doubles
  as an event emitter via `emit`/`on` (`"change"`, `"delete"`).
- `set({ get checked() { return props.completed } })` — reading `props`
  inside a getter passed to `set()` establishes the dependency; whenever
  `props.completed` changes, the checkbox's `checked` DOM property updates,
  with no explicit subscription bookkeeping written by hand.
- `style("textDecoration", () => ...)` is the thunk form of a signal-backed
  operator — the thunk is turned into an `observable(...)` internally.
- `toggleCompleted` is wrapped in `makeNonReactive` because it runs inside a
  DOM event handler and must not accidentally register `props.completed`
  as a dependency of some enclosing computation.
- `text\`${() => props.text}\`` is the template-literal text-binding form.

### 4.2 The parent component (`apps/todo-vanilla/src/components/TodoApp.ts`)

```ts
const TodoApp = component((ctx: WeakKey) => {
  const todos = Signal.of<Todo[]>([...]);
  const inputValue = Signal.of<string>("");

  const addTodo = () => { /* todos.set([...todos.get(), store(...)]) */ };
  const deleteTodo = (id: string) => { /* todos.set(todos.get().filter(...)) */ };

  ctx = suspend(ctx, () => text`Loading...`);
  waitFor(ctx, new Promise((resolve) => setTimeout(resolve, 1000)));

  return withFallback(
    ctx,
    $("div", [
      set("className", containerStyle),
      children(
        $("h1", [ ... ]),
        $("div", [ ... input + add button ... ]),
        $("p", [
          children(
            text`Remaining Todos: ${observable(() => todos.get().filter((t) => !t.completed).length)}`,
          ),
        ]),
        $("ul", [
          set("className", listStyle),
          children(
            list(
              toObservable(todos),
              component((todo, i) => {
                return TodoItem(ctx, todo.id, [
                  set({ get text() { return `${i() + 1}. ${todo.text}`; }, get completed() { return todo.completed; } }),
                  on("change", (completed) => { todo.completed = completed; }),
                  on("delete", () => deleteTodo(todo.id)),
                ]);
              }),
            ),
          ),
        ]),
      ),
    ]),
  );
});
```

Notable points:

- `todos` is a `Signal<Todo[]>` whose _elements_ are themselves `store(...)`
  objects — a signal of a reactive array of reactive records, each level
  independently trackable.
- `list(toObservable(todos), component((todo, i) => TodoItem(...)))` renders
  a keyed list (default key = the item itself, i.e. reference identity of
  each `store()` object — since `store()` proxies are stable per-element
  references, this works as a natural key) where each row gets its own live
  index accessor `i()`.
- `text\`Remaining Todos: ${observable(() => todos.get().filter(...).length)}\``—
a derived count is computed inline as an anonymous`observable(fn)`and
interpolated directly into a text template; no separate named`Derived`
  needed for a one-off computed value.
- `suspend`/`waitFor` demonstrate the Suspense-style pattern with a literal
  artificial delay ("Add artificial delay to demonstrate suspense" — a
  comment left in by the author), confirming this is a deliberately
  showcased feature, not accidental.
- `ctx` is threaded explicitly through every nested component call
  (`TodoItem(ctx, ...)`) — there is no implicit/ambient context propagation;
  you carry the (possibly `Object.create`-extended) `ctx` value by hand.

### 4.3 Mounting (`apps/todo-vanilla/src/main.ts`)

```ts
just(root, [children(TodoApp({}))]).subscribe({
  error: (err) => console.error("Error mounting the game:", err),
});
```

The entire application is one RxJS subscription. There is no separate
render/mount API beyond "subscribe to the root observable"; `.unsubscribe()`
would tear the whole app down.

### 4.4 Context objects and structural switching (`apps/minesweeper-vanilla`)

`store/Root.ts` shows `createProperty` used for plain dependency injection
of a "screen size" singleton:

```ts
class Root {
  public get dimensions(): Dimensions {
    addDependency(resize); // resize = fromEvent(window, "resize")
    return { width: window.innerWidth, height: window.innerHeight };
  }
  // ...
}
export const RootContext = createProperty(() => new Root());
```

`components/Game.ts` shows `observe(...)` turning a reactive property into an
`Observable`, and `switchMap` used explicitly for **structural** re-rendering
(swapping the entire subtree when a new game starts), as opposed to the
_fine-grained_ updates used for individual fields:

```ts
const Game = (ctx: WeakKey) => {
  const dimensions = RootContext.get(ctx);

  const state = store({
    sizeId: SIZE_PRESETS[0].id,
    game: Fields.generate(SIZE_PRESETS[0]),
  });

  const startGame = (preset: SizePreset) => {
    state.sizeId = preset.id;
    state.game = Fields.generate(preset);
  };

  // Plain objects with reactive getters, not pre-bridged Observables: each
  // getter is tracked when Viewport reads it.
  const viewport = new Viewport({
    get allFields() {
      return state.game.allFields;
    },
    get screenWidth() {
      return dimensions.screenWidth;
    },
    get screenHeight() {
      return dimensions.screenHeight;
    },
  });

  ctx = ViewportContext.set(ctx, viewport);

  return observe(state).game.pipe(
    switchMap((game) => {
      const newContext = FieldsContext.set(ctx, game);
      return $("div", [
        set("className", fullscreen),
        children(Minefield(newContext, game), Menu(newContext /* ... */)),
      ]);
    }),
  );
};
```

This is the pattern for "when the _identity_ of a nested reactive object
changes wholesale (a brand new game), tear down and rebuild the subtree that
depends on it; when only a _field_ of that object changes, update in place" —
`switchMap` gives you the former, plain signal reads inside `$(...)`
operators give you the latter, and both are ordinary RxJS/operator
composition rather than a special-cased renderer API. The mine counter is the
fine-grained half in the same file's `Menu.ts`: `` text`${() => props.game.minesLeft}` ``
updates in place and is untouched by the structural swap.

`components/FieldStatus.ts` applies the identical shape at the leaf, where a
field changing _kind_ (empty → flag → mine → a number) swaps its own small
subtree rather than mutating one:

```ts
return observable(() => getKind(field)).pipe(
  switchMap((kind) => {
    if (kind === "empty") {
      return $$("g", []);
    }
    // ... a flag, a mine, or a number
  }),
);
```

---

## 5. Design motivation (inferred — flagged as inference)

**I do not have access to the project's full commit history** (this clone is
shallow, 50 commits, spanning roughly one month per the visible timestamps),
so the following is inferred from code structure, commit _messages_ visible
in that window, package descriptions, and cross-package usage — not from any
design doc or first-hand statement of intent. Treat it as an informed
reading, not a confirmed history.

Evidence found:

- The signal package's commit log (within the visible window) includes
  `refactor: combine reactive, reactive-data-structures and signal into a
single package`, and the `dom`/`three` package descriptions until recently
  described themselves in terms of a predecessor concept that no longer
  exists in the tree. So the reactive core did not start as "signal": it
  evolved out of an earlier, differently named concept plus separately named
  "reactive" and "reactive-data-structures" modules, later unified and
  renamed. The superseded name has since been removed from the codebase, and
  should not be reintroduced — if you meet it in old commits or branches,
  it refers to this package's ancestor.
- `packages/justdom` (a from-scratch non-VDOM renderer, which also covers SSR and
  hydration — §3.7) and `packages/three` (a reactive layer over Three.js,
  using the same `component`/`operators` vocabulary) are two genuinely
  different render targets sharing one core, and `apps/kanban-webrtc`
  composes that same core with a Raft consensus implementation
  (`packages/raft`, `packages/raft-webrtc`) for a collaborative app. Nothing
  in `Signal`, `Derived` or `store()` refers to a node, an element or a
  document. Taken together, the signal package looks meant to be **the one
  reactive core shared across render targets and even across
  networked/distributed state**, not a DOM-specific tool. That is a
  materially different goal from Solid/Preact/Angular signals, all three of
  which are signal systems built _for_ one specific rendering framework's own
  template/JSX compiler.
- `Signal.bench.js`'s explicit efficiency assertions (unsubscribed vs.
  subscribed re-evaluation counts, diamond-graph exactly-once evaluation,
  batch coalescing, deep-chain and fan-out exactly-once evaluation) read as
  a deliberate, tested commitment to the same "glitch-free, minimal
  recomputation" guarantee that Solid/Preact/Angular signals are known for
  — i.e. whoever built this cared about matching that class of guarantee,
  not just "some kind of reactivity."
- Building the entire thing **on top of RxJS** (a dependency, not a
  reimplementation) rather than a bespoke pub-sub/dependency-list
  implementation (as Solid, Preact-signals, and Angular signals all do) is
  the most unusual architectural choice here. It buys uniform composition
  with async streams, DOM events, promises, and WebRTC/consensus messages
  through one Observable-based vocabulary (`effects`, `effectMap`, `map`,
  `flatMap`, `switchMap`, `combineLatest`, `distinctUntilChanged`, `share`,
  ...) instead of maintaining a separate "signals" mental model alongside a
  "streams" one. The apparent motivation (inferred) is: **treat "reactive
  value" and "asynchronous event/data stream" as the same kind of thing**,
  and get RxJS's mature operator library, cancellation semantics, and
  `share()`-based ref-counting for free, rather than reinventing them.

What this suggests the library is trying to solve: build a single,
dependency-tracked reactive core — with the same glitch-free/topological
guarantees as mainstream signal libraries — that can drive wildly different
"renderers" (hand-written vanilla DOM in the browser, the same DOM renderer
on the server via jsdom, Three.js scenes, and even distributed/CRDT-like
state synced over WebRTC) using one execution model, by making RxJS
Observables the common interchange format rather than inventing a bespoke
one.

---

## 6. Honest comparison to Solid, Preact, and Angular signals

All four systems solve the same core problem (fine-grained dependency
tracking + lazy, glitch-free recomputation), and this library's `Signal`/
`Derived`/priority-scheduler triad is recognizably the same _algorithm
shape_ as Solid's/Angular's signal graphs (push-invalidate,
pull-recompute-and-compare, topological ordering to avoid redundant
recomputation, `batch()` to coalesce). The differences are mostly about
what the graph is built out of, and what surrounds it.

|                            | This library                                                                                                                           | Solid signals                                                                                                             | Preact signals                                                                    | Angular signals                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Substrate                  | Every node is an RxJS `Subscribable`/`Observable` (`share()`-backed)                                                                   | Bespoke, minimal — arrays of observer/dependency links, no external dependency                                            | Bespoke — a doubly-linked list of subscribers per signal, no external dependency  | Bespoke — its own reactive graph (`ReactiveNode`), no RxJS                                                                                                    |
| Rendering integration      | None built-in; a separate hand-written package (`justdom`) subscribes signals directly to DOM mutations, no compiler          | JSX compiled ahead-of-time into direct DOM-mutation calls                                                                 | Patches into Preact's VDOM + hooks (`useSignal`/auto-binding in JSX)              | Angular's own template compiler + zoneless change detection                                                                                                   |
| Un/re-subscribe semantics  | Explicit dual-mode: unsubscribed `Derived.get()` recomputes every call; subscribed `Derived.get()` is memoized and push-invalidated    | Memos always require a reactive owner/root; behavior outside one is comparatively an edge case, not a documented dual API | Signals always maintain a value; "no listeners" mostly just means no DOM to patch | Similar effect/computed distinction, but no public "recompute every read" mode is a documented, tested API surface the way it is here                         |
| Interop with async/streams | Native — signals _are_ Observables, so any RxJS operator applies directly (see `switchMap` used for structural re-render in `Game.ts`) | Requires explicit resource/`createResource` primitives for async; not stream-composable via a general operator algebra    | Not stream-composable; async state handled by ordinary Promises/hooks             | Requires the explicit `toSignal`/`toObservable` interop functions to bridge RxJS `Observable`s into the signal graph — the two are separate worlds by default |
| Context/DI                 | Hand-rolled `createProperty` + `WeakKey`-chained `Object.create`, threaded manually through every component call                       | `createContext`/`useContext`, compiler/runtime-integrated                                                                 | Not part of signals proper; whatever Preact/React context you already have        | Angular's DI system, with signal-based `inject()`                                                                                                             |
| Tooling / ecosystem        | None found — no devtools, no compiler, `private: true` packages, single-repo, apparently not published                                 | Mature compiler, devtools, large ecosystem                                                                                | Mature, framework-agnostic-ish, widely used in Preact/React interop               | Backed by the Angular team, first-class framework support, official docs                                                                                      |
| List/keyed rendering       | Hand-written `ListRenderer` (index tracking, segment-based DOM surgery) — no compiler support                                          | `<For>` compiled specially by the Solid compiler                                                                          | Delegates structural diffing to Preact's VDOM (`key` prop)                        | Angular's `@for` block, compiler-optimized                                                                                                                    |

### Where this approach gives something up

- **Weight per node.** Every `Signal`/`Derived` here carries a `Map` of
  dependencies, a `Set` of subscriptions, an RxJS `Subject` for
  notifications, and a `share()`-wrapped `Observable` — considerably more
  machinery per reactive node than Solid's or Preact's plain-array/linked-list
  representations, or Angular's purpose-built reactive graph. The presence
  of a dedicated benchmark suite (`Signal.bench.js`) suggests the author is
  aware of and actively monitoring this cost, but **I found no
  cross-library benchmark numbers in this repo comparing it to Solid,
  Preact, or Angular signals** — so I can't quantify how much heavier it
  actually is in practice; flagging this as unverified rather than guessing
  a number.
- **No compiler, so no fine-grained DOM codegen from a template language.**
  Solid's biggest ergonomic win — write ordinary-looking JSX, get
  hand-optimized DOM update code — has no equivalent here. Every binding in
  this library is written by hand as an explicit operator
  (`set(...)`, `style(...)`, `children(...)`, `text\`...\``), which the todo
  app example shows is considerably more verbose than the equivalent JSX in
  Solid/Preact.
- **No official ecosystem or tooling.** No devtools, no linting rules for
  reactivity pitfalls, and the packages are `"private": true` and not
  published to npm — this is effectively a personal/experimental framework,
  not a maintained public library, which is a real cost relative to any of
  Solid/Preact/Angular. SSR and hydration are the one gap that has since been
  closed (§3.7), though the SSR path is synchronous only: there is no
  streaming SSR, and `suspend` boundaries always serialize as their fallback.
- **Manual context threading.** `createProperty`'s `WeakKey`/
  `Object.create`-chain context has to be passed by hand through every
  component call (`ctx` shows up as an explicit parameter everywhere in the
  worked examples above). Solid and Angular both have this problem solved
  by their compiler/DI systems; this library asks the developer to remember
  to thread `ctx` correctly themselves, with no compile-time enforcement
  that a component that needs a context value was actually given one.
- **The `toObservable` "TODO: explain why this does not work" comment**
  (`core.js:257-261`) is a concrete, in-code admission of an unresolved
  rough edge in the pull/push bridging logic — worth being aware of if you
  extend that function.

### Where it plausibly wins

- **A genuinely unified reactive/stream model.** Because signals _are_
  Observables, you get `switchMap`-based structural re-rendering
  (`Game.ts`), Suspense-like async gating (`suspend.js`), and DOM event
  handling (`Emitter`/`on`) all expressed in the exact same operator
  vocabulary as ordinary reactive state, with no separate "async" story
  bolted on. Angular needs explicit `toSignal`/`toObservable` adapters for
  this; Solid and Preact don't have an equivalent general operator algebra
  at all.
- **Render-target agnosticism.** The same `Signal`/`Derived`/`store()`
  primitives back a from-scratch DOM renderer (browser, server and hydration
  alike) and a Three.js integration (`packages/three`) in this monorepo —
  something none of Solid/Preact/Angular signals set out to do (they are
  each tied to one framework's rendering path). Two render targets is
  evidence rather than proof, but nothing in the core refers to a node, an
  element or a document, so the separation is real and not just conventional.
- **Explicit, tested glitch-free guarantees** via the priority-heap
  scheduler, with property-based tests on the heap itself and dedicated
  efficiency assertions (not just benchmarks) proving diamond/fan-out/deep-chain
  exactly-once recomputation — a level of rigor that's easy to _claim_ for a
  hand-rolled reactivity system but that this codebase actually backs with
  tests.

**Uncertain / unverified claims flagged above, gathered in one place:**

1. Why the simpler `toObservable` implementation "does not work" (author's
   own TODO, unresolved in source).
2. Any quantitative performance comparison against Solid/Preact/Angular
   signals — none exists in this repo; only internal before/after-style
   assertions and raw ops/sec numbers for this library alone.

_Previously flagged and since resolved:_

- Whether an SSR/hydration story exists. It does —
  `packages/justdom/src/hydrate.js` plus `apps/signal-ssr`, documented in §3.7.
  That item was written before either landed.
- What the predecessor concept named in the old package descriptions was.
  Confirmed by the author as a superseded naming convention, now removed
  from the codebase; §5 no longer treats it as an open question.
