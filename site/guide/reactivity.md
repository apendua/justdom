# Reactivity

[`justdom-signal`](/api/signal) is the core every other package is built on. It has three kinds of
node, and an explicit split between them is the whole design:

- A **`Signal`** is an input. Somebody writes it; it is where a change enters.
- A **`Derived`** is a transformation. Pure, lazy, cached, computed on demand.
- An **`Effect`** is an output. Work that reads reactive values and touches the world.

```js
import { Signal, Derived, Effect, batch } from "justdom-signal";

const count = Signal.of(0);
const doubled = new Derived(() => count.get() * 2);

// Nothing has been computed yet: nobody has asked.
const effect = new Effect(() => console.log("doubled is now", doubled.get()));
// → "doubled is now 0"

batch(() => {
  count.set(1);
  count.set(2);
});
// → "doubled is now 4"   (one run, one evaluation)

effect.dispose();
```

## A write computes nothing

A write to a signal does not compute anything. It marks what might now be wrong and stops. Values
are produced when somebody asks for them, and the asking is what establishes the order: a `Derived`
resolves its dependencies before returning, so a dependency is always current before the thing that
reads it, by construction rather than by scheduling. The call stack of a read _is_ the topological
order.

What follows from that:

- **Unread work is not done.** A `Derived` nobody reads never evaluates.
- **A `Derived` must be pure.** It runs at times nobody chose, possibly more than once, possibly not
  at all. Anything that has to happen on a schedule, or that touches the world, is an `Effect`.
- **A `Derived` is uncached until something holds it open**: an `Effect` reading it, another
  `Derived` reading it, or a direct `subscribe`. Until then `doubled.get()` re-evaluates on every
  call. Once held open it caches, and recomputes only when something it read moved.
- **Equal values stop the change.** A node that recomputes to the value it already had, by
  `Object.is` or the `isEqual` it was given, stops the change dead, and nothing below it runs.

Only effects are scheduled. `batch()` holds every effect a block of writes invalidates until the
block returns, so two writes cost one run. A `Derived` needs no batch: a write already costs it
nothing until it is read.

## Effects and cleanup

An `Effect` runs once when it is built, tracks what it read, and runs again when any of that moves.
`onCleanup(fn)` registers work to undo before the next run and when the effect is disposed:

```js
import { Effect, onCleanup } from "justdom-signal";

new Effect(() => {
  const id = setInterval(tick, period.get());
  onCleanup(() => clearInterval(id));
});
```

Inside another computation, `useEffect(fn)` is the same `Effect` with its lifetime handed to the
computation that built it: whatever cleans that computation up disposes the effect, so nobody holds
the handle only to dispose it later. That is what a component wants for the work it starts.

A `Derived` can own a resource too: a texture, a worker, anything built once and released through
`onCleanup`. A re-evaluation releases what the node held and keeps what it just built, in that
order, so an evaluation that throws leaves the old resource intact. The
[reference](/api/signal#owning-expensive-resources) states the rules exactly, including `cacheTTL`,
which keeps a value warm for a while after its last reader leaves.

## Entities and their effects

The rest of the family is built on one more idea: a list of **entity effects** mounted on a value.
An entity effect is a function `(entity) => void` run as an `Effect` for as long as the entity stays
mounted. `set`, `on` and the DOM operators are all factories of them, and a plain lambda is a valid
entry too:

```js
import { just, set, on, effects } from "justdom-signal";

const mounting = just(
  () => new Thing(),
  [
    set("label", () => label.get()), // written again whenever `label` moves
    on("done", (event) => finish(event)),
    effects((thing) => thing.poll(interval.get())), // the identity, for a named lambda
  ],
);

const subscription = mounting.subscribe(); // builds the Thing and mounts the effects
subscription.unsubscribe(); // disposes them, running every cleanup
```

`just(factory, effects)` is cold: each subscriber gets a `Thing` of its own, built at mount time.
`useEffects(value, effects)` mounts the same list directly on the surrounding computation, with no
subscription in the middle. `component(fn)` and `effectsOnly(fn)` wrap a function that builds such a
mounting into something that can itself be mounted, which is how every component in the demos is
written.

## State in objects

`store(object)` is a reactive `Proxy` over a plain object or array, with a dependency per key: an
effect that read `props.completed` re-runs when that key is written and not when another is. A
nested plain object or array is a store too, and an array's mutating methods, `push`, `splice`,
`sort` and the rest, each run as one update.

```js
import { store } from "justdom-signal";

const props = store({ text: "", completed: false });
new Effect(() => console.log(props.completed)); // re-runs on `props.completed = true` alone
```

`ReactiveMap` and `ReactiveSet` are the native collections with the same per-key tracking, and
`createProperty()` is a context mechanism: a value set on a `WeakKey` that a tree hands down, which
is how a scene passes its renderer to everything in it.

## Scheduling

An effect belongs to an `UpdateChannel`, which decides when its queue drains and how long a pass may
spend. The default channel drains at the end of `batch()`, or at once outside one. A channel built
with a `trigger`, animation frames say, holds its effects until the trigger fires and then drains
for at most its `budget` in milliseconds, which is how a panel in a scene applies its updates at a
frame boundary and within a frame's worth of time. Channels drain in `order`, and an effect may only
invalidate an effect in a later channel: application state settles before presentation reads it. The
[reference](/api/signal#update-channels) has the options, including `atomic` channels, whose effects
run all at once or not at all.

## Crossing into RxJS

`rxjs` is a peer dependency, and the boundary with it is three functions, deliberately only three:
`fromObservable(subscribable)` brings values in as a `Derived`, `toObservable(node)` sends them out
through an `Effect` per subscriber, and `toEffect(fn)` sends work out the same way. Any
`Subscribable` can also be depended on directly, as a source. `rx()` and `rxEffects()`, on the
`justdom-signal/rxjs` subpath, carry a source and an entity effect into an RxJS pipeline; the
package root names no RxJS type.
