# justdom

Signals straight to the DOM. No virtual DOM, no diffing, and the same model for Three.js and WebXR.

justdom is a small family of packages for building interfaces out of signals. A component is a
function, an element is created once, and every reactive value in it is wired to the one DOM write
it needs. The same operators build a Three.js scene, and in a WebXR headset the scene can show the
page's own DOM in a panel, so an app's interface is written once for both.

## Install

Pick the packages for what you render:

| To render                                 | Install                                              |
| ----------------------------------------- | ---------------------------------------------------- |
| Reactive state only                       | `justdom-signal`                                     |
| The DOM, on a page or on a server         | `justdom-core` and `justdom-signal`                  |
| A Three.js scene                          | `justdom-three`, `justdom-signal` and `three`        |
| DOM panels in a scene, such as a keyboard | `justdom-three-ui` and the packages of the row above |
| A WebXR session                           | `justdom-xr` with `justdom-three`                    |

`justdom-three`, `justdom-three-ui` and `justdom-xr` need `three` 0.185, 0.186 or 0.187; the
[`justdom-three` README](packages/three/README.md#installation) says why the range is closed. For a
Vite app, `npm install --save-dev justdom-vite-hmr` adds hot reloads that keep the app's live state.

The packages are JavaScript with JSDoc types and ship their `.d.ts` files, so TypeScript and editors
see every signature.

## A first example

```
npm install justdom-core justdom-signal
```

```js
import { Signal, just } from "justdom-signal";
import { $, children, on, text } from "justdom-core";

const count = Signal.of(0);

const Counter = $("button", [
  on("click", () => count.set(count.get() + 1)),
  children(text`Clicked ${() => count.get()} times`),
]);

const app = just(document.querySelector("#app"), [children(Counter)]).subscribe();
```

`$("button", …)` creates the button once. A click sets `count`, and the only work that follows is
the text node's new value. Nothing renders the button again and nothing compares two trees to find
what changed.

There is no separate mount API either. The render tree is a subscription tree: `.subscribe()` mounts
the app, and `app.unsubscribe()` removes it and runs every cleanup its parts registered.

## Packages

| Package                                                     | What it is for                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`justdom-signal`](https://justdom.dev/packages/signal)     | Reactive state: `Signal`, `Derived` and `Effect`, with a pull-based core.            |
| [`justdom-core`](https://justdom.dev/packages/core)         | The DOM, in a browser or on a server, with hydration of server-rendered markup.      |
| [`justdom-three`](https://justdom.dev/packages/three)       | A Three.js scene with the same operators, and DOM mirrored into the scene as panels. |
| [`justdom-three-ui`](https://justdom.dev/packages/three-ui) | Widgets for those panels: a dropdown, a keyboard, a scrolling window.                |
| [`justdom-xr`](https://justdom.dev/packages/xr)             | What a headset app repeats, including an emulated headset for a desktop browser.     |
| [`justdom-vite-hmr`](https://justdom.dev/packages/vite-hmr) | A Vite plugin that keeps live reactive state across hot module reloads.              |

## Documentation

- [Getting started](https://justdom.dev/guide/getting-started): a first app, and the three ideas the
  rest of the guide builds on.
- [Guide](https://justdom.dev/guide/): reactivity, rendering the DOM and a scene, server rendering,
  DOM panels and headset sessions.
- [API reference](https://justdom.dev/api/): every export, with its options and defaults.

## Demos

Each demo is a full app, and its page on justdom.dev links to its source. The ones that run in a
headset also open in a desktop browser, with an emulated headset.

- [Todo](https://justdom.dev/demos/todo/): everyone's first app, written once. In a headset the
  page's own DOM is mirrored into a panel, keyboard and all.
- [Desk](https://justdom.dev/demos/desk/): a desk drawn in HTML and CSS, which a headset sets out as
  panels on a desk in a room.
- [Showcase](https://justdom.dev/demos/showcase/): the DOM a headset panel can draw, such as lists,
  images, motion and SVG, side by side.
- [Euclid](https://justdom.dev/demos/euclid/): an editor for Euclidean constructions, where the code
  is the source of truth and the drawing is its evaluation.
- [Knights](https://justdom.dev/demos/knights/): a turn-based hex battle, ported from React, Redux
  and Meteor.
- [Castle](https://justdom.dev/demos/castle/): build a castle out of bricks in passthrough AR, then
  knock it down with a slingshot.
- [Hex Minesweeper](https://justdom.dev/demos/minesweeper/): minesweeper on a hexagonal grid, one
  `<svg>` wired to signals.

## Why justdom

justdom grew out of freedom, a reactive system for 3D apps. Its idea was to treat a Three.js scene
the way a reactive interface treats a page: create each object once and wire each of its properties
to the value it shows, with no virtual tree and no diffing. A scene has no markup to diff, and a
headset that misses its frame budget makes its wearer feel it, so work that only finds out nothing
changed is work worth not doing. The first version, from early 2025, was a set of RxJS operators
that did this for Three.js objects and, with the same vocabulary, for DOM nodes.

freedom then grew from a renderer for 3D scenes into a UI library for XR. An interface in a headset
needs what an interface on a page already has: layout, text, scrolling, text fields, a keyboard.
Rather than build those again in the scene, freedom learned to mirror real DOM into it. The name is
a double pun, and the showcase still spells it FreeDOM: "free DOM", the DOM set free from the page,
and, said aloud, "three DOM", because Three.js draws it. An app keeps its page as it is, and in a
headset `justdom-three` draws the element the app is mounted in as a panel in the room, which the
controllers point at and type into. That is how the todo and desk demos are each one app on a page
and in a headset, and the showcase demo shows what a panel can draw.

The rest of the stack grew with it:

- In October 2025 the state moved from plain RxJS to a signals library of its own. It was later
  rebuilt around a pull-based core, after the first version, which ordered updates by each node's
  depth in the graph, was found to publish values the graph never held once a signal passed through
  an RxJS wrapper. A write now only marks what may be stale, and a value is computed when something
  reads it.
- In the summer of 2026 the DOM side gained server rendering and hydration: the same components
  render to markup on a server, and the browser claims that markup instead of building it again.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) says how the repository is laid out, how to build and test it,
and how a release is published.

## License

MIT, see [LICENSE](LICENSE).
