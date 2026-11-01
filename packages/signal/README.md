# justdom-signal

A dependency-tracked reactive library with a **pull-based core** and an explicit split between the
three things a reactive graph does: a `Signal` is an input, a `Derived` is a transformation, an
`Effect` is an output. A write computes nothing; it marks what might now be wrong and stops. Values
are produced when somebody asks for them, and the asking is what establishes the order.

## Installation

```
npm install justdom-signal
```

`rxjs` is a peer dependency: any `Subscribable` can be depended on, and `toObservable` and
`fromObservable` carry values across the boundary in either direction.

## Usage

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
// → "doubled is now 4", once

effect.dispose();
```

## Learn more

- [Reactivity](https://justdom.dev/guide/reactivity) in the guide introduces signals, derived
  values, effects and channels.
- The [API reference](https://justdom.dev/api/signal) lists every export, its options and defaults:
  `UpdateChannel`, `store`, `createProperty`, the RxJS interop and the entity layer that
  [`justdom`](../justdom) and [`justdom-three`](../three) build on.

## License

MIT — see [LICENSE](../../LICENSE).
