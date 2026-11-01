# Getting started

justdom is a family of small packages. Pick the ones for what you render:

| To render                                 | Install                                                          |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Reactive state only                       | [`justdom-signal`](/packages/signal)                             |
| The DOM, on a page or on a server         | [`justdom`](/packages/justdom) and `justdom-signal`              |
| A Three.js scene                          | [`justdom-three`](/packages/three), `justdom-signal` and `three` |
| DOM panels in a scene, such as a keyboard | [`justdom-three-ui`](/packages/three-ui) and the above           |
| A WebXR session                           | [`justdom-xr`](/packages/xr) with `justdom-three`                |

For example, a page that renders the DOM:

```
npm install justdom justdom-signal
```

```js
import { Signal } from "justdom-signal";
import { $, children, set, on, text } from "justdom";
import { just } from "justdom-signal";

const count = Signal.of(0);

const Counter = $("button", [
  set("className", "counter"),
  on("click", () => count.set(count.get() + 1)),
  children(text`Clicked ${() => count.get()} times`),
]);

just(document.querySelector("#app"), [children(Counter)]).subscribe();
```

Three things in those lines are the whole model, and the next pages take them one at a time:

- `count` is a **signal**: a value somebody writes. Reading it inside a getter, as the `text`
  template does, makes whatever runs the getter depend on it. [Reactivity](./reactivity) is about
  that.
- `$("button", [...])` builds a real element and the list of **effects** that keep it current. There
  is no virtual tree and no diff: `set` writes a property, `on` adds a listener, `children` places
  nodes, and each is wired to the one DOM write it stands for.
  [Rendering the DOM](./rendering-the-dom) is about that.
- `.subscribe()` **mounts** the app. The render tree is a subscription tree: unsubscribing takes it
  down, in dependency order, running every cleanup. There is no separate mount and unmount API.

The <a href="/demos/todo/" target="_self">todo demo</a> is such a page. Add `justdom-three` and
`justdom-xr`, and a headset shows the same DOM: the scene mirrors the element the app is mounted in
into a panel in the room, so the app's interface is not built twice. [DOM panels](./dom-panels) is
about that.

<div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center">
  <img src="/screenshots/guide/todo-page.webp" alt="The todo app on a page" width="528" height="521" style="flex: 1 1 240px; min-width: 0">
  <img src="/screenshots/guide/todo-headset.webp" alt="The same app in an emulated headset" width="480" height="480" style="flex: 1 1 240px; min-width: 0">
</div>

The packages are JavaScript with JSDoc types, checked by `tsc` and shipped as source, so an editor
sees every signature, and the `.d.ts` files a consumer gets are generated from the same comments.
The [API reference](/api/) lists every export with its options and defaults.

::: warning Not on npm yet

The packages are moving here from another repository. Until their first release under these names,
these install commands find nothing.

:::

To see what the packages can do, open the [demos](/demos/). Each one links to its source.
