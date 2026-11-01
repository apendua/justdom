# justdom

A reactive, non-VDOM DOM renderer built on [`justdom-signal`](../signal). No virtual tree, no
diffing pass: every reactive value is wired directly to a concrete DOM mutation through a signal
effect.

## Installation

```
npm install justdom justdom-signal
```

## Usage

```js
import { Signal, just } from "justdom-signal";
import { $, children, set, on, text } from "justdom";

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

`justdom` builds real DOM nodes through the ambient `document`, so server rendering only needs a
`document` outside the browser (see [`@apendua/jsdom-env`](../jsdom-env)), and the exact same
component tree mounts on the server and in the browser. `hydrate(root, ...content)`, exported from
the `justdom/hydrate` subpath, mounts against markup that is already in the page by _claiming_
existing nodes instead of creating new ones. [`apps/todo-ssr`](../../apps/todo-ssr) is a complete
example.

## Learn more

- [Rendering the DOM](https://justdom.dev/guide/rendering-the-dom) and
  [Server rendering](https://justdom.dev/guide/server-rendering) in the guide.
- The [API reference](https://justdom.dev/api/justdom) lists every export: elements, operators,
  keyed lists, text and stylesheet bindings, suspense and hydration.

## License

MIT — see [LICENSE](../../LICENSE).
