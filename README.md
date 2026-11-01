# justdom

Signals straight to the DOM. No virtual DOM, no diffing, and the same model for Three.js and WebXR.

justdom is a small family of packages for building interfaces out of signals. A component is a
function, an element is created once, and every reactive value in it is wired to the one DOM write
it needs. The same operators build a Three.js scene, and in a WebXR headset the scene can show the
page's own DOM in a panel, so an app's interface is written once for both.

- [Getting started](https://justdom.dev/guide/getting-started): which packages to install for what
  you render, and a first app.
- [Packages](https://justdom.dev/packages/): a reference page for each package.
- [Demos](https://justdom.dev/demos/): full apps built on these packages, each linked to its source.

## A first example

```
npm install justdom justdom-signal
```

```js
import { Signal, just } from "justdom-signal";
import { $, children, on, text } from "justdom";

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

| Package                                 | What it is for                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| [`justdom-signal`](packages/signal)     | Reactive state: `Signal`, `Derived` and `Effect`, with a pull-based core.            |
| [`justdom`](packages/justdom)           | The DOM, in a browser or on a server, with hydration of server-rendered markup.      |
| [`justdom-three`](packages/three)       | A Three.js scene with the same operators, and DOM mirrored into the scene as panels. |
| [`justdom-three-ui`](packages/three-ui) | Widgets for those panels: a dropdown, a keyboard, a scrolling window.                |
| [`justdom-xr`](packages/xr)             | What a headset app repeats, including an emulated headset for a desktop browser.     |
| [`justdom-vite-hmr`](packages/vite-hmr) | A Vite plugin that keeps live reactive state across hot module reloads.              |

The repository also holds [`@apendua/sound`](packages/sound),
[`@apendua/geometry`](packages/geometry) and [`@apendua/jsdom-env`](packages/jsdom-env), smaller
packages the demos and the tests use, and the two private `@apendua/euclid-*` packages behind the
Euclid demo.

The packages are not on npm under these names yet. They are moving here from another repository, and
the install commands above work from their first release under these names.

## Demos

Each demo is a full app, and its source is in its folder under [`apps/`](apps). The ones that run in
a headset also open in a desktop browser, with an emulated headset.

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
Rather than build those again in the scene, freedom learned to mirror real DOM into it. An app keeps
its page as it is, and in a headset `justdom-three` draws the element the app is mounted in as a
panel in the room, which the controllers point at and type into. That is how the todo and desk demos
are each one app on a page and in a headset, and the showcase demo shows what a panel can draw.

The rest of the stack grew with it:

- In October 2025 the state moved from plain RxJS to a signals library of its own. It was later
  rebuilt around a pull-based core, after the first version, which ordered updates by each node's
  depth in the graph, was found to publish values the graph never held once a signal passed through
  an RxJS wrapper. A write now only marks what may be stale, and a value is computed when something
  reads it.
- In the summer of 2026 the DOM side gained server rendering and hydration: the same components
  render to markup on a server, and the browser claims that markup instead of building it again.

All of this grew inside [apendua.dev](https://apendua.dev), the author's personal monorepo, as
`@apendua/signal`, `@apendua/justdom` and `@apendua/freedom` among others. In October 2026 the
packages and demos moved to this repository with their git history, under the names they are
published with. [`docs/migration-plan.md`](docs/migration-plan.md) records that move.

## Working on justdom

[Rush](https://rushjs.io) drives the build, and it installs itself, so nothing needs to be installed
globally:

```
node common/scripts/install-run-rush.js install
node common/scripts/install-run-rush.js build
```

`install` also installs the pre-commit hook, which formats staged files with Prettier. `build`
type-checks and tests every package and demo. A change to a published package needs a change file,
which CI checks with `rush change --verify`:

```
node common/scripts/install-run-rush.js change
```

[`site/`](site) is justdom.dev, built with VitePress and deployed to GitHub Pages on every push to
`develop`. [`site/README.md`](site/README.md) says how to work on it. Releases are published by hand
from the maintainer's machine.

## License

MIT, see [LICENSE](LICENSE).
