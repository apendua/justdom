# @apendua/signal

A dependency-tracked reactive signals library, built directly on top of RxJS
instead of a bespoke pub-sub implementation.

Unlike most signal libraries, every reactive primitive here — `Signal`,
`Derived`, `store()`'s per-key change streams, `ReactiveMap`/`ReactiveSet` —
is backed by an RxJS `Subscribable`/`Observable`. That means signals compose
with ordinary RxJS operators (`switchMap`, `combineLatest`,
`distinctUntilChanged`, ...) instead of needing a separate adapter layer to
bridge "reactive state" and "async streams".

## Installation

```
npm install @apendua/signal
```

`rxjs` is a runtime dependency.

## Usage

```js
import { Signal, Derived, batch } from "@apendua/signal";

const count = Signal.of(0);
const doubled = new Derived(() => count.get() * 2);

doubled.subscribe(() => console.log("doubled is now", doubled.get()));

batch(() => {
  count.set(1);
  count.set(2);
}); // doubled recomputes once, not twice — logs "doubled is now 4"
```

Signals are lazy and uncached until something subscribes to them:
`doubled.get()` re-evaluates on every call until you (directly, or
indirectly by mounting into `@apendua/justdom`) subscribe to it. Once
subscribed, updates propagate push-style through a priority-ordered
scheduler that guarantees glitch-free, exactly-once recomputation — even
across diamond-shaped dependency graphs.

## Also included

- `store()` — a reactive `Proxy` over plain objects/arrays, with per-key
  dependency tracking.
- `selector()` / `arraySelector()` — structural, read-only reactive views.
- `ReactiveMap` / `ReactiveSet` — reactive wrappers around the native
  collections.
- `createProperty()` — a `WeakKey`-chained context mechanism (dependency
  injection without a compiler).
- `@memo` / `@memoFn` / `@mutate` — stage-3 decorators for memoized getters,
  memoized methods, and non-reactive mutations.

## Learn more

[`docs/signal-user-guide.md`](../../docs/signal-user-guide.md) is a full
guide to the reactive core, written from the source and test suite,
including a section-by-section walkthrough of every primitive and an honest
comparison to Solid, Preact, and Angular signals.

## License

MIT — see [LICENSE](../../LICENSE).
