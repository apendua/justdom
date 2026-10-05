# @apendua/justdom

A reactive, non-VDOM DOM renderer built on [`@apendua/signal`](../signal). No virtual tree, no
diffing pass — every reactive value is wired directly to a concrete, imperative DOM mutation through
an RxJS subscription.

## Installation

```
npm install @apendua/justdom @apendua/signal
```

## Usage

```js
import { Signal, just } from "@apendua/signal";
import { $, children, set, on, text } from "@apendua/justdom";

const count = Signal.of(0);

const Counter = $("button", [
  set("className", "counter"),
  on("click", () => count.set(count.get() + 1)),
  children(text`Clicked ${() => count.get()} times`),
]);

const root = document.querySelector("#app");
just(root, [children(Counter)]).subscribe();
```

There is no separate mount/unmount API: the render tree _is_ a subscription tree. Calling
`.subscribe()` mounts the app; calling `.unsubscribe()` on that subscription tears it down in
dependency order, running every registered cleanup.

## Server rendering and hydration

`@apendua/justdom` builds real DOM nodes through the ambient `document`, so server rendering only
needs a `document` outside the browser (see [`@apendua/jsdom-env`](../jsdom-env)) — the exact same
component tree mounts on the server and in the browser. `hydrate(root, ...content)`, exported from
the `@apendua/justdom/hydrate` subpath, mounts against markup that's already in the page by
_claiming_ existing nodes instead of creating new ones.

See [`apps/signal-ssr`](../../apps/signal-ssr) for a complete server-rendering + hydration example.

## Learn more

[`docs/signal-user-guide.md`](../../docs/signal-user-guide.md) covers the DOM layer in depth (§3):
elements as observables, keyed list rendering, text/stylesheet bindings, suspense-like async gating,
and SSR/hydration.

## License

MIT — see [LICENSE](../../LICENSE).
