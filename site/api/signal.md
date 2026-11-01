# justdom-signal

A dependency-tracked reactive library with a **pull-based core** and an explicit split between the
three things a reactive graph does: a `Signal` is an input, a `Derived` is a transformation, an
`Effect` is an output. The [guide](/guide/reactivity) introduces the model; this page lists what the
package exports.

```
npm install justdom-signal
```

`rxjs` is a peer dependency: the package root names no RxJS type, but a `Subscribable` from any
library can be depended on, and the [`justdom-signal/rxjs`](#justdom-signal-rxjs) subpath carries
values into an RxJS pipeline.

## Why pull

A write does not compute anything. It marks what might now be wrong and stops. Values are produced
when somebody asks for them, and the asking is what establishes the order: a `Derived` resolves its
dependencies before returning, so a dependency is always current before the thing that reads it, by
construction rather than by scheduling.

Ordering used to be a number. Every node carried its depth in the graph, and an update queue drained
shallowest-first. That works only while the queue can see the shape of the graph, and it could not:
a `Derived` wrapped in an ordinary `Observable` is opaque, so the wrapper reported depth 0, and a
diamond with one side through such a wrapper computed against values several levels out of date.
Under a pull model there is no number to lose. The call stack of a read _is_ the topological order,
and it sees through anything, because it is built out of the reads that actually happened.
`src/pull.test.js` keeps the case that motivated this honest.

- **No priority on any node.** Nothing to compute per evaluation, nothing to keep in step with a
  graph that changes shape, nothing for a wrapper to drop.
- **The queue is off the value path.** Only effects are scheduled, so the queue is a FIFO per
  channel with a dedup flag.
- **Unread work is not done.** A `Derived` nobody reads never evaluates.
- **Unbatched writes cost one evaluation, not one each.** `batch()` is what keeps an _effect_ from
  running twice; it is not what keeps a value from being computed twice.

Two colours of staleness make the equality cutoff work. A write marks its direct dependents `DIRTY`
and everything below them `CHECK`. Resolving a `CHECK` compares each dependency's version against
the version last seen, so a node that recomputes to the value it already had stops the change dead,
and nothing below it runs.

## `Signal`

A writable value, and where a change enters the graph.

| Member                           | What it does                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Signal.of(value)`               | A signal holding `value`.                                                                                                          |
| `new Signal(current?, isEqual?)` | `current` is `{ value }` or undefined for a signal with no value yet; `isEqual` defaults to `Object.is`.                           |
| `get()`                          | The value, depending on it. Throws `NoValueError` while the signal has none, which an effect answers by waiting.                   |
| `peek()`                         | The value, without depending on it.                                                                                                |
| `hasValue()`                     | Whether a value has been set.                                                                                                      |
| `set(value)`                     | Writes the value, unless `isEqual` says it is the one already held. Marks dependents inside a `batch`, so one write is one update. |
| `setFn(fn, onNoValue?)`          | Writes `fn(current)`; with no value yet, writes `onNoValue()` or throws.                                                           |
| `fail(err)`                      | Fails the signal terminally and drops its value.                                                                                   |
| `subscribe(observer)`            | An invalidation channel, not a value stream: see [Subscribing to a node](#subscribing-to-a-node).                                  |

## `Derived`

A value computed from other values, remembered until one of them moves. Lazy: a `Derived` does not
recompute when its inputs change. It is marked, and recomputes the next time somebody reads it,
which may be never. The evaluation function must be **pure**: it runs at times nobody chose,
possibly more than once, possibly not at all.

| Member                               | What it does                                                                                                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Derived(evaluate, options?)`    | `options` is `{ isEqual, cacheTTL }`, or an `isEqual` function alone. `evaluate` is handed an evaluation context with `fail`, for an evaluation that learns of a failure while it runs.                                                                        |
| `isEqual`                            | Decides whether a recomputed value counts as a change. `Object.is` by default.                                                                                                                                                                                 |
| `cacheTTL`                           | How long to keep the cached value after the last reader leaves, in ms. Negative, the default, drops it there and then.                                                                                                                                         |
| `get()`                              | The value, resolving dependencies first and depending on the node.                                                                                                                                                                                             |
| `peek()`                             | The value, without depending on it.                                                                                                                                                                                                                            |
| `getEvaluations()`                   | How many times the function has run, for a test.                                                                                                                                                                                                               |
| `Derived.of(fn)`                     | `new Derived(fn)`.                                                                                                                                                                                                                                             |
| `Derived.from(observable, options?)` | A `Derived` fed by an observable, held open for exactly as long as somebody reads the node. The same as `fromObservable`.                                                                                                                                      |
| `Derived.live(start, options?)`      | A `Derived` fed by work that runs while the node is live. `start` is handed `{ setValue, fail }` and may return a teardown; it runs when the first reader arrives and is torn down when the last leaves. For a WebSocket, a `ResizeObserver`, a promise chain. |

A `Derived` is uncached until something holds it open: an `Effect` reading it, another `Derived`
reading it, or a direct `subscribe`. Until then `get()` re-evaluates on every call. Passing
`channel` or `deferred` is not an error, but it does nothing, and the constructor says so once: a
`Derived` has no schedule.

### Owning expensive resources

A `Derived` that builds something costly, a texture, a compiled shader, a worker, and releases it
through `onCleanup` is a first-class use of the library, with these rules:

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

- **A re-evaluation releases what the node was holding, and keeps what it just built**, in that
  order. The teardown runs _after_ the new value exists, so an evaluation that throws leaves the old
  resource intact.
- **`isEqual` decides which one survives.** Saying the rebuild is interchangeable with what is
  already held means the _held_ one stays and the rebuild is torn down instead, so every reference
  already handed out stays valid.
- **The last reader leaving releases everything**, deferred by `cacheTTL` if one is set, which keeps
  a resource warm across a gap rather than rebuilding it for the next reader.
- **A node that holds none of its dependencies open has no cache**, so it rebuilds on every read and
  releases the read before it. Give a node that owns a resource an `Effect`, or another live node,
  reading it. A `cacheTTL` window does not count against this: there the node is still subscribed
  and a read during one is an ordinary cached read.

## `Effect`

Work that reads reactive values and does something with them. An effect is a root of demand: it
holds its dependencies open from birth, which is what keeps everything it reads awake, until it is
disposed.

| Member                      | What it does                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Effect(run, options?)` | Runs `run` once, during construction, unless `deferred`, and again whenever anything it read moves. `effect(run, options)` is the same call.                                                                                                                                                                                      |
| `channel`                   | The `UpdateChannel` its re-runs are scheduled in. The one given, else the channel of the region it is built in (see `withChannel`), else the default. Fixed for the life of the effect.                                                                                                                                           |
| `deferred`                  | Schedule the first run instead of performing it during construction.                                                                                                                                                                                                                                                              |
| `onError`                   | Where the effect's failures land once it stands. A failure of a _run_, the body throwing, is handled and the effect carries on; a failure of the _effect_, a dependency that died, has ended it by then and this is the notification. Nothing that happens while the constructor is on the stack comes here: construction throws. |
| `name`                      | Shown in diagnostics.                                                                                                                                                                                                                                                                                                             |
| `dispose()`                 | Ends the effect, running its cleanups and letting go of what it read.                                                                                                                                                                                                                                                             |
| `isDisposed`                | Whether it has been.                                                                                                                                                                                                                                                                                                              |
| `flush()`                   | Runs the effect now if it is stale.                                                                                                                                                                                                                                                                                               |
| `getRuns()`                 | How many times it has run, for a test.                                                                                                                                                                                                                                                                                            |

`useEffect(run, options?)` is the same `Effect` with its lifetime handed to the computation that
built it: whatever cleans that computation up disposes the effect, so nobody holds the handle only
to dispose it later. Its failure travels the same tie: a dependency that dies fails the computation
that built the effect, rather than stopping the effect silently. Pass `standalone: true` for an
effect whose death should stay its own.

## Inside a computation

These read or write the computation that is currently evaluating, whether a `Derived`, an `Effect`
or a bare `Computation`.

| Function                                  | What it does                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onCleanup(fn)`                           | Runs `fn` before the computation's next run and when it is disposed. Outside a computation it warns and runs `fn` at once.                                              |
| `addDependency(subscribable)`             | Makes the computation depend on any `Subscribable`, which is treated as a source with nothing to pull.                                                                  |
| `valueOf(subscribable, default?)`         | The value a subscribable emits synchronously on subscription, a `BehaviorSubject` say, with the subscribable as a dependency.                                           |
| `withComputation(computation, fn)`        | Runs `fn` with another computation active, or none for `null`.                                                                                                          |
| `makeNonReactive(fn)`                     | A copy of `fn` whose reads are tracked by nobody.                                                                                                                       |
| `withChannel(channel, fn)`                | Builds everything `fn` constructs into `channel`; `null` for an effect that must stay in the default channel inside a region.                                           |
| `resource(start)` / `Resource`            | A dependency that is work and nothing else: `start` runs when the computation connects and its teardown when it disconnects. `Computation#addResource` holds one.       |
| `skipSynchronousValues(source)`           | Everything `source` emits after the subscription is taken, for a dependency that should not mark its reader stale with the value the reader is about to use.            |
| `Computation`                             | A bare tracking scope with no value: `track(fn)` runs `fn` as its evaluation, `bind(handler)` wraps a listener so its reads are tracked and released with the listener. |
| `NoValueError`, `CircularDependencyError` | Thrown by a read of a node with no value yet, and by a graph whose effects cannot be ordered.                                                                           |

`onInvalidate` is `onCleanup` under its old name, deprecated.

## Scheduling

`batch(fn)` runs `fn` and holds every effect it invalidates until it returns, so a block of writes
costs one run per effect. Nested batches merge into the outer one.

### Update channels

An effect belongs to an `UpdateChannel`, which decides when its queue drains and how long a pass may
spend. `defaultChannel` drains at the end of `batch()`, or immediately when there is no batch. A
channel built with a `trigger` holds its work until the trigger fires, then drains for at most
`budget` milliseconds, with whatever does not fit waiting for the next trigger:

```js
import { Effect, UpdateChannel, withChannel } from "justdom-signal";

const frame = new UpdateChannel({
  name: "presentation",
  order: 1,
  trigger: animationFrames,
  budget: 8,
});

withChannel(frame, () => {
  new Effect(() => (element.style.top = `${top.get()}px`));
});
```

| Option           | Default     | What it does                                                                                                                                                                                                                                                                                 |
| ---------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | `"channel"` | Shown in diagnostics.                                                                                                                                                                                                                                                                        |
| `order`          | `0`         | Major sort key, so a channel built without one sorts with the default channel, which is at 0.                                                                                                                                                                                                |
| `trigger`        | none        | A subscribable that says when to attempt a drain pass.                                                                                                                                                                                                                                       |
| `manual`         | `false`     | Drain only when `flush()` is called, for a caller that drives several channels and divides one budget between them.                                                                                                                                                                          |
| `budget`         | none        | Milliseconds of wall clock one pass may spend; unbounded unless given.                                                                                                                                                                                                                       |
| `atomic`         | `false`     | Run the channel's effects all at once or not at all. A pass spends its budget bringing what the queued effects _read_ up to date (`Effect#warm`), and runs the effects in one unbudgeted sweep once every one of them has been. Only a channel with a `trigger`, or `manual`, can be atomic. |
| `fixedOrder`     | `false`     | Refuse automatic order correction and warn instead.                                                                                                                                                                                                                                          |
| `now`            | the clock   | Injectable for a deterministic test.                                                                                                                                                                                                                                                         |
| `maxStalePasses` | `3`         | Passes the budget may cut short in a row: the bound on how long a change that will not fit in one pass is held back.                                                                                                                                                                         |

Channels drain in `order`, and an effect may only invalidate an effect in a **later** channel:
application state settling before presentation reads it is what the arrangement is for. The other
direction is a mistake, and rather than warn and carry on, the queue fixes it: the channel that was
written into is moved above the one that wrote, so a mis-declared order corrects itself on the first
pass that exposes it and stays corrected. `fixedOrder` keeps a declared order and gets a warning
instead; the default channel is fixed at 0 for that reason. Two effects that each write what the
other reads cannot be fixed by any ordering, and the queue throws `CircularDependencyError` rather
than spinning.

### Subscribing to a node

Every node has `subscribe(observer)`, and it is an invalidation channel, not a value stream. It
fires eagerly when a node goes from clean to stale, and it does not evaluate anything. A subscriber
that wants the value pulls it, `node.get()` inside the handler, which also re-arms the notification.
That does not batch: observers are notified inside the write, so a handler that pulls does its work
halfway through a `batch()` and again on the next write. An `Effect` goes on the queue, which dedups
it:

```js
node.subscribe({ next: () => node.get() }); // runs once per write
new Effect(() => node.get()); // runs once per batch
```

## The RxJS boundary

Three functions, and deliberately only three. Values come in as a source, values go out through an
effect, work goes out through an effect. Nothing crosses in the middle, which is what makes the
depth problem of the old core impossible to reintroduce.

```js
import { fromObservable, toObservable, toEffect } from "justdom-signal";

const incoming = fromObservable(subject); // a Derived fed by a source
const outgoing = toObservable(derived); // an Effect per subscriber, pushing values
const work = toEffect(() => sync(el, x.get())); // an Effect per subscriber, pushing nothing
```

`fromObservable(observable, { cacheTTL })` returns a `Derived`; `toObservable(node)` and
`toEffect(fn, { name })` return a `Source`, the package's own observable type. `toEffect` is the one
to reach for when there is no value to carry: work that reads reactive state and touches the world,
wrapped as something a pipeline can subscribe to and unsubscribe from.

### Sources

The package's own observable shapes, so that a package built on this one spells its types in this
vocabulary without naming RxJS:

- `Stream` is a cold source: a subscribe function run once per subscriber, returning a teardown. A
  throw from the subscribe function reaches the observer's `error`, and an error nobody handles is
  reported rather than swallowed.
- `Subject` is multicast and nothing else: it delivers a value to the current observers and survives
  an observer leaving mid-round. `filtered(source, predicate)` is the one operator the internals
  use.
- `Source<T>`, `Subscribable<T>`, `Observer<T>`, `Unsubscribable`, `Operator<T, U>` and
  `MonoTypeOperator<T>` are the types.
- `Emitter` is a plain event emitter with `addEventListener` and `removeEventListener`;
  `fromEvent(emitter, event)` is its events as a source. `timer(due, period?)` and
  `interval(period)` are sources of counts.

### `justdom-signal/rxjs`

`rx(source)` carries a `Source` into an RxJS `Observable`, so an operator can be applied to it, and
`rxEffects(fn)` is `mountEach` as an RxJS operator: an entity effect lifted over a stream of
entities, mounted per value, for a pipeline that receives them rather than holding one. Everything
RxJS-shaped lives here.

## Entities and mountings

An **entity effect** is a function `(entity, context) => void` run as an `Effect` while the entity
stays mounted. `just`, `useEffects` and `store` take arrays of them, and the factories below build
them.

| Function                                | What it does                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just(valueOrFactory, effects?)`        | A source of the entity with `effects` mounted on it, cold: each subscriber gets the factory run and the effects mounted for itself, and takes them down on unsubscribe. A plain value with no effects is a constant. Sharing a mounting among subscribers is `memoize`'s job, not `just`'s. |
| `useEffects(value, effects)`            | Mounts `effects` on `value` for as long as the surrounding computation stands: each entry becomes an `Effect` owned by the computation, with no node and no subscription in the middle.                                                                                                     |
| `effects(fn)`                           | The identity, kept so a call site can say what the function is for. A plain lambda in the same position means the same thing.                                                                                                                                                               |
| `set(key, value)`                       | Writes `entity[key]` from a getter or a subscribable. `set(values)` assigns an object of plain values, and runs again when a getter in it reads something that moves.                                                                                                                       |
| `on(event, handler)`                    | Adds a listener and removes it with the entity. The handler runs inside a `Computation`, and a throw from it fails the mounting.                                                                                                                                                            |
| `use(observable)`                       | Holds an observable open for as long as the computation stands, for its side effects alone; what it emits is dropped. Takes no callback: a function arriving here throws, since what such a caller wants is `useEffect`.                                                                    |
| `observable(fn)`                        | A pure computation as a source of its values: a `Derived` and an effect per subscriber to push it.                                                                                                                                                                                          |
| `component(fn)`                         | Wraps `(…args) => Subscribable<T>` so that calling it gives a source that mounts whatever `fn` returns and re-mounts it when `fn`'s reads move.                                                                                                                                             |
| `effectsOnly(fn)`                       | A component with no value to hand back: `fn` is run as an effect for as long as the result is subscribed. For a root that decorates a scene it reads from its context.                                                                                                                      |
| `map(fn)`, `flatMap(fn)`                | Operators over sources, in the package's own types.                                                                                                                                                                                                                                         |
| `mountEach(fn)`                         | An entity effect lifted over a source of entities: mounted on each value, passed on, taken down when the next arrives.                                                                                                                                                                      |
| `takeNothing()`                         | An operator that drops every value, for a source held for its side effects.                                                                                                                                                                                                                 |
| `observe(target)`, `observeFn(target)`  | A proxy whose properties, or method calls, are sources of the target's values.                                                                                                                                                                                                              |
| `all(...operators)`, `each(source, fn)` | Composes operators; runs `fn` for each value without tracking its reads, passing the value on.                                                                                                                                                                                              |

## State

### `store()`

`store(object, effects?)` is a reactive `Proxy` over a plain object or array, with per-key
dependency tracking, and the `effects` mounted on it. A plain object or an array nested in a store
is a store too, and a store assigned to one is held as itself. An array's methods that change it,
`push`, `splice`, `sort` and the rest, each run as one update; an effect calling one does not depend
on the array's own keys the method read, and does depend on what else it read. A getter with no
setter is readonly. A store is also an `Emitter`: `emit(store, event, payload)` fires an event the
`on` operator in its effects list hears, which is how a child component tells its parent something.

| Function                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isStore(value)`              | Whether `value` is the proxy a `store()` handed back.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `emit(store, event, payload)` | Fires an event on the store.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `replace(store, value)`       | Assigns `value`'s keys through the store, in one batch, and deletes the keys it lacks.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `trackWrites(store)`          | Records which keys the program writes from now on, which `reshape` keeps.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `reshape(store, definition)`  | Swaps in a new definition, keeping the keys written since `trackWrites()`: what a hot reload does. Every other key takes the definition's side, getter, setter, value and presence alike. An array keeps which element is at each index, and its length, once the program has written to it, and takes the definition's elements otherwise; the element stores it made are reshaped in place. A store the program assigned from elsewhere is reshaped only through the store it was made in. |

Only a write through the store is seen. A `Map` the program fills in place marks nothing, so state
that has to survive a reload goes in a plain object or an array, which is a store, or in a
`ReactiveMap` or `ReactiveSet` of its own.

### Collections and views

- `ReactiveMap` and `ReactiveSet` are the native collections with a dependency per key: a reader of
  one key is not woken by a write to another, and `size`, `keys()`, `values()` and `entries()`
  depend on the set of keys.
- `selector(getter)` and `arraySelector(getter)` are read-only structural views over what a getter
  returns, with a dependency per property.
- `createProperty(getDefaultValue)` is a context mechanism: `property.get(ctx)` reads the value set
  on a `WeakKey` or the default, and `property.set(ctx, value)` returns a new key holding the value,
  so a tree hands context down without a compiler. `isProperty(value)` tells one from a plain
  object.

### Memoization

- `memoize(fn, options?)` memoizes a reactive function by its arguments; `getKey` and `cache` choose
  the key and the cache, and `cacheTTL` is how long an entry survives its last reader leaving, in
  ms. Negative, the default, evicts it there and then. `memoizeWithTTL(ttl, fn, options?)` is the
  same with the TTL first, and `MINUTE` is 60 000.
- `memoizeDerived(fn, options?)` memoizes a function returning a `Derived`, and
  `memoizeDependency(fn, options?)` one returning a dependency.
- `weakMemoize(fn)` memoizes by a single object key, in a `WeakMap`.
- `@memo(options?)`, `@memoFn(options?)` and `@mutate()` are decorators for memoized getters,
  memoized methods, and non-reactive mutations run in a batch;
  `decorate(target, key, ...decorators)` applies them without decorator syntax.

## Changes from the push core

For code written against `@apendua/signal` before the pull core. The public API is largely
unchanged; these are not.

**Side effects inside a `Derived` no longer run.** A `Derived` must be pure: it evaluates when
somebody reads it, which may be never. A `Derived` that set something up and registered an
`onCleanup`, and whose value came back `isEqual` to the last one, had that setup undone: the
equality cutoff keeps the previous value and releases whatever the run that just happened had
claimed. The idiom

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

**`use()` takes no callback.** What its callers wanted is `useEffect()`; `use()` is now nothing but
the dependency edge that holds an observable open.

**`getPriority`, `setPriority` and `getChannelOrder` are gone.** There is no depth to read or set.

**`Derived` no longer takes `channel` or `deferred`.** Both were about scheduling, and a `Derived`
has no schedule. Passing either does nothing, and the constructor says so once and points at
`Effect`, which takes both.

**`effect()` builds an `Effect`.** The old teardown-only helper of that name is `resource()`, and
`Computation#addSideEffect` is `addResource`.

**Entity effects replaced operators.** `just`, `store` and `useEffects` take arrays of entity
effects, `(entity) => void` functions run as `Effect`s, where they used to take RxJS
`MonoTypeOperatorFunction`s. `set`, `on` and friends are entity-effect factories now rather than
stream operators; the one that stayed an operator is `rxEffects(fn)`, on the `./rxjs` subpath.

`getEvaluations()` counts legitimately drop: work that used to be done eagerly and discarded is now
not done at all.
