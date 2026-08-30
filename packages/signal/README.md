# @apendua/signal

A dependency-tracked reactive library with a **pull-based core** and an
explicit split between the three things a reactive graph actually does.

- **`Signal`** — an input. Somebody writes it; it is where a change enters.
- **`Derived`** — a transformation. Pure, lazy, cached, computed on demand.
- **`Effect`** — an output. Work that reads reactive values and touches the
  world, scheduled on an update channel.

A write does not compute anything. It marks what might now be wrong and
stops. Values are produced when somebody asks for them, and the asking is
what establishes the order: a `Derived` resolves its dependencies before
returning, so a dependency is always current before the thing that reads it —
by construction rather than by scheduling.

RxJS remains the interop layer: any `Subscribable` can be depended on, and
`toObservable` / `fromObservable` carry values across the boundary in either
direction. What is no longer RxJS is the *entity* layer: `just`, `store` and
`useEffects` take arrays of **entity effects** — `(entity) => void` functions
run as `Effect`s while the entity stays mounted — where they used to take
`MonoTypeOperatorFunction`s. A plain lambda is a valid entry, and `effects(fn)`
is the identity, kept for the call sites that like to say what the function is
for.

## Installation

```
npm install @apendua/signal
```

`rxjs` is a runtime dependency.

## Usage

```js
import { Signal, Derived, Effect, batch } from "@apendua/signal";

const count = Signal.of(0);
const doubled = new Derived(() => count.get() * 2);

// Nothing has been computed yet — nobody has asked.
const effect = new Effect(() => console.log("doubled is now", doubled.get()));
// → "doubled is now 0"

batch(() => {
  count.set(1);
  count.set(2);
});
// → "doubled is now 4"   (one run, one evaluation)

effect.dispose();
```

`Derived` is lazy and uncached until something holds it open — an `Effect`
reading it, another `Derived` reading it, or a direct `subscribe`. Until
then `doubled.get()` re-evaluates on every call. Once held open it caches,
and it recomputes only when something it read actually moved.

## Why pull

Ordering used to be a number. Every node carried its depth in the graph, and
an update queue drained shallowest-first so that a dependency always ran
before its dependents. That works only while the queue can see the shape of
the graph — and it could not: a `Derived` wrapped in an ordinary `Observable`
is opaque, so the wrapper reported depth 0, and anything reading it was
scheduled as though it sat directly above a source. A diamond with one side
through such a wrapper computed against values several levels out of date and
emitted numbers the graph never held.

Under a pull model there is no number to lose. The call stack of a read _is_
the topological order, and it sees through anything, because it is built out
of the reads that actually happened. `src/pull.test.js` keeps the case that
motivated this honest.

What follows from that:

- **No priority on any node.** Nothing to compute per evaluation, nothing to
  keep in step with a graph that changes shape, nothing for a wrapper to drop.
- **The queue is off the value path.** Only effects are scheduled, so the
  queue is a FIFO per channel with a dedup flag — no depth buckets, no
  re-prioritisation, no stale slots.
- **Unread work is not done.** A `Derived` nobody reads never evaluates.
- **Unbatched writes cost one evaluation, not one each.** `batch()` is still
  what keeps an _effect_ from running twice; it is no longer what keeps a
  value from being computed twice.

Two colours of staleness make the equality cutoff work. A write marks its
direct dependents `DIRTY` and everything below them `CHECK`. Resolving a
`CHECK` compares each dependency's version against the version last seen, so
a node that recomputes to the value it already had stops the change dead, and
nothing below it runs.

## Crossing the RxJS boundary

Three functions, and deliberately only three. Values come in as a **source**,
values go out through an **effect**, work goes out through an **effect**.
Nothing crosses in the middle, which is what makes the depth problem of the
old core impossible to reintroduce.

```js
import { fromObservable, toObservable, toEffect } from "@apendua/signal";

const incoming = fromObservable(subject); // a Derived fed by a source
const outgoing = toObservable(derived); // an Effect per subscriber, pushing values
const work = toEffect(() => sync(el, x.get())); // an Effect per subscriber, pushing nothing
```

`toEffect` is the one to reach for when there is no value to carry — work that
reads reactive state and touches the world, wrapped as something an RxJS
pipeline can subscribe to and unsubscribe from. It is what `rxEffects()` is
built on, and what a `Derived` used to be misused as.

Any `Subscribable` can still be depended on directly, and is treated as a
source: it has no value to pull and nothing upstream this library can see, so
there is nothing to order it against.

## Owning expensive resources

A `Derived` that builds something costly — a texture, a compiled shader, a
worker — and releases it through `onCleanup` is a first-class use of the
library, and the rules are worth stating exactly.

```js
const texture = new Derived(
  () => {
    const built = gl.createTexture(spec.get());
    onCleanup(() => built.dispose());
    return built;
  },
  { isEqual: (a, b) => a.key === b.key },
);
const holder = new Effect(() => texture.get()); // gives it a lifetime
```

- **A re-evaluation releases what the node was holding, and keeps what it just
  built** — in that order. The teardown runs _after_ the new value exists, so
  an evaluation that throws leaves the old resource intact rather than having
  destroyed it on the way to failing.
- **`isEqual` decides which one survives.** Saying the rebuild is
  interchangeable with what is already held means the _held_ one stays and the
  rebuild is torn down instead. Every reference already handed out stays
  valid; the node never swaps a live handle for a dead one behind its readers'
  backs.
- **The last reader leaving releases everything**, deferred by `cacheTTL` if
  one is set — which is what keeps a resource warm across a gap rather than
  rebuilding it for the next reader.
- **A node that holds none of its dependencies open has no cache**, so it
  rebuilds on every read and releases the read before it. That is the one
  thing to watch: give a node that owns a resource an `Effect` (or another
  live node) reading it. A `cacheTTL` window does not count — there the node
  is still subscribed and still holding its value, and a read during one is an
  ordinary cached read.

## Update channels

An effect belongs to an `UpdateChannel`, which decides when its queue drains
and how long a pass may spend:

```js
import { Effect, UpdateChannel, withChannel } from "@apendua/signal";

const frame = new UpdateChannel({
  name: "presentation",
  order: 1,
  trigger: animationFrames,
  budget: 8, // ms
});

withChannel(frame, () => {
  new Effect(() => (element.style.top = `${top.get()}px`));
});
```

Channels drain in `order`, and an effect may only invalidate an effect in a
**later** channel — application state settling before presentation reads it
is what the arrangement is for. The other direction is a mistake, and rather
than warn and carry on, the queue fixes it: the channel that was written into
is moved above the one that wrote, and re-sorted into place, so a
mis-declared order corrects itself on the first pass that exposes it and
stays corrected. Pass `fixedOrder` to keep a declared order and get a warning
instead; the default channel is fixed at 0 for that reason.

Two effects that each write what the other reads cannot be fixed by any
ordering. The queue notices and throws rather than spinning.

## Also included

- `useEffect()` — the same `Effect`, with its lifetime handed to the
  computation that built it: whatever cleans that computation up disposes the
  effect, so nobody has to hold the handle just to dispose it later. This is
  what every `use(() => ...)` in this repo turned out to want, and `use()` no
  longer takes a callback at all.
- `store()` — a reactive `Proxy` over plain objects/arrays, with per-key
  dependency tracking.
- `selector()` / `arraySelector()` — structural, read-only reactive views.
- `ReactiveMap` / `ReactiveSet` — reactive wrappers around the native
  collections.
- `createProperty()` — a `WeakKey`-chained context mechanism (dependency
  injection without a compiler).
- `@memo` / `@memoFn` / `@mutate` — decorators for memoized getters, memoized
  methods, and non-reactive mutations.
- `just()`, `useEffects()` — mount a list of entity effects on a value:
  `just` cold, a mounting per subscriber with a factory first argument run at
  mount time; `useEffects` directly on the surrounding computation. Sharing a
  mounting among subscribers is `memoize`'s job, not `just`'s.
- `observable()`, `component()`, `effects()`, `set()`, `use()`, `on()` — the
  factory layer, built on `Effect`; `set`, `on`, `effectMap` and friends are
  entity-effect factories now rather than stream operators. `rxEffects(fn)`
  is the one that stayed an operator: the same entity effect lifted over a
  stream of entities, mounted per value, for a pipeline that receives them
  rather than holding one.

## Migrating from the push core

The public API is largely unchanged. Four things are not.

**Side effects inside a `Derived` no longer run.** A `Derived` must be pure:
it evaluates when somebody reads it, which may be never. The idiom

```js
const d = new Derived(() => {
  element.style.top = `${top.get()}px`;
});
const sub = d.subscribe({}); // used to force it to run
```

becomes

```js
const effect = new Effect(() => {
  element.style.top = `${top.get()}px`;
});
```

This is the migration that bites, and it bites twice. The obvious way is that
the work simply never happens. The second is worse, and caught this library
itself: a `Derived` that sets something up and registers an `onCleanup` to
tear it down again, and whose value comes back `isEqual` to the last one, has
that setup **undone**. The equality cutoff keeps the previous value and
releases whatever the run that just happened had claimed — correct for a node
that rebuilt a texture it already had, ruinous for one that had just started
an interval. `use()` used to be built that way, returning the same `NEVER`
every time. What its callers wanted from it is `useEffect()`, which is an
`Effect`; `use()` itself is now nothing but the dependency edge that holds an
observable open.

**`subscribe()` is an invalidation channel, not a value stream.** It fires
eagerly when a node goes from clean to stale, and it does not evaluate
anything. A subscriber that wants the value must pull it (`node.get()` inside
the handler), which also re-arms the notification.

That still works, but it **does not batch**. Observers are notified inside the
write, so a handler that pulls does its work halfway through a `batch()` and
is notified again on the next write — two mutations in one flush, two
recomputations. An `Effect` goes on the queue, which dedups it:

```js
node.subscribe({ next: () => node.get() }); // runs once per write
new Effect(() => node.get()); // runs once per batch
```

**`getPriority` / `setPriority` / `getChannelOrder` are gone.** There is no
depth to read or set. Nothing in this repository used them.

**`Derived` no longer takes `channel` or `deferred`.** Both were about
scheduling, and a `Derived` has no schedule — it computes when it is read.
Passing either is not an error, but it does nothing, so the constructor says
so once and points at `Effect`, which takes both.

**`effect()` now builds an `Effect`.** The old teardown-only helper of that
name is `resource()`, and `Computation#addSideEffect` is `addResource`.

`getEvaluations()` counts legitimately drop: work that used to be done
eagerly and discarded is now not done at all.

## Learn more

- [`docs/signal-pull-model.md`](../../docs/signal-pull-model.md) — the design,
  the measurements, and what changed from the push core.
- [`docs/signal-user-guide.md`](../../docs/signal-user-guide.md) — the fuller
  guide (written against the push core; see the note at its top).

## License

MIT — see [LICENSE](../../LICENSE).
